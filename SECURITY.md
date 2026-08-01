# Security Policy

TaskFence enforces a deterministic, application-hook policy on coding-agent
tool calls. It is an **application-layer guardrail**, not an operating-system
isolation boundary. This document describes what the project supports, how to
report vulnerabilities, and the precise boundary of the guarantees it can and
cannot provide.

## Supported versions

TaskFence is pre-1.0 software. Security fixes are provided for the current
`0.1.x` line only.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1.0 | No        |

## Reporting a vulnerability

**Do not open a public GitHub issue** for a suspected security vulnerability.

Report vulnerabilities privately through GitHub Security Advisories:

1. Open <https://github.com/iannellomarco/taskfence/security/advisories/new>.
2. Choose *"Report a vulnerability"*.
3. Provide a description, reproduction steps, the runtime/adapter involved,
   and the TaskFence version.

This creates a private advisory visible only to repository maintainers, who
will acknowledge receipt and coordinate a fix and disclosure with you.

If GitHub Security Advisories are unavailable to you, contact a maintainer
through any other private channel listed on the repository profile. A direct
public mention is acceptable **only** to request a private channel — never to
disclose exploit details.

## Responsible disclosure

We ask reporters to:

- Provide a clear, reproducible description of the issue.
- Allow reasonable time for triage, fix, and coordinated disclosure before any
  public disclosure.
- Avoid accessing or altering data that does not belong to you.
- Refrain from degrading service for other users.

We commit to:

- Acknowledging reports promptly.
- Investigating in good faith and keeping reporters informed of progress.
- Coordinating a fix and credit (if desired) upon resolution.

No specific response-time SLA is promised; pre-1.0 maintenance is best-effort
and depends on maintainer availability.

## Threat boundary (what TaskFence is)

TaskFence is a **deterministic policy gate** installed at the application-tool
hook boundary of a supported coding agent. Within that boundary it provides:

- A **frozen, exact contract** declared before work begins: the approved paths
  an agent may write, create, or delete, the commands it may run, and the paths
  that are explicitly protected. The contract body is strict JSON behind a
  `taskfence-contract` fence; unknown or duplicate keys are rejected.
- **Read-only tolerance**: when no contract is active, read-only tool calls are
  allowed and project mutations/commands are denied. The Claude Code adapter
  has one pre-engine exception: while the host reports Plan Mode, it defers only
  Claude Code's bounded native plan-file write to the host's own gate. The first
  destination must be absent and is claimed by its basename in a safe hidden
  directory on the same plans filesystem, which arbitrates case and Unicode
  aliases while the record binds the canonical root and host session. Later
  writes must reuse that binding, and the safe default plans directory must
  resolve outside the project. That write grants no project authority. Project
  mutations and commands require an active contract and bound host authority.
- **Checkpoint before activation**: before a contract becomes active, a
  checkpoint of the project tree is staged and committed so the work can be
  rolled back.
- **One pending mutation at a time**, correlated by a hash of the raw host input
  and reconciled against the runtime, session, call ID, input hash, and reported
  outcome after the tool returns. Missing, failed, uncertain, or mismatched
  post-tool reconciliation fails closed.
- **Rollback** that restores the checkpointed tree while preserving the
  project's `.git` directory.
- A **tamper-evident receipt ledger**: every decision and lifecycle transition
  is written as a hash-chained receipt anchored into durable project state,
  which can be verified with `taskfence receipts verify`.

## Non-goals (what TaskFence is *not*)

The following are **explicitly out of scope** and must not be relied upon:

- **No OS or kernel sandbox.** TaskFence runs as a normal process under your own
  user account. It does not use containers, chroots, namespaces, seatbelts, or
  any privileged isolation mechanism.
- **No protection from same-user malicious processes.** Any process, shell,
  terminal, editor, language server, debugger, or agent extension running as
  your user can read or modify the project tree, the TaskFence state, or the
  agent's own configuration outside of TaskFence's view. TaskFence cannot
  reliably prevent, detect, or contain such activity.
- **No protection from transitive behavior inside approved commands.** Once you
  approve a command in the contract, TaskFence permits that exact argument
  vector to run. Whatever that command itself does — including arbitrary work
  performed by its dependencies, build scripts, lifecycle hooks, or spawned
  children — is **outside TaskFence's containment** and runs with your full
  user privileges. Approve commands only when you trust them and their supply
  chain.
