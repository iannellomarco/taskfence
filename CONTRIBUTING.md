# Contributing to TaskFence

Thank you for your interest in contributing to TaskFence. This document covers
the development setup, the gates a change must pass, the test philosophy, and
the contract/security invariants every contribution must preserve.

TaskFence is a security-relevant tool: it mediates coding-agent tool calls at
the application-hook boundary. Contributions that touch enforcement, state,
checkpoints, or receipts carry elevated review weight.

## Prerequisites

- **Node.js >= 20** (matches `engines.node` in `package.json`; the build target
  is `node20`).
- **npm** is the package manager used by the project (`packageManager` field in
  the contract accepts `npm`, `pnpm`, `yarn`, `bun`, or `none`, but the
  repository itself is developed with npm).

## Setup

```sh
git clone https://github.com/iannellomarco/taskfence.git
cd taskfence
npm ci
```

After install, build once so the CLI and adapters exist:

```sh
npm run build
```

## Development gates

Every change should pass these gates. They mirror the `scripts` in
`package.json`:

| Gate | Command | Purpose |
| ---- | ------- | ------- |
| Typecheck | `npm run check` | `tsc --noEmit`; the source must typecheck cleanly. |
| Test | `npm run test` | `vitest run`; runs the full Vitest suite. |
| Build | `npm run build` | `tsup`; produces `dist/` (ESM, `node20`, with `.d.ts`). |
| Artifact drift | `npm run check:artifact` | Verifies committed `dist/` matches a clean rebuild (no drift). |
| Package | `npm run test:package` | Packaging-specific tests (`test/packaging.test.ts`). |

For everyday iteration, typecheck and run the focused tests for the area you
changed. Run the full suite and the build/artifact/package gates before
requesting review.

## Focused test philosophy

The test suite is intentionally thorough on the security-critical paths and
light elsewhere. When you change behavior:

- **Add or update tests that defend an observable contract** — a decision
  code, a state transition, a rollback outcome, a receipt-chain property, a
  path-resolution rule. A test should fail on a plausible bug, not merely
  exercise plumbing.
- Prefer deterministic, isolated tests. The existing suite uses temporary
  project roots and exercises real filesystem state; follow that pattern via
  the helpers in `test/helpers.ts`.
- Do not add tests that assert on source text, incidental formatting, or
  internal call sequences — assert on behavior and outcomes.
- Boundary cases matter: missing/failed/uncertain/mismatched post-tool
  reconciliation must fail closed; rollback must preserve `.git`; the receipt
  chain must remain verifiable.

The full suite currently spans the test files under `test/` covering contract
compilation/validation, tool and command policy, path policy, checkpoints,
rollback, the CAS store, state durability and locking, transaction recovery,
receipts (including hardening and verification), CLI receipts, session
authority, adapter behavior, the installer, and packaging.

## Contract invariants (must not be broken)

Every contribution that touches contract handling, policy, state, checkpoints,
or receipts must preserve these invariants. They are the core of TaskFence's
guarantees:

