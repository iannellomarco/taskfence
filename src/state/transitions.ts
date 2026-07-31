import type { ContractState, PendingMutation, ProjectState } from "../types.js";
import {
  StateTransitionError,
  assertTimestamp,
  isAuthorityIdentifier,
  type MutationIdentity,
  type StateTransitionEvent,
} from "./model.js";

type TransitionType = StateTransitionEvent["type"];

const LEGAL_EVENTS: Readonly<
  Record<ContractState, Readonly<Partial<Record<TransitionType, true>>>>
> = {
  absent: { stage: true },
  staged: { bind_authority: true, begin_checkpoint: true, revoke: true, fail: true },
  checkpointing: {
    checkpoint_succeeded: true,
    checkpoint_failed: true,
    revoke: true,
    fail: true,
  },
  active: {
    amend: true,
    bind_authority: true,
    delegate_session: true,
    begin_mutation: true,
    violate: true,
    require_recovery: true,
    begin_rollback: true,
    complete: true,
    revoke: true,
    fail: true,
  },
  mutation_pending: {
    mutation_completed: true,
    mutation_violated: true,
    mutation_uncertain: true,
    fail: true,
  },
  violated: {
    stage: true,
    require_recovery: true,
    begin_rollback: true,
    revoke: true,
    fail: true,
  },
  recovery_required: {
    stage: true,
    recover_active: true,
    begin_rollback: true,
    revoke: true,
    fail: true,
  },
  rolling_back: {
    rollback_succeeded: true,
    rollback_failed: true,
    fail: true,
  },
  rolled_back: { stage: true },
  completed: { stage: true },
  revoked: { stage: true },
  error: { stage: true, begin_rollback: true, revoke: true },
};

