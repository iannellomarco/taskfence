# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-07-31

First public release of TaskFence, a deterministic application-hook policy
enforcement layer for coding agents.

### Added

- **Contract-gated enforcement.** A plan declares exactly one
  `taskfence-contract` fenced block whose body is a strict JSON object with
  `version`, `write`, `create`, `delete`, `protected`, `commands`, and
  `packageManager` fields. Unknown or duplicate keys are rejected. `version`
  must be `1`; `packageManager` must be one of `npm`, `pnpm`, `yarn`, `bun`, or
  `none`. Path selectors support exact paths and `/**` subtrees; command rules
  are exact argument vectors with a `cwd` relative to the project root.
- **Read-only tolerance and fail-closed mutations.** With no contract active,
  read-only tool calls are allowed and all mutations and commands are denied.
  Mutations and commands require an active contract plus bound host authority.
- **Checkpoint-then-activate lifecycle.** A contract is staged, a content
  addressed checkpoint of the project tree is committed, and only after the
  checkpoint succeeds does the contract become active.
- **Pending-mutation reconciliation.** At most one mutation is pending at a
  time, correlated by a hash of the raw host input and reconciled against the
  runtime, session, call ID, input hash, and reported outcome after the tool
  returns. Missing, failed, uncertain, or mismatched reconciliation denies
  later mutations.
- **Rollback.** Restores the checkpointed project tree on demand while
  preserving the project's `.git` directory. A dry-run preview is available.
- **Tamper-evident receipt ledger.** Every decision and lifecycle transition is
  written as an append-only, hash-chained receipt anchored into durable project
  state, with `receipts verify` and `receipts list` (with cursor pagination).
  Known-secret patterns in tool-call metadata are redacted to `[REDACTED]`
  before persistence.
- **Per-project secure state.** State directories are created with mode `0700`;
  state files must be current-user-owned regular files with a single link and
  are opened with `O_NOFOLLOW`.
- **Root-scoped project lock** serializing state and receipt writes, with a
  durable write-ahead transaction and recovery for crash/race safety.
- **Host authority binding** for coding-agent sessions, scoped to the host
  sessions TaskFence is configured for.
- **Adapters and installer** for five runtimes: Claude Code, Codex CLI,
  OpenCode, OMP, and Pi. `taskfence install` / `uninstall` (user or project
  scope) and `taskfence doctor` (adapter self-test and host-heartbeat status)
  are provided.
- **Guided Claude Code setup.** The marketplace plugin includes a `setup` skill
  that inspects a task in Plan Mode, prepares the least-privileged contract,
  and hands approval to Claude Code's native `ExitPlanMode` UI.
- **CLI** (`taskfence` / `tf`) covering `contract validate`, `approve`,
  `amend`, `status`, `complete`, `revoke`, `rollback`, `receipts verify`,
  `receipts list`, `install`, `uninstall`, `doctor`, and the `hook` entrypoint.
  Authority-bearing actions require interactive confirmation unless `--yes` is
  supplied by the user.

### Security

- **Threat boundary is explicitly application-layer.** TaskFence is a
  policy gate at the agent tool-hook boundary, not an OS/kernel sandbox. It
  does not defend against same-user malicious processes, transitive behavior
  inside approved commands, or host runtimes that fail to invoke hooks. See
  `SECURITY.md` for the full boundary and non-goals.
- Fail-closed behavior on uncertain, missing, failed, or mismatched
  post-tool reconciliation.
- Receipt metadata redaction for common secret patterns (tokens, keys,
  credentials, `Bearer`/`Basic` headers, URI-embedded credentials, known token
  formats). Redaction is best-effort pattern matching, not a secrecy guarantee.
- Secure state directory and file handling (mode `0700`, current-user
  ownership, single link, `O_NOFOLLOW`).

### Testing

- Vitest suite covering contract compilation and validation, tool and command
  policy, path policy, checkpoints, rollback, the content-addressed store,
  state durability and locking, transaction recovery, receipts (including
  hardening and verification), CLI receipts, session authority, adapter
  behavior, the installer, and packaging.

### Known limitations (application layer)

- **No operating-system or kernel isolation.** TaskFence runs as a normal
  process under the user's own account.
- **No containment of same-user processes**, including other shells, editors,
  language servers, debuggers, or agent extensions that can read or modify the
  project tree, TaskFence state, or the agent configuration outside TaskFence's
  view.
- **No containment of transitive behavior inside approved commands.** An
  approved command and everything it spawns or depends upon runs with the
  user's full privileges.
- **Depends on the host runtime** to invoke hooks correctly and in order. A
  runtime that bypasses or misorders hooks, or that is itself compromised, is
  outside TaskFence's ability to detect or contain.
- **Authority inheritance to child agents/subagents is runtime-dependent**, not
  universally guaranteed by TaskFence.
- **Receipt redaction is best-effort**, not a guarantee that no sensitive value
  will be persisted.

