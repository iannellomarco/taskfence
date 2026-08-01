import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  rename,
  unlink,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname } from "node:path";
import { stateLayout } from "./layout.js";
import { recoverProjectTransactionUnderLock } from "../receipts/ledger.js";
import { ProjectLockError } from "./model.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_RECOVERY_LIMIT = 3;
const LOCK_FILE_MODE = 0o600;
const MAX_LOCK_BYTES = 16 * 1024;
const QUARANTINE_PREFIX = ".stale-lock-";
const QUARANTINE_POLL_MS = 25;
const MAX_QUARANTINE_WAITERS = 1_000;
const MAX_QUARANTINE_FILES = 100;
const MAX_LOCK_ARTIFACT_LINKS = MAX_QUARANTINE_FILES + 1;
const MAX_OWNED_ARTIFACT_CLEANUP_PASSES = 3;
const QUARANTINE_NAME_PATTERN =
  /^\.stale-lock-(?:[1-9]\d*|orphan)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface LockPayload {
  schemaVersion: 1;
  rootHash: string;
  pid: number;
  nonce: string;
  createdAt: string;
}

interface InspectedLock {
  payload: LockPayload | null;
  text: string;
  metadata: Stats;
}

interface LockArtifactIdentity {
  dev: number;
  ino: number;
  text: string;
}

