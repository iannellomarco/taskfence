export type RuntimeName = "claude" | "codex" | "opencode" | "omp" | "pi";

export const MAX_AUTHORITY_ID_LENGTH = 4_096;

export interface AuthorizedSession {
  sessionId: string;
  parentSessionId: string | null;
}

export interface SessionAuthority {
  runtime: RuntimeName;
  rootSessionId: string;
  sessions: AuthorizedSession[];
}

export type ContractState =
  | "absent"
  | "staged"
  | "checkpointing"
  | "active"
  | "mutation_pending"
  | "violated"
  | "recovery_required"
  | "rolling_back"
  | "rolled_back"
  | "completed"
  | "revoked"
  | "error";

export type PathOperation = "write" | "create" | "delete";

export interface PathSelector {
  kind: "exact" | "subtree";
  path: string;
}

export interface CommandRule {
  argv: string[];
  cwd: string;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "none";

export interface ContractDocument {
  version: 1;
  write: PathSelector[];
  create: PathSelector[];
  delete: PathSelector[];
  protected: PathSelector[];
  commands: CommandRule[];
  packageManager: PackageManager;
}

export interface CompiledContract {
  version: 1;
  root: string;
  rootHash: string;
  planHash: string;
  contractHash: string;
  document: ContractDocument;
}

export type DecisionCode =
  | "allow_read_only"
  | "allow_command"
  | "allow_mutation"
  | "deny_contract_required"
  | "deny_contract_inactive"
  | "deny_malformed_tool"
  | "deny_unknown_tool"
  | "deny_unsupported_operation"
  | "deny_command_syntax"
  | "deny_command_not_approved"
  | "deny_package_manager"
  | "deny_path"
  | "deny_protected_path"
  | "deny_root_mismatch"
  | "deny_pending_mutation"
  | "deny_recovery_required"
  | "deny_authority"
  | "deny_internal_error";

export interface Decision {
  allowed: boolean;
  code: DecisionCode;
  reason: string;
}

interface NormalizedToolCallBase {
  runtime: RuntimeName;
  toolName: string;
  cwd: string;
  sessionId?: string;
  callId?: string;
}

export interface NormalizedOperation {
  operation: PathOperation;
  target: string;
}

export type NormalizedToolCall =
  | (NormalizedToolCallBase & { kind: "read" })
  | (NormalizedToolCallBase & { kind: "command"; command: string })
  | (NormalizedToolCallBase & {
      kind: "mutation";
      operations: NormalizedOperation[];
    })
  | (NormalizedToolCallBase & { kind: "unknown"; reason: string })
  | (NormalizedToolCallBase & { kind: "malformed"; reason: string });

export interface PendingMutation {
  runtime: RuntimeName;
  sessionId: string;
  callId: string;
  inputHash: string;
  startedAt: string;
  contractHash: string;
  revision: number;
}

export interface CheckpointEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  hash: string;
  size?: number;
  link?: string;
}

export interface CheckpointManifest {
  version: 1;
  root: string;
  entries: CheckpointEntry[];
  totalFiles: number;
  totalBytes: number;
  hash: string;
}

export interface ReceiptAnchor {
  count: number;
  lastHash: string | null;
  byteLength: number;
}

export interface ProjectState {
  schemaVersion: 3;
  root: string;
  rootHash: string;
  status: ContractState;
  generation: number;
  revision: number;
  contract: CompiledContract | null;
  checkpoint: CheckpointManifest | null;
  pendingMutation: PendingMutation | null;
  authority: SessionAuthority | null;
  reason: string | null;
  updatedAt: string;
  receiptAnchor: ReceiptAnchor;
}

export type ReceiptEvent =
  | "decision"
  | "lifecycle"
  | "checkpoint"
  | "rollback"
  | "amendment"
  | "authority";

export interface ReceiptRecord {
  version: 1;
  sequence: number;
  timestamp: string;
  event: ReceiptEvent;
  root: string;
  rootHash: string;
  contractHash: string;
  checkpointHash: string;
  revision: number;
  runtime: RuntimeName | null;
  sessionId: string | null;
  callId: string | null;
  toolName: string | null;
  inputHash: string | null;
  decision: Decision | null;
  lifecycle: { from: ContractState; to: ContractState } | null;
  resultHash: string | null;
  metadata: Record<string, unknown>;
  previousHash: string | null;
  recordHash: string;
}

/**
 * A bounded page of receipts. `cursor` is an opaque resumption token: pass it
 * as the next request's cursor to fetch the following page. It is `null` when
 * the page contains the final records of the ledger. Pages never collect the
 * entire (up to 64 GiB) ledger into memory.
 */
export interface ReceiptPage {
  records: ReceiptRecord[];
  cursor: string | null;
}
