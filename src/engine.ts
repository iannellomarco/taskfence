import { canonicalStringify, sha256 } from "./contract/canonical.js";
import { compileContract } from "./contract/compile.js";
import { createCheckpoint } from "./checkpoint/create.js";
import {
  compareCheckpoint,
  type CheckpointComparison,
} from "./checkpoint/compare.js";
import { rollbackCheckpoint } from "./checkpoint/rollback.js";
import { semanticContractDelta } from "./control.js";
import { evaluateToolCall } from "./policy/evaluate.js";
import { normalizeToolCall } from "./policy/tools.js";
import {
  commitStateAndReceiptsUnderLock,
  type ReceiptInput,
} from "./receipts/ledger.js";
import { canonicalStateRoot, stateLayout } from "./state/layout.js";
import { withProjectLock } from "./state/lock.js";
import { createProjectState, isAuthorityIdentifier } from "./state/model.js";
import { loadProjectState } from "./state/store.js";
import { transition } from "./state/transitions.js";
import { dirname, relative, resolve, sep } from "node:path";
import type {
  CheckpointManifest,
  ContractState,
  Decision,
  NormalizedToolCall,
  PendingMutation,
  ProjectState,
  RuntimeName,
} from "./types.js";

const NO_CHECKPOINT_HASH = sha256(canonicalStringify(null));
export interface TrustedApprovalIdentity {
  runtime: "claude" | "omp" | "pi";
  sessionId: string;
}

export interface SessionAuthorityClaimInput {
  root: string;
  runtime: RuntimeName;
  sessionId: string;
  parentSessionId?: string | null;
  expectedContractHash?: string;
  expectedPlanHash?: string;
}


export interface PreToolCallInput {
  runtime: RuntimeName;
  toolName: string;
  input: unknown;
  cwd: string;
  sessionId?: string;
  parentSessionId?: string | null;
  callId?: string;
}

export interface PreToolCallResult {
  decision: Decision;
  inputHash: string | null;
  root: string;
  status: ContractState;
}

export interface PostToolCallInput {
  root: string;
  runtime: RuntimeName;
  sessionId: string;
  callId: string;
  inputHash: string;
  success: boolean;
  observedViolation?: boolean | string;
}

function eventContext(state: ProjectState, at = new Date().toISOString()) {
  return {
    expectedGeneration: state.generation,
    expectedRevision: state.revision,
    at,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length !== 0) {
    return error.message;
  }
  return "Unknown engine failure";
}

function requireLoadedState(state: ProjectState | null): ProjectState {
  if (state === null) throw new Error("No TaskFence project state exists for this root");
  return state;
}

interface StateBoundary {
  readonly cwd: string;
  readonly root: string;
  readonly state: ProjectState | null;
}

function isStateDirectoryBoundary(error: unknown): boolean {
  return error instanceof Error &&
    error.message.startsWith("TaskFence state directory must be outside the project root:");
}