export interface ProjectLockOptions {
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
export async function withProjectLock<T>(
  root: string,
  operation: () => Promise<T> | T,
  options: ProjectLockOptions = {},
): Promise<T> {
  const layout = await stateLayout(root);
  const acquireTimeoutMs = positiveInteger(
    options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    "acquireTimeoutMs",
  );
  const staleLockMs = positiveInteger(
    options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    "staleLockMs",
  );
  const retryDelayMs = positiveInteger(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
  );
  const staleRecoveryLimit = nonnegativeInteger(
    options.staleRecoveryLimit ?? DEFAULT_STALE_RECOVERY_LIMIT,
    "staleRecoveryLimit",
  );

  const payload: LockPayload = {
    schemaVersion: 1,
    rootHash: layout.rootHash,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const payloadText = `${JSON.stringify(payload)}\n`;
  const deadline = Date.now() + acquireTimeoutMs;
  let staleRecoveries = 0;

  while (true) {
    // Pre-create: wait for any quarantine files to be reconciled. No acquirer
    // creates a lock while recovery is in progress.
    const cleared = await waitForQuarantineCleared(
      layout.projectDir,
      layout.rootHash,
      staleLockMs,
      deadline,
    );
    if (cleared.kind === "timeout") {
      throw new ProjectLockError(
        "LOCK_TIMEOUT",
        `Timed out acquiring project lock for ${layout.canonicalRoot}`,
      );
    }
    if (cleared.kind === "error") {
      throw cleared.error;
    }

    let created:
      | { path: string; dev: number; ino: number; payloadText: string }
      | undefined;
    try {
      created = await createLockFile(layout.lockFile, payload);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new ProjectLockError(
          "LOCK_IO",
          `Unable to acquire project lock for ${layout.canonicalRoot}`,
          { cause: error },
        );
      }

      if (Date.now() >= deadline) {
        throw new ProjectLockError(
          "LOCK_TIMEOUT",
          `Timed out acquiring project lock for ${layout.canonicalRoot}`,
        );
      }

      let inspected: InspectedLock;
      try {
        inspected = await inspectLock(layout.lockFile);
      } catch (inspectionError) {
        if (isNodeError(inspectionError, "ENOENT")) continue;
        throw inspectionError;
      }
      if (
        inspected.payload !== null &&
        inspected.payload.rootHash !== layout.rootHash
      ) {
        throw new ProjectLockError(
          "LOCK_CORRUPT",
          "Project lock is bound to a different canonical root hash",
        );
      }
      const ageMs = Math.max(0, Date.now() - inspected.metadata.mtimeMs);
      const ownerAlive = inspected.payload
        ? isProcessAlive(inspected.payload.pid)
        : false;

      if (
        ageMs >= staleLockMs &&
        !ownerAlive &&
        staleRecoveries < staleRecoveryLimit
      ) {
        const recovered = await recoverStaleLock(
          layout.lockFile,
          layout.projectDir,
          inspected,
          layout.rootHash,
          staleLockMs,
        );
        if (recovered.kind === "recovered") {
          staleRecoveries += 1;
          continue;
        }
        if (recovered.kind === "error") {
          throw recovered.error;
        }
      }

      await sleep(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
      continue;
    }

    // Post-create rescan: if any quarantine file appeared while we were
    // creating state.lock, a recovery may be in progress. Remove only our
    // own exact lock artifact and retry.
    const postCheck = await scanQuarantine(
      layout.projectDir,
      layout.rootHash,
      staleLockMs,
    );
    if (postCheck.kind === "error") {
      await removeOwnedLockArtifacts(
        layout.lockFile,
        layout.projectDir,
        layout.rootHash,
        staleLockMs,
        created.payloadText,
      ).catch(() => undefined);
      throw postCheck.error;
    }
    if (postCheck.kind === "present") {
      await removeOwnedLockArtifacts(
        layout.lockFile,
        layout.projectDir,
        layout.rootHash,
        staleLockMs,
        created.payloadText,
      );
      continue;
    }
    // No quarantine files, but our lock may have been replaced (content
    // overwrite with same inode on Linux). Verify exact payload ownership.
    if (!(await lockOwnershipMatches(layout.lockFile, created))) {
      await removeOwnedLockArtifacts(
        layout.lockFile,
        layout.projectDir,
        layout.rootHash,
        staleLockMs,
        created.payloadText,
      );
      continue;
    }
    break;
  }

  const heartbeat = startHeartbeat(layout.lockFile, payload, staleLockMs);
  try {
    await recoverProjectTransactionUnderLock(layout.canonicalRoot);
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await removeOwnedLockArtifacts(
      layout.lockFile,
      layout.projectDir,
      layout.rootHash,
      staleLockMs,
      payloadText,
    );
  }
}

async function createLockFile(
  path: string,
  payload: LockPayload,
): Promise<{ path: string; dev: number; ino: number; payloadText: string }> {
  const payloadText = `${JSON.stringify(payload)}\n`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NONBLOCK |
        fsConstants.O_NOFOLLOW,
      LOCK_FILE_MODE,
    );
    await handle.chmod(LOCK_FILE_MODE);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== LOCK_FILE_MODE ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        `New lock inode is unsafe: ${path}`,
      );
    }
    await handle.writeFile(payloadText, "utf8");
    await handle.sync();
    const identity = { path, dev: metadata.dev, ino: metadata.ino, payloadText };
    await handle.close();
    handle = undefined;
    return identity;
  } catch (error) {
    if (handle !== undefined) {
      const identity = await inspectCreatedLockHandle(handle).catch(() => undefined);
      await handle.close().catch(() => undefined);
      if (identity !== undefined) {
        await removeFailedCreateArtifact(path, payload.rootHash, identity).catch(
          () => undefined,
        );
      }
    }
    throw error;
  }
}

async function inspectCreatedLockHandle(
  handle: FileHandle,
): Promise<LockArtifactIdentity | undefined> {
  const metadata = await handle.stat();
  if (
    metadata.nlink === 0 ||
    !metadata.isFile() ||
    metadata.size > MAX_LOCK_BYTES ||
    metadata.nlink > MAX_LOCK_ARTIFACT_LINKS
  ) {
    return undefined;
  }
  const buffer = Buffer.allocUnsafe(MAX_LOCK_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_LOCK_BYTES) return undefined;
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    text: buffer.subarray(0, bytesRead).toString("utf8"),
  };
}

