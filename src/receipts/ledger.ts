import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { rename, unlink, type FileHandle } from "node:fs/promises";
import { canonicalStringify, sha256 } from "../contract/canonical.js";
import { stateLayout, type StateLayout } from "../state/layout.js";
import { withProjectLock } from "../state/lock.js";
import {
  createSecureFile,
  isNodeError,
  openSecureFile,
  syncSecureDirectory,
} from "../state/secure-file.js";
import { createProjectState } from "../state/model.js";
import {
  loadProjectState,
  MAX_STATE_BYTES,
  validateProjectState,
  writeProjectStateUnderLock,
} from "../state/store.js";
import type {
  Decision,
  ProjectState,
  ReceiptAnchor,
  ReceiptRecord,
} from "../types.js";
import { normalizeReceiptMetadata } from "./redact.js";
import {
  MAX_RECEIPT_LEDGER_BYTES,
  MAX_RECEIPT_LINE_BYTES,
  RECEIPT_FILE_MODE,
  ReceiptLedgerError,
  validateReceiptRecord,
} from "./verify.js";

const HASH = /^[a-f0-9]{64}$/;
const TRANSACTION_FILE_MODE = 0o600;
const MAX_TRANSACTION_RECEIPTS = 16;
const MAX_TRANSACTION_BYTES =
  MAX_STATE_BYTES + MAX_TRANSACTION_RECEIPTS * MAX_RECEIPT_LINE_BYTES + 1024 * 1024;

const ZERO_ANCHOR: ReceiptAnchor = {
  count: 0,
  lastHash: null,
  byteLength: 0,
};

type ManagedReceiptField =
  | "version"
  | "sequence"
  | "timestamp"
  | "root"
  | "rootHash"
  | "previousHash"
  | "recordHash";

export type ReceiptInput = Omit<ReceiptRecord, ManagedReceiptField> &
  Partial<Pick<ReceiptRecord, ManagedReceiptField>>;

export interface ReceiptCommitResult {
  state: ProjectState;
  receipts: ReceiptRecord[];
}

/**
 * Raised when a receipt/state transaction has a durable write-ahead log (its
 * commit point) but its final on-disk outcome could not be established before
 * returning. Unlike an ordinary failure, the caller cannot assume the request
 * was rejected: a later lock acquisition may finish committing it. Callers
 * must surface this distinctly and preserve recoverability.
 */
export class IndeterminateTransactionError extends Error {
  readonly root: string;
  readonly transactionFile: string;

  constructor(root: string, transactionFile: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndeterminateTransactionError";
    this.root = root;
    this.transactionFile = transactionFile;
  }
}

/**
 * Optional fault-injection seam for transaction durability tests. Each hook,
 * when set, may throw to simulate a failure at that post-WAL phase. Hooks are
 * never set in production code paths; tests opt in explicitly.
 */
export interface TransactionFaultHooks {
  beforeReceiptAppend?: () => Promise<void>;
  beforeStateInstall?: () => Promise<void>;
  beforeWalClear?: () => Promise<void>;
}

const FAULT_HOOKS: TransactionFaultHooks = {};

/**
 * Test-only seam: installs transaction fault hooks. Returns a function that
 * restores the previous hook state. Never call from production code.
 */
export function __setTransactionFaultHooks(
  hooks: Partial<TransactionFaultHooks> | null,
): () => void {
  const previous = { ...FAULT_HOOKS };
  for (const key of Object.keys(FAULT_HOOKS) as (keyof TransactionFaultHooks)[]) {
    delete FAULT_HOOKS[key];
  }
  if (hooks) {
    for (const [key, value] of Object.entries(hooks)) {
      if (value !== undefined) {
        (FAULT_HOOKS as Record<string, () => Promise<void>>)[key] = value;
      }
    }
  }
  return () => {
    for (const key of Object.keys(FAULT_HOOKS) as (keyof TransactionFaultHooks)[]) {
      delete FAULT_HOOKS[key];
    }
    Object.assign(FAULT_HOOKS, previous);
  };
}

interface ReceiptTransaction {
  version: 1;
  root: string;
  rootHash: string;
  beforeStateHash: string | null;
  afterStateHash: string;
  priorAnchor: ReceiptAnchor;
  receipts: ReceiptRecord[];
  nextState: ProjectState;
}

interface PreparedReceipts {
  records: ReceiptRecord[];
  bytes: Buffer;
  anchor: ReceiptAnchor;
}

