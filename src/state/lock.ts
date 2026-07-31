import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  rename,
  unlink,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { stateLayout } from "./layout.js";
import { recoverProjectTransactionUnderLock } from "../receipts/ledger.js";
import { ProjectLockError } from "./model.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_RECOVERY_LIMIT = 3;
const LOCK_FILE_MODE = 0o600;
const RECOVERY_MARKER_MODE = 0o600;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const RECOVERY_MARKER_POLL_MS = 25;
const MAX_RECOVERY_MARKER_WAITERS = 1_000;

interface LockPayload {
  schemaVersion: 1;
  rootHash: string;
  pid: number;
  nonce: string;
  createdAt: string;
}

interface RecoveryMarkerPayload {
  schemaVersion: 1;
  rootHash: string;
  pid: number;
  nonce: string;
  createdAt: string;
}

interface InspectedLock {
  payload: LockPayload | null;
  metadata: Stats;
}

interface InspectedMarker {
  payload: RecoveryMarkerPayload;
  metadata: Stats;
}

interface RecoveryMarkerPath {
  path: string;
  projectDir: string;
}

export interface ProjectLockOptions {
  acquireTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
  staleRecoveryLimit?: number;
}


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
  const deadline = Date.now() + acquireTimeoutMs;
  let staleRecoveries = 0;

  const marker: RecoveryMarkerPath = {
    path: `${layout.projectDir}/state.lock.recover`,
    projectDir: layout.projectDir,
  };

  while (true) {
    const blocked = await waitForRecoveryMarkerCleared(
      marker,
      deadline,
      layout.rootHash,
    );
    if (blocked.kind === "timeout") {
      throw new ProjectLockError(
        "LOCK_TIMEOUT",
        `Timed out acquiring project lock for ${layout.canonicalRoot}`,
      );
    }
    if (blocked.kind === "error") {
      throw blocked.error;
    }

    let created: { path: string; dev: number; ino: number } | undefined;
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
          marker,
          inspected.metadata,
          layout.rootHash,
          staleLockMs,
          deadline,
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

    // Post-creation checks: a contender may have observed our just-created
    // inode before its payload was written/synced (empty file → null payload
    // → treated as stale under a tight staleLockMs). That contender acquires
    // the recovery marker, removes our inode, creates its own lock, and clears
    // the marker — all before we reach here. So we must verify BOTH:
    //   1. No live recovery marker remains (contender still mid-recovery).
    //   2. state.lock still points at the inode we created. If it was replaced,
    //      the path now belongs to another owner; remove nothing and retry.
    const postCheck = await reclaimMarkerIfStale(marker, layout.rootHash);
    if (postCheck.kind === "error") {
      await removeOwnedLockInode(layout.lockFile, created);
      throw postCheck.error;
    }
    if (postCheck.kind === "present") {
      await removeOwnedLockInode(layout.lockFile, created);
      staleRecoveries += 1;
      continue;
    }
    // Marker is absent, but our inode may have been replaced while the marker
    // was active. Verify ownership before entering the critical section.
    if (!(await lockInodeMatches(layout.lockFile, created))) {
      staleRecoveries += 1;
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
    await releaseOwnedLock(layout.lockFile, payload);
  }
}

// Creates the lock via O_EXCL and returns the resulting inode identity so the
// caller can remove exactly that inode (and no other) if a recovery marker
// appears immediately afterward.
async function createLockFile(
  path: string,
  payload: LockPayload,
): Promise<{ path: string; dev: number; ino: number }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY |
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
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.sync();
    const identity = { path, dev: metadata.dev, ino: metadata.ino };
    await handle.close();
    handle = undefined;
    return identity;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    }
    throw error;
  }
}

// Removes a lock inode only if it still matches the identity we just created.
// Never unlinks a path that now points at a different inode (e.g. a restored
// owner's lock or a contender's freshly created lock).
async function removeOwnedLockInode(
  lockFile: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  try {
    const current = await lstat(lockFile);
    if (current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(lockFile);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      // Best-effort cleanup; the loop retries and O_EXCL prevents double owners.
    }
  }
}

// Verifies that lockFile still resolves to the exact inode we created. Used
// after the post-creation marker check to detect that a contender's recovery
// replaced our inode while a marker was active.
async function lockInodeMatches(
  lockFile: string,
  identity: { dev: number; ino: number },
): Promise<boolean> {
  try {
    const current = await lstat(lockFile);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

async function inspectLock(path: string): Promise<InspectedLock> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        fsConstants.O_NONBLOCK |
        fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_LOCK_BYTES ||
      (metadata.mode & 0o777) !== LOCK_FILE_MODE ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        `Lock file permissions, ownership, type, or size are unsafe: ${path}`,
      );
    }
    const text = await handle.readFile("utf8");
    return { payload: parseLockPayload(text), metadata };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw error;
    }
    throw new ProjectLockError("LOCK_CORRUPT", `Cannot inspect lock file: ${path}`, {
      cause: error,
    });
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