async function removeFailedCreateArtifact(
  lockFile: string,
  rootHash: string,
  identity: LockArtifactIdentity,
): Promise<void> {
  const projectDir = dirname(lockFile);
  for (
    let pass = 0;
    pass < MAX_OWNED_ARTIFACT_CLEANUP_PASSES;
    pass += 1
  ) {
    let removed = false;
    let rescanRequired = false;
    let fixed: InspectedLock | undefined;
    try {
      fixed = await inspectLockArtifact(lockFile, "Lock artifact");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    if (fixed !== undefined && lockArtifactIdentityMatches(fixed, identity)) {
      const quarantinePath =
        `${projectDir}/${QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`;
      try {
        await rename(lockFile, quarantinePath);
        await fsyncDirectory(projectDir);
        const moved = await inspectQuarantine(quarantinePath);
        if (lockArtifactIdentityMatches(moved, identity)) {
          try {
            await unlink(quarantinePath);
            removed = true;
          } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
            rescanRequired = true;
          }
        } else {
          const restored = await restoreQuarantineToLock(
            quarantinePath,
            lockFile,
            projectDir,
            rootHash,
            DEFAULT_STALE_LOCK_MS,
            moved,
            false,
          );
          if (restored.kind === "error") throw restored.error;
          if (restored.kind === "present") {
            await handOffQuarantineGuard(quarantinePath, projectDir);
          }
          rescanRequired = true;
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        rescanRequired = true;
      }
    }

    const quarantineFiles = await listQuarantineFiles(projectDir);
    for (const name of quarantineFiles) {
      const path = `${projectDir}/${name}`;
      let exactMatch = false;
      try {
        const inspected = await inspectQuarantine(path);
        if (!lockArtifactIdentityMatches(inspected, identity)) continue;
        exactMatch = true;
        await unlink(path);
        removed = true;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        if (exactMatch) rescanRequired = true;
      }
    }
    if (removed) await fsyncDirectory(projectDir);
    if (removed || rescanRequired) continue;
    return;
  }
}

function lockArtifactIdentityMatches(
  inspected: InspectedLock,
  identity: LockArtifactIdentity,
): boolean {
  return (
    inspected.metadata.dev === identity.dev &&
    inspected.metadata.ino === identity.ino &&
    inspected.text === identity.text
  );
}

async function handOffQuarantineGuard(
  quarantinePath: string,
  projectDir: string,
): Promise<void> {
  const orphanPath =
    `${projectDir}/${QUARANTINE_PREFIX}orphan-${randomUUID()}`;
  await rename(quarantinePath, orphanPath);
  await fsyncDirectory(projectDir);
}

// Removes every exact nonce-bearing artifact owned by this acquisition.
// The fixed path is first moved to a unique quarantine guard and verified
// there, so a replacement that appears between inspection and rename is
// restored rather than unlinked. Unique quarantine paths can then be removed
// by exact payload because legitimate TaskFence processes never reuse them.
async function removeOwnedLockArtifacts(
  lockFile: string,
  projectDir: string,
  rootHash: string,
  staleLockMs: number,
  payloadText: string,
): Promise<void> {
  for (
    let pass = 0;
    pass < MAX_OWNED_ARTIFACT_CLEANUP_PASSES;
    pass += 1
  ) {
    let removed = false;
    let rescanRequired = false;
    let fixed: InspectedLock | undefined;
    try {
      fixed = await inspectLockArtifact(lockFile, "Lock artifact");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    if (fixed?.text === payloadText) {
      const quarantinePath =
        `${projectDir}/${QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`;
      try {
        await rename(lockFile, quarantinePath);
        await fsyncDirectory(projectDir);
        const moved = await inspectQuarantine(quarantinePath);
        if (moved.text === payloadText) {
          await unlink(quarantinePath);
          await fsyncDirectory(projectDir);
          removed = true;
        } else {
          const restored = await restoreQuarantineToLock(
            quarantinePath,
            lockFile,
            projectDir,
            rootHash,
            staleLockMs,
            moved,
          );
          if (restored.kind === "error") throw restored.error;
          if (restored.kind === "present") {
            await handOffQuarantineGuard(quarantinePath, projectDir);
          }
          rescanRequired = true;
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        rescanRequired = true;
      }
    }

    const quarantineFiles = await listQuarantineFiles(projectDir);
    for (const name of quarantineFiles) {
      const path = `${projectDir}/${name}`;
      let exactMatch = false;
      try {
        const inspected = await inspectQuarantine(path);
        if (inspected.text !== payloadText) continue;
        exactMatch = true;
        await unlink(path);
        removed = true;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        if (exactMatch) rescanRequired = true;
      }
    }
    if (removed) await fsyncDirectory(projectDir);
    if (removed || rescanRequired) continue;
    return;
  }
}

// Verifies that lockFile still contains the exact payload we wrote. On Linux,
// inode numbers can be reused, so dev/ino alone is insufficient.
async function lockOwnershipMatches(
  lockFile: string,
  identity: { dev: number; ino: number; payloadText: string },
): Promise<boolean> {
  try {
    const current = await inspectLock(lockFile);
    return (
      current.metadata.dev === identity.dev &&
      current.metadata.ino === identity.ino &&
      current.text === identity.payloadText
    );
  } catch {
    return false;
  }
}

async function inspectLock(path: string): Promise<InspectedLock> {
  return inspectLockArtifact(path, "Lock file");
}

async function inspectLockArtifact(
  path: string,
  label: string,
): Promise<InspectedLock> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > MAX_LOCK_BYTES ||
      (metadata.mode & 0o777) !== LOCK_FILE_MODE ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        `${label} permissions, ownership, type, or size are unsafe: ${path}`,
      );
    }
    // nlink === 0: the file was unlinked between our open and fstat. Treat
    // this as disappeared (ENOENT), not corruption — the owner legitimately
    // removed the path while we held the open fd.
    if (metadata.nlink === 0) {
      const error = new Error(`File disappeared (nlink=0): ${path}`);
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    }
    // Bounded protocol aliases: during concurrent restore operations, a lock
    // inode may be hard-linked as state.lock plus multiple quarantine names
    // (Q1, Q2, ...). Allow up to MAX_LOCK_ARTIFACT_LINKS (100 Q names + 1
    // fixed path) rather than treating transient extra links as corruption.
    if (metadata.nlink > MAX_LOCK_ARTIFACT_LINKS) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        `${label} has an unbounded link count (${metadata.nlink}): ${path}`,
      );
    }
    const buffer = Buffer.allocUnsafe(MAX_LOCK_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LOCK_BYTES) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        `${label} exceeds the size limit: ${path}`,
      );
    }
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return { payload: parseLockPayload(text), text, metadata };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    if (error instanceof ProjectLockError) throw error;
    throw new ProjectLockError(
      "LOCK_CORRUPT",
      `Cannot inspect ${label.toLowerCase()}: ${path}`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseLockPayload(text: string): LockPayload | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "schemaVersion",
        "rootHash",
        "pid",
        "nonce",
        "createdAt",
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.rootHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.rootHash) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.nonce !== "string" ||
      value.nonce.length === 0 ||
      typeof value.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null;
    }
    return value as unknown as LockPayload;
  } catch {
    return null;
  }
}

