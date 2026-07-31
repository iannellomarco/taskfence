import { constants as fsConstants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export interface SecureFile {
  handle: FileHandle;
  metadata: Stats;
}

export interface SecureFileRequirements {
  mode: number;
  maxBytes: number;
  label: string;
}

const SECURE_OPEN_FLAGS = fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export async function openSecureFile(
  path: string,
  flags: number,
  requirements: SecureFileRequirements,
): Promise<SecureFile> {
  const handle = await open(path, flags | SECURE_OPEN_FLAGS);
  try {
    const metadata = await handle.stat();
    validateSecureFile(path, metadata, requirements);
    return { handle, metadata };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function createSecureFile(
  path: string,
  flags: number,
  requirements: SecureFileRequirements,
): Promise<SecureFile> {
  const handle = await open(
    path,
    flags |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      SECURE_OPEN_FLAGS,
    requirements.mode,
  );
  try {
    // A restrictive process umask may remove owner bits. The inode is ours and
    // was created exclusively, so establish the exact invariant before use.
    await handle.chmod(requirements.mode);
    const metadata = await handle.stat();
    validateSecureFile(path, metadata, requirements);
    return { handle, metadata };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function validateSecureFile(
  path: string,
  metadata: Stats,
  requirements: SecureFileRequirements,
): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size < 0 ||
    metadata.size > requirements.maxBytes ||
    (metadata.mode & 0o777) !== requirements.mode ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      `${requirements.label} must be a current-user regular file with mode ${requirements.mode.toString(8)}, one link, and at most ${requirements.maxBytes} bytes: ${path}`,
    );
  }
}

export async function syncSecureDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() ||
      (metadata.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new Error(`State directory is unsafe: ${path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
