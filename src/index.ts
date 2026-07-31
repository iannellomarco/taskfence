export type {
  AuthorizedSession,
  CheckpointEntry,
  CheckpointManifest,
  CommandRule,
  CompiledContract,
  ContractDocument,
  ContractState,
  Decision,
  DecisionCode,
  NormalizedOperation,
  NormalizedToolCall,
  PackageManager,
  PathOperation,
  PathSelector,
  SessionAuthority,
  PendingMutation,
  ProjectState,
  ReceiptAnchor,
  ReceiptEvent,
  ReceiptPage,
  ReceiptRecord,
  RuntimeName,
} from "./types.js";
export { MAX_AUTHORITY_ID_LENGTH } from "./types.js";

export { canonicalStringify, sha256 } from "./contract/canonical.js";
export {
  compileContract,
  PROTECTED_SELECTOR_DEFAULTS,
} from "./contract/compile.js";
export { extractContractBlock, parseContractJson } from "./contract/extract.js";

export { authorizeCommand } from "./policy/commands.js";
export { evaluateToolCall } from "./policy/evaluate.js";
export {
  authorizeCreate,
  authorizeDelete,
  authorizePath,
  authorizeRename,
  authorizeWrite,
  canonicalizeObservedCwd,
  canonicalizeRoot,
  normalizeSelector,
  PathResolutionError,
  resolveTarget,
  selectorMatches,
  validateCanonicalRoot,
} from "./policy/path.js";
export { parseRestrictedCommand, RestrictedShellError } from "./policy/shell.js";
export { normalizeToolCall } from "./policy/tools.js";

export {
  createCheckpoint,
  type CreateCheckpointOptions,
} from "./checkpoint/create.js";
export {
  compareCheckpoint,
  type CheckpointComparison,
  type CheckpointDifference,
  validateCheckpointManifest,
} from "./checkpoint/compare.js";
export { rollbackCheckpoint } from "./checkpoint/rollback.js";

export {
  canonicalStateRoot,
  hashProjectRoot,
  stateLayout,
  type StateLayout,
} from "./state/layout.js";
export {
  ProjectLockError,
  StateStoreError,
  StateTransitionError,
  type StateTransitionEvent,
} from "./state/model.js";
export {
  withProjectLock,
  type ProjectLockOptions,
} from "./state/lock.js";
export {
  loadProjectState,
  saveProjectState,
  validateProjectState,
} from "./state/store.js";
export { transition } from "./state/transitions.js";

export {
  appendReceipt,
  appendReceiptUnderLock,
  IndeterminateTransactionError,
  type ReceiptInput,
} from "./receipts/ledger.js";
export {
  DEFAULT_RECEIPT_PAGE_SIZE,
  listReceipts,
  MAX_RECEIPT_PAGE_SIZE,
  MAX_RECEIPTS_COLLECTED,
  readReceipts,
  ReceiptLedgerError,
  streamReceipts,
  type ListReceiptsOptions,
  type ReceiptVerificationResult,
  validateReceiptRecord,
  verifyReceiptLedger,
} from "./receipts/verify.js";

export {
  confirmTTY,
  semanticContractDelta,
  type SemanticCollectionDelta,
  type SemanticContractDelta,
  type TTYConfirmationOptions,
} from "./control.js";
export {
  amendPlan,
  claimSessionAuthority,
  approvePlan,
  completePlan,
  getStatus,
  hashNormalizedToolCall,
  hashRawToolCall,
  postToolCall,
  preToolCall,
  previewRollback,
  revokePlan,
  rollbackPlan,
  type SessionAuthorityClaimInput,
  type TrustedApprovalIdentity,
  type PostToolCallInput,
  type PreToolCallInput,
  type PreToolCallResult,
} from "./engine.js";