type RecoveryResult =
  | { kind: "recovered" | "aborted" }
  | { kind: "error"; error: ProjectLockError };

// Recovers a stale lock by atomically renaming it to a unique quarantine
// guard. The moved file is verified by inode and raw payload before deletion;
// a live, fresh, foreign-root, or changed candidate is restored without
// clobbering any fixed-path contender.
async function recoverStaleLock(
  lockFile: string,
  projectDir: string,
  inspected: InspectedLock,
  rootHash: string,
  staleLockMs: number,
): Promise<RecoveryResult> {
  const quarantinePath =
    `${projectDir}/${QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`;
  try {
    const snapshotText = inspected.text;
    const snapshotDev = inspected.metadata.dev;
    const snapshotIno = inspected.metadata.ino;

    await rename(lockFile, quarantinePath);
    await fsyncDirectory(projectDir);

    let quarantined: InspectedLock;
    try {
      quarantined = await inspectQuarantine(quarantinePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { kind: "aborted" };
      throw error;
    }
    if (
      quarantined.metadata.dev !== snapshotDev ||
      quarantined.metadata.ino !== snapshotIno ||
      quarantined.text !== snapshotText
    ) {
      return abortRecoveryAndRestore(
        quarantinePath,
        lockFile,
        projectDir,
        rootHash,
        staleLockMs,
        quarantined,
      );
    }

    if (quarantined.payload !== null) {
      if (quarantined.payload.rootHash !== rootHash) {
        const restored = await restoreQuarantineToLock(
          quarantinePath,
          lockFile,
          projectDir,
          rootHash,
          staleLockMs,
          quarantined,
        );
        if (restored.kind === "error") return restored;
        return {
          kind: "error",
          error: new ProjectLockError(
            "LOCK_CORRUPT",
            "Project lock is bound to a different canonical root hash",
          ),
        };
      }
      if (isProcessAlive(quarantined.payload.pid)) {
        return abortRecoveryAndRestore(
          quarantinePath,
          lockFile,
          projectDir,
          rootHash,
          staleLockMs,
          quarantined,
        );
      }
    }
    const currentAgeMs = Math.max(
      0,
      Date.now() - quarantined.metadata.mtimeMs,
    );
    if (currentAgeMs < staleLockMs) {
      return abortRecoveryAndRestore(
        quarantinePath,
        lockFile,
        projectDir,
        rootHash,
        staleLockMs,
        quarantined,
      );
    }

    await unlink(quarantinePath);
    await fsyncDirectory(projectDir);
    return { kind: "recovered" };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "aborted" };
    return {
      kind: "error",
      error:
        error instanceof ProjectLockError
          ? error
          : new ProjectLockError(
              "LOCK_IO",
              "Unable to recover stale project lock",
              { cause: error },
            ),
    };
  }
}

