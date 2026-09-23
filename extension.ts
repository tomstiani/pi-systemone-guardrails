import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  isToolCallEventType,
  readStoredCredential,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { score, TypeSafeClient, type ScoreResponse } from "@typesafe-ai/sdk";

export const DANGER_CRITERIA = [
  "Read-only or observational; no meaningful mutation or external side effect.",
  "Bounded, reversible mutation within the current project.",
  "Broad or consequential mutation, external side effect, credential or privilege change, or unclear scope.",
  "Likely irreversible destruction, exfiltration, system-wide or production impact, or deliberately obscured behavior.",
] as const;

export interface Thresholds {
  runSafeProbability: number;
  runConfidence: number;
  denyExtremeProbability: number;
  denyConfidence: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  runSafeProbability: 0.9,
  runConfidence: 0.8,
  denyExtremeProbability: 0.8,
  denyConfidence: 0.7,
};

const thresholdNames = Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[];

export function resolveThresholds(settings: unknown): Thresholds {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings.json must contain an object");
  }

  const config = (settings as Record<string, unknown>).systemOneGuardrails;
  if (config === undefined) return { ...DEFAULT_THRESHOLDS };
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("systemOneGuardrails must contain an object");
  }

  const values = config as Record<string, unknown>;
  const unknown = Object.keys(values).filter((name) => !thresholdNames.includes(name as keyof Thresholds));
  if (unknown.length) throw new Error(`Unknown systemOneGuardrails setting: ${unknown.join(", ")}`);

  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const name of thresholdNames) {
    if (values[name] === undefined) continue;
    if (typeof values[name] !== "number" || !Number.isFinite(values[name]) || values[name] < 0 || values[name] > 1) {
      throw new Error(`systemOneGuardrails.${name} must be a number from 0 to 1`);
    }
    thresholds[name] = values[name];
  }
  return thresholds;
}

function loadThresholds(): Thresholds {
  try {
    const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
    return resolveThresholds(settings);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_THRESHOLDS };
    throw error;
  }
}

const AUTH_PROVIDER_ID = "typesafe";

const dangerQuestion = score(
  "Rate the worst plausible danger of executing `command` from `cwd` exactly as given. Treat downloaded, encoded, or otherwise uninspectable executable content as obscured behavior.",
  DANGER_CRITERIA,
);

type DangerAnswer = ScoreResponse<typeof DANGER_CRITERIA>;
type DangerJudgment = Pick<DangerAnswer, "confidence" | "probabilities">;
export type Route = "run" | "ask" | "deny";

export interface DecisionRecord {
  command: string;
  cwd: string;
  route: Route;
  outcome: "run" | "deny";
  source: "jev" | "fallback" | "config";
  score?: number;
  confidence?: number;
  probabilities?: DangerAnswer["probabilities"];
  thresholds?: Thresholds;
  detail?: string;
}

export function writeDecision(record: DecisionRecord, path = join(getAgentDir(), "logs", "pi-systemone-guardrails.jsonl")): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // ponytail: unbounded JSONL; add rotation if real usage makes file growth material.
  appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function audit(record: DecisionRecord): string | undefined {
  try {
    writeDecision(record);
  } catch (error) {
    return `Could not write guardrail audit log: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function routeDanger(answer: DangerJudgment, thresholds = DEFAULT_THRESHOLDS): Route {
  if (
    answer.probabilities[0] >= thresholds.runSafeProbability &&
    answer.confidence >= thresholds.runConfidence
  ) return "run";

  if (
    answer.probabilities[3] >= thresholds.denyExtremeProbability &&
    answer.confidence >= thresholds.denyConfidence
  ) return "deny";

  return "ask";
}

function summary(answer: DangerAnswer, route: Route): string {
  return `${route.toUpperCase()} · danger ${answer.score.toFixed(2)}/3 · confidence ${answer.confidence.toFixed(2)}`;
}

export default function systemOneGuardrails(pi: ExtensionAPI) {
  let client: TypeSafeClient | undefined;
  let thresholds: Thresholds | undefined;
  let configError: string | undefined;
  try {
    thresholds = loadThresholds();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;
    if (!thresholds) {
      const reason = `Invalid System One guardrails config: ${configError}`;
      const auditError = audit({ command, cwd: ctx.cwd, route: "deny", outcome: "deny", source: "config", detail: reason });
      if (ctx.hasUI) ctx.ui.notify(auditError ?? reason, "error");
      return { block: true, reason: auditError ? `${reason}; ${auditError}` : reason };
    }
    let answer: DangerAnswer;

    try {
      if (!client) {
        const credential = readStoredCredential(AUTH_PROVIDER_ID);
        const apiKey = credential?.type === "api_key" ? credential.key : undefined;
        client = new TypeSafeClient(apiKey ? { apiKey } : {});
      }
      const response = await client.systemOne(
        {
          state: { command, cwd: ctx.cwd },
          questions: { danger: dangerQuestion },
        },
        { signal: ctx.signal },
      );
      answer = response.answers.danger;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const approved = ctx.hasUI && await ctx.ui.confirm(
        "Jev unavailable",
        `Could not score this command (${detail}). Run anyway?\n\n${command}`,
      );
      const auditError = audit({
        command,
        cwd: ctx.cwd,
        route: "ask",
        outcome: approved ? "run" : "deny",
        source: "fallback",
        detail,
      });
      if (auditError) return { block: true, reason: auditError };
      if (!approved) return { block: true, reason: `Jev unavailable: ${detail}` };
      return;
    }

    const route = routeDanger(answer, thresholds);
    const decision = summary(answer, route);
    const approved = route === "run" || route === "ask" && ctx.hasUI && await ctx.ui.confirm(
      `Jev: ${decision}`,
      `Run this command?\n\n${command}`,
    );
    const auditError = audit({
      command,
      cwd: ctx.cwd,
      route,
      outcome: approved ? "run" : "deny",
      source: "jev",
      score: answer.score,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      thresholds,
    });

    if (auditError) {
      if (ctx.hasUI) ctx.ui.notify(auditError, "error");
      return { block: true, reason: auditError };
    }
    if (approved) {
      if (ctx.hasUI && route === "run") ctx.ui.notify(`Jev: ${decision}`, "info");
      return;
    }
    if (ctx.hasUI && route === "deny") ctx.ui.notify(`Jev: ${decision}`, "error");
    return { block: true, reason: route === "deny" ? `Jev denied command: ${decision}` : `Command not approved: ${decision}` };
  });
}
