import { MAX_AUTHORITY_ID_LENGTH } from "../types.js";
import type {
  CheckpointManifest,
  CompiledContract,
  PendingMutation,
  ProjectState,
  RuntimeName,
} from "../types.js";

export const STATE_SCHEMA_VERSION = 3 as const;

export const CONTRACT_STATES = [
  "absent",
  "staged",
  "checkpointing",
  "active",
  "mutation_pending",
  "violated",
  "recovery_required",
  "rolling_back",
  "rolled_back",
  "completed",
  "revoked",
  "error",
] as const;

export type StateTransitionEvent =
  | TransitionEvent<"stage", { contract: CompiledContract; revision: number }>
  | TransitionEvent<"amend", { contract: CompiledContract; revision: number }>
  | TransitionEvent<"bind_authority", { runtime: RuntimeName; sessionId: string }>
  | TransitionEvent<
      "delegate_session",
      { runtime: RuntimeName; sessionId: string; parentSessionId: string }
    >
  | TransitionEvent<"begin_checkpoint">
  | TransitionEvent<"checkpoint_succeeded", { checkpoint: CheckpointManifest }>
  | TransitionEvent<"checkpoint_failed", { reason: string }>
  | TransitionEvent<"begin_mutation", { pendingMutation: PendingMutation }>
  | TransitionEvent<"mutation_completed", MutationIdentity>
  | TransitionEvent<"mutation_violated", MutationIdentity & { reason: string }>
  | TransitionEvent<"mutation_uncertain", MutationIdentity & { reason: string }>
  | TransitionEvent<"violate", { reason: string }>
  | TransitionEvent<"require_recovery", { reason: string }>
  | TransitionEvent<"recover_active", { pendingMutation: MutationIdentity | null }>
  | TransitionEvent<"begin_rollback">
  | TransitionEvent<"rollback_succeeded">
  | TransitionEvent<"rollback_failed", { reason: string }>
  | TransitionEvent<"complete">
  | TransitionEvent<"revoke", { reason: string }>
  | TransitionEvent<"fail", { reason: string }>;

type TransitionEvent<Type extends string, Payload extends object = Record<never, never>> = {
  type: Type;
  expectedGeneration: number;
  expectedRevision: number;
  at: string;
} & Payload;

export interface MutationIdentity {
  callId: string;
  inputHash: string;
}

export class StateTransitionError extends Error {
  readonly code: "ILLEGAL_TRANSITION" | "STALE_TRANSITION" | "INVALID_TRANSITION";

  constructor(
    code: "ILLEGAL_TRANSITION" | "STALE_TRANSITION" | "INVALID_TRANSITION",
    message: string,
  ) {
    super(message);
    this.name = "StateTransitionError";
    this.code = code;
  }
}

export class StateStoreError extends Error {
  readonly code:
    | "STATE_CORRUPT"
    | "STATE_INCOMPATIBLE"
    | "STATE_ROOT_MISMATCH"
    | "STATE_IO";

  constructor(
    code:
      | "STATE_CORRUPT"
      | "STATE_INCOMPATIBLE"
      | "STATE_ROOT_MISMATCH"
      | "STATE_IO",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StateStoreError";
    this.code = code;
  }
}

export class ProjectLockError extends Error {
  readonly code: "LOCK_TIMEOUT" | "LOCK_CORRUPT" | "LOCK_IO";

  constructor(
    code: "LOCK_TIMEOUT" | "LOCK_CORRUPT" | "LOCK_IO",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectLockError";
    this.code = code;
  }
}

export function createProjectState(
  root: string,
  rootHash: string,
  at: string,
): ProjectState {
  assertTimestamp(at, "initial state timestamp");
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    root,
    rootHash,
    status: "absent",
    generation: 0,
    revision: 0,
    contract: null,
    checkpoint: null,
    pendingMutation: null,
    authority: null,
    reason: null,
    updatedAt: at,
    receiptAnchor: { count: 0, lastHash: null, byteLength: 0 },
  };
}

export function isAuthorityIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AUTHORITY_ID_LENGTH &&
    !value.includes("\0");
}

export function assertTimestamp(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new StateTransitionError(
      "INVALID_TRANSITION",
      `${label} must be an ISO 8601 UTC timestamp`,
    );
  }
}