async function abortRecoveryAndRestore(
  quarantinePath: string,
  lockFile: string,
  projectDir: string,
  rootHash: string,
  staleLockMs: number,
  inspected: InspectedLock,
): Promise<RecoveryResult> {
  const restored = await restoreQuarantineToLock(
    quarantinePath,
    lockFile,
    projectDir,
    rootHash,
    staleLockMs,
    inspected,
  );
  return restored.kind === "error" ? restored : { kind: "aborted" };
}

async function inspectQuarantine(path: string): Promise<InspectedLock> {
  return inspectLockArtifact(path, "Quarantine file");
}

type QuarantinePresence =
  | { kind: "present" | "absent" }
  | { kind: "error"; error: ProjectLockError };

async function listQuarantineFiles(projectDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw new ProjectLockError("LOCK_IO", "Cannot scan project directory", {
      cause: error,
    });
  }
  const quarantineFiles = entries
    .filter((name) => name.startsWith(QUARANTINE_PREFIX))
    .sort();
  const malformed = quarantineFiles.find(
    (name) => !QUARANTINE_NAME_PATTERN.test(name),
  );
  if (malformed !== undefined) {
    throw new ProjectLockError(
      "LOCK_CORRUPT",
      `Malformed quarantine filename: ${malformed}`,
    );
  }
  if (quarantineFiles.length > MAX_QUARANTINE_FILES) {
    throw new ProjectLockError(
      "LOCK_CORRUPT",
      `Too many quarantine files: ${quarantineFiles.length}`,
    );
  }
  return quarantineFiles;
}

// Extracts the recoverer PID from an active quarantine filename
// (.stale-lock-<pid>-<uuid>). Orphan handoff names intentionally return null.
function extractRecovererPid(quarantinePath: string): number | null {
  const basename = quarantinePath.split("/").pop();
  if (basename === undefined) return null;
  const match = basename.match(/^\.stale-lock-([1-9]\d*)-/);
  return match ? Number.parseInt(match[1], 10) : null;
}