function requireHash(value: string, name: string): void {
  if (!HASH.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hash`);
  }
}

function canonicalTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new TypeError("Receipt timestamp must be a canonical ISO-8601 instant");
  }
  return timestamp;
}

function stateHash(state: ProjectState): string {
  return sha256(canonicalStringify(state));
}

function sameAnchor(left: ReceiptAnchor, right: ReceiptAnchor): boolean {
  return left.count === right.count &&
    left.lastHash === right.lastHash &&
    left.byteLength === right.byteLength;
}

function validateAnchor(anchor: ReceiptAnchor, label: string): void {
  if (
    !Number.isSafeInteger(anchor.count) ||
    anchor.count < 0 ||
    !Number.isSafeInteger(anchor.byteLength) ||
    anchor.byteLength < 0 ||
    anchor.byteLength > MAX_RECEIPT_LEDGER_BYTES ||
    (anchor.lastHash !== null && !HASH.test(anchor.lastHash)) ||
    (anchor.count === 0) !== (anchor.lastHash === null) ||
    (anchor.count === 0) !== (anchor.byteLength === 0)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function buildReceipt(
  layout: StateLayout,
  input: ReceiptInput,
  sequence: number,
  previousHash: string | null,
): ReceiptRecord {
  requireHash(input.contractHash, "contractHash");
  requireHash(input.checkpointHash, "checkpointHash");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new TypeError("revision must be a positive safe integer");
  }
  if (input.inputHash !== null) requireHash(input.inputHash, "inputHash");
  if (input.resultHash !== null) requireHash(input.resultHash, "resultHash");

  const metadata = normalizeReceiptMetadata(input.metadata);
  const decision = input.decision === null
    ? null
    : normalizeReceiptMetadata({
        allowed: input.decision.allowed,
        code: input.decision.code,
        reason: input.decision.reason,
      }) as unknown as Decision;
  const unsigned: Omit<ReceiptRecord, "recordHash"> = {
    version: 1,
    sequence,
    timestamp: canonicalTimestamp(input.timestamp),
    event: input.event,
    root: layout.canonicalRoot,
    rootHash: layout.rootHash,
    contractHash: input.contractHash,
    checkpointHash: input.checkpointHash,
    revision: input.revision,
    runtime: input.runtime,
    sessionId: input.sessionId,
    callId: input.callId,
    toolName: input.toolName,
    inputHash: input.inputHash,
    decision,
    lifecycle: input.lifecycle,
    resultHash: input.resultHash,
    metadata,
    previousHash,
  };
  const receipt: ReceiptRecord = {
    ...unsigned,
    recordHash: sha256(canonicalStringify(unsigned)),
  };
  const schemaFailure = validateReceiptRecord(receipt);
  if (schemaFailure !== null) {
    throw new TypeError(`Invalid receipt input: ${schemaFailure}`);
  }
  const lineBytes = Buffer.byteLength(canonicalStringify(receipt), "utf8");
  if (lineBytes === 0 || lineBytes > MAX_RECEIPT_LINE_BYTES) {
    throw new TypeError(`Receipt exceeds ${MAX_RECEIPT_LINE_BYTES} bytes`);
  }
  return receipt;
}

function prepareReceipts(
  layout: StateLayout,
  inputs: readonly ReceiptInput[],
  priorAnchor: ReceiptAnchor,
): PreparedReceipts {
  if (inputs.length === 0 || inputs.length > MAX_TRANSACTION_RECEIPTS) {
    throw new TypeError(
      `Receipt transaction must contain 1-${MAX_TRANSACTION_RECEIPTS} records`,
    );
  }
  const records: ReceiptRecord[] = [];
  const lines: Buffer[] = [];
  let previousHash = priorAnchor.lastHash;
  let byteLength = priorAnchor.byteLength;
  for (let index = 0; index < inputs.length; index += 1) {
    const record = buildReceipt(
      layout,
      inputs[index],
      priorAnchor.count + index + 1,
      previousHash,
    );
    const line = Buffer.from(`${canonicalStringify(record)}\n`, "utf8");
    byteLength += line.length;
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_RECEIPT_LEDGER_BYTES) {
      throw new Error("Receipt ledger byte length exceeds its durable bound");
    }
    records.push(record);
    lines.push(line);
    previousHash = record.recordHash;
  }
  return {
    records,
    bytes: Buffer.concat(lines),
    anchor: {
      count: priorAnchor.count + records.length,
      lastHash: previousHash,
      byteLength,
    },
  };
}

async function validateAnchoredTail(
  handle: FileHandle,
  anchor: ReceiptAnchor,
  layout: StateLayout,
): Promise<void> {
  validateAnchor(anchor, "Receipt anchor");
  if (anchor.count === 0) return;
  const readLength = Math.min(
    anchor.byteLength,
    MAX_RECEIPT_LINE_BYTES + 2,
  );
  const buffer = Buffer.allocUnsafe(readLength);
  const { bytesRead } = await handle.read(
    buffer,
    0,
    readLength,
    anchor.byteLength - readLength,
  );
  if (bytesRead !== readLength || buffer[readLength - 1] !== 0x0a) {
    throw new ReceiptLedgerError(anchor.count - 1, "anchor_tail_unreadable");
  }
  const previousNewline = buffer.lastIndexOf(0x0a, readLength - 2);
  const start = previousNewline === -1 ? 0 : previousNewline + 1;
  if (previousNewline === -1 && anchor.byteLength > MAX_RECEIPT_LINE_BYTES + 1) {
    throw new ReceiptLedgerError(anchor.count - 1, "anchor_tail_line_too_large");
  }
  const bytes = buffer.subarray(start, readLength - 1);
  let line: string;
  let parsed: unknown;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(line);
  } catch {
    throw new ReceiptLedgerError(anchor.count - 1, "anchor_tail_invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    canonicalStringify(parsed) !== line
  ) {
    throw new ReceiptLedgerError(anchor.count - 1, "anchor_tail_noncanonical");
  }
  const record = parsed as unknown as ReceiptRecord;
  const schemaFailure = validateReceiptRecord(record);
  if (
    schemaFailure !== null ||
    record.sequence !== anchor.count ||
    record.recordHash !== anchor.lastHash ||
    record.root !== layout.canonicalRoot ||
    record.rootHash !== layout.rootHash
  ) {
    throw new ReceiptLedgerError(
      anchor.count - 1,
      schemaFailure ?? "anchor_tail_mismatch",
    );
  }
}

async function openLedger(
  layout: StateLayout,
  allowCreate: boolean,
): Promise<{ handle: FileHandle; size: number; created: boolean }> {
  try {
    const opened = await openSecureFile(
      layout.receiptsFile,
      fsConstants.O_RDWR,
      {
        mode: RECEIPT_FILE_MODE,
        maxBytes: MAX_RECEIPT_LEDGER_BYTES,
        label: "Receipt ledger",
      },
    );
    return { handle: opened.handle, size: opened.metadata.size, created: false };
  } catch (error) {
    if (!allowCreate || !isNodeError(error, "ENOENT")) throw error;
    try {
      const created = await createSecureFile(
        layout.receiptsFile,
        fsConstants.O_RDWR,
        {
          mode: RECEIPT_FILE_MODE,
          maxBytes: MAX_RECEIPT_LEDGER_BYTES,
          label: "Receipt ledger",
        },
      );
      await created.handle.sync();
      await syncSecureDirectory(layout.projectDir);
      return { handle: created.handle, size: 0, created: true };
    } catch (createError) {
      if (!isNodeError(createError, "EEXIST")) throw createError;
      const opened = await openSecureFile(
        layout.receiptsFile,
        fsConstants.O_RDWR,
        {
          mode: RECEIPT_FILE_MODE,
          maxBytes: MAX_RECEIPT_LEDGER_BYTES,
          label: "Receipt ledger",
        },
      );
      return { handle: opened.handle, size: opened.metadata.size, created: false };
    }
  }
}

async function validateFastLedgerAnchor(
  layout: StateLayout,
  anchor: ReceiptAnchor,
): Promise<void> {
  const opened = await openLedger(layout, anchor.count === 0);
  try {
    if (opened.size !== anchor.byteLength) {
      throw new ReceiptLedgerError(anchor.count, "anchor_byte_length_mismatch");
    }
    await validateAnchoredTail(opened.handle, anchor, layout);
  } finally {
    await opened.handle.close();
  }
}

async function writeAll(
  handle: FileHandle,
  bytes: Buffer,
  offset: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      offset + written,
    );
    if (result.bytesWritten <= 0) {
      throw new Error(`Short receipt append after ${written} bytes`);
    }
    written += result.bytesWritten;
  }
}

async function appendPreparedBytes(
  layout: StateLayout,
  priorAnchor: ReceiptAnchor,
  bytes: Buffer,
): Promise<void> {
  const opened = await openLedger(layout, priorAnchor.count === 0);
  try {
    if (opened.size !== priorAnchor.byteLength) {
      throw new ReceiptLedgerError(priorAnchor.count, "anchor_byte_length_mismatch");
    }
    await validateAnchoredTail(opened.handle, priorAnchor, layout);
    try {
      await writeAll(opened.handle, bytes, priorAnchor.byteLength);
      await opened.handle.sync();
    } catch (appendError) {
      try {
        await opened.handle.truncate(priorAnchor.byteLength);
        await opened.handle.sync();
      } catch (truncateError) {
        throw new AggregateError(
          [appendError, truncateError],
          "Receipt append failed and its partial bytes could not be rolled back",
        );
      }
      throw appendError;
    }
  } finally {
    await opened.handle.close();
  }
}

function transactionBytes(transaction: ReceiptTransaction): Buffer {
  const serialized = `${canonicalStringify(transaction)}\n`;
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.length > MAX_TRANSACTION_BYTES) {
    throw new Error(`Receipt transaction exceeds ${MAX_TRANSACTION_BYTES} bytes`);
  }
  return bytes;
}

async function writeTransaction(
  layout: StateLayout,
  transaction: ReceiptTransaction,
): Promise<void> {
  let existing: FileHandle | undefined;
  try {
    existing = (
      await openSecureFile(layout.transactionFile, fsConstants.O_RDONLY, {
        mode: TRANSACTION_FILE_MODE,
        maxBytes: MAX_TRANSACTION_BYTES,
        label: "Receipt transaction WAL",
      })
    ).handle;
    throw new Error("A receipt transaction is already pending recovery");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  } finally {
    await existing?.close().catch(() => undefined);
  }

  const temporaryFile = `${layout.projectDir}/.transaction-${process.pid}-${randomUUID()}.tmp`;
  let temporaryHandle: FileHandle | undefined;
  try {
    const created = await createSecureFile(
      temporaryFile,
      fsConstants.O_WRONLY,
      {
        mode: TRANSACTION_FILE_MODE,
        maxBytes: MAX_TRANSACTION_BYTES,
        label: "Temporary receipt transaction WAL",
      },
    );
    temporaryHandle = created.handle;
    await temporaryHandle.writeFile(transactionBytes(transaction));
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryFile, layout.transactionFile);
    await syncSecureDirectory(layout.projectDir);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
}

async function clearTransaction(layout: StateLayout): Promise<void> {
  const opened = await openSecureFile(
    layout.transactionFile,
    fsConstants.O_RDONLY,
    {
      mode: TRANSACTION_FILE_MODE,
      maxBytes: MAX_TRANSACTION_BYTES,
      label: "Receipt transaction WAL",
    },
  );
  await opened.handle.close();
  await unlink(layout.transactionFile);
  await syncSecureDirectory(layout.projectDir);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validateTransaction(
  value: unknown,
  layout: StateLayout,
): ReceiptTransaction {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "version",
      "root",
      "rootHash",
      "beforeStateHash",
      "afterStateHash",
      "priorAnchor",
      "receipts",
      "nextState",
    ])
  ) {
    throw new Error("Receipt transaction WAL has invalid fields");
  }
  const transaction = value as unknown as ReceiptTransaction;
  if (
    transaction.version !== 1 ||
    transaction.root !== layout.canonicalRoot ||
    transaction.rootHash !== layout.rootHash ||
    (
      transaction.beforeStateHash !== null &&
      !HASH.test(transaction.beforeStateHash)
    ) ||
    !HASH.test(transaction.afterStateHash) ||
    !Array.isArray(transaction.receipts) ||
    transaction.receipts.length === 0 ||
    transaction.receipts.length > MAX_TRANSACTION_RECEIPTS
  ) {
    throw new Error("Receipt transaction WAL is malformed or belongs to another root");
  }
  validateAnchor(transaction.priorAnchor, "Transaction prior receipt anchor");
  validateProjectState(transaction.nextState, layout);
  if (stateHash(transaction.nextState) !== transaction.afterStateHash) {
    throw new Error("Receipt transaction after-state hash mismatch");
  }

  let previousHash = transaction.priorAnchor.lastHash;
  let byteLength = transaction.priorAnchor.byteLength;
  for (let index = 0; index < transaction.receipts.length; index += 1) {
    const receipt = transaction.receipts[index];
    const failure = validateReceiptRecord(receipt);
    const line = Buffer.from(`${canonicalStringify(receipt)}\n`, "utf8");
    if (
      failure !== null ||
      line.length - 1 > MAX_RECEIPT_LINE_BYTES ||
      receipt.sequence !== transaction.priorAnchor.count + index + 1 ||
      receipt.previousHash !== previousHash ||
      receipt.root !== layout.canonicalRoot ||
      receipt.rootHash !== layout.rootHash
    ) {
      throw new Error(`Receipt transaction contains an invalid record at ${index}`);
    }
    const unsigned: Partial<ReceiptRecord> = { ...receipt };
    delete unsigned.recordHash;
    if (receipt.recordHash !== sha256(canonicalStringify(unsigned))) {
      throw new Error(`Receipt transaction record hash mismatch at ${index}`);
    }
    previousHash = receipt.recordHash;
    byteLength += line.length;
  }
  const expectedAnchor: ReceiptAnchor = {
    count: transaction.priorAnchor.count + transaction.receipts.length,
    lastHash: previousHash,
    byteLength,
  };
  if (!sameAnchor(transaction.nextState.receiptAnchor, expectedAnchor)) {
    throw new Error("Receipt transaction next-state anchor mismatch");
  }
  return transaction;
}

async function readTransaction(
  layout: StateLayout,
): Promise<ReceiptTransaction | null> {
  let handle: FileHandle | undefined;
  try {
    const opened = await openSecureFile(
      layout.transactionFile,
      fsConstants.O_RDONLY,
      {
        mode: TRANSACTION_FILE_MODE,
        maxBytes: MAX_TRANSACTION_BYTES,
        label: "Receipt transaction WAL",
      },
    );
    handle = opened.handle;
    const bytes = await handle.readFile();
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
      throw new Error("Receipt transaction WAL is empty or unterminated");
    }
    let text: string;
    let parsed: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, -1),
      );
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Receipt transaction WAL is not valid UTF-8 JSON");
    }
    if (canonicalStringify(parsed) !== text) {
      throw new Error("Receipt transaction WAL is not canonical JSON");
    }
    return validateTransaction(parsed, layout);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function receiptSegment(transaction: ReceiptTransaction): Buffer {
  return Buffer.concat(
    transaction.receipts.map((receipt) =>
      Buffer.from(`${canonicalStringify(receipt)}\n`, "utf8")
    ),
  );
}

async function readExact(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== length) throw new Error("Unexpected EOF in receipt ledger");
  return bytes;
}

/** Completes an interrupted receipt/state pair. The caller must hold the lock. */
export async function recoverProjectTransactionUnderLock(root: string): Promise<void> {
  const layout = await stateLayout(root);
  const transaction = await readTransaction(layout);
  if (transaction === null) return;

  const current = await loadProjectState(layout.canonicalRoot);
  const currentHash = current === null ? null : stateHash(current);
  await applyTransactionUnderLock(layout, transaction, currentHash);
}

/**
 * Reconciles a durable receipt/state transaction to its definitive committed
 * outcome. The caller must hold the lock. The WAL is the commit point, so this
 * makes the ledger bytes, state file, and WAL-clear consistent before returning.
 */
async function applyTransactionUnderLock(
  layout: StateLayout,
  transaction: ReceiptTransaction,
  currentHash: string | null,
): Promise<void> {
  if (
    currentHash !== transaction.beforeStateHash &&
    currentHash !== transaction.afterStateHash
  ) {
    throw new Error(
      "Ambiguous receipt transaction divergence: state matches neither WAL boundary",
    );
  }

  const segment = receiptSegment(transaction);
  const finalLength = transaction.priorAnchor.byteLength + segment.length;
  const opened = await openLedger(
    layout,
    transaction.priorAnchor.count === 0,
  );
  try {
    if (
      opened.size < transaction.priorAnchor.byteLength ||
      opened.size > finalLength
    ) {
      throw new Error(
        "Ambiguous receipt transaction divergence: ledger length is outside WAL boundaries",
      );
    }
    await validateAnchoredTail(opened.handle, transaction.priorAnchor, layout);
    const appendedLength = opened.size - transaction.priorAnchor.byteLength;
    if (appendedLength > 0) {
      const durablePrefix = await readExact(
        opened.handle,
        appendedLength,
        transaction.priorAnchor.byteLength,
      );
      if (!durablePrefix.equals(segment.subarray(0, appendedLength))) {
        throw new Error(
          "Ambiguous receipt transaction divergence: appended bytes differ from WAL",
        );
      }
    }
    if (opened.size !== finalLength) {
      await opened.handle.truncate(transaction.priorAnchor.byteLength);
      await opened.handle.sync();
      await writeAll(
        opened.handle,
        segment,
        transaction.priorAnchor.byteLength,
      );
      await opened.handle.sync();
    }
  } finally {
    await opened.handle.close();
  }

  if (currentHash === transaction.beforeStateHash) {
    await writeProjectStateUnderLock(transaction.nextState);
  }
  await clearTransaction(layout);
}

/**
 * Durably commits receipts and their resulting state anchor as one recoverable
 * write-ahead transaction. The caller must hold the root-scoped project lock.
 */
export async function commitStateAndReceiptsUnderLock(
  root: string,
  before: ProjectState | null,
  after: ProjectState,
  inputs: readonly ReceiptInput[],
): Promise<ReceiptCommitResult> {
  const layout = await stateLayout(root);
  const current = await loadProjectState(layout.canonicalRoot);
  const currentHash = current === null ? null : stateHash(current);
  const beforeHash = before === null ? null : stateHash(before);
  if (currentHash !== beforeHash) {
    throw new Error("Stale state supplied to receipt transaction");
  }
  const priorAnchor = before?.receiptAnchor ?? ZERO_ANCHOR;
  validateAnchor(priorAnchor, "Durable receipt anchor");
  await validateFastLedgerAnchor(layout, priorAnchor);

  const prepared = prepareReceipts(layout, inputs, priorAnchor);
  const nextState: ProjectState = {
    ...after,
    receiptAnchor: prepared.anchor,
  };
  validateProjectState(nextState, layout);
  const transaction: ReceiptTransaction = {
    version: 1,
    root: layout.canonicalRoot,
    rootHash: layout.rootHash,
    beforeStateHash: beforeHash,
    afterStateHash: stateHash(nextState),
    priorAnchor: { ...priorAnchor },
    receipts: prepared.records,
    nextState,
  };

  // The durable WAL is the transaction commit point: once written, an ordinary
  // failure must never later surface as a committed transition that the caller
  // was told was rejected. Drive post-WAL phases to a definitive committed
  // outcome, or surface an explicit indeterminate result that preserves
  // recoverability rather than a misleading rejection.
  await writeTransaction(layout, transaction);

  let postWalError: unknown;
  try {
    await FAULT_HOOKS.beforeReceiptAppend?.();
    await appendPreparedBytes(layout, priorAnchor, prepared.bytes);
    await FAULT_HOOKS.beforeStateInstall?.();
    await writeProjectStateUnderLock(nextState);
    await FAULT_HOOKS.beforeWalClear?.();
    await clearTransaction(layout);
    return { state: nextState, receipts: prepared.records };
  } catch (error) {
    postWalError = error;
  }

  // The WAL is durable, so synchronously finish to a definitive committed
  // result before returning. If this also fails, the outcome cannot be
  // established: neither a clean commit nor a clean abort is possible.
  try {
    const afterCurrent = await loadProjectState(layout.canonicalRoot);
    const afterHash = afterCurrent === null ? null : stateHash(afterCurrent);
    await applyTransactionUnderLock(layout, transaction, afterHash);
    return { state: nextState, receipts: prepared.records };
  } catch (finishError) {
    throw new IndeterminateTransactionError(
      layout.canonicalRoot,
      layout.transactionFile,
      "Receipt transaction committed its write-ahead log but could not establish a definitive on-disk outcome; recovery may complete it on the next lock acquisition",
      { cause: new AggregateError([postWalError, finishError], "Post-WAL finish failed") },
    );
  }
}

/** Appends one canonical receipt while the caller holds the root lock. */
export async function appendReceiptUnderLock(
  root: string,
  input: ReceiptInput,
): Promise<ReceiptRecord> {
  const durable = await loadProjectState(root);
  const layout = await stateLayout(root);
  const state = durable ??
    createProjectState(
      layout.canonicalRoot,
      layout.rootHash,
      new Date().toISOString(),
    );
  const committed = await commitStateAndReceiptsUnderLock(
    root,
    durable,
    state,
    [input],
  );
  return committed.receipts[0];
}

/** Appends one canonical, hash-chained receipt under the root-scoped lock. */
export async function appendReceipt(
  root: string,
  input: ReceiptInput,
): Promise<ReceiptRecord> {
  return withProjectLock(root, () => appendReceiptUnderLock(root, input));
}
