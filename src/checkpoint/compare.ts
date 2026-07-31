import { realpath } from "node:fs/promises";
import { canonicalStringify, sha256 } from "../contract/canonical.js";
import { stateLayout } from "../state/layout.js";
import type { CheckpointEntry, CheckpointManifest } from "../types.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  scanWorktree,
} from "./scan.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CheckpointDifference {
  path: string;
  reason: "added" | "removed" | "type" | "hash" | "mode" | "size" | "link";
  expected?: CheckpointEntry;
  actual?: CheckpointEntry;
}

export interface CheckpointComparison {
  matches: boolean;
  differences: CheckpointDifference[];
}

export async function compareCheckpoint(
  root: string,
  manifest: CheckpointManifest,
): Promise<CheckpointComparison> {
  const layout = await stateLayout(root);
  validateCheckpointManifest(manifest, layout.canonicalRoot);
  return compareCheckpointTree(layout.canonicalRoot, manifest);
}

export async function compareCheckpointTree(
  root: string,
  manifest: CheckpointManifest,
): Promise<CheckpointComparison> {
  validateCheckpointManifest(manifest);
  const canonicalRoot = await realpath(root);
  const largestFile = manifest.entries.reduce(
    (largest, entry) =>
      entry.type === "file" ? Math.max(largest, entry.size ?? 0) : largest,
    0,
  );
  const scan = await scanWorktree(canonicalRoot, {
    maxFiles: Math.max(DEFAULT_MAX_FILES, manifest.entries.length),
    maxFileBytes: Math.max(DEFAULT_MAX_FILE_BYTES, largestFile),
    maxBytes: Math.max(DEFAULT_MAX_BYTES, manifest.totalBytes + largestFile),
  });

  const expectedByPath = new Map(
    manifest.entries.map((entry) => [entry.path, entry]),
  );
  const actualByPath = new Map(scan.entries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])];
  allPaths.sort();
  const differences: CheckpointDifference[] = [];

  for (const entryPath of allPaths) {
    const expected = expectedByPath.get(entryPath);
    const actual = actualByPath.get(entryPath);
    if (!expected) {
      differences.push({ path: entryPath, reason: "added", actual });
      continue;
    }
    if (!actual) {
      differences.push({ path: entryPath, reason: "removed", expected });
      continue;
    }
    if (expected.type !== actual.type) {
      differences.push({ path: entryPath, reason: "type", expected, actual });
      continue;
    }
    if (expected.hash !== actual.hash) {
      differences.push({ path: entryPath, reason: "hash", expected, actual });
    }
    if (expected.mode !== actual.mode) {
      differences.push({ path: entryPath, reason: "mode", expected, actual });
    }
    if (
      expected.type === "file" &&
      actual.type === "file" &&
      expected.size !== actual.size
    ) {
      differences.push({ path: entryPath, reason: "size", expected, actual });
    }
    if (
      expected.type === "symlink" &&
      actual.type === "symlink" &&
      expected.link !== actual.link
    ) {
      differences.push({ path: entryPath, reason: "link", expected, actual });
    }
  }

  return { matches: differences.length === 0, differences };
}

