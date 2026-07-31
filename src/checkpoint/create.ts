import path from "node:path";

import { canonicalStringify, sha256 } from "../contract/canonical.js";
import { stateLayout } from "../state/layout.js";
import type { CheckpointManifest } from "../types.js";
import { ensureCheckpointDirectory } from "./cas.js";
import { scanWorktree, type ScanLimits } from "./scan.js";

export type CreateCheckpointOptions = ScanLimits;

export async function createCheckpoint(
  root: string,
  options: CreateCheckpointOptions = {},
): Promise<CheckpointManifest> {
  const layout = await stateLayout(root);
  const objectStore = path.join(layout.checkpointsDir, "objects");
  const canonicalObjectStore = await ensureCheckpointDirectory(
    objectStore,
    layout.checkpointsDir,
  );
  assertExternalStore(layout.canonicalRoot, canonicalObjectStore);

  const scan = await scanWorktree(layout.canonicalRoot, {
    ...options,
    objectStore: canonicalObjectStore,
  });
  const unsigned = {
    version: 1 as const,
    root: layout.canonicalRoot,
    entries: scan.entries,
    totalFiles: scan.totalFiles,
    totalBytes: scan.totalBytes,
  };
  return {
    ...unsigned,
    hash: sha256(canonicalStringify(unsigned)),
  };
}

function assertExternalStore(root: string, objectStore: string): void {
  const relative = path.relative(root, objectStore);
  if (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  ) {
    throw new Error("Checkpoint object store must be outside the worktree");
  }
}
