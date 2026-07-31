import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUFFER_SIZE = 64 * 1024;
const CAS_OBJECT_MODE = 0o600;

function assertSecureObject(metadata: Stats, expectedSize: number, label: string): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size !== expectedSize ||
    (metadata.mode & 0o777) !== CAS_OBJECT_MODE ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      `${label} must be a current-user regular file with mode ${CAS_OBJECT_MODE.toString(8)}, one link, and exactly ${expectedSize} bytes`,
    );
  }
}

export function objectPath(objectStore: string, hash: string): string {
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`Invalid checkpoint object hash: ${hash}`);
  }
  return path.join(objectStore, hash.slice(0, 2), hash.slice(2));
}

export interface ObjectTemp {
  path: string;
  handle: FileHandle;
}

export async function createObjectTemp(
  objectStore: string,
): Promise<ObjectTemp> {
  const tempDirectory = path.join(objectStore, ".tmp");
  await ensureCheckpointDirectory(tempDirectory, objectStore);
  const tempPath = path.join(tempDirectory, `${process.pid}-${randomUUID()}`);
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    CAS_OBJECT_MODE,
  );
  try {
    // A restrictive process umask may strip owner bits from the freshly
    // created inode. The inode is exclusively ours, so establish the exact
    // invariant before writing bytes that will be renamed into the CAS.
    await handle.chmod(CAS_OBJECT_MODE);
    const metadata = await handle.stat();
    assertSecureObject(metadata, 0, "Checkpoint object temp");
    return { path: tempPath, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function commitObjectTemp(
  objectStore: string,
  tempPath: string,
  hash: string,
): Promise<void> {
  const destination = objectPath(objectStore, hash);
  const bucket = path.dirname(destination);
  await ensureCheckpointDirectory(bucket, objectStore);
  await rename(tempPath, destination);
  const directory = await open(
    bucket,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function discardObjectTemp(tempPath: string): Promise<void> {
  await unlink(tempPath).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  });
}

export async function verifyObject(
  objectStore: string,
  expectedHash: string,
  expectedSize: number,
): Promise<void> {
  const source = await openSecureObjectSource(
    objectStore,
    expectedHash,
    expectedSize,
  );
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let size = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const actualHash = digest.digest("hex");
    if (size !== expectedSize || actualHash !== expectedHash) {
      throw new Error(`Checkpoint object is missing or corrupt: ${expectedHash}`);
    }
  } finally {
    await source.close();
  }
}

async function openSecureObjectSource(
  objectStore: string,
  expectedHash: string,
  expectedSize: number,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(
      objectPath(objectStore, expectedHash),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error(`Checkpoint object is missing or corrupt: ${expectedHash}`);
  }
  try {
    const metadata = await handle.stat();
    try {
      assertSecureObject(metadata, expectedSize, `Checkpoint object ${expectedHash}`);
    } catch {
      throw new Error(`Checkpoint object is missing or corrupt: ${expectedHash}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("Checkpoint object is missing or corrupt")) {
      throw error;
    }
    throw new Error(`Checkpoint object is missing or corrupt: ${expectedHash}`);
  }
}

export async function restoreObject(
  objectStore: string,
  expectedHash: string,
  expectedSize: number,
  destination: string,
  mode: number,
): Promise<void> {
  const source = await openSecureObjectSource(
    objectStore,
    expectedHash,
    expectedSize,
  );
  let target: FileHandle | undefined;
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
  let size = 0;

  try {
    target = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
      await writeAll(target, buffer, bytesRead);
    }
    const actualHash = digest.digest("hex");
    if (size !== expectedSize || actualHash !== expectedHash) {
      throw new Error(`Checkpoint object is missing or corrupt: ${expectedHash}`);
    }
    await target.chmod(mode);
    await target.sync();
    await target.close();
    target = undefined;
  } catch (error) {
    if (target) await target.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await source.close();
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      length - offset,
      null,
    );
    if (bytesWritten === 0) {
      throw new Error("Unable to write checkpoint data");
    }
    offset += bytesWritten;
  }
}

export async function ensureCheckpointDirectory(
  directory: string,
  parentDirectory: string,
): Promise<string> {
  await assertSecureCheckpointDirectory(parentDirectory);

  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  await assertSecureCheckpointDirectory(directory);
  const [canonicalParent, canonicalDirectory] = await Promise.all([
    realpath(parentDirectory),
    realpath(directory),
  ]);
  if (path.dirname(canonicalDirectory) !== canonicalParent) {
    throw new Error(
      `Checkpoint storage path escapes its parent directory: ${directory}`,
    );
  }
  if (created) {
    await syncDirectory(canonicalParent);
  }
  return canonicalDirectory;
}

async function assertSecureCheckpointDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Checkpoint storage path is not a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(
      `Checkpoint storage path is not owned by the current user: ${directory}`,
    );
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error(
      `Checkpoint storage path has unsafe permissions: ${directory}`,
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
