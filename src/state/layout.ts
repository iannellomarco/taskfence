import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const DIRECTORY_MODE = 0o700;

export interface StateLayout {
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

export async function canonicalStateRoot(root: string): Promise<string> {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new TypeError("Project root must be a non-empty path without NUL bytes");
  }

  const canonicalRoot = await realpath(resolve(root));
  const metadata = await lstat(canonicalRoot);
  if (!metadata.isDirectory()) {
    throw new TypeError(`Project root is not a directory: ${canonicalRoot}`);
  }
  return canonicalRoot;
}

export function hashProjectRoot(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot, "utf8").digest("hex");
}

export async function stateLayout(root: string): Promise<StateLayout> {
  const canonicalRoot = await canonicalStateRoot(root);
  const configuredBase = resolveConfiguredStateDirectory();
  const prospectiveBase = await resolveProspectivePath(configuredBase);
  if (
    isWithin(canonicalRoot, configuredBase) ||
    isWithin(canonicalRoot, prospectiveBase)
  ) {
    throw new Error(
      `TaskFence state directory must be outside the project root: ${configuredBase}`,
    );
  }

  await ensureSecureDirectory(configuredBase);
  const baseDir = await realpath(configuredBase);
  if (isWithin(canonicalRoot, baseDir)) {
    throw new Error(
      `TaskFence state directory must be outside the project root: ${baseDir}`,
    );
  }

  const projectsDir = join(baseDir, "projects");
  await ensureSecureDirectory(projectsDir);

  const rootHash = hashProjectRoot(canonicalRoot);
  const projectDir = join(projectsDir, rootHash);
  const checkpointsDir = join(projectDir, "checkpoints");
  await ensureSecureDirectory(projectDir);
  await ensureSecureDirectory(checkpointsDir);

  return {
    canonicalRoot,
    rootHash,
    baseDir,
    projectsDir,
    projectDir,
    stateFile: join(projectDir, "state.json"),
    lockFile: join(projectDir, "state.lock"),
    checkpointsDir,
    receiptsFile: join(projectDir, "receipts.jsonl"),
    transactionFile: join(projectDir, "transaction.json"),
  };
}

function resolveConfiguredStateDirectory(): string {
  const explicit = process.env.TASKFENCE_STATE_DIR;
  if (explicit !== undefined) {
    return requireAbsoluteStatePath(explicit, "TASKFENCE_STATE_DIR");
  }

  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome !== undefined) {
    return join(requireAbsoluteStatePath(xdgStateHome, "XDG_STATE_HOME"), "taskfence");
  }

  return join(homedir(), ".local", "state", "taskfence");
}

function requireAbsoluteStatePath(value: string, variable: string): string {
  if (value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error(`${variable} must contain a non-empty absolute path`);
  }
  return resolve(value);
}

async function resolveProspectivePath(path: string): Promise<string> {
  let ancestor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...suffix.reverse());
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  const createdChain = await createMissingDirectoryChain(directory);

  for (const created of createdChain) {
    assertSecureDirectory(created.directory, created.metadata);
    // A power loss between creating a directory entry and fsyncing its parent
    // can lose the entire subtree after approval reported success, so persist
    // each new link and its newly updated parent before proceeding.
    await syncStateDirectory(created.directory);
    await syncStateDirectory(created.parent);
  }

  if (createdChain.length === 0) {
    const metadata = await lstat(directory);
    assertSecureDirectory(directory, metadata);
    if ((metadata.mode & 0o777) !== DIRECTORY_MODE) {
      await chmod(directory, DIRECTORY_MODE);
      const secured = await lstat(directory);
      assertSecureDirectory(directory, secured);
      if ((secured.mode & 0o777) !== DIRECTORY_MODE) {
        throw new Error(`Unable to secure state directory: ${directory}`);
      }
      await syncStateDirectory(directory);
      await syncStateDirectory(dirname(directory));
    }
  }
}

interface CreatedDirectory {
  directory: string;
  parent: string;
  metadata: Stats;
}

async function createMissingDirectoryChain(
  directory: string,
): Promise<CreatedDirectory[]> {
  const components: string[] = [];
  let ancestor = directory;
  while (true) {
    try {
      const metadata = await lstat(ancestor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`State path is not a real directory: ${ancestor}`);
      }
      break;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`Unable to create state directory: ${directory}`);
    }
    components.push(ancestor);
    ancestor = parent;
  }
  if (components.length === 0) return [];

  const created: CreatedDirectory[] = [];
  for (let index = components.length - 1; index >= 0; index -= 1) {
    const component = components[index];
    const parent = dirname(component);
    await mkdir(component, { recursive: false, mode: DIRECTORY_MODE }).catch(
      (error: unknown) => {
        if (!isNodeError(error, "EEXIST")) throw error;
      },
    );
    // A restrictive process umask may strip owner bits from the freshly created
    // directory, so establish the exact invariant before relying on it.
    await chmod(component, DIRECTORY_MODE);
    const metadata = await lstat(component);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== DIRECTORY_MODE
    ) {
      throw new Error(`Unable to secure state directory: ${component}`);
    }
    created.push({ directory: component, parent, metadata });
  }
  return created;
}

function assertSecureDirectory(directory: string, metadata: Stats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`State path is not a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`State directory is not owned by the current user: ${directory}`);
  }
}

async function syncStateDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export const STATE_FILE_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