export function transition(
  state: Readonly<ProjectState>,
  event: StateTransitionEvent,
): ProjectState {
  validateFreshEvent(state, event);
  if (LEGAL_EVENTS[state.status][event.type] !== true) {
    throw new StateTransitionError(
      "ILLEGAL_TRANSITION",
      `Event ${event.type} is illegal while state is ${state.status}`,
    );
  }

  const base = {
    ...state,
    generation: state.generation + 1,
    updatedAt: event.at,
  };

  switch (event.type) {
    case "stage":
      if (!Number.isSafeInteger(event.revision) || event.revision <= state.revision) {
        throw new StateTransitionError(
          "INVALID_TRANSITION",
          "A staged contract revision must be a positive monotonic integer",
        );
      }
      validateStagedContract(event.contract, state);
      return {
        ...base,
        status: "staged",
        revision: event.revision,
        contract: event.contract,
        checkpoint: null,
        pendingMutation: null,
        authority: null,
        reason: null,
      };

    case "amend":
      if (!Number.isSafeInteger(event.revision) || event.revision <= state.revision) {
        throw new StateTransitionError(
          "INVALID_TRANSITION",
          "An amended contract revision must be a positive monotonic integer",
        );
      }
      requireContractAndCheckpoint(state);
      validateCheckpoint(state.checkpoint, state);
      validateStagedContract(event.contract, state);
      validateProtectedSuperset(state.contract, event.contract);
      return {
        ...base,
        status: "active",
        revision: event.revision,
        contract: event.contract,
        pendingMutation: null,
        reason: null,
      };

    case "bind_authority":
      if (state.authority !== null) {
        throw new StateTransitionError(
          "INVALID_TRANSITION",
          "Session authority is already bound",
        );
      }
      if (
        !["claude", "codex", "opencode", "omp", "pi"].includes(event.runtime) ||
        !isAuthorityIdentifier(event.sessionId)
      ) {
        throw new StateTransitionError(
          "INVALID_TRANSITION",
          "Session authority binding is malformed",
        );
      }
      return {
        ...base,
        authority: {
          runtime: event.runtime,
          rootSessionId: event.sessionId,
          sessions: [{ sessionId: event.sessionId, parentSessionId: null }],
        },
      };

    case "delegate_session": {
      const authority = state.authority;
      if (
        authority === null ||
        event.runtime !== authority.runtime ||
        !isAuthorityIdentifier(event.sessionId) ||
        !isAuthorityIdentifier(event.parentSessionId) ||
        authority.sessions.some((session) => session.sessionId === event.sessionId) ||
        !authority.sessions.some((session) => session.sessionId === event.parentSessionId)
      ) {
        throw new StateTransitionError(
          "INVALID_TRANSITION",
          "Delegated session authority is malformed or has unauthorized ancestry",
        );
      }
      return {
        ...base,
        authority: {
          ...authority,
          sessions: [
            ...authority.sessions,
            {
              sessionId: event.sessionId,
              parentSessionId: event.parentSessionId,
            },
          ].sort((left, right) =>
            left.sessionId < right.sessionId
              ? -1
              : left.sessionId > right.sessionId
                ? 1
                : 0
          ),
        },
      };
    }

    case "begin_checkpoint":
      requireContract(state);
      return { ...base, status: "checkpointing", reason: null };

    case "checkpoint_succeeded":
      requireContract(state);
      validateCheckpoint(event.checkpoint, state);
      return {
        ...base,
        status: "active",
        checkpoint: event.checkpoint,
        pendingMutation: null,
        reason: null,
      };

    case "checkpoint_failed":
      return toError(base, event.reason);

    case "begin_mutation":
      requireContractAndCheckpoint(state);
      validatePendingMutation(event.pendingMutation, state, event.at);
      return {
        ...base,
        status: "mutation_pending",
        pendingMutation: event.pendingMutation,
        reason: null,
      };

    case "mutation_completed":
      requireMatchingMutation(state.pendingMutation, event);
      return {
        ...base,
        status: "active",
        pendingMutation: null,
        reason: null,
      };

    case "mutation_violated":
      requireMatchingMutation(state.pendingMutation, event);
      return {
        ...base,
        status: "violated",
        reason: requireReason(event.reason),
      };

    case "mutation_uncertain":
      requireMatchingMutation(state.pendingMutation, event);
      return {
        ...base,
        status: "recovery_required",
        reason: requireReason(event.reason),
      };

    case "violate":
      return {
        ...base,
        status: "violated",
        reason: requireReason(event.reason),
      };

    case "require_recovery":
      return {
        ...base,
        status: "recovery_required",
        reason: requireReason(event.reason),
      };

    case "recover_active":
      requireMatchingRecovery(state.pendingMutation, event.pendingMutation);
      requireContractAndCheckpoint(state);
      return {
        ...base,
        status: "active",
        pendingMutation: null,
        reason: null,
      };

    case "begin_rollback":
      if (state.checkpoint === null) {
        throw new StateTransitionError(
          "INVALID_TRANSITION",
          "Rollback requires a verified checkpoint",
        );
      }
      return {
        ...base,
        status: "rolling_back",
        pendingMutation: null,
        reason: null,
      };

    case "rollback_succeeded":
      return {
        ...base,
        status: "rolled_back",
        pendingMutation: null,
        authority: null,
        reason: null,
      };

    case "rollback_failed":
      return toError(base, event.reason);

    case "complete":
      return {
        ...base,
        status: "completed",
        pendingMutation: null,
        authority: null,
        reason: "completed",
      };

    case "revoke":
      return {
        ...base,
        status: "revoked",
        pendingMutation: null,
        authority: null,
        reason: requireReason(event.reason),
      };

    case "fail":
      return toError(base, event.reason);
  }
}

function validateFreshEvent(
  state: Readonly<ProjectState>,
  event: StateTransitionEvent,
): void {
  assertTimestamp(event.at, "transition timestamp");
  if (
    !Number.isSafeInteger(event.expectedGeneration) ||
    !Number.isSafeInteger(event.expectedRevision)
  ) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Expected generation and revision must be safe integers",
    );
  }
  if (
    event.expectedGeneration !== state.generation ||
    event.expectedRevision !== state.revision
  ) {
    throw new StateTransitionError(
      "STALE_TRANSITION",
      `Stale event expected generation/revision ${event.expectedGeneration}/${event.expectedRevision}, current is ${state.generation}/${state.revision}`,
    );
  }
  if (Date.parse(event.at) < Date.parse(state.updatedAt)) {
    throw new StateTransitionError(
      "STALE_TRANSITION",
      "Transition timestamp predates the current state",
    );
  }
}

function validateStagedContract(
  contract: ProjectState["contract"],
  state: Readonly<ProjectState>,
): void {
  if (
    !isRecord(contract) ||
    contract.version !== 1 ||
    contract.root !== state.root ||
    contract.rootHash !== state.rootHash ||
    typeof contract.planHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(contract.planHash) ||
    typeof contract.contractHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(contract.contractHash) ||
    !isRecord(contract.document)
  ) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Staged contract is malformed or bound to a different project root",
    );
  }
}

