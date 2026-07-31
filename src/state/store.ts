import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { rename, unlink, type FileHandle } from "node:fs/promises";
import type {
  CheckpointManifest,
  ContractState,
  PendingMutation,
  ProjectState,
  ReceiptAnchor,
} from "../types.js";
import { canonicalStringify, sha256 } from "../contract/canonical.js";
import { parseContractJson } from "../contract/extract.js";
import { validateCheckpointManifest } from "../checkpoint/compare.js";
import { stateLayout, type StateLayout } from "./layout.js";
import { withProjectLock } from "./lock.js";
import {
  createSecureFile,
  isNodeError,
  openSecureFile,
  syncSecureDirectory,
} from "./secure-file.js";
import {
  CONTRACT_STATES,
  STATE_SCHEMA_VERSION,
  StateStoreError,
  isAuthorityIdentifier,
} from "./model.js";

const STATE_FILE_MODE = 0o600;
export const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_LEDGER_BYTES = 64 * 1024 * 1024 * 1024;
const PROJECT_STATE_KEYS = [
  "schemaVersion",
  "root",
  "rootHash",
  "status",
  "generation",
  "revision",
  "contract",
  "checkpoint",
  "pendingMutation",
  "authority",
  "reason",
  "updatedAt",
  "receiptAnchor",
] as const;
const CONTRACT_STATE_LOOKUP: Readonly<Record<ContractState, true>> = Object.fromEntries(
  CONTRACT_STATES.map((state) => [state, true]),
) as Record<ContractState, true>;

export { stateLayout } from "./layout.js";

