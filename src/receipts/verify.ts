import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { canonicalStringify, sha256 } from "../contract/canonical.js";
import { stateLayout } from "../state/layout.js";
import { withProjectLock } from "../state/lock.js";
import {
  isNodeError,
  openSecureFile,
} from "../state/secure-file.js";
import { loadProjectState } from "../state/store.js";
import { MAX_AUTHORITY_ID_LENGTH } from "../types.js";
import type { ReceiptAnchor, ReceiptPage, ReceiptRecord } from "../types.js";
import { normalizeReceiptMetadata } from "./redact.js";

const HASH = /^[a-f0-9]{64}$/;
export const RECEIPT_FILE_MODE = 0o600;
export const MAX_RECEIPT_LINE_BYTES = 1024 * 1024;
export const MAX_RECEIPT_LEDGER_BYTES = 64 * 1024 * 1024 * 1024;
/**
 * Maximum number of receipts a single bounded read path may collect into
 * memory. The accepted ledger bound is 64 GiB; this keeps the array-returning
 * compatibility helper from allocating an unbounded structure on that ledger.
 */
export const MAX_RECEIPTS_COLLECTED = 10_000;
/** Default and maximum page sizes for `listReceipts`. */
export const DEFAULT_RECEIPT_PAGE_SIZE = 100;
export const MAX_RECEIPT_PAGE_SIZE = 1_000;
const READ_CHUNK_BYTES = 64 * 1024;
const RECEIPT_KEYS: Record<keyof ReceiptRecord, true> = {
  version: true,
  sequence: true,
  timestamp: true,
  event: true,
  root: true,
  rootHash: true,
  contractHash: true,
  checkpointHash: true,
  revision: true,
  runtime: true,
  sessionId: true,
  callId: true,
  toolName: true,
  inputHash: true,
  decision: true,
  lifecycle: true,
  resultHash: true,
  metadata: true,
  previousHash: true,
  recordHash: true,
};
const RECEIPT_KEY_NAMES = Object.keys(RECEIPT_KEYS);
const EVENTS: Record<string, true> = {
  decision: true,
  lifecycle: true,
  checkpoint: true,
  rollback: true,
  amendment: true,
  authority: true,
};
const RUNTIMES: Record<string, true> = {
  claude: true,
  codex: true,
  opencode: true,
  omp: true,
  pi: true,
};
const CONTRACT_STATES: Record<string, true> = {
  absent: true,
  staged: true,
  checkpointing: true,
  active: true,
  mutation_pending: true,
  violated: true,
  recovery_required: true,
  rolling_back: true,
  rolled_back: true,
  completed: true,
  revoked: true,
  error: true,
};
const DECISION_CODES: Record<string, true> = {
  allow_read_only: true,
  allow_command: true,
  allow_mutation: true,
  deny_contract_required: true,
  deny_contract_inactive: true,
  deny_malformed_tool: true,
  deny_unknown_tool: true,
  deny_unsupported_operation: true,
  deny_command_syntax: true,
  deny_command_not_approved: true,
  deny_package_manager: true,
  deny_path: true,
  deny_protected_path: true,
  deny_root_mismatch: true,
  deny_pending_mutation: true,
  deny_recovery_required: true,
  deny_authority: true,
  deny_internal_error: true,
};

export type ReceiptVerificationResult =
  | {
      valid: true;
      count: number;
      lastHash: string | null;
      byteLength: number;
    }
  | { valid: false; index: number; reason: string };