// Recovers a stale lock under a durable recovery marker. The marker is created
// atomically (O_EXCL) before state.lock is touched, so any acquirer that
// observes the marker waits instead of creating a competing lock. Under the
// marker, the candidate is re-inspected for current payload, mtime, and owner
// liveness — a lock that was stale when inspected (e.g. empty payload from a
// creator mid-write) may have become valid by the time the marker is acquired.
// Only a genuinely stale candidate is quarantined, removed, and the marker
// cleared after the quarantine directory is fsynced.
async function recoverStaleLock(
  lockFile: string,
  marker: RecoveryMarkerPath,
  inspected: Stats,
  rootHash: string,
  staleLockMs: number,
  deadline: number,
): Promise<
  | { kind: "recovered" | "aborted" }
  | { kind: "error"; error: ProjectLockError }
> {
  let markerHandle: FileHandle | undefined;
  let markerCreated = false;
  let markerIdentity: { dev: number; ino: number } | undefined;
  try {
    // Acquire the recovery marker exclusively. If another recovery is already
    // in progress, abort and let the acquire loop wait for it to clear.
    const acquired = await acquireRecoveryMarker(marker, rootHash, deadline);
    if (acquired.kind === "busy" || acquired.kind === "aborted") {
      return { kind: "aborted" };
    }
    if (acquired.kind === "error") {
      return { kind: "error", error: acquired.error };
    }
    markerHandle = acquired.handle;
    markerIdentity = acquired.identity;
    markerCreated = true;

    // Re-inspect the candidate under the marker. The original inspection may
    // have seen an empty/partial payload from a creator mid-write (inode
    // visible before writeFile+sync). By now that creator may have finished,
    // making the lock valid and live. Verify inode identity AND current
    // staleness before removing anything.
    let currentInspected: InspectedLock;
    try {
      currentInspected = await inspectLock(lockFile);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { kind: "aborted" };
      throw error;
    }
    if (
      currentInspected.metadata.dev !== inspected.dev ||
      currentInspected.metadata.ino !== inspected.ino
    ) {
      // Inode changed: another recovery or contender already resolved it.
      return { kind: "aborted" };
    }
    // Preserve the caller's root-binding rule: a non-null payload bound to a
    // different canonical root is corrupt, not recoverable — even if its owner
    // is dead. The initial inspection may have seen an empty file (null
    // payload) that passed the root check trivially; the current payload read
    // under the marker may reveal a foreign-root lock.
    if (
      currentInspected.payload !== null &&
      currentInspected.payload.rootHash !== rootHash
    ) {
      return {
        kind: "error",
        error: new ProjectLockError(
          "LOCK_CORRUPT",
          "Project lock is bound to a different canonical root hash",
        ),
      };
    }
    // Re-check staleness with the current payload and mtime. A lock that is
    // now valid (non-null payload) and owned by a live process must not be
    // removed, even if it was empty when first inspected.
    const currentAgeMs = Math.max(
      0,
      Date.now() - currentInspected.metadata.mtimeMs,
    );
    const currentOwnerAlive = currentInspected.payload
      ? isProcessAlive(currentInspected.payload.pid)
      : false;
    if (currentAgeMs < staleLockMs || currentOwnerAlive) {
      return { kind: "aborted" };
    }

    // Move the candidate into the quarantine path resolved relative to the
    // marker, then fsync the parent so the rename is durable before any acquirer
    // observes the cleared marker.
    const quarantinePath = `${marker.projectDir}/.stale-lock-${process.pid}-${randomUUID()}`;
    await rename(lockFile, quarantinePath);
    const quarantined = await lstat(quarantinePath);
    if (quarantined.dev !== inspected.dev || quarantined.ino !== inspected.ino) {
      // The rename did not move our candidate (concurrent replace). Restore by
      // inode identity so we never clobber a contender's fresh lock.
      await restoreQuarantinedLock(quarantinePath, lockFile);
      return { kind: "aborted" };
    }

    await unlink(quarantinePath);
    return { kind: "recovered" };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { kind: "aborted" };
    }
    return {
      kind: "error",
      error: new ProjectLockError(
        "LOCK_IO",
        "Unable to recover stale project lock",
        { cause: error },
      ),
    };
  } finally {
    if (markerCreated) {
      await releaseRecoveryMarker(marker, markerHandle, markerIdentity);
    } else if (markerHandle !== undefined) {
      await markerHandle.close().catch(() => undefined);
    }
  }
}

