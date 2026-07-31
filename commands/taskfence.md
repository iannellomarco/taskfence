---
description: Inspect or manage the TaskFence contract lifecycle
argument-hint: "[status|contract validate <plan-file>|approve <plan-file>|amend <plan-file>|rollback|complete|revoke ...]"
allowed-tools: Bash
---

Use the built TaskFence CLI from this plugin. If `$ARGUMENTS` is empty, run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" status
```

Otherwise, pass the user's arguments unchanged:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" $ARGUMENTS
```

Do not invent, reorder, or broaden arguments. In particular, never add `--yes`; it is valid only when the user explicitly included it. Report the CLI result without claiming that this slash command grants tool authority or bypasses Claude Code permissions.

## Contract block

Before approval, the plan must contain exactly one fenced block whose opening line is exactly `\`\`\`taskfence-contract`. Its body must be one strict JSON object with every field below and no additional or duplicate keys:

```taskfence-contract
{
  "version": 1,
  "write": ["src/existing.ts", "src/features/**"],
  "create": ["src/new.ts", "tests/**"],
  "delete": ["src/obsolete.ts"],
  "protected": ["secrets/**"],
  "commands": [
    {
      "argv": ["npm", "test", "--", "tests/unit.test.ts"],
      "cwd": "."
    }
  ],
  "packageManager": "npm"
}
```

Use relative POSIX paths. A plain path selects exactly that path; a path ending in `/**` selects its subtree. Command entries are exact argument vectors and declare their working directory relative to the project root. `packageManager` must be exactly `npm`, `pnpm`, `yarn`, `bun`, or `none`. TaskFence also protects its built-in control paths independently of the extra `protected` entries.

## Approval lifecycle

1. Claude proposes a plan containing the exact contract block and calls `ExitPlanMode`.
2. The synchronous `PreToolUse` hook compiles the injected `tool_input.plan`. An invalid contract is denied. A valid contract returns `ask`, preserving Claude Code's native user approval UI; preflight does not activate the contract.
3. The user reviews the plan in that native UI. Only a successful `PostToolUse` for `ExitPlanMode` supplies the approved `tool_response.plan`; TaskFence then stages it, creates the checkpoint, and activates it only after checkpoint creation succeeds.
4. While active, every non-read tool call is checked locally. An allowed mutation remains pending until a matching post-hook reconciles the same call ID and normalized input digest. Missing, failed, uncertain, or mismatched reconciliation remains fail closed for later mutations.
5. Use `status` to inspect state. Use `amend` with a plan file for an explicit contract change, `complete` when work is accepted, `rollback` to restore the checkpoint, or `revoke --reason <text>` to withdraw authority. Authority-bearing CLI actions require their own user confirmation unless the user explicitly supplied `--yes`.

TaskFence mediates Claude Code tool calls at the application hook boundary. It does not provide OS isolation, and it does not replace Claude Code's normal permission system.