function validVerification(
  count: number,
  lastHash: string | null,
  byteLength: number,
): Extract<ReceiptVerificationResult, { valid: true }> {
  const result = { valid: true as const, count, lastHash } as Extract<
    ReceiptVerificationResult,
    { valid: true }
  >;
  // Length participates in anchor checks and remains directly accessible, but
  // keeping it non-enumerable preserves the established CLI JSON schema.
  Object.defineProperty(result, "byteLength", {
    value: byteLength,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}


export class ReceiptLedgerError extends Error {
  readonly index: number;
  readonly reason: string;

  constructor(index: number, reason: string) {
    super(`Invalid receipt at index ${index}: ${reason}`);
    this.name = "ReceiptLedgerError";
    this.index = index;
    this.reason = reason;
  }
}

interface InspectedLedger {
  records: ReceiptRecord[];
  verification: ReceiptVerificationResult;
  /**
   * Byte offset where the next unprocessed record begins. Present when the
   * scan stopped before reaching end-of-file (bounded page or stream).
   */
  nextOffset?: number;
  /** True when records remain in the ledger beyond this scan. */
  hasMore?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length > 0);
}

function authorityIdentifier(value: unknown): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AUTHORITY_ID_LENGTH &&
    !value.includes("\0");
}

function nullableHash(value: unknown): boolean {
  return value === null || (typeof value === "string" && HASH.test(value));
}

export function validateReceiptRecord(value: unknown): string | null {
  if (!isRecord(value)) return "record_not_object";

  const actualKeys = Object.keys(value);
  for (const key of actualKeys) {
    if (!Object.hasOwn(RECEIPT_KEYS, key)) return `unknown_field:${key}`;
  }
  for (const key of RECEIPT_KEY_NAMES) {
    if (!Object.hasOwn(value, key)) return `missing_field:${key}`;
  }

  if (value.version !== 1) return "invalid_version";
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return "invalid_sequence";
  if (
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    new Date(value.timestamp).toISOString() !== value.timestamp
  ) return "invalid_timestamp";
  if (typeof value.event !== "string" || !Object.hasOwn(EVENTS, value.event)) return "invalid_event";
  if (typeof value.root !== "string" || value.root.length === 0) return "invalid_root";
  if (typeof value.rootHash !== "string" || !HASH.test(value.rootHash)) return "invalid_root_hash";
  if (typeof value.contractHash !== "string" || !HASH.test(value.contractHash)) return "invalid_contract_hash";
  if (typeof value.checkpointHash !== "string" || !HASH.test(value.checkpointHash)) return "invalid_checkpoint_hash";
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return "invalid_revision";
  if (value.runtime !== null && (typeof value.runtime !== "string" || !Object.hasOwn(RUNTIMES, value.runtime))) return "invalid_runtime";
  if (!nullableString(value.sessionId)) return "invalid_session_id";
  if (!nullableString(value.callId)) return "invalid_call_id";
  if (!nullableString(value.toolName)) return "invalid_tool_name";
  if (!nullableHash(value.inputHash)) return "invalid_input_hash";
  if (!nullableHash(value.resultHash)) return "invalid_result_hash";
  if (!nullableHash(value.previousHash)) return "invalid_previous_hash";
  if (typeof value.recordHash !== "string" || !HASH.test(value.recordHash)) return "invalid_record_hash";

  if (value.decision !== null) {
    if (!isRecord(value.decision)) return "invalid_decision";
    const keys = Object.keys(value.decision).sort().join(",");
    if (keys !== "allowed,code,reason") return "invalid_decision_fields";
    if (typeof value.decision.allowed !== "boolean") return "invalid_decision_allowed";
    if (typeof value.decision.code !== "string" || !Object.hasOwn(DECISION_CODES, value.decision.code)) return "invalid_decision_code";
    if (typeof value.decision.reason !== "string" || value.decision.reason.length === 0) return "invalid_decision_reason";
    const normalizedDecision = normalizeReceiptMetadata(value.decision);
    if (canonicalStringify(normalizedDecision) !== canonicalStringify(value.decision)) return "unredacted_decision";
  }
  if (value.event === "decision" && value.decision === null) return "decision_event_missing_decision";
  if (value.event === "authority") {
    if (
      value.runtime === null ||
      !authorityIdentifier(value.sessionId) ||
      value.callId !== null ||
      value.toolName !== null ||
      value.inputHash !== null ||
      value.decision !== null ||
      value.lifecycle !== null ||
      value.resultHash === null ||
      !isRecord(value.metadata)
    ) return "invalid_authority_event";
    const metadataKeys = Object.keys(value.metadata).sort().join(",");
    if (metadataKeys !== "action,parentSessionId") {
      return "invalid_authority_metadata_fields";
    }
    if (
      value.metadata.action === "authority.bind" &&
      value.metadata.parentSessionId !== null
    ) return "invalid_authority_parent";
    if (
      value.metadata.action === "authority.delegate" &&
      !authorityIdentifier(value.metadata.parentSessionId)
    ) return "invalid_authority_parent";
    if (
      value.metadata.action !== "authority.bind" &&
      value.metadata.action !== "authority.delegate"
    ) return "invalid_authority_action";
  }

  if (value.lifecycle !== null) {
    if (!isRecord(value.lifecycle)) return "invalid_lifecycle";
    const keys = Object.keys(value.lifecycle).sort().join(",");
    if (keys !== "from,to") return "invalid_lifecycle_fields";
    if (typeof value.lifecycle.from !== "string" || !Object.hasOwn(CONTRACT_STATES, value.lifecycle.from)) return "invalid_lifecycle_from";
    if (typeof value.lifecycle.to !== "string" || !Object.hasOwn(CONTRACT_STATES, value.lifecycle.to)) return "invalid_lifecycle_to";
  }
  if (value.event === "lifecycle" && value.lifecycle === null) return "lifecycle_event_missing_transition";

  if (!isRecord(value.metadata)) return "invalid_metadata";
  const normalizedMetadata = normalizeReceiptMetadata(value.metadata);
  if (canonicalStringify(normalizedMetadata) !== canonicalStringify(value.metadata)) return "unredacted_metadata";

  return null;
}