async function discoverStateBoundary(cwd: string): Promise<StateBoundary> {
  const canonicalCwd = await canonicalStateRoot(cwd);
  let candidate = canonicalCwd;
  while (true) {
    let state: ProjectState | null;
    try {
      state = await withProjectLock(candidate, () => loadProjectState(candidate));
    } catch (error) {
      if (isStateDirectoryBoundary(error)) break;
      throw error;
    }
    if (state !== null) {
      return { cwd: canonicalCwd, root: state.root, state };
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return { cwd: canonicalCwd, root: canonicalCwd, state: null };
}

function rebaseMutationToContract(
  call: NormalizedToolCall,
  contractRoot: string,
): NormalizedToolCall {
  if (call.kind !== "mutation") return call;
  return {
    ...call,
    cwd: contractRoot,
    operations: call.operations.map((operation) => ({
      ...operation,
      target: relative(
        contractRoot,
        resolve(call.cwd, operation.target),
      ).split(sep).join("/"),
    })),
  };
}

function requireReceiptState(state: ProjectState): asserts state is ProjectState & {
  contract: NonNullable<ProjectState["contract"]>;
} {
  if (state.contract === null || state.revision < 1) {
    throw new Error("A persisted contract is required before writing a receipt");
  }
}

function receiptInput(
  state: ProjectState,
  input: Omit<
    ReceiptInput,
    "contractHash" | "checkpointHash" | "revision" | "timestamp"
  >,
): ReceiptInput {
  requireReceiptState(state);
  return {
    ...input,
    timestamp: state.updatedAt,
    contractHash: state.contract.contractHash,
    checkpointHash: state.checkpoint?.hash ?? NO_CHECKPOINT_HASH,
    revision: state.revision,
  };
}

function lifecycleReceipt(
  before: ProjectState,
  after: ProjectState,
  action: string,
): ReceiptInput {
  return receiptInput(after, {
    event: "lifecycle",
    runtime: null,
    sessionId: null,
    callId: null,
    toolName: null,
    inputHash: null,
    decision: null,
    lifecycle: { from: before.status, to: after.status },
    resultHash: sha256(canonicalStringify({
      generation: after.generation,
      reason: after.reason,
      status: after.status,
    })),
    metadata: { action },
  });
}
function authorityReceipt(
  state: ProjectState,
  action: "bind" | "delegate",
  runtime: RuntimeName,
  sessionId: string,
  parentSessionId: string | null,
): ReceiptInput {
  return receiptInput(state, {
    event: "authority",
    runtime,
    sessionId,
    callId: null,
    toolName: null,
    inputHash: null,
    decision: null,
    lifecycle: null,
    resultHash: sha256(canonicalStringify(state.authority)),
    metadata: {
      action: `authority.${action}`,
      parentSessionId,
    },
  });
}

function authorityDenied(reason: string): Decision {
  return { allowed: false, code: "deny_authority", reason };
}

type AuthorityPreflightResult =
  | { state: ProjectState; decision: null }
  | { state: ProjectState; decision: Decision };

async function preflightAuthorityUnderLock(
  state: ProjectState,
  input: {
    runtime: RuntimeName;
    sessionId?: string;
    parentSessionId?: string | null;
  },
): Promise<AuthorityPreflightResult> {
  if (!isAuthorityIdentifier(input.sessionId)) {
    return {
      state,
      decision: authorityDenied(
        "TaskFence requires a non-empty, bounded, NUL-free host session identity",
      ),
    };
  }
  if (input.runtime === "opencode" && input.parentSessionId === undefined) {
    return {
      state,
      decision: authorityDenied(
        "OpenCode session ancestry could not be verified by the host",
      ),
    };
  }
  if (
    input.parentSessionId !== undefined &&
    input.parentSessionId !== null &&
    !isAuthorityIdentifier(input.parentSessionId)
  ) {
    return {
      state,
      decision: authorityDenied("Host session ancestry is malformed"),
    };
  }

  const authority = state.authority;
  if (authority === null) {
    if (typeof input.parentSessionId === "string") {
      return {
        state,
        decision: authorityDenied(
          "A child session cannot claim an unbound TaskFence contract",
        ),
      };
    }
    const bound = transition(state, {
      type: "bind_authority",
      ...eventContext(state),
      runtime: input.runtime,
      sessionId: input.sessionId,
    });
    const committed = await commitStateAndReceiptsUnderLock(
      bound.root,
      state,
      bound,
      [authorityReceipt(bound, "bind", input.runtime, input.sessionId, null)],
    );
    return { state: committed.state, decision: null };
  }

  if (authority.runtime !== input.runtime) {
    return {
      state,
      decision: authorityDenied(
        `TaskFence is bound to runtime ${authority.runtime}, not ${input.runtime}`,
      ),
    };
  }

  const authorized = authority.sessions.find(
    (session) => session.sessionId === input.sessionId,
  );
  if (authorized !== undefined) {
    if (
      input.parentSessionId !== undefined &&
      input.parentSessionId !== authorized.parentSessionId
    ) {
      return {
        state,
        decision: authorityDenied(
          "Host-reported session ancestry does not match durable authority",
        ),
      };
    }
    return { state, decision: null };
  }

  if (
    typeof input.parentSessionId !== "string" ||
    !authority.sessions.some(
      (session) => session.sessionId === input.parentSessionId,
    )
  ) {
    return {
      state,
      decision: authorityDenied(
        "Session is not authorized and its parent is missing or unauthorized",
      ),
    };
  }

  const delegated = transition(state, {
    type: "delegate_session",
    ...eventContext(state),
    runtime: input.runtime,
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
  });
  const committed = await commitStateAndReceiptsUnderLock(
    delegated.root,
    state,
    delegated,
    [
      authorityReceipt(
        delegated,
        "delegate",
        input.runtime,
        input.sessionId,
        input.parentSessionId,
      ),
    ],
  );
  return { state: committed.state, decision: null };
}


export function hashNormalizedToolCall(call: NormalizedToolCall): string {
  const common = {
    runtime: call.runtime,
    toolName: call.toolName,
    cwd: call.cwd,
    sessionId: call.sessionId ?? null,
    callId: call.callId ?? null,
    kind: call.kind,
  };
  const payload = call.kind === "command"
    ? { ...common, command: call.command }
    : call.kind === "mutation"
      ? { ...common, operations: call.operations }
      : call.kind === "unknown" || call.kind === "malformed"
        ? { ...common, reason: call.reason }
        : common;
  return sha256(canonicalStringify(payload));
}

export function hashRawToolCall(input: PreToolCallInput): string {
  return sha256(canonicalStringify({
    runtime: input.runtime,
    toolName: input.toolName,
    cwd: input.cwd,
    sessionId: input.sessionId ?? null,
    callId: input.callId ?? null,
    input: input.input,
  }));
}

function inactiveDecision(state: ProjectState): Decision {
  if (state.status === "mutation_pending") {
    return {
      allowed: false,
      code: "deny_pending_mutation",
      reason: "A prior mutation is still pending post-tool verification",
    };
  }
  if (state.status === "violated" || state.status === "recovery_required") {
    return {
      allowed: false,
      code: "deny_recovery_required",
      reason: "Contract recovery or rollback is required before another mutation",
    };
  }
  return {
    allowed: false,
    code: "deny_contract_inactive",
    reason: `The TaskFence contract is not active (state: ${state.status})`,
  };
}

function shouldReceiptDecision(state: ProjectState): boolean {
  return state.contract !== null &&
    state.checkpoint !== null &&
    [
      "active",
      "mutation_pending",
      "violated",
      "recovery_required",
      "rolling_back",
    ].includes(state.status);
}

export async function claimSessionAuthority(
  input: SessionAuthorityClaimInput,
): Promise<ProjectState> {
  return withProjectLock(input.root, async () => {
    const current = requireLoadedState(await loadProjectState(input.root));
    if (current.status !== "active" || current.contract === null) {
      throw new Error(
        "Session authority can only be claimed for an active TaskFence contract",
      );
    }
    if (
      (
        input.expectedContractHash !== undefined &&
        input.expectedContractHash !== current.contract.contractHash
      ) ||
      (
        input.expectedPlanHash !== undefined &&
        input.expectedPlanHash !== current.contract.planHash
      )
    ) {
      throw new Error(
        "The active TaskFence contract does not match the host-verified plan",
      );
    }
    const authority = await preflightAuthorityUnderLock(current, input);
    if (authority.decision !== null) {
      throw new Error(authority.decision.reason);
    }
    return authority.state;
  });
}

export async function approvePlan(
  planText: string,
  root: string,
  identity?: TrustedApprovalIdentity,
): Promise<ProjectState> {
  if (
    identity !== undefined &&
    (
      !["claude", "omp", "pi"].includes(identity.runtime) ||
      !isAuthorityIdentifier(identity.sessionId)
    )
  ) {
    throw new Error("Trusted approval identity is malformed");
  }
  const contract = compileContract(planText, root);
  let checkpointingState: ProjectState;

  checkpointingState = await withProjectLock(contract.root, async () => {
    const layout = await stateLayout(contract.root);
    const durable = await loadProjectState(layout.canonicalRoot);
    const initial = durable ??
      createProjectState(
        layout.canonicalRoot,
        layout.rootHash,
        new Date().toISOString(),
      );
    let staged = transition(initial, {
      type: "stage",
      ...eventContext(initial),
      contract,
      revision: initial.revision + 1,
    });
    staged = (
      await commitStateAndReceiptsUnderLock(
        layout.canonicalRoot,
        durable,
        staged,
        [lifecycleReceipt(initial, staged, "approve.stage")],
      )
    ).state;
    if (identity !== undefined) {
      const authority = await preflightAuthorityUnderLock(staged, identity);
      if (authority.decision !== null) {
        throw new Error(authority.decision.reason);
      }
      staged = authority.state;
    }

    let checkpointing = transition(staged, {
      type: "begin_checkpoint",
      ...eventContext(staged),
    });
    checkpointing = (
      await commitStateAndReceiptsUnderLock(
        layout.canonicalRoot,
        staged,
        checkpointing,
        [lifecycleReceipt(staged, checkpointing, "approve.checkpoint.begin")],
      )
    ).state;
    return checkpointing;
  });

  let checkpoint: CheckpointManifest;
  try {
    checkpoint = await createCheckpoint(checkpointingState.root);
  } catch (error) {
    const reason = errorMessage(error);
    try {
      await withProjectLock(checkpointingState.root, async () => {
        const current = requireLoadedState(
          await loadProjectState(checkpointingState.root),
        );
        const failed = transition(current, {
          type: "checkpoint_failed",
          ...eventContext(current),
          reason,
        });
        await commitStateAndReceiptsUnderLock(
          failed.root,
          current,
          failed,
          [
            lifecycleReceipt(current, failed, "approve.checkpoint.failed"),
            receiptInput(failed, {
              event: "checkpoint",
              runtime: null,
              sessionId: null,
              callId: null,
              toolName: null,
              inputHash: null,
              decision: null,
              lifecycle: { from: current.status, to: failed.status },
              resultHash: null,
              metadata: { outcome: "failed", reason },
            }),
          ],
        );
      });
    } catch (persistenceError) {
      throw new AggregateError(
        [error, persistenceError],
        "Checkpoint creation failed and the failure state could not be persisted",
      );
    }
    throw error;
  }

  return withProjectLock(checkpointingState.root, async () => {
    const current = requireLoadedState(
      await loadProjectState(checkpointingState.root),
    );
    const active = transition(current, {
      type: "checkpoint_succeeded",
      ...eventContext(current),
      checkpoint,
    });
    return (
      await commitStateAndReceiptsUnderLock(
        active.root,
        current,
        active,
        [
          lifecycleReceipt(
            current,
            active,
            "approve.checkpoint.succeeded",
          ),
          receiptInput(active, {
            event: "checkpoint",
            runtime: null,
            sessionId: null,
            callId: null,
            toolName: null,
            inputHash: null,
            decision: null,
            lifecycle: { from: current.status, to: active.status },
            resultHash: checkpoint.hash,
            metadata: {
              outcome: "succeeded",
              totalBytes: checkpoint.totalBytes,
              totalFiles: checkpoint.totalFiles,
            },
          }),
        ],
      )
    ).state;
  });
}

export async function amendPlan(
  planText: string,
  root: string,
): Promise<ProjectState> {
  const contract = compileContract(planText, root);
  return withProjectLock(contract.root, async () => {
    const current = requireLoadedState(await loadProjectState(contract.root));
    const amended = transition(current, {
      type: "amend",
      ...eventContext(current),
      contract,
      revision: current.revision + 1,
    });
    return (
      await commitStateAndReceiptsUnderLock(
        amended.root,
        current,
        amended,
        [
          receiptInput(amended, {
            event: "amendment",
            runtime: null,
            sessionId: null,
            callId: null,
            toolName: null,
            inputHash: null,
            decision: null,
            lifecycle: { from: current.status, to: amended.status },
            resultHash: amended.contract?.contractHash ?? null,
            metadata: {
              delta: semanticContractDelta(current.contract, contract),
              previousContractHash: current.contract?.contractHash ?? null,
            },
          }),
        ],
      )
    ).state;
  });
}

export async function getStatus(root: string): Promise<ProjectState> {
  const boundary = await discoverStateBoundary(root);
  return withProjectLock(boundary.root, async () => {
    const layout = await stateLayout(boundary.root);
    const recovered = await loadProjectState(layout.canonicalRoot);
    return recovered ??
      createProjectState(
        layout.canonicalRoot,
        layout.rootHash,
        new Date().toISOString(),
      );
  });
}

export async function preToolCall(
  input: PreToolCallInput,
): Promise<PreToolCallResult> {
  const boundary = await discoverStateBoundary(input.cwd);
  const normalized = normalizeToolCall(
    input.runtime,
    input.toolName,
    input.input,
    boundary.cwd,
    input.sessionId,
    input.callId,
  );

  return withProjectLock(boundary.root, async () => {
    const layout = await stateLayout(boundary.root);
    let state = await loadProjectState(layout.canonicalRoot);
    if (state === null) {
      const decision = evaluateToolCall(null, normalized);
      return {
        decision,
        inputHash: null,
        root: layout.canonicalRoot,
        status: "absent",
      };
    }
    let authorityDecision: Decision | null = null;
    if (state.status === "active" || state.authority !== null) {
      const authority = await preflightAuthorityUnderLock(state, input);
      state = authority.state;
      authorityDecision = authority.decision;
    }


    const evaluated = state.contract === null
      ? normalized
      : rebaseMutationToContract(normalized, state.contract.root);
    let decision: Decision;
    if (authorityDecision !== null) {
      decision = authorityDecision;
    } else if (evaluated.kind === "read") {
      decision = evaluateToolCall(null, evaluated);
    } else if (evaluated.kind === "unknown" || evaluated.kind === "malformed") {
      decision = evaluateToolCall(state.status === "active" ? state.contract : null, evaluated);
    } else if (state.status !== "active" || state.contract === null) {
      decision = inactiveDecision(state);
    } else {
      decision = evaluateToolCall(state.contract, evaluated);
    }

    if (
      decision.allowed &&
      (evaluated.kind === "command" || evaluated.kind === "mutation") &&
      (
        typeof evaluated.sessionId !== "string" ||
        evaluated.sessionId.length === 0 ||
        typeof evaluated.callId !== "string" ||
        evaluated.callId.length === 0
      )
    ) {
      decision = {
        allowed: false,
        code: "deny_malformed_tool",
        reason: "Allowed commands and mutations require non-empty sessionId and callId values",
      };
    }

    let receiptState = state;
    let inputHash: string | null = null;
    let lifecycle: { from: ContractState; to: ContractState } | null = null;
    if (
      decision.allowed &&
      (evaluated.kind === "command" || evaluated.kind === "mutation")
    ) {
      inputHash = hashRawToolCall(input);
      const pendingMutation: PendingMutation = {
        runtime: evaluated.runtime,
        sessionId: evaluated.sessionId!,
        callId: evaluated.callId!,
        inputHash,
        startedAt: new Date().toISOString(),
        contractHash: state.contract!.contractHash,
        revision: state.revision,
      };
      receiptState = transition(state, {
        type: "begin_mutation",
        ...eventContext(state, pendingMutation.startedAt),
        pendingMutation,
      });
      lifecycle = { from: state.status, to: receiptState.status };
    }

    if (shouldReceiptDecision(state)) {
      receiptState = (
        await commitStateAndReceiptsUnderLock(
          receiptState.root,
          state,
          receiptState,
          [
            receiptInput(receiptState, {
              event: "decision",
              runtime: evaluated.runtime,
              sessionId: evaluated.sessionId ?? null,
              callId: evaluated.callId ?? null,
              toolName: evaluated.toolName,
              inputHash,
              decision,
              lifecycle,
              resultHash: null,
              metadata: { kind: evaluated.kind },
            }),
          ],
        )
      ).state;
    } else if (receiptState !== state) {
      throw new Error("A lifecycle transition cannot commit without a receipt");
    }

    return {
      decision,
      inputHash,
      root: state.root,
      status: receiptState.status,
    };
  });
}

export async function postToolCall(
  input: PostToolCallInput,
): Promise<ProjectState> {
  return withProjectLock(input.root, async () => {
    const current = requireLoadedState(await loadProjectState(input.root));
    if (current.status !== "mutation_pending" || current.pendingMutation === null) {
      throw new Error("No pending mutation matches this post-tool call");
    }
    const pending = current.pendingMutation;
    if (
      !isAuthorityIdentifier(input.sessionId) ||
      pending.runtime !== input.runtime ||
      pending.sessionId !== input.sessionId ||
      current.authority === null ||
      current.authority.runtime !== input.runtime ||
      !current.authority.sessions.some(
        (session) => session.sessionId === input.sessionId,
      )
    ) {
      throw new Error(
        "Post-tool runtime or session does not match durable TaskFence authority",
      );
    }

    const identity = { callId: input.callId, inputHash: input.inputHash };
    let updated: ProjectState;
    let action: string;
    const violationReason = input.observedViolation === true
      ? "Tool call reported an observed contract violation"
      : typeof input.observedViolation === "string" &&
          input.observedViolation.trim().length !== 0
        ? input.observedViolation
        : null;
    if (violationReason !== null) {
      updated = transition(current, {
        type: "mutation_violated",
        ...eventContext(current),
        ...identity,
        reason: violationReason,
      });
      action = "tool.mutation_violated";
    } else if (input.success) {
      updated = transition(current, {
        type: "mutation_completed",
        ...eventContext(current),
        ...identity,
      });
      action = "tool.mutation_completed";
    } else {
      updated = transition(current, {
        type: "mutation_uncertain",
        ...eventContext(current),
        ...identity,
        reason: "Tool call reported failure; mutation outcome is uncertain",
      });
      action = "tool.mutation_uncertain";
    }
    return (
      await commitStateAndReceiptsUnderLock(
        updated.root,
        current,
        updated,
        [
          receiptInput(updated, {
            event: "lifecycle",
            runtime: pending.runtime,
            sessionId: pending.sessionId,
            callId: pending.callId,
            toolName: null,
            inputHash: pending.inputHash,
            decision: null,
            lifecycle: { from: current.status, to: updated.status },
            resultHash: sha256(canonicalStringify({
              callId: pending.callId,
              inputHash: pending.inputHash,
              success: input.success,
              reason: updated.reason,
              status: updated.status,
            })),
            metadata: { action },
          }),
        ],
      )
    ).state;
  });
}

export async function previewRollback(
  root: string,
): Promise<CheckpointComparison> {
  const state = await withProjectLock(root, async () =>
    requireLoadedState(await loadProjectState(root))
  );
  if (state.checkpoint === null) {
    throw new Error("Rollback requires a verified checkpoint");
  }
  return compareCheckpoint(state.root, state.checkpoint);
}

export async function rollbackPlan(root: string): Promise<ProjectState> {
  const rollingBack = await withProjectLock(root, async () => {
    const current = requireLoadedState(await loadProjectState(root));
    if (current.status === "rolling_back") return current;
    const updated = transition(current, {
      type: "begin_rollback",
      ...eventContext(current),
    });
    return (
      await commitStateAndReceiptsUnderLock(
        updated.root,
        current,
        updated,
        [lifecycleReceipt(current, updated, "rollback.begin")],
      )
    ).state;
  });
  if (rollingBack.checkpoint === null) {
    throw new Error("Rollback entered without a checkpoint");
  }

  try {
    await rollbackCheckpoint(rollingBack.root, rollingBack.checkpoint);
  } catch (error) {
    const reason = errorMessage(error);
    try {
      await withProjectLock(rollingBack.root, async () => {
        const current = requireLoadedState(
          await loadProjectState(rollingBack.root),
        );
        const failed = transition(current, {
          type: "rollback_failed",
          ...eventContext(current),
          reason,
        });
        await commitStateAndReceiptsUnderLock(
          failed.root,
          current,
          failed,
          [
            lifecycleReceipt(current, failed, "rollback.failed"),
            receiptInput(failed, {
              event: "rollback",
              runtime: null,
              sessionId: null,
              callId: null,
              toolName: null,
              inputHash: null,
              decision: null,
              lifecycle: { from: current.status, to: failed.status },
              resultHash: null,
              metadata: { outcome: "failed", reason },
            }),
          ],
        );
      });
    } catch (persistenceError) {
      throw new AggregateError(
        [error, persistenceError],
        "Rollback failed and the failure state could not be persisted",
      );
    }
    throw error;
  }

  return withProjectLock(rollingBack.root, async () => {
    const current = requireLoadedState(await loadProjectState(rollingBack.root));
    const rolledBack = transition(current, {
      type: "rollback_succeeded",
      ...eventContext(current),
    });
    return (
      await commitStateAndReceiptsUnderLock(
        rolledBack.root,
        current,
        rolledBack,
        [
          lifecycleReceipt(current, rolledBack, "rollback.succeeded"),
          receiptInput(rolledBack, {
            event: "rollback",
            runtime: null,
            sessionId: null,
            callId: null,
            toolName: null,
            inputHash: null,
            decision: null,
            lifecycle: { from: current.status, to: rolledBack.status },
            resultHash: rolledBack.checkpoint?.hash ?? null,
            metadata: { outcome: "succeeded", verified: true },
          }),
        ],
      )
    ).state;
  });
}

export async function completePlan(root: string): Promise<ProjectState> {
  return withProjectLock(root, async () => {
    const current = requireLoadedState(await loadProjectState(root));
    const completed = transition(current, {
      type: "complete",
      ...eventContext(current),
    });
    return (
      await commitStateAndReceiptsUnderLock(
        completed.root,
        current,
        completed,
        [lifecycleReceipt(current, completed, "complete")],
      )
    ).state;
  });
}

export async function revokePlan(
  root: string,
  reason: string,
): Promise<ProjectState> {
  return withProjectLock(root, async () => {
    const current = requireLoadedState(await loadProjectState(root));
    const revoked = transition(current, {
      type: "revoke",
      ...eventContext(current),
      reason,
    });
    return (
      await commitStateAndReceiptsUnderLock(
        revoked.root,
        current,
        revoked,
        [lifecycleReceipt(current, revoked, "revoke")],
      )
    ).state;
  });
}