- **No replacement for the host runtime's native permission system.** TaskFence
  mediates the tool-hook boundary; it does not subsume or bypass the agent
  runtime's own approvals or operating-system access controls.
- **No guarantee of universal child-agent inheritance.** TaskFence binds
  authority to the host sessions it is configured for. Whether a given runtime
  propagates hooks/authority to spawned child agents, subagents, or
  out-of-process workers depends on that runtime's behavior and is not
  guaranteed by TaskFence.
- **No protection against a compromised or buggy agent runtime** that fails to
  invoke hooks, invokes them out of order, or bypasses them entirely. TaskFence
  can only act on the tool calls the runtime actually routes through it.
- **No confidentiality guarantee for approved paths.** A contract's `protected`
  list prevents *mutations* to those paths under an active contract; it is not
  an access-control list for reads or a secrecy mechanism.

## Data and state handling

TaskFence stores its state on the local filesystem under your user account:

- **Project state** lives in a per-project directory derived from the canonical
  project root. State directories are created with mode `0700` (owner-only) and
  state files must be regular files owned by the current user with a single
  link; `O_NOFOLLOW` is used to refuse symlinks. These are tamper-resistance
  measures for *accidental* and *same-user* mistakes, **not** a defense against
  a malicious same-user process, which can modify or replace them at will.
- **Checkpoints** are content-addressed snapshots of the project tree used to
  support rollback. They live alongside the state directory.
- **Receipts** are append-only, hash-chained records of decisions and lifecycle
  events. They include normalized tool-call metadata, **not** raw tool content
  for content-bearing keys; known-secret patterns (tokens, keys, credentials,
  `Bearer`/`Basic` headers, URI-embedded credentials, known token formats) are
  redacted to `[REDACTED]` before being written. Redaction is best-effort
  pattern matching and is **not** a guarantee that no sensitive value will ever
  appear; treat the receipt ledger as potentially containing sensitive data and
  protect it accordingly.
- **Nothing is transmitted off the local machine** by TaskFence itself. There
  is no telemetry, crash reporting, or phone-home in the core library or CLI.
  Commands you approve and run may, of course, perform network access on their
  own.

## Runtime-host limitations

TaskFence depends on the coding-agent runtime to invoke its hooks correctly and
at the right times. Specifically:

- TaskFence can only observe and decide on tool calls that the runtime
  **routes through the installed hook**. Tool calls that bypass the hook are
  invisible to TaskFence.
- The exact hook contract, ordering semantics, payload shape, and whether hooks
  fire for a given tool/action are defined by **each runtime** (Claude Code,
  Codex CLI, OpenCode, OMP, Pi), not by TaskFence. TaskFence's adapters
  translate each runtime's hook format into a common decision; they cannot make
  a runtime invoke hooks it does not support.
- A runtime that is compromised, misconfigured, or itself malicious can fail to
  call hooks, call them out of order, or ignore their decisions. TaskFence
  cannot defend against its own host being subverted.

Run `taskfence doctor [claude|codex|opencode|omp|pi|all]` to inspect adapter
loadability and recent host-heartbeat status for a configured runtime.

## Hardening recommendations

- Run agents on a machine and user account whose privilege level you accept an
  agent having. Do not assume TaskFence contains a privileged agent to a
  lesser-privileged context — it cannot.
- Review every entry in a contract's `commands` before approving. Treat an
  approved command as running with your full user privileges, including
  everything its dependencies and lifecycle scripts do.
- Keep the `protected` list focused on paths whose accidental mutation you want
  to prevent; do not treat it as a secrecy or read-access control.
- Commit or checkpoint externally any work you cannot afford to lose before
  activating or rolling back a contract.
- Do not store secrets in locations that approved commands or the agent can
  read if you do not want them exposed.

## Scope of fixes

In-scope for a security fix: a defect in TaskFence's source whereby, under a
correctly behaving host runtime, the enforcement it claims to provide fails —
for example, a mutation or command permitted outside the active contract,
incorrect rollback, a broken receipt chain, or secret material written to the
receipt ledger in clear text despite matching a redaction pattern.

Out of scope: the inherent limitations listed under *Non-goals* above,
including same-user process activity, transitive command behavior, and host
runtimes that fail to invoke hooks. These are design boundaries, not bugs.
