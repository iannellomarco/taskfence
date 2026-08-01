# Runtime Support

TaskFence 0.1.1 contains adapters and installers for five coding-agent runtimes. “Implemented” below means the adapter matches the current TaskFence source and the cited host API was source-verified on 2026-08-01. It does not mean that `taskfence doctor` can prove end-to-end enforcement; doctor deliberately does not make that claim.

## Compatibility targets

| Runtime | Source-verified host target (2026-08-01) | Implemented gate | Contract activation |
| --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-code` 2.1.220 | synchronous catch-all `PreToolUse` and `PostToolUse` command hooks | native `ExitPlanMode`: pre validates and returns `ask`; successful post activates the exact host-approved plan |
| Codex CLI | `@openai/codex` 0.146.0, tag `rust-v0.146.0` (`e363b08`) | native catch-all `PreToolUse` and `PostToolUse` command hooks | external `taskfence approve`; no native plan-exit activation in the current adapter |
| OpenCode | OpenCode / `@opencode-ai/plugin` 1.18.10, commit `e4bd9757…` | plugin `tool.execute.before` / `tool.execute.after` | external `taskfence approve`, then exact-hash validation at `plan_exit` |
| OMP | `@oh-my-pi/pi-coding-agent` 17.2.1, commit `ef44bb57…` | extension `tool_call` / `tool_result` | user-only `/taskfence approve <plan-file>` command |
| Pi | `@earendil-works/pi-coding-agent` 0.83.0, commit `977ec833…` | extension `tool_call` / `tool_result` | user-only `/taskfence approve <plan-file>` command |

TaskFence's standalone CLI declares Node.js 20 or newer. That does not lower host requirements: the checked Claude npm release declares Node 22+, and the checked Pi package declares Node 22.19.0+; OMP uses its own Bun-based distribution.

## Installation

Install the pinned CLI with `npm install --global https://github.com/iannellomarco/taskfence/archive/refs/tags/v0.1.1.tar.gz`, or build it from the source checkout as described in the [README](../README.md#install-from-source). The CLI supports the same surface for every adapter:

```sh
taskfence install claude --scope user
taskfence install codex --scope project --root /absolute/project
taskfence install opencode omp pi --scope user
taskfence doctor all --scope user
taskfence uninstall claude codex opencode omp pi --scope user
```

Omitting runtime names is equivalent to `all`. Scope is `user` by default; project scope uses the canonical `--root` or current directory. The installer creates backups before replacing an owned JSON configuration and refuses to overwrite an unrelated loader, extension, symlink, or incompatible config shape.

| Runtime | User scope | Project scope | Installed representation |
| --- | --- | --- | --- |
| Claude | `~/.claude/settings.json` | `<root>/.claude/settings.json` | catch-all PreToolUse and PostToolUse groups executing absolute Node + TaskFence CLI paths |
| Codex | `~/.codex/hooks.json` | `<root>/.codex/hooks.json` | catch-all PreToolUse and PostToolUse groups executing an absolute quoted TaskFence command |
| OpenCode | `${OPENCODE_CONFIG_DIR:-~/.config/opencode}/plugins/taskfence.ts` | `<root>/.opencode/plugins/taskfence.ts` | generated ESM loader importing this installation's adapter |
| OMP | `~/.omp/agent/extensions/taskfence.js` | `<root>/.omp/extensions/taskfence.js` | symlink to this installation's adapter |
| Pi | `~/.pi/agent/extensions/taskfence.js` | `<root>/.pi/extensions/taskfence.js` | symlink to this installation's adapter |

For Codex, the installer refuses to create `hooks.json` when the same scope's `.codex/config.toml` already contains inline hooks; Codex merges both representations. Project-local Codex hooks still require Codex project trust, and changed hooks are skipped by Codex until their new hash is trusted. Project-local Pi packages likewise depend on host project trust. Claude managed-hook policy can suppress ordinary user/project hooks unless the plugin/hook is deployed through the applicable managed mechanism.

These paths install local artifacts only. They do not assert that an npm package has been published, that a host accepted/trusted the entry, or that no other configuration disables it.

## Approval and enforcement by runtime

### Claude Code

The adapter accepts bounded current-version `PreToolUse` and `PostToolUse` payloads. For ordinary tools:

- pre calls the shared engine and emits no output on allow, preserving Claude's normal permission flow;
- denial is exact structured `permissionDecision: "deny"`; and
- malformed payload or internal failure exits 2 with a reason, which blocks on the checked host version.