// Scans the project directory for quarantine guards. Crash-stale guards are
// reconciled; any live or fresh guard blocks acquisition.
async function scanQuarantine(
  projectDir: string,
  rootHash: string,
  staleLockMs: number,
): Promise<QuarantinePresence> {
  let quarantineFiles: string[];
  try {
    quarantineFiles = await listQuarantineFiles(projectDir);
  } catch (error) {
    return {
      kind: "error",
      error:
        error instanceof ProjectLockError
          ? error
          : new ProjectLockError(
              "LOCK_IO",
              "Cannot scan project directory",
              { cause: error },
            ),
    };
  }
  if (quarantineFiles.length === 0) return { kind: "absent" };

  for (const name of quarantineFiles) {
    const path = `${projectDir}/${name}`;
    const reconciled = await reconcileQuarantine(
      path,
      projectDir,
      rootHash,
      staleLockMs,
    );
    if (reconciled.kind === "error") {
      return { kind: "error", error: reconciled.error };
    }
    if (reconciled.kind === "present") {
      return { kind: "present" };
    }
  }

  try {
    const remaining = await listQuarantineFiles(projectDir);
    return remaining.length > 0 ? { kind: "present" } : { kind: "absent" };
  } catch (error) {
    return {
      kind: "error",
      error:
        error instanceof ProjectLockError
          ? error
          : new ProjectLockError(
              "LOCK_IO",
              "Cannot re-scan project directory",
              { cause: error },
            ),
    };
  }
}

type ReconcileResult =
  | { kind: "cleared" | "present" }
  | { kind: "error"; error: ProjectLockError };

// Reconciles a single crash-stale quarantine file using this decision tree:
//   1. Valid same-root, PID-alive: restore via link(Q→state.lock), unlink Q.
//   2. Valid PID-dead, age < staleLockMs: wait (leave Q present).
//   3. Valid PID-dead, age >= staleLockMs: delete Q (completed recovery).
//   4. Payload-null (empty/malformed), fresh: wait; stale: delete.
//   5. Foreign-root / unsafe metadata: fail closed (LOCK_CORRUPT).
// If Q+state.lock coexist with identical content: unlink Q (prior restore
// completed). If different live payload: leave Q present and wait.
async function reconcileQuarantine(
  quarantinePath: string,
  projectDir: string,
  rootHash: string,
  staleLockMs: number,
): Promise<ReconcileResult> {
  let inspected: InspectedLock;
  try {
    inspected = await inspectQuarantine(quarantinePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "cleared" };
    if (error instanceof ProjectLockError) {
      return { kind: "error", error };
    }
    return {
      kind: "error",
      error: new ProjectLockError(
        "LOCK_CORRUPT",
        `Cannot inspect quarantine file: ${quarantinePath}`,
        { cause: error },
      ),
    };
  }
  // Check the recoverer PID from the filename. If the recoverer is alive,
  // this is an active recovery — the quarantine guard blocks all acquirers
  // regardless of the quarantined lock's own PID or staleness.
  const recovererPid = extractRecovererPid(quarantinePath);
  if (recovererPid !== null && isProcessAlive(recovererPid)) {
    return { kind: "present" };
  }

  const ageMs = Math.max(0, Date.now() - inspected.metadata.mtimeMs);
  const lockFile = `${projectDir}/state.lock`;

  if (inspected.payload !== null) {
    // Foreign-root quarantine: fail closed.
    if (inspected.payload.rootHash !== rootHash) {
      return {
        kind: "error",
        error: new ProjectLockError(
          "LOCK_CORRUPT",
          "Quarantine file is bound to a different canonical root hash",
        ),
      };
    }
    // Valid same-root, PID-alive: restore the live owner's lock.
    if (isProcessAlive(inspected.payload.pid)) {
      return restoreQuarantineToLock(
        quarantinePath,
        lockFile,
        projectDir,
        rootHash,
        staleLockMs,
        inspected,
      );
    }
    // Valid PID-dead, age < staleLockMs: wait (do not restore a dead owner).
    if (ageMs < staleLockMs) {
      return { kind: "present" };
    }
    // Valid PID-dead, age >= staleLockMs: delete (recovery completed).
    await unlink(quarantinePath);
    await fsyncDirectory(projectDir);
    return { kind: "cleared" };
  }

  // Payload-null (empty/malformed): fresh → wait, stale → delete.
  if (ageMs < staleLockMs) {
    return { kind: "present" };
  }
  await unlink(quarantinePath);
  await fsyncDirectory(projectDir);
  return { kind: "cleared" };
}

