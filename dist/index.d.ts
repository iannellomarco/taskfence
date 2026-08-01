type RuntimeName = "claude" | "codex" | "opencode" | "omp" | "pi";
declare const MAX_AUTHORITY_ID_LENGTH = 4096;
interface AuthorizedSession {
    sessionId: string;
    parentSessionId: string | null;
}
interface SessionAuthority {
    runtime: RuntimeName;
    rootSessionId: string;
    sessions: AuthorizedSession[];
}
type ContractState = "absent" | "staged" | "checkpointing" | "active" | "mutation_pending" | "violated" | "recovery_required" | "rolling_back" | "rolled_back" | "completed" | "revoked" | "error";
type PathOperation = "write" | "create" | "delete";
interface PathSelector {
    kind: "exact" | "subtree";
    path: string;
}
interface CommandRule {
    argv: string[];
    cwd: string;
}
type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "none";
interface ContractDocument {
    version: 1;
    write: PathSelector[];
    create: PathSelector[];
    delete: PathSelector[];
    protected: PathSelector[];
    commands: CommandRule[];
    packageManager: PackageManager;
}
interface CompiledContract {
    version: 1;
    root: string;
    rootHash: string;
    planHash: string;
    contractHash: string;
    document: ContractDocument;
}
type DecisionCode = "allow_read_only" | "allow_command" | "allow_mutation" | "deny_contract_required" | "deny_contract_inactive" | "deny_malformed_tool" | "deny_unknown_tool" | "deny_unsupported_operation" | "deny_command_syntax" | "deny_command_not_approved" | "deny_package_manager" | "deny_path" | "deny_protected_path" | "deny_root_mismatch" | "deny_pending_mutation" | "deny_recovery_required" | "deny_authority" | "deny_internal_error";
interface Decision {
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
interface NormalizedOperation {
    operation: PathOperation;
    target: string;
}
type NormalizedToolCall = (NormalizedToolCallBase & {
    kind: "read";
}) | (NormalizedToolCallBase & {
    kind: "command";
    command: string;
}) | (NormalizedToolCallBase & {
    kind: "mutation";
    operations: NormalizedOperation[];
}) | (NormalizedToolCallBase & {
    kind: "unknown";
    reason: string;
}) | (NormalizedToolCallBase & {
    kind: "malformed";
    reason: string;
});
interface PendingMutation {
    runtime: RuntimeName;
    sessionId: string;
    callId: string;
    inputHash: string;
    startedAt: string;
    contractHash: string;
    revision: number;
}
interface CheckpointEntry {
    path: string;
    type: "file" | "directory" | "symlink";
    mode: number;
    hash: string;
    size?: number;
    link?: string;
}
interface CheckpointManifest {
    version: 1;
    root: string;
    entries: CheckpointEntry[];
    totalFiles: number;
    totalBytes: number;
    hash: string;
}
interface ReceiptAnchor {
    count: number;
    lastHash: string | null;
    byteLength: number;
}
interface ProjectState {
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
type ReceiptEvent = "decision" | "lifecycle" | "checkpoint" | "rollback" | "amendment" | "authority";
interface ReceiptRecord {
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
    lifecycle: {
        from: ContractState;
        to: ContractState;
    } | null;
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
interface ReceiptPage {
    records: ReceiptRecord[];
    cursor: string | null;
}

declare function canonicalStringify(value: unknown): string;
declare function sha256(value: string | Uint8Array): string;

declare const PROTECTED_SELECTOR_DEFAULTS: readonly [".git/**", ".taskfence/**", ".claude/**", ".codex/**", ".opencode/**", ".omp/**", ".pi/**"];
declare function compileContract(planText: string, root: string): CompiledContract;

declare function extractContractBlock(planText: string): string;
declare function parseContractJson(source: string): unknown;

declare function authorizeCommand(contract: CompiledContract, command: string, cwd: string): Decision;

/**
 * Compose a deterministic decision from an already-normalized tool call. This
 * function has no side effects; filesystem access is limited to canonical path
 * resolution performed by the shared path policy.
 */
declare function evaluateToolCall(contractOrNull: CompiledContract | null, call: NormalizedToolCall): Decision;

type PathResolutionCode = "invalid_nul" | "invalid_absolute" | "invalid_traversal" | "invalid_syntax" | "not_found" | "dangling_symlink" | "ambiguous_path" | "case_collision" | "symbolic_link" | "hard_link" | "invalid_root" | "root_mismatch" | "root_escape";
declare class PathResolutionError extends Error {
    readonly code: PathResolutionCode;
    constructor(code: PathResolutionCode, message: string, options?: ErrorOptions);
}
interface ResolveTargetOptions {
    mustExist: boolean;
}
declare function canonicalizeRoot(root: string): string;
declare function validateCanonicalRoot(root: string): string;
declare function canonicalizeObservedCwd(root: string, cwd: string): string;
declare function resolveTarget(root: string, target: string, options: ResolveTargetOptions): string;

declare function normalizeSelector(selector: string | PathSelector): PathSelector;
declare function selectorMatches(selector: PathSelector, relativePath: string): boolean;
declare function authorizePath(contract: CompiledContract, operation: PathOperation, target: string): Decision;
declare function authorizeWrite(contract: CompiledContract, target: string): Decision;
declare function authorizeCreate(contract: CompiledContract, target: string): Decision;
declare function authorizeDelete(contract: CompiledContract, target: string): Decision;
declare function authorizeRename(contract: CompiledContract, source: string, destination: string): Decision;

declare class RestrictedShellError extends Error {
    constructor(message: string);
}
/**
 * Parse the deliberately small shell subset used by command rules. The result is
 * literal argv; no expansion, operator, redirect, or secondary parse is accepted.
 */
declare function parseRestrictedCommand(command: string): string[];

declare function normalizeToolCall(runtime: RuntimeName, toolName: string, input: unknown, cwd: string, sessionId?: string, callId?: string): NormalizedToolCall;

interface ScanLimits {
    maxFiles?: number;
    maxFileBytes?: number;
    maxBytes?: number;
}

type CreateCheckpointOptions = ScanLimits;
declare function createCheckpoint(root: string, options?: CreateCheckpointOptions): Promise<CheckpointManifest>;

interface CheckpointDifference {
    path: string;
    reason: "added" | "removed" | "type" | "hash" | "mode" | "size" | "link";
    expected?: CheckpointEntry;
    actual?: CheckpointEntry;
}
interface CheckpointComparison {
    matches: boolean;
    differences: CheckpointDifference[];
}
declare function compareCheckpoint(root: string, manifest: CheckpointManifest): Promise<CheckpointComparison>;
declare function validateCheckpointManifest(manifest: CheckpointManifest, expectedRoot?: string): void;

interface RollbackOptions {
    /**
     * Test-only crash/race injection point. A thrown error intentionally leaves
     * the durable journal and staging trees intact for the next invocation.
     */
    onBoundary?: (boundary: string) => void | Promise<void>;
}
declare function rollbackCheckpoint(root: string, manifest: CheckpointManifest, options?: RollbackOptions): Promise<void>;

interface StateLayout {
    canonicalRoot: string;
    rootHash: string;
    baseDir: string;
    projectsDir: string;
    projectDir: string;
    stateFile: string;
    lockFile: string;
    checkpointsDir: string;
    receiptsFile: string;
    transactionFile: string;
}
declare function canonicalStateRoot(root: string): Promise<string>;
declare function hashProjectRoot(canonicalRoot: string): string;
declare function stateLayout(root: string): Promise<StateLayout>;

type StateTransitionEvent = TransitionEvent<"stage", {
    contract: CompiledContract;
    revision: number;
}> | TransitionEvent<"amend", {
    contract: CompiledContract;
    revision: number;
}> | TransitionEvent<"bind_authority", {
    runtime: RuntimeName;
    sessionId: string;
}> | TransitionEvent<"delegate_session", {
    runtime: RuntimeName;
    sessionId: string;
    parentSessionId: string;
}> | TransitionEvent<"begin_checkpoint"> | TransitionEvent<"checkpoint_succeeded", {
    checkpoint: CheckpointManifest;
}> | TransitionEvent<"checkpoint_failed", {
    reason: string;
}> | TransitionEvent<"begin_mutation", {
    pendingMutation: PendingMutation;
}> | TransitionEvent<"mutation_completed", MutationIdentity> | TransitionEvent<"mutation_violated", MutationIdentity & {
    reason: string;
}> | TransitionEvent<"mutation_uncertain", MutationIdentity & {
    reason: string;
}> | TransitionEvent<"violate", {
    reason: string;
}> | TransitionEvent<"require_recovery", {
    reason: string;
}> | TransitionEvent<"recover_active", {
    pendingMutation: MutationIdentity | null;
}> | TransitionEvent<"begin_rollback"> | TransitionEvent<"rollback_succeeded"> | TransitionEvent<"rollback_failed", {
    reason: string;
}> | TransitionEvent<"complete"> | TransitionEvent<"revoke", {
    reason: string;
}> | TransitionEvent<"fail", {
    reason: string;
}>;
type TransitionEvent<Type extends string, Payload extends object = Record<never, never>> = {
    type: Type;
    expectedGeneration: number;
    expectedRevision: number;
    at: string;
} & Payload;
interface MutationIdentity {
    callId: string;
    inputHash: string;
}
declare class StateTransitionError extends Error {
    readonly code: "ILLEGAL_TRANSITION" | "STALE_TRANSITION" | "INVALID_TRANSITION";
    constructor(code: "ILLEGAL_TRANSITION" | "STALE_TRANSITION" | "INVALID_TRANSITION", message: string);
}
declare class StateStoreError extends Error {
    readonly code: "STATE_CORRUPT" | "STATE_INCOMPATIBLE" | "STATE_ROOT_MISMATCH" | "STATE_IO";
    constructor(code: "STATE_CORRUPT" | "STATE_INCOMPATIBLE" | "STATE_ROOT_MISMATCH" | "STATE_IO", message: string, options?: ErrorOptions);
}
declare class ProjectLockError extends Error {
    readonly code: "LOCK_TIMEOUT" | "LOCK_CORRUPT" | "LOCK_IO";
    constructor(code: "LOCK_TIMEOUT" | "LOCK_CORRUPT" | "LOCK_IO", message: string, options?: ErrorOptions);
}

interface ProjectLockOptions {
    acquireTimeoutMs?: number;
    staleLockMs?: number;
    retryDelayMs?: number;
    staleRecoveryLimit?: number;
}
/**
 * Quarantine-as-guard lock acquisition.
 *
 * Instead of a fixed-path recovery marker (which has no guard for itself),
 * stale recovery uses an atomic rename of state.lock → a unique quarantine
 * file (`.stale-lock-<pid|orphan>-<uuid>`). This rename is atomic: state.lock
 * disappears and the quarantine file appears in the same syscall, so there
 * is never a state where neither exists.
 *
 * Every acquirer scans for quarantine files before O_EXCL creation AND rescans
 * after creation before entering the critical section. If any quarantine file
 * exists, the acquirer removes only its own exact nonce-bearing lock artifact
 * and retries — it never enters while recovery is in progress.
 *
 * The recoverer renames the stale lock to quarantine, re-reads the quarantined
 * file's raw bytes against the under-snapshot, and either deletes it (dead/
 * stale exact match) or restores it to state.lock (live/mismatched). Unique
 * quarantine names eliminate ABA/inode-reuse across different recoverers.
 * Cleanup that races with replacement creation atomically hands an unresolved
 * guard to an `orphan` name, so later scans use payload liveness and age
 * instead of mistaking the cleanup process for an active recoverer.
 *
 * A crash after rename leaves the quarantine file. A later acquirer either
 * restores a live owner's lock by linking quarantine→state.lock before
 * unlinking the guard, or removes a dead stale candidate.
 */
declare function withProjectLock<T>(root: string, operation: () => Promise<T> | T, options?: ProjectLockOptions): Promise<T>;

declare function loadProjectState(root: string): Promise<ProjectState | null>;
/**
 * Saves a caller-supplied snapshot with a generation/revision compare-and-swap.
 * Engine transitions use the receipt transaction writer instead.
 */
declare function saveProjectState(state: ProjectState): Promise<void>;
declare function validateProjectState(value: unknown, layout: StateLayout): ProjectState;

declare function transition(state: Readonly<ProjectState>, event: StateTransitionEvent): ProjectState;

type ManagedReceiptField = "version" | "sequence" | "timestamp" | "root" | "rootHash" | "previousHash" | "recordHash";
type ReceiptInput = Omit<ReceiptRecord, ManagedReceiptField> & Partial<Pick<ReceiptRecord, ManagedReceiptField>>;
/**
 * Raised when a receipt/state transaction has a durable write-ahead log (its
 * commit point) but its final on-disk outcome could not be established before
 * returning. Unlike an ordinary failure, the caller cannot assume the request
 * was rejected: a later lock acquisition may finish committing it. Callers
 * must surface this distinctly and preserve recoverability.
 */
declare class IndeterminateTransactionError extends Error {
    readonly root: string;
    readonly transactionFile: string;
    constructor(root: string, transactionFile: string, message: string, options?: ErrorOptions);
}
/** Appends one canonical receipt while the caller holds the root lock. */
declare function appendReceiptUnderLock(root: string, input: ReceiptInput): Promise<ReceiptRecord>;
/** Appends one canonical, hash-chained receipt under the root-scoped lock. */
declare function appendReceipt(root: string, input: ReceiptInput): Promise<ReceiptRecord>;

/**
 * Maximum number of receipts a single bounded read path may collect into
 * memory. The accepted ledger bound is 64 GiB; this keeps the array-returning
 * compatibility helper from allocating an unbounded structure on that ledger.
 */
declare const MAX_RECEIPTS_COLLECTED = 10000;
/** Default and maximum page sizes for `listReceipts`. */
declare const DEFAULT_RECEIPT_PAGE_SIZE = 100;
declare const MAX_RECEIPT_PAGE_SIZE = 1000;
type ReceiptVerificationResult = {
    valid: true;
    count: number;
    lastHash: string | null;
    byteLength: number;
} | {
    valid: false;
    index: number;
    reason: string;
};
declare class ReceiptLedgerError extends Error {
    readonly index: number;
    readonly reason: string;
    constructor(index: number, reason: string);
}
declare function validateReceiptRecord(value: unknown): string | null;
/** Streams and verifies the complete ledger against the durable state anchor. */
declare function verifyReceiptLedger(root: string): Promise<ReceiptVerificationResult>;
interface ListReceiptsOptions {
    /** Maximum records in this page (clamped to MAX_RECEIPT_PAGE_SIZE). */
    limit?: number;
    /** Opaque resumption token returned by a prior page. */
    cursor?: string | null;
}
/**
 * Returns a bounded page of receipts from `root`. `cursor` resumes from a prior
 * page; the returned `cursor` is `null` on the final page. On resume the reader
 * first stream-verifies the ledger prefix through the cursor offset (constant
 * memory, no collection), so a forged, stale, or replayed cursor fails closed
 * before any record is emitted — it cannot skip or hide corruption. Memory is
 * bounded by the page size regardless of total ledger size (up to 64 GiB).
 */
declare function listReceipts(root: string, options?: ListReceiptsOptions): Promise<ReceiptPage>;
/**
 * Streams every receipt in the ledger to `emit`, verifying the full hash chain
 * against the durable anchor. Only one record is held in memory at a time, so
 * a 64 GiB ledger never causes unbounded allocation. Returns the verification
 * result once the stream completes.
 */
declare function streamReceipts(root: string, emit: (record: ReceiptRecord) => void): Promise<ReceiptVerificationResult>;
/**
 * Compatibility helper that returns verified receipts. Bounded to
 * MAX_RECEIPTS_COLLECTED records — it rejects rather than allocate an unbounded
 * array over the accepted 64 GiB ledger. Prefer `listReceipts` for paging or
 * `streamReceipts` for full-ledger processing with constant memory.
 */
declare function readReceipts(root: string): Promise<ReceiptRecord[]>;

interface TTYConfirmationOptions {
    yes?: boolean;
    input?: NodeJS.ReadableStream & {
        isTTY?: boolean;
    };
    output?: NodeJS.WritableStream & {
        isTTY?: boolean;
    };
}
interface SemanticCollectionDelta<T> {
    added: T[];
    removed: T[];
}
interface SemanticContractDelta {
    changed: boolean;
    root: {
        before: string | null;
        after: string;
    } | null;
    packageManager: {
        before: PackageManager | null;
        after: PackageManager;
    } | null;
    write: SemanticCollectionDelta<PathSelector>;
    create: SemanticCollectionDelta<PathSelector>;
    delete: SemanticCollectionDelta<PathSelector>;
    protected: SemanticCollectionDelta<PathSelector>;
    commands: SemanticCollectionDelta<CommandRule>;
}
/**
 * Confirms an authority-bearing action. Non-interactive callers must opt in
 * explicitly with `yes`; a redirected stdin/stdout pair never counts as user
 * confirmation.
 */
declare function confirmTTY(prompt: string, options?: TTYConfirmationOptions): Promise<boolean>;
/** Returns only authority-relevant semantic changes, ignoring plan prose/hash changes. */
declare function semanticContractDelta(previous: CompiledContract | null, next: CompiledContract): SemanticContractDelta;

interface TrustedApprovalIdentity {
    runtime: "claude" | "omp" | "pi";
    sessionId: string;
}
interface SessionAuthorityClaimInput {
    root: string;
    runtime: RuntimeName;
    sessionId: string;
    parentSessionId?: string | null;
    expectedContractHash?: string;
    expectedPlanHash?: string;
}
interface PreToolCallInput {
    runtime: RuntimeName;
    toolName: string;
    input: unknown;
    cwd: string;
    sessionId?: string;
    parentSessionId?: string | null;
    callId?: string;
}
interface PreToolCallResult {
    decision: Decision;
    inputHash: string | null;
    root: string;
    status: ContractState;
}
interface PostToolCallInput {
    root: string;
    runtime: RuntimeName;
    sessionId: string;
    callId: string;
    inputHash: string;
    success: boolean;
    observedViolation?: boolean | string;
}
declare function hashNormalizedToolCall(call: NormalizedToolCall): string;
declare function hashRawToolCall(input: PreToolCallInput): string;
declare function claimSessionAuthority(input: SessionAuthorityClaimInput): Promise<ProjectState>;
declare function approvePlan(planText: string, root: string, identity?: TrustedApprovalIdentity): Promise<ProjectState>;
declare function amendPlan(planText: string, root: string): Promise<ProjectState>;
declare function getStatus(root: string): Promise<ProjectState>;
declare function preToolCall(input: PreToolCallInput): Promise<PreToolCallResult>;
declare function postToolCall(input: PostToolCallInput): Promise<ProjectState>;
declare function previewRollback(root: string): Promise<CheckpointComparison>;
declare function rollbackPlan(root: string): Promise<ProjectState>;
declare function completePlan(root: string): Promise<ProjectState>;
declare function revokePlan(root: string, reason: string): Promise<ProjectState>;

export { type AuthorizedSession, type CheckpointComparison, type CheckpointDifference, type CheckpointEntry, type CheckpointManifest, type CommandRule, type CompiledContract, type ContractDocument, type ContractState, type CreateCheckpointOptions, DEFAULT_RECEIPT_PAGE_SIZE, type Decision, type DecisionCode, IndeterminateTransactionError, type ListReceiptsOptions, MAX_AUTHORITY_ID_LENGTH, MAX_RECEIPTS_COLLECTED, MAX_RECEIPT_PAGE_SIZE, type NormalizedOperation, type NormalizedToolCall, PROTECTED_SELECTOR_DEFAULTS, type PackageManager, type PathOperation, PathResolutionError, type PathSelector, type PendingMutation, type PostToolCallInput, type PreToolCallInput, type PreToolCallResult, ProjectLockError, type ProjectLockOptions, type ProjectState, type ReceiptAnchor, type ReceiptEvent, type ReceiptInput, ReceiptLedgerError, type ReceiptPage, type ReceiptRecord, type ReceiptVerificationResult, RestrictedShellError, type RuntimeName, type SemanticCollectionDelta, type SemanticContractDelta, type SessionAuthority, type SessionAuthorityClaimInput, type StateLayout, StateStoreError, StateTransitionError, type StateTransitionEvent, type TTYConfirmationOptions, type TrustedApprovalIdentity, amendPlan, appendReceipt, appendReceiptUnderLock, approvePlan, authorizeCommand, authorizeCreate, authorizeDelete, authorizePath, authorizeRename, authorizeWrite, canonicalStateRoot, canonicalStringify, canonicalizeObservedCwd, canonicalizeRoot, claimSessionAuthority, compareCheckpoint, compileContract, completePlan, confirmTTY, createCheckpoint, evaluateToolCall, extractContractBlock, getStatus, hashNormalizedToolCall, hashProjectRoot, hashRawToolCall, listReceipts, loadProjectState, normalizeSelector, normalizeToolCall, parseContractJson, parseRestrictedCommand, postToolCall, preToolCall, previewRollback, readReceipts, resolveTarget, revokePlan, rollbackCheckpoint, rollbackPlan, saveProjectState, selectorMatches, semanticContractDelta, sha256, stateLayout, streamReceipts, transition, validateCanonicalRoot, validateCheckpointManifest, validateProjectState, validateReceiptRecord, verifyReceiptLedger, withProjectLock };
