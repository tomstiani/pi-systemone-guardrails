import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_THRESHOLDS, resolveThresholds, routeDanger, writeDecision } from "./extension.ts";

const answer = (probabilities: readonly [number, number, number, number], confidence: number) => ({
  confidence,
  probabilities: {
    0: probabilities[0],
    1: probabilities[1],
    2: probabilities[2],
    3: probabilities[3],
  },
});

test("routes only confident safe and extreme commands automatically", () => {
  assert.equal(routeDanger(answer([0.92, 0.05, 0.02, 0.01], 0.9)), "run");
  assert.equal(routeDanger(answer([0.91, 0.06, 0.02, 0.01], 0.7)), "ask");
  assert.equal(routeDanger(answer([0.01, 0.03, 0.06, 0.9], 0.85)), "deny");
  assert.equal(routeDanger(answer([0.05, 0.1, 0.15, 0.7], 0.8)), "ask");
});

test("loads optional threshold overrides and rejects invalid values", () => {
  assert.deepEqual(resolveThresholds({}), DEFAULT_THRESHOLDS);
  const thresholds = resolveThresholds({ systemOneGuardrails: { runConfidence: 0.95 } });
  assert.deepEqual(thresholds, { ...DEFAULT_THRESHOLDS, runConfidence: 0.95 });
  assert.equal(routeDanger(answer([0.92, 0.05, 0.02, 0.01], 0.9), thresholds), "ask");
  assert.throws(() => resolveThresholds({ systemOneGuardrails: { denyConfidence: 2 } }), /0 to 1/);
  assert.throws(() => resolveThresholds({ systemOneGuardrails: { typo: 0.5 } }), /Unknown/);
});

test("writes private JSONL decision records", () => {
  const directory = mkdtempSync(join(tmpdir(), "systemone-guardrails-"));
  const path = join(directory, "audit.jsonl");
  try {
    writeDecision({ command: "ls", cwd: "/tmp", route: "run", outcome: "run", source: "jev" }, path);
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.command, "ls");
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