// Restores a quarantine guard without clobbering a fixed-path contender. A
// stale dead contender can be cleared while the existing quarantine remains
// the global guard; live or fresh contenders are left for their owner.
async function restoreQuarantineToLock(
  quarantinePath: string,
  lockFile: string,
  projectDir: string,
  rootHash: string,
  staleLockMs: number,
  inspected: InspectedLock,
  recoverConflictingLock = true,
): Promise<ReconcileResult> {
  let existingLock: InspectedLock | undefined;
  try {
    existingLock = await inspectLockArtifact(lockFile, "Lock artifact");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      return {
        kind: "error",
        error:
          error instanceof ProjectLockError
            ? error
            : new ProjectLockError(
                "LOCK_IO",
                `Cannot inspect project lock while restoring ${quarantinePath}`,
                { cause: error },
              ),
      };
    }
  }

  if (existingLock !== undefined) {
    if (
      existingLock.metadata.dev === inspected.metadata.dev &&
      existingLock.metadata.ino === inspected.metadata.ino &&
      existingLock.text === inspected.text
    ) {
      try {
        await unlink(quarantinePath);
        await fsyncDirectory(projectDir);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          return {
            kind: "error",
            error: new ProjectLockError(
              "LOCK_IO",
              `Cannot complete quarantine restoration: ${quarantinePath}`,
              { cause: error },
            ),
          };
        }
      }
      return { kind: "cleared" };
    }
    if (inspected.metadata.nlink > 1) {
      return { kind: "present" };
    }
    if (!recoverConflictingLock || existingLock.metadata.nlink > 1) {
      return { kind: "present" };
    }
    if (
      existingLock.payload !== null &&
      existingLock.payload.rootHash !== rootHash
    ) {
      return {
        kind: "error",
        error: new ProjectLockError(
          "LOCK_CORRUPT",
          "Conflicting project lock is bound to a different canonical root hash",
        ),
      };
    }
    const ageMs = Math.max(0, Date.now() - existingLock.metadata.mtimeMs);
    if (
      (existingLock.payload !== null &&
        isProcessAlive(existingLock.payload.pid)) ||
      ageMs < staleLockMs
    ) {
      return { kind: "present" };
    }
    const cleared = await clearConflictingStaleLock(
      lockFile,
      projectDir,
      rootHash,
      staleLockMs,
      existingLock,
    );
    if (cleared.kind !== "cleared") return cleared;
  } else if (inspected.metadata.nlink > 1) {
    return { kind: "present" };
  }

  try {
    await link(quarantinePath, lockFile);
    await fsyncDirectory(projectDir);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return { kind: "present" };
    if (isNodeError(error, "ENOENT")) return { kind: "cleared" };
    return {
      kind: "error",
      error: new ProjectLockError(
        "LOCK_IO",
        `Cannot restore quarantine file: ${quarantinePath}`,
        { cause: error },
      ),
    };
  }
  try {
    await unlink(quarantinePath);
    await fsyncDirectory(projectDir);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      return {
        kind: "error",
        error: new ProjectLockError(
          "LOCK_IO",
          `Cannot finish restoring quarantine file: ${quarantinePath}`,
          { cause: error },
        ),
      };
    }
  }
  return { kind: "cleared" };
}

