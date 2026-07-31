import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";

import { canonicalStringify, sha256 } from "../contract/canonical.js";
import type { CheckpointEntry } from "../types.js";
import {
  commitObjectTemp,
  createObjectTemp,
  discardObjectTemp,
  type ObjectTemp,
} from "./cas.js";
const BUFFER_SIZE = 64 * 1024;

export const DEFAULT_MAX_FILES = 100_000;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024;

export interface ScanLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxBytes?: number;
}

export interface ScanOptions extends ScanLimits {
  objectStore?: string;
}

export interface WorktreeScan {
  entries: CheckpointEntry[];
  totalFiles: number;
  totalBytes: number;
}

interface EffectiveLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxBytes: number;
}

interface CapturedEntry {
  entry: CheckpointEntry;
  fingerprint: string;
}

interface PassState {
  root: string;
  objectStore?: string;
  limits: EffectiveLimits;
  entries: CapturedEntry[];
  entryCount: number;
  totalFiles: number;
  totalBytes: number;
}

export async function scanWorktree(
  root: string,
  options: ScanOptions = {},
): Promise<WorktreeScan> {
  if (options.objectStore) {
    const relativeStore = path.relative(
      path.resolve(root),
      path.resolve(options.objectStore),
    );
    if (
      relativeStore === "" ||
      (relativeStore !== ".." &&
        !relativeStore.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeStore))
    ) {
      throw new Error("Checkpoint object store must be outside the worktree");
    }
  }
  const limits: EffectiveLimits = {
    maxFiles: checkedLimit("maxFiles", options.maxFiles, DEFAULT_MAX_FILES),
    maxFileBytes: checkedLimit(
      "maxFileBytes",
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
    ),
    maxBytes: checkedLimit("maxBytes", options.maxBytes, DEFAULT_MAX_BYTES),
  };
  const first = await scanPass(root, options.objectStore, limits);
  const verification = await scanPass(root, undefined, limits);

  if (
    first.totalFiles !== verification.totalFiles ||
    first.totalBytes !== verification.totalBytes ||
    canonicalStringify(first.entries) !== canonicalStringify(verification.entries)
  ) {
    throw new Error("Worktree changed while the checkpoint was being scanned");
  }

  return {
    entries: first.entries.map(({ entry }) => entry),
    totalFiles: first.totalFiles,
    totalBytes: first.totalBytes,
  };
}

async function scanPass(
  root: string,
  objectStore: string | undefined,
  limits: EffectiveLimits,
): Promise<{
  entries: CapturedEntry[];
  totalFiles: number;
  totalBytes: number;
}> {
  const state: PassState = {
    root,
    objectStore,
    limits,
    entries: [],
    entryCount: 0,
    totalFiles: 0,
    totalBytes: 0,
  };
  const rootBefore = await lstat(root, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error("Checkpoint root must be a real directory");
  }

  await captureDirectory(state, ".", rootBefore, true);
  const rootAfter = await lstat(root, { bigint: true });
  if (fingerprint(rootBefore) !== fingerprint(rootAfter)) {
    throw new Error("Worktree changed while the checkpoint was being scanned");
  }
  state.entries.sort((left, right) =>
    left.entry.path < right.entry.path
      ? -1
      : left.entry.path > right.entry.path
        ? 1
        : 0,
  );
  return {
    entries: state.entries,
    totalFiles: state.totalFiles,
    totalBytes: state.totalBytes,
  };
}