export async function loadProjectState(root: string): Promise<ProjectState | null> {
  const layout = await stateLayout(root);
  let handle: FileHandle | undefined;
  try {
    const opened = await openSecureFile(
      layout.stateFile,
      fsConstants.O_RDONLY,
      {
        mode: STATE_FILE_MODE,
        maxBytes: MAX_STATE_BYTES,
        label: "State file",
      },
    );
    handle = opened.handle;
    const serialized = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = parseContractJson(serialized);
    } catch (error) {
      throw new StateStoreError(
        "STATE_CORRUPT",
        `State file contains invalid JSON: ${layout.stateFile}`,
        { cause: error },
      );
    }
    return validateProjectState(parsed, layout);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    if (error instanceof StateStoreError) throw error;
    throw new StateStoreError(
      "STATE_IO",
      `Unable to load project state: ${layout.stateFile}`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Saves a caller-supplied snapshot with a generation/revision compare-and-swap.
 * Engine transitions use the receipt transaction writer instead.
 */
export async function saveProjectState(state: ProjectState): Promise<void> {
  await withProjectLock(state.root, async () => {
    const current = await loadProjectState(state.root);
    assertFreshReplacement(current, state);
    await writeProjectStateUnderLock(state);
  });
}

export async function writeProjectStateUnderLock(
  state: ProjectState,
): Promise<void> {
  const layout = await stateLayout(state.root);
  const validated = validateProjectState(state, layout);
  let serialized: string;
  try {
    serialized = `${JSON.stringify(validated)}\n`;
  } catch (error) {
    throw new StateStoreError("STATE_CORRUPT", "Project state is not serializable", {
      cause: error,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new StateStoreError(
      "STATE_CORRUPT",
      `Project state exceeds ${MAX_STATE_BYTES} bytes`,
    );
  }

  const temporaryFile = `${layout.projectDir}/.state-${process.pid}-${randomUUID()}.tmp`;
  let temporaryHandle: FileHandle | undefined;
  try {
    const created = await createSecureFile(
      temporaryFile,
      fsConstants.O_WRONLY,
      {
        mode: STATE_FILE_MODE,
        maxBytes: MAX_STATE_BYTES,
        label: "Temporary state file",
      },
    );
    temporaryHandle = created.handle;
    await temporaryHandle.writeFile(serialized, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryFile, layout.stateFile);
    await syncSecureDirectory(layout.projectDir);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryFile).catch(() => undefined);
    if (error instanceof StateStoreError) throw error;
    throw new StateStoreError(
      "STATE_IO",
      `Unable to atomically save project state: ${layout.stateFile}`,
      { cause: error },
    );
  }
}

function assertFreshReplacement(
  current: ProjectState | null,
  next: ProjectState,
): void {
  if (current === null) return;
  if (
    next.generation !== current.generation + 1 ||
    next.revision < current.revision ||
    next.revision > current.revision + 1
  ) {
    throw new StateStoreError(
      "STATE_CORRUPT",
      `Stale or non-successor state replacement: durable=${current.generation}/${current.revision}, proposed=${next.generation}/${next.revision}`,
    );
  }
  if (
    next.receiptAnchor.count !== current.receiptAnchor.count ||
    next.receiptAnchor.lastHash !== current.receiptAnchor.lastHash ||
    next.receiptAnchor.byteLength !== current.receiptAnchor.byteLength
  ) {
    throw new StateStoreError(
      "STATE_CORRUPT",
      "Raw state replacement cannot modify the receipt anchor",
    );
  }
  if (
    canonicalStringify(next.authority) !==
      canonicalStringify(current.authority)
  ) {
    throw new StateStoreError(
      "STATE_CORRUPT",
      "Raw state replacement cannot modify session authority",
    );
  }
}

export function validateProjectState(
  value: unknown,
  layout: StateLayout,
): ProjectState {
  if (!isRecord(value)) {
    throw corrupt("Project state must be a JSON object");
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...PROJECT_STATE_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw corrupt("Project state has missing or unknown fields");
  }

  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new StateStoreError(
      "STATE_INCOMPATIBLE",
      `Unsupported state schema version: ${String(value.schemaVersion)}`,
    );
  }
  if (value.root !== layout.canonicalRoot || value.rootHash !== layout.rootHash) {
    throw new StateStoreError(
      "STATE_ROOT_MISMATCH",
      "State root or root hash does not match the canonical project root",
    );
  }
  if (
    typeof value.status !== "string" ||
    !(value.status in CONTRACT_STATE_LOOKUP)
  ) {
    throw corrupt("Project state has an unknown lifecycle status");
  }
  if (
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    throw corrupt("Project state generation and revision must be non-negative integers");
  }
  validateReceiptAnchor(value.receiptAnchor);
  if (
    typeof value.updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw corrupt("Project state updatedAt is not an ISO 8601 UTC timestamp");
  }
  if (value.reason !== null && typeof value.reason !== "string") {
    throw corrupt("Project state reason must be a string or null");
  }
  if (value.contract !== null) validateStoredContract(value.contract, layout);
  if (value.checkpoint !== null) validateStoredCheckpoint(value.checkpoint, layout);
  if (value.pendingMutation !== null) {
    validateStoredPendingMutation(value.pendingMutation);
  }
  if (value.authority !== null) validateStoredAuthority(value.authority);

  const status = value.status as ContractState;
  validateLifecycleInvariants(value, status);
  // Embedded objects have already been verified against the canonical root.

  if (
    value.pendingMutation !== null &&
    (value.pendingMutation as unknown as PendingMutation).revision !== value.revision
  ) {
    throw corrupt("Pending mutation revision does not match project state");
  }

  const contractHash = isRecord(value.contract)
    ? value.contract.contractHash
    : undefined;
  if (
    value.pendingMutation !== null &&
    typeof contractHash === "string" &&
    (value.pendingMutation as unknown as PendingMutation).contractHash !== contractHash
  ) {
    throw corrupt("Pending mutation contract hash does not match project state");
  }

  return value as unknown as ProjectState;
}

function validateLifecycleInvariants(
  value: Record<string, unknown>,
  status: ContractState,
): void {
  if (status === "absent") {
    if (
      value.revision !== 0 ||
      value.contract !== null ||
      value.checkpoint !== null ||
      value.pendingMutation !== null ||
      value.authority !== null ||
      value.reason !== null
    ) {
      throw corrupt("Absent state must not contain contract, checkpoint, mutation, authority, or reason data");
    }
    return;
  }

  if (value.contract === null || (value.revision as number) <= 0) {
    throw corrupt("Non-absent state requires a contract and positive revision");
  }

  const statesWithoutCheckpoint: ContractState[] = ["staged", "checkpointing"];
  if (statesWithoutCheckpoint.includes(status) && value.checkpoint !== null) {
    throw corrupt(`${status} state cannot contain a checkpoint`);
  }
  const statesRequiringCheckpoint: ContractState[] = [
    "active",
    "mutation_pending",
    "violated",
    "recovery_required",
    "rolling_back",
    "rolled_back",
    "completed",
  ];
  if (statesRequiringCheckpoint.includes(status) && value.checkpoint === null) {
    throw corrupt(`${status} state requires a checkpoint`);
  }

  if (
    ["rolled_back", "completed", "revoked", "error"].includes(status) &&
    value.authority !== null
  ) {
    throw corrupt(`${status} state cannot retain session authority`);
  }

  if (status === "mutation_pending" && value.pendingMutation === null) {
    throw corrupt("mutation_pending state requires a pending mutation");
  }
  if (
    value.pendingMutation !== null &&
    !["mutation_pending", "violated", "recovery_required", "error"].includes(status)
  ) {
    throw corrupt(`${status} state cannot contain a pending mutation`);
  }

  if (status === "active" && value.reason !== null) {
    throw corrupt("active state cannot contain a reason");
  }

  const statesRequiringReason: ContractState[] = [
    "violated",
    "recovery_required",
    "completed",
    "revoked",
    "error",
  ];
  if (
    statesRequiringReason.includes(status) &&
    (typeof value.reason !== "string" || value.reason.trim().length === 0)
  ) {
    throw corrupt(`${status} state requires a non-empty reason`);
  }
}

function validateStoredAuthority(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["runtime", "rootSessionId", "sessions"]) ||
    typeof value.runtime !== "string" ||
    !["claude", "codex", "opencode", "omp", "pi"].includes(value.runtime) ||
    !isAuthorityIdentifier(value.rootSessionId) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length === 0
  ) {
    throw corrupt("Project state contains malformed session authority");
  }

  const sessionIds = new Set<string>();
  const parents = new Map<string, string | null>();
  let previousSessionId: string | null = null;
  for (const session of value.sessions) {
    if (
      !isRecord(session) ||
      !hasExactKeys(session, ["sessionId", "parentSessionId"]) ||
      !isAuthorityIdentifier(session.sessionId) ||
      (
        session.parentSessionId !== null &&
        !isAuthorityIdentifier(session.parentSessionId)
      ) ||
      sessionIds.has(session.sessionId) ||
      (
        previousSessionId !== null &&
        session.sessionId <= previousSessionId
      )
    ) {
      throw corrupt("Project state authority sessions must be unique, sorted, and well formed");
    }
    sessionIds.add(session.sessionId);
    parents.set(session.sessionId, session.parentSessionId);
    previousSessionId = session.sessionId;
  }

  if (
    parents.get(value.rootSessionId) !== null ||
    [...parents.values()].filter((parent) => parent === null).length !== 1
  ) {
    throw corrupt("Project state authority must contain its root session exactly once with null parent");
  }

  for (const [sessionId, parentSessionId] of parents) {
    if (sessionId === value.rootSessionId) continue;
    if (parentSessionId === null || !parents.has(parentSessionId)) {
      throw corrupt("Project state authority contains unresolved session ancestry");
    }
    const visited: Set<string> = new Set([sessionId]);
    let ancestor: string | null = parentSessionId;
    while (ancestor !== null && ancestor !== value.rootSessionId) {
      if (visited.has(ancestor)) {
        throw corrupt("Project state authority contains cyclic session ancestry");
      }
      visited.add(ancestor);
      ancestor = parents.get(ancestor) ?? null;
    }
    if (ancestor !== value.rootSessionId) {
      throw corrupt("Project state authority ancestry does not reach the root session");
    }
  }
}