By default Claude Code stores native plans under `${CLAUDE_CONFIG_DIR:-~/.claude}/plans`. TaskFence 0.1.1 defers only that default host-managed `Write`, only while `permission_mode` is `plan`, to Claude Code's own gate and never treats it as project authority. The directory must resolve physically outside the project, be owned by the current user, and not be group/world-writable; an existing destination must be a current-user-owned, single-link regular file outside the project. Symlinked, hard-linked, project-contained, and ambiguous destinations fail closed. Claude Code's supported `plansDirectory` customization is intentionally unsupported: the pre-write hook does not expose the host's resolved setting, so accepting another model-supplied path would weaken the boundary. Customized plan paths fail closed; use the default directory for TaskFence setup. Content remains bounded, and ordinary writes still require an active contract.

For `ExitPlanMode`, a root-session pre hook validates the host-injected `tool_input.plan`, optional `planFilePath`, and the exact contract, then durably correlates its hash with the session and tool-use ID. It returns `ask`, not `allow`, so TaskFence does not bypass the native user approval prompt. Official guidance prefers returned `tool_response.plan`, which TaskFence validates when present. In the tested Claude Code 2.1.220 interactive flow, the successful post payload instead had empty `tool_input`, `tool_response.plan: null`, and `tool_response.filePath`; that exact shape is runtime-observed, not documented as stable. The generated 2.1.220 output schema permits nullable plan text and an optional file path, so TaskFence uses the secure plan-file read only as that pinned fallback, verifies it against the pre-hook correlation, then checkpoints, activates, and binds the Claude root session. A child `ExitPlanMode` is denied.

Claude reports `agent_id` in child tool hooks. TaskFence derives a deterministic child ID from the root host session and agent ID and records the root session as parent. This is adapter-specific; no universal inheritance is implied. The current explicit tool catalog does not allow Claude's `Agent` spawn tool, because unknown tools are denied.

Claude runs matching hooks from settings/plugins; host decision precedence is deny over defer/ask/allow. TaskFence is silent on allowed ordinary tools rather than returning a permission grant. HTTP and asynchronous hooks are unsuitable enforcement surfaces and are not installed.

### Codex CLI

The installer registers native command hooks, not legacy `notify` and not app-server observation. PreToolUse denies through structured JSON; adapter/parsing errors exit 2 with non-empty stderr. PostToolUse performs correlation and finalizes the pending state.

Current deliberate restrictions:

- every Codex command/shell surface (`bash`, `exec_command`, `local_shell`, `shell`, `shell_command`, and `Bash`) is denied even when a contract lists the command;
- the reason is host `write_stdin`: subsequent input to an existing unified-exec process receives no fresh `PreToolUse` event;
- the currently supported Codex mutation path is `apply_patch`, with the exact 0.146.0 `{command: string}` input and string post response; and
- other unknown local or MCP tool names are denied by the explicit tool catalog. Hosted tools do not receive Codex tool hooks and are outside this mutation boundary.

The adapter contains a `PermissionRequest` handler, but the current installer registers only PreToolUse and PostToolUse; PermissionRequest would not replace PreToolUse because it fires only when Codex is already asking permission. Codex launches multiple matching command hooks concurrently, so TaskFence cannot prevent another hook from starting or independently causing effects. `SubagentStart` cannot be used as a blocking boundary, and the current TaskFence Codex adapter does not establish child ancestry.

### OpenCode

The generated loader returns the ESM plugin adapter. At initialization TaskFence canonicalizes OpenCode's project `directory`; all tool calls are evaluated against that immutable root. A before-hook rejection throws, preventing the wrapped executor from running. After hooks correlate tool/session/call/raw args and finalize pending state. The pinned current after hook repeats args, which TaskFence hashes directly; for the older compatible shape that omits args, TaskFence re-hashes the retained shared before-hook argument carrier.

OpenCode `plan_exit` does not itself grant TaskFence authority. Before it can proceed:

1. the user must activate the exact plan with the external TaskFence CLI;
2. `plan_exit` must supply the same canonical root, plan hash, and contract hash;
3. TaskFence must synchronously fetch session metadata through `client.session.get`;
4. the reported session directory must be canonical and equal to the plugin root; and
5. a parent, when present, must already be in durable authority.

After `plan_exit`, TaskFence revalidates the explicit current after args or retained legacy argument carrier, then checks that the exact plan/root/contract, generation, and revision did not change between hooks.

OpenCode runs all plugin before hooks sequentially with a shared mutable `output.args`. An earlier plugin can alter args before TaskFence sees them; a later plugin can alter args after TaskFence approves them. TaskFence hashes its observed pre args and, at post, hashes explicit current after args or re-hashes the retained shared carrier for the older no-args shape. A mismatch leaves the project pending/fail-closed, but that post detection cannot undo effects already caused. OpenCode session event callbacks are fire-and-forget, so TaskFence does not depend on event ordering; it fetches ancestry synchronously in the before hook.