export function validateCheckpointManifest(
  manifest: CheckpointManifest,
  expectedRoot?: string,
): void {
  if (!isRecord(manifest)) {
    throw new Error("Invalid checkpoint manifest");
  }
  requireExactKeys(manifest, [
    "entries",
    "hash",
    "root",
    "totalBytes",
    "totalFiles",
    "version",
  ]);
  if (manifest.version !== 1) {
    throw new Error("Unsupported checkpoint manifest version");
  }
  if (typeof manifest.root !== "string" || manifest.root.length === 0) {
    throw new Error("Invalid checkpoint manifest root");
  }
  if (expectedRoot !== undefined && manifest.root !== expectedRoot) {
    throw new Error("Checkpoint manifest belongs to a different worktree");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Checkpoint manifest entries must be a non-empty array");
  }
  if (
    !Number.isSafeInteger(manifest.totalFiles) ||
    manifest.totalFiles < 0 ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0
  ) {
    throw new Error("Invalid checkpoint manifest totals");
  }
  if (typeof manifest.hash !== "string" || !SHA256_PATTERN.test(manifest.hash)) {
    throw new Error("Invalid checkpoint manifest hash");
  }

  let previousPath: string | undefined;
  let totalFiles = 0;
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    validateEntry(entry);
    if (previousPath !== undefined && previousPath >= entry.path) {
      throw new Error("Checkpoint entries must have unique sorted paths");
    }
    previousPath = entry.path;
    if (entry.type === "file") {
      totalFiles += 1;
      totalBytes += entry.size!;
      if (!Number.isSafeInteger(totalBytes)) {
        throw new Error("Checkpoint byte total exceeds safe integer range");
      }
    }
  }
  const rootEntry = manifest.entries.find((entry) => entry.path === ".");
  if (!rootEntry || rootEntry.type !== "directory") {
    throw new Error("Checkpoint manifest must include the root directory");
  }
  const entryByPath = new Map(
    manifest.entries.map((entry) => [entry.path, entry]),
  );
  for (const entry of manifest.entries) {
    if (entry.path === ".") continue;
    const separator = entry.path.lastIndexOf("/");
    const parentPath =
      separator === -1 ? "." : entry.path.slice(0, separator);
    if (entryByPath.get(parentPath)?.type !== "directory") {
      throw new Error(
        `Checkpoint entry has a missing or non-directory parent: ${entry.path}`,
      );
    }
  }
  if (totalFiles !== manifest.totalFiles || totalBytes !== manifest.totalBytes) {
    throw new Error("Checkpoint manifest totals do not match its entries");
  }

  const unsigned = {
    version: manifest.version,
    root: manifest.root,
    entries: manifest.entries,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
  };
  if (sha256(canonicalStringify(unsigned)) !== manifest.hash) {
    throw new Error("Checkpoint manifest hash does not match its contents");
  }
}

function validateEntry(entry: CheckpointEntry): void {
  if (!isRecord(entry)) {
    throw new Error("Invalid checkpoint entry");
  }
  if (!isSafeCheckpointPath(entry.path)) {
    throw new Error(`Unsafe checkpoint path: ${String(entry.path)}`);
  }
  if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
    throw new Error(`Invalid checkpoint mode for ${entry.path}`);
  }
  if (typeof entry.hash !== "string" || !SHA256_PATTERN.test(entry.hash)) {
    throw new Error(`Invalid checkpoint hash for ${entry.path}`);
  }

  if (entry.type === "directory") {
    requireExactKeys(entry, ["hash", "mode", "path", "type"]);
    const expectedHash = sha256(
      canonicalStringify({
        path: entry.path,
        type: "directory",
        mode: entry.mode,
      }),
    );
    if (entry.hash !== expectedHash) {
      throw new Error(`Invalid directory hash for ${entry.path}`);
    }
    return;
  }
  if (entry.type === "file") {
    requireExactKeys(entry, ["hash", "mode", "path", "size", "type"]);
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0) {
      throw new Error(`Invalid checkpoint file size for ${entry.path}`);
    }
    return;
  }
  if (entry.type === "symlink") {
    requireExactKeys(entry, ["hash", "link", "mode", "path", "type"]);
    if (typeof entry.link !== "string" || entry.link.includes("\0")) {
      throw new Error(`Invalid symlink target for ${entry.path}`);
    }
    if (entry.hash !== sha256(entry.link)) {
      throw new Error(`Invalid symlink hash for ${entry.path}`);
    }
    return;
  }
  throw new Error(`Unsupported checkpoint entry type for ${entry.path}`);
}

function isSafeCheckpointPath(value: unknown): value is string {
  if (value === ".") return true;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    return false;
  }
  const components = value.split("/");
  return (
    components.every(
      (component) => component.length > 0 && component !== "." && component !== "..",
    ) && components[0] !== ".git"
  );
}

function requireExactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  expected.sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Checkpoint data contains unknown or missing fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