async function captureDirectory(
  state: PassState,
  relativePath: string,
  before: BigIntStats,
  isRoot = false,
): Promise<void> {
  if (!isRoot) reserveEntry(state, relativePath);
  const absolutePath =
    relativePath === "."
      ? state.root
      : path.join(state.root, ...relativePath.split("/"));
  const mode = permissionMode(before);
  state.entries.push({
    entry: {
      path: relativePath,
      type: "directory",
      mode,
      hash: sha256(
        canonicalStringify({ path: relativePath, type: "directory", mode }),
      ),
    },
    fingerprint: fingerprint(before),
  });

  const directory = await open(
    absolutePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let names: string[] | null = null;
  try {
    const opened = await directory.stat({ bigint: true });
    if (!opened.isDirectory() || fingerprint(before) !== fingerprint(opened)) {
      throw new Error(
        `Worktree changed while opening directory: ${relativePath}`,
      );
    }
    names = await readDirectoryNames(absolutePath);
    const afterEnumeration = await lstat(absolutePath, { bigint: true });
    if (fingerprint(opened) !== fingerprint(afterEnumeration)) {
      throw new Error(
        `Worktree changed while reading directory: ${relativePath}`,
      );
    }
  } finally {
    await directory.close();
  }
  if (names === null) {
    throw new Error(`Unable to enumerate checkpoint directory: ${relativePath}`);
  }
  for (const name of names) {
    if (isRoot && name === ".git") continue;
    const childRelative =
      relativePath === "." ? name : `${relativePath}/${name}`;
    const childAbsolute = path.join(absolutePath, name);
    const childBefore = await lstat(childAbsolute, { bigint: true });

    if (childBefore.isDirectory() && !childBefore.isSymbolicLink()) {
      await captureDirectory(state, childRelative, childBefore);
    } else if (childBefore.isFile()) {
      await captureFile(state, childRelative, childAbsolute, childBefore);
    } else if (childBefore.isSymbolicLink()) {
      await captureSymlink(state, childRelative, childAbsolute, childBefore);
    } else {
      throw new Error(`Unsupported special file in checkpoint: ${childRelative}`);
    }
  }

  const after = await lstat(absolutePath, { bigint: true });
  if (fingerprint(before) !== fingerprint(after)) {
    throw new Error(
      `Worktree changed while scanning directory: ${relativePath}`,
    );
  }
}

async function captureFile(
  state: PassState,
  relativePath: string,
  absolutePath: string,
  pathBefore: BigIntStats,
): Promise<void> {
  if (pathBefore.nlink > 1n) {
    throw new Error(
      `Checkpoint cannot represent hard-linked file: ${relativePath}`,
    );
  }
  reserveEntry(state, relativePath);
  state.totalFiles += 1;
  if (pathBefore.size > BigInt(state.limits.maxFileBytes)) {
    throw new Error(
      `Checkpoint file byte limit exceeded for ${relativePath} (${state.limits.maxFileBytes})`,
    );
  }
  if (BigInt(state.totalBytes) + pathBefore.size > BigInt(state.limits.maxBytes)) {
    throw new Error(
      `Checkpoint total byte limit exceeded (${state.limits.maxBytes})`,
    );
  }

  const source = await open(
    absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const sourceBefore = await source.stat({ bigint: true });
  if (
    !sourceBefore.isFile() ||
    fingerprint(pathBefore) !== fingerprint(sourceBefore)
  ) {
    await source.close();
    throw new Error(`Worktree changed while opening file: ${relativePath}`);
  }

  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
  let temp: ObjectTemp | undefined;
  let fileBytes = 0;
  try {
    if (state.objectStore) {
      temp = await createObjectTemp(state.objectStore);
    }
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      fileBytes += bytesRead;
      if (fileBytes > state.limits.maxFileBytes) {
        throw new Error(
          `Checkpoint file byte limit exceeded for ${relativePath} (${state.limits.maxFileBytes})`,
        );
      }
      if (state.totalBytes + fileBytes > state.limits.maxBytes) {
        throw new Error(
          `Checkpoint total byte limit exceeded (${state.limits.maxBytes})`,
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      if (temp) {
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await temp.handle.write(
            buffer,
            offset,
            bytesRead - offset,
            null,
          );
          if (bytesWritten === 0) {
            throw new Error("Unable to write checkpoint object");
          }
          offset += bytesWritten;
        }
      }
    }

    const sourceAfter = await source.stat({ bigint: true });
    const pathAfter = await lstat(absolutePath, { bigint: true });
    if (
      fingerprint(sourceBefore) !== fingerprint(sourceAfter) ||
      fingerprint(sourceBefore) !== fingerprint(pathAfter) ||
      BigInt(fileBytes) !== sourceAfter.size
    ) {
      throw new Error(`Worktree changed while reading file: ${relativePath}`);
    }

    const hash = digest.digest("hex");
    if (temp) {
      await temp.handle.sync();
      await temp.handle.close();
      await commitObjectTemp(state.objectStore!, temp.path, hash);
    }
    state.totalBytes += fileBytes;
    state.entries.push({
      entry: {
        path: relativePath,
        type: "file",
        mode: permissionMode(sourceAfter),
        hash,
        size: fileBytes,
      },
      fingerprint: fingerprint(sourceAfter),
    });
  } catch (error) {
    if (temp) {
      await temp.handle.close().catch(() => undefined);
      await discardObjectTemp(temp.path).catch(() => undefined);
    }
    throw error;
  } finally {
    await source.close();
  }
}

async function captureSymlink(
  state: PassState,
  relativePath: string,
  absolutePath: string,
  before: BigIntStats,
): Promise<void> {
  reserveEntry(state, relativePath);
  const rawLink = await readlink(absolutePath, { encoding: "buffer" });
  const link = rawLink.toString("utf8");
  if (!Buffer.from(link).equals(rawLink)) {
    throw new Error(
      `Checkpoint cannot represent a non-UTF-8 symlink target: ${relativePath}`,
    );
  }
  const after = await lstat(absolutePath, { bigint: true });
  if (fingerprint(before) !== fingerprint(after)) {
    throw new Error(`Worktree changed while reading symlink: ${relativePath}`);
  }
  const mode = permissionMode(after);
  state.entries.push({
    entry: {
      path: relativePath,
      type: "symlink",
      mode,
      link,
      hash: sha256(link),
    },
    fingerprint: fingerprint(after),
  });
}

function reserveEntry(state: PassState, relativePath: string): void {
  state.entryCount += 1;
  if (state.entryCount > state.limits.maxFiles) {
    throw new Error(
      `Checkpoint entry limit exceeded at ${relativePath} (${state.limits.maxFiles})`,
    );
  }
}

function permissionMode(stats: BigIntStats): number {
  return Number(stats.mode & 0o7777n);
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  const rawNames = await readdir(directory, { encoding: "buffer" });
  const names = rawNames.map((rawName) => {
    const decoded = rawName.toString("utf8");
    if (!Buffer.from(decoded).equals(rawName)) {
      throw new Error(
        `Checkpoint cannot represent a non-UTF-8 filename in ${directory}`,
      );
    }
    if (decoded.includes("\\")) {
      throw new Error(
        `Checkpoint cannot represent a filename containing a backslash in ${directory}`,
      );
    }
    return decoded;
  });
  names.sort();
  return names;
}

function fingerprint(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.uid,
    stats.gid,
    stats.rdev,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(":");
}

function checkedLimit(name: string, value: number | undefined, fallback: number) {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return effective;
}