1. **Exact, frozen contract.** The plan must contain exactly one fenced block
   whose opening line is exactly ```` ```taskfence-contract ````. Its body is
   one strict JSON object with exactly the schema fields (`version`, `write`,
   `create`, `delete`, `protected`, `commands`, `packageManager`) and no
   additional or duplicate keys. `packageManager` must be one of `npm`,
   `pnpm`, `yarn`, `bun`, `none`.
2. **Read-only tolerance, fail closed.** With no active contract, read-only
   calls are allowed and mutations/commands are denied. Mutations and commands
   require an active contract and bound host authority. Missing, failed,
   uncertain, or mismatched post-tool reconciliation denies later mutations.
3. **Checkpoint before activation.** A contract is staged and a checkpoint
   created/committed *before* the contract becomes active. If checkpoint
   creation fails, the contract is not activated.
4. **One pending mutation.** At most one mutation is pending at a time,
   correlated by a hash of the raw host input and reconciled against the
   runtime, session, call ID, input hash, and reported outcome after the tool
   returns.
5. **Rollback preserves `.git`.** Rolling back restores the checkpointed tree
   but never removes or rewrites the project's `.git` directory.
6. **Tamper-evident receipts.** Every decision and lifecycle transition is
   recorded as a hash-chained receipt anchored into durable project state, and
   `taskfence receipts verify` must detect tampering or gaps in the chain.
7. **Same-user secure state.** State directories are mode `0700`; state files
   are current-user-owned regular files with a single link, opened with
   `O_NOFOLLOW`.

## Security invariants

- **Never weaken fail-closed behavior.** If you are unsure whether an outcome
  is allowed, the answer must be *deny*.
- **Never write raw secret material to the receipt ledger.** Known-secret
  patterns are redacted before persistence; changes to metadata handling must
  not regress this.
- **Never add a code path that activates a contract without a successful
  checkpoint.**
- **Never introduce OS-sandbox, universal-inheritance, or process-isolation
  claims** into code, docs, or user-facing strings. TaskFence is an
  application-layer guardrail; see `SECURITY.md` for the precise boundary.

If your change could affect security posture, describe how in your PR and
confirm the relevant tests still pass (or add new ones).

## Adapter source verification

TaskFence ships adapters for multiple runtimes (Claude Code, Codex CLI,
OpenCode, OMP, Pi). Each adapter translates that runtime's hook format into
TaskFence's common decision model. The hook contract — payload shape, ordering,
which tools fire hooks, whether subagents/child processes inherit hooks — is
defined by **each runtime**, and runtimes evolve independently of TaskFence.

When you change an adapter:

- **Verify behavior against the current runtime source/docs**, not against
  assumptions or memory. Runtime truth lives in the runtime's own
  documentation and current adapter source; do not infer hook semantics.
- Prefer changes that are robust to payload variation and that fail closed on
  unknown/uncertain input.
- Document, in the PR, which runtime and version you verified against.
- `taskfence doctor <runtime>` performs an adapter self-test and reports recent
  host-heartbeat status; use it to confirm an adapter loads.

## Coding standards

- **TypeScript**, ESM (`"type": "module"`), targeting `node20`. Follow the
  style of the surrounding code.
- Keep dependencies minimal. The only runtime dependency is `zod`.
- Prefer narrow, composable functions. Avoid needless allocations and copies.
- Do not leave dead code, commented-out blocks, or `TODO` markers in landed
  code.

## Commit and pull request standards

- **Focused PRs.** One logical change per PR. Keep diffs reviewable.
- **Clear description.** State what changed, why, and which gates you ran.
  Note any security-relevant implications.
- **Tests included** for behavioral changes, defending the observable contract.
- **Pass the gates** locally: `npm run check`, `npm run test`, `npm run build`,
  `npm run check:artifact`, `npm run test:package`.
- **Conventional, imperative commit messages** (e.g., "deny mutations when
  post-tool reconciliation is uncertain"). Keep the subject line short.

## DCO / CLA

TaskFence does **not** require a Developer Certificate of Origin sign-off or a
Contributor License Agreement at this time. Contributions are made under the
MIT License (see `LICENSE`). If a DCO/CLA policy is adopted in the future, it
will be documented here and announced.

## Release process (overview)

Releases are maintained by repository maintainers and follow roughly:

1. All gates pass on `main` (`check`, `test`, `build`, `check:artifact`,
   `test:package`).
2. `dist/` is rebuilt and confirmed free of artifact drift.
3. The version is bumped in `package.json` (and `package-lock.json`) following
   [Semantic Versioning](https://semver.org/). During the `0.1.x` line, the
   supported-version table in `SECURITY.md` governs which line receives fixes.
4. A git tag is created for the release and the changelog is updated.

Do not publish release artifacts from a contributor fork; coordinate releases
with a maintainer.

## Getting help

Open a GitHub issue with the `question` or `discussion` label for design
questions or clarifications before starting non-trivial work. For anything
security-sensitive, follow `SECURITY.md` instead of opening a public issue.