interface VerificationCursor {
  count: number;
  previousHash: string | null;
}
/**
 * Encoded resumption state for a bounded receipt page. The cursor is a
 * deterministic, versioned, base64url token — no secret key — so it survives
 * across CLI process invocations. An integrity digest binds the fields so
 * accidental corruption is detected. Security against forgery comes from
 * `verifyCursorPrefix`: on resume the reader stream-verifies the actual ledger
 * bytes from offset 0 through the cursor offset, confirming the real chain has
 * exactly `count` records ending in `previousHash` at `offset`. A cursor that
 * does not match the live ledger therefore fails closed; it cannot skip or hide
 * corruption.
 */
const CURSOR_VERSION = 1;
const CURSOR_DOMAIN = "taskfence:receipt-cursor:v1";

interface ReceiptCursorPayload {
  v: typeof CURSOR_VERSION;
  offset: number;
  count: number;
  previousHash: string | null;
  byteLength: number;
  digest: string;
}

function cursorDigest(
  offset: number,
  count: number,
  previousHash: string | null,
  byteLength: number,
): string {
  // Canonical, order-independent encoding of the cursor fields under a fixed
  // domain-separation prefix. Deterministic across processes and Node versions.
  return createHash("sha256")
    .update(CURSOR_DOMAIN)
    .update("\noffset:")
    .update(offset.toString())
    .update("\ncount:")
    .update(count.toString())
    .update("\npreviousHash:")
    .update(previousHash ?? "")
    .update("\nbyteLength:")
    .update(byteLength.toString())
    .digest("hex");
}