### OMP

The adapter is one unified extension, not a parallel legacy hook. It canonicalizes `process.cwd()` at extension load, records the stable host session ID on `session_start`, and requires that identity to remain unchanged. `tool_call` invokes shared preflight and returns `{block: true, reason}` on denial or internal error. `tool_result` compares the executed event input with the raw pre-input hash and reports `!isError` as success.

OMP's command context is documented as user-initiated. TaskFence registers:

```text
/taskfence approve <plan-file>
/taskfence amend <plan-file>
/taskfence status
/taskfence rollback
/taskfence complete
/taskfence revoke <reason>
```

Approval reads a bounded current-user-owned regular plan file, checkpoints, activates, and binds the current OMP session. There is no model-callable TaskFence authority tool.

OMP extension failures and the 30-second extension timeout are host fail-closed for tool calls. OMP input replacement is last-wins and handlers do not observe each other's revisions; it also has documented exceptions such as computer calls. TaskFence never rewrites approved input. Later extension mutation may be detected only at tool_result, after effects. OMP `session_stop` is main-session-only, so TaskFence does not use it as the enforcement boundary. The current adapter supplies no parent session ID; it makes no child-agent inheritance guarantee.

### Pi

Pi uses the same user command UX and lifecycle policy as OMP, but its host event semantics differ and the adapters are separate. The Pi adapter records the stable session identity on `session_start`, blocks in `tool_call`, and correlates executed `tool_result.input` before finalization.

Pi lets extension handlers mutate `event.input` in place; later handlers see earlier changes and the host performs no schema revalidation after mutation. TaskFence does not mutate it. A later extension can still change input after TaskFence's preflight; post correlation can leave the state pending but cannot undo the executed effect. Pi extensions execute in process with full system permissions. The current adapter supplies no parent session ID and therefore makes no child-agent inheritance guarantee.

## Common policy behavior

Across all adapters:

- explicitly classified reads are allowed without a contract;
- commands and project mutations require active contract plus bound session/call authority;
- Claude Code's bounded native plan-file write is the sole pre-engine exception; TaskFence defers it to the host's own Plan Mode gate only when it resolves safely outside the project, and it grants no project authority;
- unknown and malformed tools deny;
- an allowed command/mutation is durably marked pending before the host executes it;
- raw host input is hashed at pre and correlated at post;
- only one command/mutation may be pending for a root; and
- post failure, missing/mismatched correlation, or unresolved authority prevents a return to active state.

Host post hooks run after execution. They can reconcile evidence and trigger recovery state, but they cannot retroactively prevent a side effect.

## Heartbeats and `doctor`

Every adapter writes a best-effort diagnostic heartbeat under:

```text
${XDG_STATE_HOME:-~/.local/state}/taskfence/host-heartbeats/<runtime>.json
```

The record contains runtime, observation time, and PID. Claude/Codex write after their CLI hook executes; OpenCode writes at plugin initialization; OMP/Pi write at extension initialization and at most once per minute while handling events/commands. Heartbeat failure never weakens or interrupts authorization.

`taskfence doctor` reports three independent facts:

1. **local adapter self-test** — Node, CLI, and built adapter files exist and the adapter export is callable in the doctor process;
2. **configured** — the expected TaskFence-owned hook/loader/symlink is present at the selected scope; and
3. **host heartbeat** — a loading observation exists and is recent (10 minutes by default), stale, missing, or invalid.

A heartbeat is not bound to a project, host process instance, session, contract, or denied smoke call. Accordingly `hostHeartbeat.verified` is always `false` in the current implementation, even for a recent heartbeat. The doctor command returns failure unless self-test, configuration, **and verified host heartbeat** are all true; today that means it honestly does not certify enforcement. End-to-end assurance requires a real host smoke test that exercises a known-denied mutation and confirms the denial.

## Upgrade and coverage cautions

- Host tool names and argument shapes are versioned policy input. Upgrade a host only after adapter compatibility tests and a real deny smoke.
- Catch-all registration is required, but a host may have specialized or hosted execution paths outside its general tool hook.
- Multiple plugins/extensions/hooks have host-specific ordering and mutation semantics; there is no cross-host exclusive-priority API.
- Installation is user-controlled unless separately deployed through a host's managed policy. A user can disable, untrust, or bypass ordinary configuration.
- Adapters execute in the host process or as local hook commands. They are application mediation, not isolation from the host, extensions, same-user processes, or subprocesses of an approved command.