function validateProtectedSuperset(
  current: ProjectState["contract"],
  amended: NonNullable<ProjectState["contract"]>,
): void {
  if (current === null) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Amendment requires an active compiled contract",
    );
  }
  const currentProtected = protectedSelectorSet(current.document.protected);
  const amendedProtected = protectedSelectorSet(amended.document.protected);
  for (const selector of currentProtected) {
    if (!amendedProtected.has(selector)) {
      throw new StateTransitionError(
        "INVALID_TRANSITION",
        "An amended contract cannot remove or weaken protected selectors",
      );
    }
  }
}

function protectedSelectorSet(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Contract protected selectors are malformed",
    );
  }

  const selectors = new Set<string>();
  for (const selector of value) {
    if (
      !isRecord(selector) ||
      !["exact", "subtree"].includes(selector.kind as string) ||
      typeof selector.path !== "string" ||
      selector.path.length === 0 ||
      selector.path.includes("\0")
    ) {
      throw new StateTransitionError(
        "INVALID_TRANSITION",
        "Contract protected selectors are malformed",
      );
    }
    const key = `${String(selector.kind)}\0${selector.path}`;
    if (selectors.has(key)) {
      throw new StateTransitionError(
        "INVALID_TRANSITION",
        "Contract protected selectors must be unique",
      );
    }
    selectors.add(key);
  }
  return selectors;
}

function validateCheckpoint(
  checkpoint: ProjectState["checkpoint"],
  state: Readonly<ProjectState>,
): void {
  if (
    !isRecord(checkpoint) ||
    checkpoint.version !== 1 ||
    checkpoint.root !== state.root ||
    typeof checkpoint.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(checkpoint.hash) ||
    !Array.isArray(checkpoint.entries) ||
    !Number.isSafeInteger(checkpoint.totalFiles) ||
    (checkpoint.totalFiles as number) < 0 ||
    !Number.isSafeInteger(checkpoint.totalBytes) ||
    (checkpoint.totalBytes as number) < 0
  ) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Checkpoint manifest is malformed or bound to a different project root",
    );
  }
}

function requireContract(state: Readonly<ProjectState>): void {
  if (state.contract === null) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Transition requires a compiled contract",
    );
  }
}

function requireContractAndCheckpoint(state: Readonly<ProjectState>): void {
  requireContract(state);
  if (state.checkpoint === null) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Transition requires a verified checkpoint",
    );
  }
}

function validatePendingMutation(
  pending: PendingMutation,
  state: Readonly<ProjectState>,
  eventAt: string,
): void {
  if (
    !isRecord(pending) ||
    typeof pending.runtime !== "string" ||
    !["claude", "codex", "opencode", "omp", "pi"].includes(pending.runtime) ||
    typeof pending.sessionId !== "string" ||
    pending.sessionId.length === 0 ||
    typeof pending.callId !== "string" ||
    pending.callId.length === 0 ||
    typeof pending.inputHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(pending.inputHash) ||
    pending.revision !== state.revision ||
    typeof pending.contractHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(pending.contractHash) ||
    state.contract === null ||
    pending.contractHash !== state.contract.contractHash ||
    typeof pending.startedAt !== "string" ||
    !Number.isFinite(Date.parse(pending.startedAt)) ||
    Date.parse(pending.startedAt) > Date.parse(eventAt)
  ) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Pending mutation is malformed or does not match the active revision",
    );
  }
}

function requireMatchingMutation(
  pending: PendingMutation | null,
  identity: MutationIdentity,
): void {
  if (
    pending === null ||
    pending.callId !== identity.callId ||
    pending.inputHash !== identity.inputHash
  ) {
    throw new StateTransitionError(
      "STALE_TRANSITION",
      "Mutation completion does not match the durable pending mutation",
    );
  }
}

function requireMatchingRecovery(
  pending: PendingMutation | null,
  identity: MutationIdentity | null,
): void {
  if (pending === null && identity === null) return;
  if (pending === null || identity === null) {
    throw new StateTransitionError(
      "STALE_TRANSITION",
      "Recovery identity does not match the durable pending mutation",
    );
  }
  requireMatchingMutation(pending, identity);
}

function requireReason(reason: string): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      "Transition reason must be a non-empty string",
    );
  }
  return reason;
}

function toError(
  state: ProjectState,
  reason: string,
): ProjectState {
  return {
    ...state,
    status: "error",
    authority: null,
    reason: requireReason(reason),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