function validateStoredPendingMutation(value: unknown): asserts value is PendingMutation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "runtime",
      "sessionId",
      "callId",
      "inputHash",
      "startedAt",
      "contractHash",
      "revision",
    ]) ||
    typeof value.runtime !== "string" ||
    !["claude", "codex", "opencode", "omp", "pi"].includes(value.runtime) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    typeof value.inputHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.inputHash) ||
    typeof value.contractHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contractHash) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0 ||
    typeof value.startedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.startedAt) ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw corrupt("Project state contains a malformed pending mutation");
  }
}

function validateStoredContract(value: unknown, layout: StateLayout): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "root",
      "rootHash",
      "planHash",
      "contractHash",
      "document",
    ]) ||
    value.version !== 1 ||
    typeof value.root !== "string" ||
    typeof value.rootHash !== "string" ||
    typeof value.planHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.planHash) ||
    typeof value.contractHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contractHash) ||
    !isRecord(value.document)
  ) {
    throw corrupt("Project state contains a malformed compiled contract");
  }
  if (value.root !== layout.canonicalRoot || value.rootHash !== layout.rootHash) {
    throw new StateStoreError(
      "STATE_ROOT_MISMATCH",
      "Embedded contract does not match the canonical project root",
    );
  }
  validateContractDocument(value.document);

  const payload = {
    version: value.version,
    root: value.root,
    rootHash: value.rootHash,
    planHash: value.planHash,
    document: value.document,
  };
  if (sha256(canonicalStringify(payload)) !== value.contractHash) {
    throw corrupt("Compiled contract hash does not match its canonical payload");
  }
}

