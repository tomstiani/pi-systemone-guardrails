# Pi System One Guardrails

A conservative [Pi](https://github.com/earendil-works/pi-mono) extension that asks Jev to score agent-proposed Bash commands before execution.

## Use

```bash
npm install
pi -e ./extension.ts
```

Store the TypeSafe API token in Pi's `auth.json`:

```json
{
  "typesafe": { "type": "api_key", "key": "..." }
}
```

`TYPESAFE_API_KEY` remains supported as a fallback. The extension automatically runs only commands Jev considers clearly safe, denies confidently extreme commands, and asks about everything else. If Jev is unavailable, it asks in interactive mode and denies in headless mode.

Configure thresholds in Pi's global `settings.json` (all values must be between `0` and `1`):

```json
{
  "systemOneGuardrails": {
    "runSafeProbability": 0.9,
    "runConfidence": 0.8,
    "denyExtremeProbability": 0.8,
    "denyConfidence": 0.7
  }
}
```

Restart Pi or run `/reload` after changing them. Omitted values use the defaults above; unknown or invalid values block Bash commands until fixed.

Every decision is written as JSONL to `~/.config/pi/logs/pi-systemone-guardrails.jsonl` (or the equivalent active Pi agent directory). Records include the command and may contain secrets, so the file is kept at permission mode `0600`. If the audit log cannot be written, the command is blocked.

```bash
npm test
npm run typecheck
```