// Restores a quarantined candidate back to state.lock. The recovery marker is
// held for the entire rename→resolve window, so no contender can create
// state.lock concurrently; link() therefore recreates the original owner's
// inode without risk of clobbering a fresh lock.
async function restoreQuarantinedLock(
  stalePath: string,
  lockFile: string,
): Promise<void> {
  try {
    await link(stalePath, lockFile);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      // Should not happen under the marker, but stay fail-safe: drop the
      // quarantine rather than clobbering an existing lock.
      await unlink(stalePath).catch(() => undefined);
      return;
    }
    throw error;
  }
  await unlink(stalePath);
}

type MarkerAcquireResult =
  | {
      kind: "acquired";
      handle: FileHandle;
      identity: { dev: number; ino: number };
    }
  | { kind: "busy" }
  | { kind: "aborted" }
  | { kind: "error"; error: ProjectLockError };

// Atomically creates the recovery marker via O_EXCL and returns the owning
// handle plus inode identity. If a marker already exists, a crash-stale one
// (dead owner) is reclaimed by identity so recovery can proceed; a live one
// makes this recovery defer to the in-progress owner. The whole resolution is
// a single bounded loop driven by the acquire deadline.
async function acquireRecoveryMarker(
  marker: RecoveryMarkerPath,
  rootHash: string,
  deadline: number,
): Promise<MarkerAcquireResult> {
  while (Date.now() < deadline) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        marker.path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NONBLOCK |
          fsConstants.O_NOFOLLOW,
        RECOVERY_MARKER_MODE,
      );
      await handle.chmod(RECOVERY_MARKER_MODE);
      const metadata = await handle.stat();
      if (!isSafeRecoveryInode(metadata)) {
        throw new ProjectLockError(
          "LOCK_CORRUPT",
          `New recovery marker inode is unsafe: ${marker.path}`,
        );
      }
      const payload: RecoveryMarkerPayload = {
        schemaVersion: 1,
        rootHash,
        pid: process.pid,
        nonce: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.sync();
      return {
        kind: "acquired",
        handle,
        identity: { dev: metadata.dev, ino: metadata.ino },
      };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        await unlink(marker.path).catch(() => undefined);
      }
      if (!isNodeError(error, "EEXIST")) {
        return {
          kind: "error",
          error: new ProjectLockError(
            "LOCK_IO",
            `Unable to create recovery marker: ${marker.path}`,
            { cause: error },
          ),
        };
      }
    }

    // A marker already exists. Resolve it: defer to a live owner, or reclaim a
    // crash-stale one by identity and retry acquisition within the deadline.
    let inspected: InspectedMarker;
    try {
      inspected = await inspectRecoveryMarker(marker, rootHash);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue; // Cleared by its owner between the EEXIST and the inspect.
      }
      if (error instanceof ProjectLockError) {
        return { kind: "error", error };
      }
      return {
        kind: "error",
        error: new ProjectLockError(
          "LOCK_CORRUPT",
          `Cannot inspect existing recovery marker: ${marker.path}`,
          { cause: error },
        ),
      };
    }
    if (isProcessAlive(inspected.payload.pid)) {
      return { kind: "busy" };
    }
    if (!(await removeMarkerByIdentity(marker, inspected.metadata))) {
      continue; // Changed underneath us; re-inspect by looping.
    }
  }
  return { kind: "aborted" };
}