async function clearConflictingStaleLock(
  lockFile: string,
  projectDir: string,
  rootHash: string,
  staleLockMs: number,
  inspected: InspectedLock,
): Promise<ReconcileResult> {
  const quarantinePath =
    `${projectDir}/${QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`;
  try {
    await rename(lockFile, quarantinePath);
    await fsyncDirectory(projectDir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "cleared" };
    return {
      kind: "error",
      error: new ProjectLockError(
        "LOCK_IO",
        "Cannot quarantine a conflicting stale lock",
        { cause: error },
      ),
    };
  }

  let moved: InspectedLock;
  try {
    moved = await inspectQuarantine(quarantinePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "cleared" };
    return {
      kind: "error",
      error:
        error instanceof ProjectLockError
          ? error
          : new ProjectLockError(
              "LOCK_IO",
              "Cannot inspect a conflicting stale lock",
              { cause: error },
            ),
    };
  }

  const changed =
    moved.metadata.dev !== inspected.metadata.dev ||
    moved.metadata.ino !== inspected.metadata.ino ||
    moved.text !== inspected.text;
  const foreign =
    moved.payload !== null && moved.payload.rootHash !== rootHash;
  const ageMs = Math.max(0, Date.now() - moved.metadata.mtimeMs);
  const active =
    (moved.payload !== null && isProcessAlive(moved.payload.pid)) ||
    ageMs < staleLockMs;
  if (changed || foreign || active) {
    const restored = await restoreQuarantineToLock(
      quarantinePath,
      lockFile,
      projectDir,
      rootHash,
      staleLockMs,
      moved,
      false,
    );
    if (restored.kind === "error") return restored;
    if (foreign) {
      return {
        kind: "error",
        error: new ProjectLockError(
          "LOCK_CORRUPT",
          "Conflicting project lock changed to a foreign canonical root",
        ),
      };
    }
    return { kind: "present" };
  }

  try {
    await unlink(quarantinePath);
    await fsyncDirectory(projectDir);
    return { kind: "cleared" };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "cleared" };
    return {
      kind: "error",
      error: new ProjectLockError(
        "LOCK_IO",
        "Cannot remove a conflicting stale lock",
        { cause: error },
      ),
    };
  }
}

// Waits for all quarantine files to be reconciled. Bounded by the acquire
// deadline and a hard iteration cap — no unbounded polling.
async function waitForQuarantineCleared(
  projectDir: string,
  rootHash: string,
  staleLockMs: number,
  deadline: number,
): Promise<
  | { kind: "cleared" }
  | { kind: "timeout" }
  | { kind: "error"; error: ProjectLockError }
> {
  let iterations = 0;
  while (Date.now() < deadline) {
    if (iterations >= MAX_QUARANTINE_WAITERS) {
      return { kind: "timeout" };
    }
    iterations += 1;
    const presence = await scanQuarantine(projectDir, rootHash, staleLockMs);
    if (presence.kind === "error") {
      return { kind: "error", error: presence.error };
    }
    if (presence.kind === "absent") {
      return { kind: "cleared" };
    }
    await sleep(Math.min(QUARANTINE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return { kind: "timeout" };
}

function startHeartbeat(
  lockFile: string,
  payload: LockPayload,
  staleLockMs: number,
): NodeJS.Timeout {
  let running = false;
  const heartbeat = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const inspected = await inspectLock(lockFile);
      if (inspected.payload?.nonce === payload.nonce) {
        const now = new Date();
        await utimes(lockFile, now, now);
      }
    } catch {
      // Losing the heartbeat never creates another lock owner. Release verifies nonce.
    } finally {
      running = false;
    }
  }, Math.max(1_000, Math.floor(staleLockMs / 3)));
  heartbeat.unref();
  return heartbeat;
}


function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    await handle.sync();
  } catch {
    // Directory fsync is best-effort for durability; a missing or unsupported
    // sync never creates a concurrent owner (quarantine protocol still holds).
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
