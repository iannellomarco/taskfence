---
name: setup
description: Set up TaskFence for a first protected Claude Code task. Use when the user asks to set up, configure, start, enable, or try TaskFence; protect a task; create a TaskFence contract; add guardrails; or learn the safe approval, recovery, completion, rollback, or revocation workflow.
---

# Set up a protected task

The plugin is already installed. Its Claude Code hooks are registered by the plugin, so do not install another hook, edit hook configuration, or run `taskfence install`. A second hook install is unnecessary and could duplicate interception.

## Choose the task

1. Use the concrete task in `$ARGUMENTS` when present.
2. Otherwise, use a concrete task stated in the user's prompt or current conversation.
3. Only when neither contains a task, ask once: “What task would you like TaskFence to protect?” Do not ask this question again.

The user does not need to write JSON. Derive the contract from the task and repository inspection. Never present placeholder paths, example commands, ellipses, or guessed values as a finished contract. If the task is still not concrete enough to produce a truthful contract after the one answer, explain what is missing instead of fabricating authority.

## Plan safely

Enter Plan Mode before inspecting the project. While planning, use only read-only tools to understand the repository, its local instructions, the files relevant to the task, and its existing verification commands. Do not mutate files or run commands during this inspection.

Draft a concrete implementation plan that names the intended changes, affected paths, verification, and recovery. Keep authority least-privileged: authorize only operations and exact commands needed by that plan.

Do not use `Write` or another mutation tool to save the plan file before approval. Pass the complete plan directly in the `ExitPlanMode` call; pre-approval project mutations are intentionally unavailable.

Append exactly one top-level fenced block. Its opening delimiter must be the literal line `` ```taskfence-contract `` and its closing delimiter must be the literal line `` ``` ``. Nothing may follow the closing fence. The body must be strict JSON with no comments, duplicate keys, or unknown fields, and must contain all seven fields:

- `version`: exactly `1`.
- `write`: existing files that may be edited or overwritten.
- `create`: currently nonexistent files or directories that may be created.
- `delete`: existing files that may be deleted.
- `protected`: additional paths that must never be mutated; use an empty array when no extra protection is needed because TaskFence protects its own control paths automatically.
- `commands`: only required commands, each as an object with an exact literal `argv` string array and an exact existing `cwd` relative to the project root.
- `packageManager`: exactly `npm`, `pnpm`, `yarn`, `bun`, or `none`, based on the inspected project and the approved commands.

Selectors must be relative POSIX paths. Use an exact path for one target or a final `/**` for a genuinely required subtree; do not use broad repository-wide selectors. Keep write, create, and delete authority separate. Commands are exact argv/cwd pairs, not shell strings: do not authorize wrappers, pipelines, redirections, command substitution, interactive commands, or extra flags “just in case.” Empty operation or command arrays are valid and preferred over invented entries.

After the complete plan and its single contract block are ready, call Claude Code's native `ExitPlanMode`. TaskFence's plugin hook validates the proposed plan and preserves the native approval UI. The user approves or rejects there; Claude must not approve or activate its own contract.

Never invoke `taskfence approve`, `taskfence install`, or any TaskFence authority-changing verb through Bash or another agent tool call. This prohibition includes `activate`, `amend`, `stage`, `rollback`, `complete`, `revoke`, `close`, and `uninstall`. Do not substitute a CLI workflow for `ExitPlanMode` approval.

## User-controlled lifecycle

Claude may explain these commands, but the user must type them directly in Claude Code shell mode. In particular, the user—not Claude—must enter every authority-changing command:

- Inspect current state: `!taskfence status --root .`
- Preview recovery without changing the worktree: `!taskfence rollback --root . --dry-run`
- Restore the checkpoint when recovery is needed: `!taskfence rollback --root . --yes`
- End accepted work normally: `!taskfence complete --root . --yes`
- Withdraw authority with a durable reason: `!taskfence revoke --root . --reason "scope changed" --yes`

Use status when uncertain. Preview rollback before an actual rollback. Complete only after the user accepts the work; revoke when work should stop without normal completion.

The `--yes` flag is appropriate here only because the user enters the direct shell command. Claude must never add it to an agent-run tool call.

TaskFence mediates Claude Code tool calls at the application-hook boundary. It is not an operating-system sandbox and does not isolate the host, other same-user processes, or subprocesses of an approved command. Use OS sandboxing or containers separately when that isolation is required.