function encodeCursor(
  offset: number,
  count: number,
  previousHash: string | null,
  byteLength: number,
): string {
  const digest = cursorDigest(offset, count, previousHash, byteLength);
  const payload: ReceiptCursorPayload = {
    v: CURSOR_VERSION,
    offset,
    count,
    previousHash,
    byteLength,
    digest,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): ReceiptCursorPayload {
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ReceiptLedgerError(0, "invalid_cursor_encoding");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new ReceiptLedgerError(0, "invalid_cursor_json");
  }
  if (!isRecord(payload)) {
    throw new ReceiptLedgerError(0, "invalid_cursor_shape");
  }
  if (payload.v !== CURSOR_VERSION) {
    throw new ReceiptLedgerError(0, "unsupported_cursor_version");
  }
  const { offset, count, previousHash, byteLength, digest } = payload;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (previousHash !== null && (typeof previousHash !== "string" || !HASH.test(previousHash))) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    typeof digest !== "string"
  ) {
    throw new ReceiptLedgerError(0, "invalid_cursor_fields");
  }
  const expected = cursorDigest(offset, count, previousHash, byteLength);
  if (digest !== expected) {
    throw new ReceiptLedgerError(0, "cursor_digest_mismatch");
  }
  return { v: payload.v, offset, count, previousHash, byteLength, digest };
}

function verifyRecord(
  record: ReceiptRecord,
  canonicalRoot: string,
  rootHash: string,
  cursor: VerificationCursor,
): Extract<ReceiptVerificationResult, { valid: false }> | null {
  const index = cursor.count;
  const schemaFailure = validateReceiptRecord(record);
  if (schemaFailure !== null) {
    return { valid: false, index, reason: schemaFailure };
  }
  if (record.sequence !== index + 1) {
    return { valid: false, index, reason: `sequence_expected:${index + 1}` };
  }
  if (record.root !== canonicalRoot) {
    return { valid: false, index, reason: "root_mismatch" };
  }
  if (record.rootHash !== rootHash) {
    return { valid: false, index, reason: "root_hash_mismatch" };
  }
  if (record.previousHash !== cursor.previousHash) {
    return { valid: false, index, reason: "previous_hash_mismatch" };
  }
  const unsigned: Partial<ReceiptRecord> = { ...record };
  delete unsigned.recordHash;
  if (record.recordHash !== sha256(canonicalStringify(unsigned))) {
    return { valid: false, index, reason: "record_hash_mismatch" };
  }
  cursor.count += 1;
  cursor.previousHash = record.recordHash;
  return null;
}

function compareAnchor(
  verification: Extract<ReceiptVerificationResult, { valid: true }>,
  expected: ReceiptAnchor | undefined,
): ReceiptVerificationResult {
  if (expected === undefined) return verification;
  if (verification.count !== expected.count) {
    return {
      valid: false,
      index: verification.count,
      reason: "anchor_count_mismatch",
    };
  }
  if (verification.lastHash !== expected.lastHash) {
    return {
      valid: false,
      index: verification.count,
      reason: "anchor_last_hash_mismatch",
    };
  }
  if (verification.byteLength !== expected.byteLength) {
    return {
      valid: false,
      index: verification.count,
      reason: "anchor_byte_length_mismatch",
    };
  }
  return verification;
}

async function parseLine(
  bytes: Buffer,
  canonicalRoot: string,
  rootHash: string,
  cursor: VerificationCursor,
): Promise<
  | { record: ReceiptRecord }
  | { failure: Extract<ReceiptVerificationResult, { valid: false }> }