// Releases the recovery marker: fsync the parent directory so the marker
// contents are durable, then remove the marker only if it is still the inode
// we created. A crash before completion leaves a crash-stale marker that a
// later acquirer reclaims safely by identity.
async function releaseRecoveryMarker(
  marker: RecoveryMarkerPath,
  handle: FileHandle | undefined,
  identity: { dev: number; ino: number } | undefined,
): Promise<void> {
  if (handle !== undefined) {
    await handle.sync().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
  await fsyncDirectory(marker.projectDir);
  if (identity === undefined) {
    return;
  }
  try {
    const current = await lstat(marker.path);
    if (current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(marker.path);
      await fsyncDirectory(marker.projectDir);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      // Best-effort: a leftover marker is reclaimed as crash-stale later.
    }
  }
}

async function removeMarkerByIdentity(
  marker: RecoveryMarkerPath,
  expected: Stats,
): Promise<boolean> {
  try {
    const current = await lstat(marker.path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      return false;
    }
    await unlink(marker.path);
    await fsyncDirectory(marker.projectDir);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    return false;
  }
}

type MarkerPresence =
  | { kind: "present" | "absent" }
  | { kind: "error"; error: ProjectLockError };

// Inspects a recovery marker and, if its owner process is dead, removes it by
// inode identity so a crashed recoverer never permanently blocks acquisition.
// Returns "cleared" if the marker is absent or was just reclaimed, "present"
// if a live owner still holds it, or "error" for unsafe/foreign/malformed
// markers that must never be silently deleted.
async function reclaimMarkerIfStale(
  marker: RecoveryMarkerPath,
  rootHash: string,
): Promise<MarkerPresence> {
  let inspected: InspectedMarker;
  try {
    inspected = await inspectRecoveryMarker(marker, rootHash);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "absent" };
    if (error instanceof ProjectLockError) {
      return { kind: "error", error };
    }
    return {
      kind: "error",
      error: new ProjectLockError(
        "LOCK_CORRUPT",
        `Cannot inspect recovery marker: ${marker.path}`,
        { cause: error },
      ),
    };
  }
  if (isProcessAlive(inspected.payload.pid)) {
    return { kind: "present" };
  }
  // Crash-stale marker: remove it by identity, never a foreign/live inode.
  const removed = await removeMarkerByIdentity(marker, inspected.metadata);
  return removed ? { kind: "absent" } : { kind: "present" };
}

// Waits for any existing recovery marker to clear. Acquirers must observe no
// marker before O_EXCL creation so they never race with a quarantined owner.
// A crash-stale marker (dead owner) is reclaimed by inode identity here so a
// crashed recoverer never permanently blocks acquisition. A live owner's
// marker is never removed. Bounded by the acquire deadline and a hard
// iteration cap — no unbounded polling.
async function waitForRecoveryMarkerCleared(
  marker: RecoveryMarkerPath,
  deadline: number,
  rootHash: string,
): Promise<
  | { kind: "cleared" }
  | { kind: "timeout" }
  | { kind: "error"; error: ProjectLockError }
> {
  let iterations = 0;
  while (Date.now() < deadline) {
    if (iterations >= MAX_RECOVERY_MARKER_WAITERS) {
      return { kind: "timeout" };
    }
    iterations += 1;
    const presence = await reclaimMarkerIfStale(marker, rootHash);
    if (presence.kind === "error") {
      return { kind: "error", error: presence.error };
    }
    if (presence.kind === "absent") {
      return { kind: "cleared" };
    }
    await sleep(Math.min(RECOVERY_MARKER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return { kind: "timeout" };
}

async function inspectRecoveryMarker(
  marker: RecoveryMarkerPath,
  rootHash: string,
): Promise<InspectedMarker> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      marker.path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !isSafeRecoveryInode(metadata) ||
      metadata.size > MAX_MARKER_BYTES
    ) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        `Recovery marker is unsafe: ${marker.path}`,
      );
    }
    const text = await handle.readFile("utf8");
    const payload = parseRecoveryMarkerPayload(text);
    if (payload === null) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        `Recovery marker payload is invalid: ${marker.path}`,
      );
    }
    if (rootHash.length > 0 && payload.rootHash !== rootHash) {
      throw new ProjectLockError(
        "LOCK_CORRUPT",
        "Recovery marker is bound to a different canonical root hash",
      );
    }
    return { payload, metadata };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw error;
    }
    if (error instanceof ProjectLockError) {
      throw error;
    }
    throw new ProjectLockError(
      "LOCK_CORRUPT",
      `Cannot inspect recovery marker: ${marker.path}`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseRecoveryMarkerPayload(text: string): RecoveryMarkerPayload | null {
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
    return value as unknown as RecoveryMarkerPayload;
  } catch {
    return null;
  }
}

function isSafeRecoveryInode(metadata: Stats): boolean {
  return (
    metadata.isFile() &&
    metadata.nlink === 1 &&
    (metadata.mode & 0o777) === RECOVERY_MARKER_MODE &&
    (typeof process.getuid !== "function" || metadata.uid === process.getuid())
  );
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    await handle.sync();
  } catch {
    // Directory fsync is best-effort for durability; a missing or unsupported
    // sync never creates a concurrent owner (O_EXCL + marker protocol still hold).
  } finally {
    await handle?.close().catch(() => undefined);
  }
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

async function releaseOwnedLock(
  lockFile: string,
  payload: LockPayload,
): Promise<void> {
  try {
    const inspected = await inspectLock(lockFile);
    if (inspected.payload?.nonce === payload.nonce) {
      await unlink(lockFile);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw new ProjectLockError("LOCK_IO", "Unable to release project lock", {
        cause: error,
      });
    }
  }
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