function validateContractDocument(value: Record<string, unknown>): void {
  if (
    !hasExactKeys(value, [
      "version",
      "write",
      "create",
      "delete",
      "protected",
      "commands",
      "packageManager",
    ]) ||
    value.version !== 1 ||
    !["npm", "pnpm", "yarn", "bun", "none"].includes(
      value.packageManager as string,
    )
  ) {
    throw corrupt("Compiled contract document is malformed");
  }

  for (const field of ["write", "create", "delete", "protected"] as const) {
    const selectors = value[field];
    if (!Array.isArray(selectors)) {
      throw corrupt(`Compiled contract ${field} selectors are malformed`);
    }
    for (const selector of selectors) {
      if (
        !isRecord(selector) ||
        !hasExactKeys(selector, ["kind", "path"]) ||
        !["exact", "subtree"].includes(selector.kind as string) ||
        typeof selector.path !== "string" ||
        selector.path.length === 0 ||
        selector.path.includes("\0")
      ) {
        throw corrupt(`Compiled contract ${field} selector is malformed`);
      }
    }
  }

  if (!Array.isArray(value.commands)) {
    throw corrupt("Compiled contract commands are malformed");
  }
  for (const command of value.commands) {
    if (
      !isRecord(command) ||
      !hasExactKeys(command, ["argv", "cwd"]) ||
      !Array.isArray(command.argv) ||
      command.argv.length === 0 ||
      command.argv.some(
        (argument) => typeof argument !== "string" || argument.includes("\0"),
      ) ||
      typeof command.cwd !== "string" ||
      command.cwd.length === 0 ||
      command.cwd.includes("\0")
    ) {
      throw corrupt("Compiled contract command is malformed");
    }
  }
}

function validateStoredCheckpoint(value: unknown, layout: StateLayout): void {
  if (
    isRecord(value) &&
    typeof value.root === "string" &&
    value.root !== layout.canonicalRoot
  ) {
    throw new StateStoreError(
      "STATE_ROOT_MISMATCH",
      "Embedded checkpoint does not match the canonical project root",
    );
  }
  try {
    validateCheckpointManifest(
      value as CheckpointManifest,
      layout.canonicalRoot,
    );
  } catch (error) {
    throw new StateStoreError(
      "STATE_CORRUPT",
      "Project state contains an invalid checkpoint manifest",
      { cause: error },
    );
  }
}

function validateReceiptAnchor(value: unknown): asserts value is ReceiptAnchor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["count", "lastHash", "byteLength"]) ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0 ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    (value.byteLength as number) > MAX_RECEIPT_LEDGER_BYTES ||
    (
      value.lastHash !== null &&
      (
        typeof value.lastHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.lastHash)
      )
    ) ||
    ((value.count as number) === 0) !== (value.lastHash === null) ||
    ((value.count as number) === 0) !== ((value.byteLength as number) === 0)
  ) {
    throw corrupt("Project state contains a malformed receipt anchor");
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}


function corrupt(message: string): StateStoreError {
  return new StateStoreError("STATE_CORRUPT", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