> {
  if (bytes.length === 0) {
    return { failure: { valid: false, index: cursor.count, reason: "empty_line" } };
  }
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { failure: { valid: false, index: cursor.count, reason: "invalid_utf8" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { failure: { valid: false, index: cursor.count, reason: "invalid_json" } };
  }
  if (!isRecord(parsed)) {
    return { failure: { valid: false, index: cursor.count, reason: "record_not_object" } };
  }
  try {
    if (canonicalStringify(parsed) !== line) {
      return { failure: { valid: false, index: cursor.count, reason: "noncanonical_json" } };
    }
  } catch {
    return { failure: { valid: false, index: cursor.count, reason: "noncanonical_json" } };
  }
  const record = parsed as unknown as ReceiptRecord;
  const failure = verifyRecord(record, canonicalRoot, rootHash, cursor);
  return failure === null ? { record } : { failure };
}

export interface InspectReceiptsOptions {
  /**
   * Stop after this many records have been verified (independent of
   * `collectRecords`). The scan reports `hasMore: true` and `nextOffset`
   * pointing at the first unprocessed record so callers can resume.
   */
  maxRecords?: number;
  /**
   * Byte offset to resume scanning from. Combined with a `startCursor`
   * describing the hash-chain state at that offset, this enables paging.
   */
  startOffset?: number;
  /** Hash-chain state expected at `startOffset`. */
  startCursor?: VerificationCursor;
  /**
   * Invoked for each verified record when `collectRecords` is false. Lets
   * callers stream records with constant memory instead of collecting them.
   */
  onRecord?: (record: ReceiptRecord) => void;
}

export async function inspectReceiptFile(
  receiptsFile: string,
  canonicalRoot: string,
  rootHash: string,
  expectedAnchor?: ReceiptAnchor,
  collectRecords = true,
  options: InspectReceiptsOptions = {},
): Promise<InspectedLedger> {
  let handle: FileHandle | undefined;
  try {
    const opened = await openSecureFile(
      receiptsFile,
      fsConstants.O_RDONLY,
      {
        mode: RECEIPT_FILE_MODE,
        maxBytes: MAX_RECEIPT_LEDGER_BYTES,
        label: "Receipt ledger",
      },
    );
    handle = opened.handle;
    const byteLength = opened.metadata.size;
    const records: ReceiptRecord[] = [];
    const cursor: VerificationCursor = {
      count: options.startCursor?.count ?? 0,
      previousHash: options.startCursor?.previousHash ?? null,
    };
    const limit = options.maxRecords;
    let emitted = 0;
    let pending = Buffer.alloc(0);
    let position = options.startOffset ?? 0;

    if (position > byteLength) {
      return {
        records,
        verification: {
          valid: false,
          index: cursor.count,
          reason: "cursor_offset_beyond_eof",
        },
      };
    }

    while (position < byteLength) {
      const length = Math.min(READ_CHUNK_BYTES, byteLength - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) {
        return {
          records,
          verification: {
            valid: false,
            index: cursor.count,
            reason: "unexpected_eof",
          },
        };
      }
      position += bytesRead;
      const data = pending.length === 0
        ? chunk.subarray(0, bytesRead)
        : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (let newline = data.indexOf(0x0a, start); newline !== -1; newline = data.indexOf(0x0a, start)) {
        const lineBytes = data.subarray(start, newline);
        if (lineBytes.length > MAX_RECEIPT_LINE_BYTES) {
          return {
            records,
            verification: {
              valid: false,
              index: cursor.count,
              reason: "line_too_large",
            },
          };
        }
        const parsed = await parseLine(
          lineBytes,
          canonicalRoot,
          rootHash,
          cursor,
        );
        if ("failure" in parsed) {
          return { records, verification: parsed.failure };
        }
        if (collectRecords) records.push(parsed.record);
        if (options.onRecord !== undefined) options.onRecord(parsed.record);
        emitted += 1;
        start = newline + 1;
        if (limit !== undefined && emitted >= limit) {
          // Page filled: compute the offset of the next unprocessed record.
          const remaining = Buffer.from(data.subarray(start));
          const nextOffset = position - remaining.length;
          return {
            records,
            verification: validVerification(
              cursor.count,
              cursor.previousHash,
              byteLength,
            ),
            nextOffset,
            hasMore: nextOffset < byteLength,
          };
        }
      }
      pending = Buffer.from(data.subarray(start));
      if (pending.length > MAX_RECEIPT_LINE_BYTES) {
        return {
          records,
          verification: {
            valid: false,
            index: cursor.count,
            reason: "line_too_large",
          },
        };
      }
    }

    if (pending.length !== 0) {
      return {
        records,
        verification: {
          valid: false,
          index: cursor.count,
          reason: "unterminated_line",
        },
      };
    }
    const verification = compareAnchor(
      validVerification(cursor.count, cursor.previousHash, byteLength),
      expectedAnchor,
    );
    return { records, verification, nextOffset: byteLength, hasMore: false };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      const verification = compareAnchor(
        validVerification(0, null, 0),
        expectedAnchor,
      );
      return { records: [], verification };
    }
    return {
      records: [],
      verification: {
        valid: false,
        index: 0,
        reason: `ledger_read_failed:${isNodeError(error, "EACCES") ? "EACCES" : (error as NodeJS.ErrnoException).code ?? "unsafe"}`,
      },
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Streams and verifies the complete ledger against the durable state anchor. */
export async function verifyReceiptLedger(root: string): Promise<ReceiptVerificationResult> {
  return withProjectLock(root, async () => {
    const layout = await stateLayout(root);
    const state = await loadProjectState(layout.canonicalRoot);
    const anchor = state?.receiptAnchor ??
      { count: 0, lastHash: null, byteLength: 0 };
    return (
      await inspectReceiptFile(
        layout.receiptsFile,
        layout.canonicalRoot,
        layout.rootHash,
        anchor,
        false,
      )
    ).verification;
  });
}

export interface ListReceiptsOptions {
  /** Maximum records in this page (clamped to MAX_RECEIPT_PAGE_SIZE). */
  limit?: number;
  /** Opaque resumption token returned by a prior page. */
  cursor?: string | null;
}

/**
 * Stream-verifies the ledger prefix [0, cursor.offset) in constant memory,
 * confirming the live ledger actually contains exactly `cursor.count` valid
 * records whose chain ends in `cursor.previousHash` at `cursor.offset`. This is
 * the trust boundary for a cursor: no record is emitted to the caller until the
 * prefix has been re-proven against the current ledger bytes, so a forged,
 * stale, or replayed cursor cannot skip corruption or hide tampering.
 */
async function verifyCursorPrefix(
  receiptsFile: string,
  canonicalRoot: string,
  rootHash: string,
  decoded: ReceiptCursorPayload,
): Promise<void> {
  const inspected = await inspectReceiptFile(
    receiptsFile,
    canonicalRoot,
    rootHash,
    undefined,
    false,
    { maxRecords: decoded.count, startOffset: 0 },
  );
  if (!inspected.verification.valid) {
    throw new ReceiptLedgerError(
      inspected.verification.index,
      `cursor_prefix_invalid:${inspected.verification.reason}`,
    );
  }
  if (inspected.verification.count !== decoded.count) {
    throw new ReceiptLedgerError(decoded.count, "cursor_count_mismatch");
  }
  if (inspected.verification.lastHash !== decoded.previousHash) {
    throw new ReceiptLedgerError(decoded.count, "cursor_hash_mismatch");
  }
  if (inspected.nextOffset !== decoded.offset) {
    throw new ReceiptLedgerError(decoded.count, "cursor_offset_mismatch");
  }
}

/**
 * Returns a bounded page of receipts from `root`. `cursor` resumes from a prior
 * page; the returned `cursor` is `null` on the final page. On resume the reader
 * first stream-verifies the ledger prefix through the cursor offset (constant
 * memory, no collection), so a forged, stale, or replayed cursor fails closed
 * before any record is emitted — it cannot skip or hide corruption. Memory is
 * bounded by the page size regardless of total ledger size (up to 64 GiB).
 */
export async function listReceipts(
  root: string,
  options: ListReceiptsOptions = {},
): Promise<ReceiptPage> {
  return withProjectLock(root, async () => {
    const layout = await stateLayout(root);
    const state = await loadProjectState(layout.canonicalRoot);
    const anchor = state?.receiptAnchor ??
      { count: 0, lastHash: null, byteLength: 0 };
    let limit = options.limit ?? DEFAULT_RECEIPT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ReceiptLedgerError(0, "limit must be a positive integer");
    }
    if (limit > MAX_RECEIPT_PAGE_SIZE) limit = MAX_RECEIPT_PAGE_SIZE;

    let startOffset = 0;
    let startCursor: VerificationCursor = { count: 0, previousHash: null };
    if (options.cursor !== undefined && options.cursor !== null) {
      const decoded = decodeCursor(options.cursor);
      if (decoded.byteLength !== anchor.byteLength) {
        throw new ReceiptLedgerError(0, "cursor_ledger_changed");
      }
      // Re-prove the prefix against the live ledger bytes before trusting the
      // cursor's offset/count/hash to resume from.
      await verifyCursorPrefix(
        layout.receiptsFile,
        layout.canonicalRoot,
        layout.rootHash,
        decoded,
      );
      startOffset = decoded.offset;
      startCursor = {
        count: decoded.count,
        previousHash: decoded.previousHash,
      };
    }

    const inspected = await inspectReceiptFile(
      layout.receiptsFile,
      layout.canonicalRoot,
      layout.rootHash,
      anchor,
      true,
      { maxRecords: limit, startOffset, startCursor },
    );
    if (!inspected.verification.valid) {
      throw new ReceiptLedgerError(
        inspected.verification.index,
        inspected.verification.reason,
      );
    }
    const nextOffset = inspected.nextOffset ?? anchor.byteLength;
    const nextCursor = inspected.hasMore
      ? encodeCursor(
          nextOffset,
          inspected.verification.count,
          inspected.verification.lastHash,
          anchor.byteLength,
        )
      : null;
    return { records: inspected.records, cursor: nextCursor };
  });
}

/**
 * Streams every receipt in the ledger to `emit`, verifying the full hash chain
 * against the durable anchor. Only one record is held in memory at a time, so
 * a 64 GiB ledger never causes unbounded allocation. Returns the verification
 * result once the stream completes.
 */
export async function streamReceipts(
  root: string,
  emit: (record: ReceiptRecord) => void,
): Promise<ReceiptVerificationResult> {
  return withProjectLock(root, async () => {
    const layout = await stateLayout(root);
    const state = await loadProjectState(layout.canonicalRoot);
    const anchor = state?.receiptAnchor ??
      { count: 0, lastHash: null, byteLength: 0 };
    const inspected = await inspectReceiptFile(
      layout.receiptsFile,
      layout.canonicalRoot,
      layout.rootHash,
      anchor,
      false,
      { onRecord: emit },
    );
    return inspected.verification;
  });
}

/**
 * Compatibility helper that returns verified receipts. Bounded to
 * MAX_RECEIPTS_COLLECTED records — it rejects rather than allocate an unbounded
 * array over the accepted 64 GiB ledger. Prefer `listReceipts` for paging or
 * `streamReceipts` for full-ledger processing with constant memory.
 */
export async function readReceipts(root: string): Promise<ReceiptRecord[]> {
  return withProjectLock(root, async () => {
    const layout = await stateLayout(root);
    const state = await loadProjectState(layout.canonicalRoot);
    const anchor = state?.receiptAnchor ??
      { count: 0, lastHash: null, byteLength: 0 };
    const inspected = await inspectReceiptFile(
      layout.receiptsFile,
      layout.canonicalRoot,
      layout.rootHash,
      anchor,
      true,
      { maxRecords: MAX_RECEIPTS_COLLECTED + 1 },
    );
    if (!inspected.verification.valid) {
      throw new ReceiptLedgerError(
        inspected.verification.index,
        inspected.verification.reason,
      );
    }
    if (inspected.hasMore || inspected.records.length > MAX_RECEIPTS_COLLECTED) {
      throw new ReceiptLedgerError(
        inspected.records.length,
        `ledger_exceeds_collect_limit:${MAX_RECEIPTS_COLLECTED}`,
      );
    }
    return inspected.records;
  });
}
