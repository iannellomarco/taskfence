import { randomUUID } from "node:crypto";
import {
  constants,
  lchmod as lchmodCallback,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { canonicalStringify } from "../contract/canonical.js";
import { stateLayout, type StateLayout } from "../state/layout.js";
import {
  createSecureFile,
  isNodeError as isSecureFileNodeError,
  openSecureFile,
  syncSecureDirectory,
} from "../state/secure-file.js";
import type { CheckpointEntry, CheckpointManifest } from "../types.js";
import { restoreObject } from "./cas.js";
import {
  compareCheckpoint,
  compareCheckpointTree,
  validateCheckpointManifest,
} from "./compare.js";

export interface RollbackOptions {
  /**
   * Test-only crash/race injection point. A thrown error intentionally leaves
   * the durable journal and staging trees intact for the next invocation.
   */
  onBoundary?: (boundary: string) => void | Promise<void>;
}

export async function rollbackCheckpoint(
  root: string,
  manifest: CheckpointManifest,
  options: RollbackOptions = {},
): Promise<void> {
  const layout = await stateLayout(root);
  validateCheckpointManifest(manifest, layout.canonicalRoot);
  const objectStore = await realpath(
    path.join(layout.checkpointsDir, "objects"),
  );
  assertOutsideRoot(layout.canonicalRoot, objectStore);
  const desiredNames = topLevelCheckpointNames(manifest);
  const journalPath = rollbackJournalPath(layout);
  const durable = await loadRollbackJournal(
    layout,
    journalPath,
    manifest,
    desiredNames,
  );

  let journal: RollbackJournal;
  let expectedRoot: BigIntStats;
  if (durable !== null) {
    journal = durable;
    expectedRoot = await assertCanonicalRoot(layout.canonicalRoot);
    assertNodeIdentity(expectedRoot, journal.rootIdentity, "rollback root");
    await assertRecoveryResources(layout, journal, manifest);
  } else {
    const originalRoot = await assertCanonicalRoot(layout.canonicalRoot);
    const retainedStage = await prepareRetainedStage(
      layout.checkpointsDir,
      objectStore,
      manifest,
    );
    expectedRoot = await assertCanonicalRoot(
      layout.canonicalRoot,
      originalRoot,
    );
    const installContainer = await prepareInstallStage(
      layout.canonicalRoot,
      retainedStage,
      manifest,
    );
    expectedRoot = await assertCanonicalRoot(
      layout.canonicalRoot,
      expectedRoot,
    );

    await chmod(
      layout.canonicalRoot,
      Number(expectedRoot.mode & 0o7777n) | 0o700,
    );
    expectedRoot = await assertCanonicalRootNode(
      layout.canonicalRoot,
      expectedRoot,
    );

    journal = await createRollbackJournal(
      layout,
      manifest,
      retainedStage,
      installContainer,
      desiredNames,
      expectedRoot,
    );
    await writeRollbackJournal(layout, journalPath, journal);
  }

  expectedRoot = await executeRollbackJournal(
    layout,
    journalPath,
    journal,
    expectedRoot,
    options,
  );

  expectedRoot = await assertCanonicalRoot(
    layout.canonicalRoot,
    expectedRoot,
  );
  await chmod(layout.canonicalRoot, journal.rootMode);
  expectedRoot = await assertCanonicalRootNode(
    layout.canonicalRoot,
    expectedRoot,
  );
  await syncDirectory(layout.canonicalRoot);
  await syncDirectory(path.dirname(layout.canonicalRoot));

  if (journal.phase !== "verifying") {
    journal.phase = "verifying";
    await writeRollbackJournal(layout, journalPath, journal);
  }

  const comparison = await compareCheckpoint(layout.canonicalRoot, manifest);
  if (!comparison.matches) {
    const first = comparison.differences[0];
    throw new Error(
      `Rollback verification failed${first ? ` at ${first.path} (${first.reason})` : ""}`,
    );
  }

  await assertCanonicalRootNode(layout.canonicalRoot, expectedRoot);
  await syncDirectory(layout.canonicalRoot);
  await syncDirectory(path.dirname(layout.canonicalRoot));
  await unlink(journalPath);
  await syncSecureDirectory(layout.projectDir);

  await rm(journal.installContainer, { recursive: true, force: true }).catch(
    () => undefined,
  );
  await rm(journal.retainedStage, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

const ROLLBACK_JOURNAL_SCHEMA_VERSION = 1 as const;
const ROLLBACK_JOURNAL_MODE = 0o600;
const MAX_ROLLBACK_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_ROLLBACK_ENTRIES = 100_000;

interface NodeIdentity {
  dev: string;
  ino: string;
  mode: string;
  ctimeNs: string;
}

type RollbackEntryPhase = "pending" | "backed_up" | "installed" | "completed";

interface RollbackJournalEntry {
  kind: "remove" | "install";
  nameBase64: string;
  hadLive: boolean;
  liveIdentity: NodeIdentity | null;
  installIdentity: NodeIdentity | null;
  phase: RollbackEntryPhase;
}

interface RollbackJournal {
  schemaVersion: typeof ROLLBACK_JOURNAL_SCHEMA_VERSION;
  canonicalRoot: string;
  rootIdentity: NodeIdentity;
  manifestHash: string;
  retainedStage: string;
  installContainer: string;
  installTree: string;
  backupTree: string;
  rootMode: number;
  phase: "mutating" | "verifying";
  cursor: number;
  entries: RollbackJournalEntry[];
}

function rollbackJournalPath(layout: StateLayout): string {
  return path.join(layout.projectDir, "rollback-journal.json");
}

async function createRollbackJournal(
  layout: StateLayout,
  manifest: CheckpointManifest,
  retainedStage: string,
  installContainer: string,
  desiredNames: Set<string>,
  rootIdentity: BigIntStats,
): Promise<RollbackJournal> {
  const installTree = path.join(installContainer, "tree");
  const backupTree = path.join(installContainer, "backup");
  const currentNames = await readdir(layout.canonicalRoot, {
    encoding: "buffer",
  });
  currentNames.sort(Buffer.compare).reverse();
  const entries: RollbackJournalEntry[] = [];

  for (const name of currentNames) {
    if (name.equals(Buffer.from(".git"))) continue;
    const decoded = decodeCheckpointName(name);
    if (decoded !== undefined && desiredNames.has(decoded)) continue;
    const metadata = await lstat(pathWithName(layout.canonicalRoot, name), {
      bigint: true,
    });
    entries.push({
      kind: "remove",
      nameBase64: name.toString("base64"),
      hadLive: true,
      liveIdentity: nodeIdentity(metadata),
      installIdentity: null,
      phase: "pending",
    });
  }

  for (const name of [...desiredNames].sort()) {
    const encoded = Buffer.from(name, "utf8");
    const live = await lstatMaybe(pathWithName(layout.canonicalRoot, encoded));
    const staged = await lstat(pathWithName(installTree, encoded), {
      bigint: true,
    });
    entries.push({
      kind: "install",
      nameBase64: encoded.toString("base64"),
      hadLive: live !== undefined,
      liveIdentity: live === undefined ? null : nodeIdentity(live),
      installIdentity: nodeIdentity(staged),
      phase: "pending",
    });
  }

  if (entries.length > MAX_ROLLBACK_ENTRIES) {
    throw new Error(`Rollback journal exceeds ${MAX_ROLLBACK_ENTRIES} entries`);
  }
  const rootEntry = manifest.entries.find((entry) => entry.path === ".");
  if (rootEntry?.type !== "directory") {
    throw new Error("Rollback manifest has no root directory entry");
  }
  return {
    schemaVersion: ROLLBACK_JOURNAL_SCHEMA_VERSION,
    canonicalRoot: layout.canonicalRoot,
    rootIdentity: nodeIdentity(rootIdentity),
    manifestHash: manifest.hash,
    retainedStage,
    installContainer,
    installTree,
    backupTree,
    rootMode: rootEntry.mode,
    phase: "mutating",
    cursor: 0,
    entries,
  };
}

async function executeRollbackJournal(
  layout: StateLayout,
  journalPath: string,
  journal: RollbackJournal,
  expectedRoot: BigIntStats,
  options: RollbackOptions,
): Promise<BigIntStats> {
  for (
    let index = journal.cursor;
    index < journal.entries.length;
    index += 1
  ) {
    const entry = journal.entries[index]!;
    const name = decodeJournalName(entry.nameBase64);
    if (entry.kind === "remove") {
      expectedRoot = await executeRemoveEntry(
        layout,
        journalPath,
        journal,
        entry,
        index,
        name,
        expectedRoot,
        options,
      );
    } else {
      expectedRoot = await executeInstallEntry(
        layout,
        journalPath,
        journal,
        entry,
        index,
        name,
        expectedRoot,
        options,
      );
    }
  }
  return expectedRoot;
}

async function executeRemoveEntry(
  layout: StateLayout,
  journalPath: string,
  journal: RollbackJournal,
  entry: RollbackJournalEntry,
  index: number,
  name: Buffer,
  expectedRoot: BigIntStats,
  options: RollbackOptions,
): Promise<BigIntStats> {
  if (
    entry.phase === "completed" &&
    index < journal.cursor
  ) return expectedRoot;
  if (
    entry.phase !== "pending" ||
    !entry.hadLive ||
    entry.liveIdentity === null ||
    entry.installIdentity !== null
  ) {
    throw new Error("Rollback journal has an invalid remove phase");
  }
  const live = pathWithName(layout.canonicalRoot, name);
  const backup = pathWithName(journal.backupTree, name);
  const liveMetadata = await lstatMaybe(live);
  const backupMetadata = await lstatMaybe(backup);

  if (liveMetadata === undefined && backupMetadata !== undefined) {
    assertNodeIdentity(backupMetadata, entry.liveIdentity, "rollback backup");
  } else if (liveMetadata !== undefined && backupMetadata === undefined) {
    assertNodeIdentity(liveMetadata, entry.liveIdentity, "rollback live entry");
    expectedRoot = await renameOutOfRoot(
      layout.canonicalRoot,
      live,
      backup,
      expectedRoot,
      entry.liveIdentity,
      `remove:${displayJournalName(name)}`,
      options,
    );
    await runBoundary(
      options,
      `after:${index}:backup:${displayJournalName(name)}`,
    );
  } else {
    throw new Error("Rollback journal remove entry is not recoverable");
  }

  entry.phase = "completed";
  journal.cursor = index + 1;
  await writeRollbackJournal(layout, journalPath, journal);
  return expectedRoot;
}

async function executeInstallEntry(
  layout: StateLayout,
  journalPath: string,
  journal: RollbackJournal,
  entry: RollbackJournalEntry,
  index: number,
  name: Buffer,
  expectedRoot: BigIntStats,
  options: RollbackOptions,
): Promise<BigIntStats> {
  if (
    entry.phase === "installed" &&
    index < journal.cursor
  ) return expectedRoot;
  if (
    entry.installIdentity === null ||
    entry.phase === "completed"
  ) {
    throw new Error("Rollback journal has an invalid install phase");
  }

  const live = pathWithName(layout.canonicalRoot, name);
  const backup = pathWithName(journal.backupTree, name);
  const staged = pathWithName(journal.installTree, name);
  let liveMetadata = await lstatMaybe(live);
  let backupMetadata = await lstatMaybe(backup);
  let stagedMetadata = await lstatMaybe(staged);

  if (stagedMetadata === undefined && liveMetadata !== undefined) {
    assertNodeIdentity(liveMetadata, entry.installIdentity, "installed checkpoint entry");
    if (entry.hadLive) {
      if (entry.liveIdentity === null || backupMetadata === undefined) {
        throw new Error("Rollback journal lost the backed-up live entry");
      }
      assertNodeIdentity(backupMetadata, entry.liveIdentity, "rollback backup");
    } else if (backupMetadata !== undefined) {
      throw new Error("Rollback journal has an unexpected backup entry");
    }
    entry.phase = "installed";
    journal.cursor = index + 1;
    await writeRollbackJournal(layout, journalPath, journal);
    return expectedRoot;
  }

  if (stagedMetadata === undefined) {
    throw new Error("Rollback journal lost a staged checkpoint entry");
  }
  assertNodeIdentity(stagedMetadata, entry.installIdentity, "staged checkpoint entry");

  if (entry.phase === "pending" && entry.hadLive) {
    if (entry.liveIdentity === null) {
      throw new Error("Rollback journal omitted a live entry identity");
    }
    if (liveMetadata !== undefined && backupMetadata === undefined) {
      assertNodeIdentity(liveMetadata, entry.liveIdentity, "rollback live entry");
      expectedRoot = await renameOutOfRoot(
        layout.canonicalRoot,
        live,
        backup,
        expectedRoot,
        entry.liveIdentity,
        `backup:${displayJournalName(name)}`,
        options,
      );
      await runBoundary(
        options,
        `after:${index}:backup:${displayJournalName(name)}`,
      );
      entry.phase = "backed_up";
      await writeRollbackJournal(layout, journalPath, journal);
      liveMetadata = undefined;
      backupMetadata = await lstatMaybe(backup);
    } else if (liveMetadata === undefined && backupMetadata !== undefined) {
      assertNodeIdentity(backupMetadata, entry.liveIdentity, "rollback backup");
      entry.phase = "backed_up";
      await writeRollbackJournal(layout, journalPath, journal);
    } else {
      throw new Error("Rollback journal live backup is not recoverable");
    }
  } else if (entry.phase === "pending") {
    if (liveMetadata !== undefined || backupMetadata !== undefined) {
      throw new Error("Rollback destination changed before installation");
    }
    entry.phase = "backed_up";
    await writeRollbackJournal(layout, journalPath, journal);
  } else if (entry.phase === "backed_up") {
    if (liveMetadata !== undefined) {
      throw new Error("Rollback destination changed before installation");
    }
    if (entry.hadLive) {
      if (entry.liveIdentity === null || backupMetadata === undefined) {
        throw new Error("Rollback journal lost the backed-up live entry");
      }
      assertNodeIdentity(backupMetadata, entry.liveIdentity, "rollback backup");
    } else if (backupMetadata !== undefined) {
      throw new Error("Rollback journal has an unexpected backup entry");
    }
  } else {
    throw new Error("Rollback journal install entry is not recoverable");
  }

  expectedRoot = await renameIntoRoot(
    layout.canonicalRoot,
    staged,
    live,
    expectedRoot,
    entry.installIdentity,
    `install:${displayJournalName(name)}`,
    options,
  );
  await runBoundary(
    options,
    `after:${index}:install:${displayJournalName(name)}`,
  );
  entry.phase = "installed";
  journal.cursor = index + 1;
  await writeRollbackJournal(layout, journalPath, journal);
  return expectedRoot;
}

async function renameOutOfRoot(
  root: string,
  source: Buffer,
  destination: Buffer,
  expectedRoot: BigIntStats,
  expectedEntry: NodeIdentity,
  label: string,
  options: RollbackOptions,
): Promise<BigIntStats> {
  await runBoundary(options, `before:${label}`);
  expectedRoot = await assertCanonicalRoot(root, expectedRoot);
  const sourceMetadata = await lstat(source, { bigint: true });
  assertNodeIdentity(sourceMetadata, expectedEntry, "rollback rename source");
  expectedRoot = await assertCanonicalRoot(root, expectedRoot);
  await rename(source, destination);
  await syncDirectory(root);
  await syncDirectory(path.dirname(destination.toString()));
  try {
    return await assertCanonicalRootNode(root, expectedRoot);
  } catch (error) {
    const moved = await lstatMaybe(destination);
    const replacementSource = await lstatMaybe(source);
    if (
      moved !== undefined &&
      replacementSource === undefined &&
      !matchesNodeIdentity(moved, expectedEntry)
    ) {
      await rename(destination, source);
      await syncDirectory(root);
      await syncDirectory(path.dirname(destination.toString()));
    }
    throw error;
  }
}

async function renameIntoRoot(
  root: string,
  source: Buffer,
  destination: Buffer,
  expectedRoot: BigIntStats,
  expectedEntry: NodeIdentity,
  label: string,
  options: RollbackOptions,
): Promise<BigIntStats> {
  await runBoundary(options, `before:${label}`);
  expectedRoot = await assertCanonicalRoot(root, expectedRoot);
  const sourceMetadata = await lstat(source, { bigint: true });
  assertNodeIdentity(sourceMetadata, expectedEntry, "rollback install source");
  if (await lstatMaybe(destination)) {
    throw new Error("Rollback destination changed before rename");
  }
  expectedRoot = await assertCanonicalRoot(root, expectedRoot);
  await rename(source, destination);
  await syncDirectory(path.dirname(source.toString()));
  await syncDirectory(root);
  try {
    return await assertCanonicalRootNode(root, expectedRoot);
  } catch (error) {
    const installed = await lstatMaybe(destination);
    const staged = await lstatMaybe(source);
    if (
      installed !== undefined &&
      staged === undefined &&
      matchesNodeIdentity(installed, expectedEntry)
    ) {
      await rename(destination, source);
      await syncDirectory(root);
      await syncDirectory(path.dirname(source.toString()));
    }
    throw error;
  }
}

async function runBoundary(
  options: RollbackOptions,
  boundary: string,
): Promise<void> {
  await options.onBoundary?.(boundary);
}

async function loadRollbackJournal(
  layout: StateLayout,
  journalPath: string,
  manifest: CheckpointManifest,
  desiredNames: Set<string>,
): Promise<RollbackJournal | null> {
  let handle: FileHandle | undefined;
  try {
    const opened = await openSecureFile(journalPath, constants.O_RDONLY, {
      mode: ROLLBACK_JOURNAL_MODE,
      maxBytes: MAX_ROLLBACK_JOURNAL_BYTES,
      label: "Rollback journal",
    });
    handle = opened.handle;
    const serialized = await handle.readFile("utf8");
    const parsed = JSON.parse(serialized) as unknown;
    if (`${canonicalStringify(parsed)}\n` !== serialized) {
      throw new Error("Rollback journal is not canonical JSON");
    }
    return validateRollbackJournal(layout, parsed, manifest, desiredNames);
  } catch (error) {
    if (isSecureFileNodeError(error, "ENOENT")) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateRollbackJournal(
  layout: StateLayout,
  value: unknown,
  manifest: CheckpointManifest,
  desiredNames: Set<string>,
): RollbackJournal {
  if (!isRecord(value)) throw new Error("Rollback journal must be an object");
  assertExactKeys(value, [
    "backupTree",
    "canonicalRoot",
    "cursor",
    "entries",
    "installContainer",
    "installTree",
    "manifestHash",
    "phase",
    "retainedStage",
    "rootIdentity",
    "rootMode",
    "schemaVersion",
  ]);
  if (
    value.schemaVersion !== ROLLBACK_JOURNAL_SCHEMA_VERSION ||
    value.canonicalRoot !== layout.canonicalRoot ||
    value.manifestHash !== manifest.hash ||
    typeof value.retainedStage !== "string" ||
    typeof value.installContainer !== "string" ||
    typeof value.installTree !== "string" ||
    typeof value.backupTree !== "string" ||
    (value.phase !== "mutating" && value.phase !== "verifying") ||
    !Number.isInteger(value.cursor) ||
    !Number.isInteger(value.rootMode) ||
    (value.rootMode as number) < 0 ||
    (value.rootMode as number) > 0o7777 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ROLLBACK_ENTRIES
  ) {
    throw new Error("Rollback journal metadata is invalid");
  }
  const expectedRetained = path.join(
    layout.checkpointsDir,
    `.rollback-${manifest.hash}`,
  );
  const installPrefix = `.taskfence-rollback-${path.basename(layout.canonicalRoot)}-`;
  if (
    value.retainedStage !== expectedRetained ||
    path.dirname(value.installContainer) !== path.dirname(layout.canonicalRoot) ||
    !path.basename(value.installContainer).startsWith(installPrefix) ||
    value.installTree !== path.join(value.installContainer, "tree") ||
    value.backupTree !== path.join(value.installContainer, "backup")
  ) {
    throw new Error("Rollback journal contains an unsafe staging path");
  }
  const rootIdentity = validateNodeIdentity(value.rootIdentity);
  const entries = value.entries.map(validateRollbackEntry);
  const cursor = value.cursor as number;
  if (cursor < 0 || cursor > entries.length) {
    throw new Error("Rollback journal cursor is out of bounds");
  }
  const seen = new Set<string>();
  const installs = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const name = decodeJournalName(entry.nameBase64);
    const key = entry.nameBase64;
    if (seen.has(key)) throw new Error("Rollback journal repeats an entry");
    seen.add(key);
    const decoded = decodeCheckpointName(name);
    if (entry.kind === "install") {
      if (decoded === undefined || !desiredNames.has(decoded)) {
        throw new Error("Rollback journal installs an unexpected entry");
      }
      installs.add(decoded);
    } else if (decoded !== undefined && desiredNames.has(decoded)) {
      throw new Error("Rollback journal removes a checkpoint entry");
    }
    const terminal = entry.kind === "remove"
      ? entry.phase === "completed"
      : entry.phase === "installed";
    if ((index < cursor) !== terminal) {
      throw new Error("Rollback journal cursor and phases disagree");
    }
  }
  if (
    installs.size !== desiredNames.size ||
    [...desiredNames].some((name) => !installs.has(name))
  ) {
    throw new Error("Rollback journal omits checkpoint entries");
  }
  if (
    value.phase === "verifying" &&
    cursor !== entries.length
  ) {
    throw new Error("Rollback journal verifies before mutation completion");
  }
  return {
    schemaVersion: ROLLBACK_JOURNAL_SCHEMA_VERSION,
    canonicalRoot: value.canonicalRoot,
    rootIdentity,
    manifestHash: value.manifestHash,
    retainedStage: value.retainedStage,
    installContainer: value.installContainer,
    installTree: value.installTree,
    backupTree: value.backupTree,
    rootMode: value.rootMode as number,
    phase: value.phase,
    cursor,
    entries,
  };
}

function validateRollbackEntry(value: unknown): RollbackJournalEntry {
  if (!isRecord(value)) throw new Error("Rollback journal entry must be an object");
  assertExactKeys(value, [
    "hadLive",
    "installIdentity",
    "kind",
    "liveIdentity",
    "nameBase64",
    "phase",
  ]);
  if (
    (value.kind !== "remove" && value.kind !== "install") ||
    typeof value.nameBase64 !== "string" ||
    typeof value.hadLive !== "boolean" ||
    !["pending", "backed_up", "installed", "completed"].includes(
      value.phase as string,
    )
  ) {
    throw new Error("Rollback journal entry metadata is invalid");
  }
  const phase = value.phase as RollbackEntryPhase;
  const liveIdentity = value.liveIdentity === null
    ? null
    : validateNodeIdentity(value.liveIdentity);
  const installIdentity = value.installIdentity === null
    ? null
    : validateNodeIdentity(value.installIdentity);
  if (
    (value.kind === "remove" &&
      (!value.hadLive ||
        liveIdentity === null ||
        installIdentity !== null ||
        (phase !== "pending" && phase !== "completed"))) ||
    (value.kind === "install" &&
      (installIdentity === null ||
        (value.hadLive !== (liveIdentity !== null)) ||
        (phase !== "pending" &&
          phase !== "backed_up" &&
          phase !== "installed")))
  ) {
    throw new Error("Rollback journal entry phase is invalid");
  }
  decodeJournalName(value.nameBase64);
  return {
    kind: value.kind,
    nameBase64: value.nameBase64,
    hadLive: value.hadLive,
    liveIdentity,
    installIdentity,
    phase,
  };
}

async function writeRollbackJournal(
  layout: StateLayout,
  journalPath: string,
  journal: RollbackJournal,
): Promise<void> {
  const serialized = `${canonicalStringify(journal)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_ROLLBACK_JOURNAL_BYTES) {
    throw new Error(
      `Rollback journal exceeds ${MAX_ROLLBACK_JOURNAL_BYTES} bytes`,
    );
  }
  const temporaryPath = path.join(
    layout.projectDir,
    `.rollback-journal-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    const created = await createSecureFile(temporaryPath, constants.O_WRONLY, {
      mode: ROLLBACK_JOURNAL_MODE,
      maxBytes: MAX_ROLLBACK_JOURNAL_BYTES,
      label: "Temporary rollback journal",
    });
    handle = created.handle;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, journalPath);
    await syncSecureDirectory(layout.projectDir);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function assertRecoveryResources(
  layout: StateLayout,
  journal: RollbackJournal,
  manifest: CheckpointManifest,
): Promise<void> {
  assertOutsideRoot(layout.canonicalRoot, journal.retainedStage);
  assertOutsideRoot(layout.canonicalRoot, journal.installContainer);
  await assertPrivateContainer(journal.retainedStage);
  await assertPrivateContainer(journal.installContainer);
  await assertOwnedDirectory(journal.installTree, "rollback install tree");
  await assertPrivateContainer(journal.backupTree);
  await assertStagedCheckpoint(path.join(journal.retainedStage, "tree"), manifest);
}

async function assertOwnedDirectory(
  directory: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.nlink < 1 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error(`Unsafe ${label}: ${directory}`);
  }
}

function validateNodeIdentity(value: unknown): NodeIdentity {
  if (!isRecord(value)) throw new Error("Rollback node identity must be an object");
  assertExactKeys(value, ["ctimeNs", "dev", "ino", "mode"]);
  for (const field of ["ctimeNs", "dev", "ino", "mode"] as const) {
    if (
      typeof value[field] !== "string" ||
      !/^(?:0|[1-9]\d*)$/u.test(value[field] as string)
    ) {
      throw new Error("Rollback node identity is invalid");
    }
  }
  return {
    dev: value.dev as string,
    ino: value.ino as string,
    mode: value.mode as string,
    ctimeNs: value.ctimeNs as string,
  };
}

function nodeIdentity(metadata: BigIntStats): NodeIdentity {
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
  };
}

function matchesNodeIdentity(
  metadata: BigIntStats,
  expected: NodeIdentity,
): boolean {
  return metadata.dev.toString() === expected.dev &&
    metadata.ino.toString() === expected.ino;
}

function assertNodeIdentity(
  metadata: BigIntStats,
  expected: NodeIdentity,
  label: string,
): void {
  if (!matchesNodeIdentity(metadata, expected)) {
    throw new Error(`${label} identity changed during rollback`);
  }
}

function decodeJournalName(encoded: string): Buffer {
  const name = Buffer.from(encoded, "base64");
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.toString("base64") !== encoded ||
    name.includes(0) ||
    name.equals(Buffer.from(".")) ||
    name.equals(Buffer.from("..")) ||
    name.equals(Buffer.from(".git")) ||
    name.includes(0x2f)
  ) {
    throw new Error("Rollback journal contains an unsafe entry name");
  }
  return name;
}

function displayJournalName(name: Buffer): string {
  return decodeCheckpointName(name) ?? `base64:${name.toString("base64")}`;
}

function pathWithName(parent: string, name: Buffer): Buffer {
  return Buffer.concat([Buffer.from(parent), Buffer.from("/"), name]);
}

async function lstatMaybe(target: string | Buffer): Promise<BigIntStats | undefined> {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Rollback journal contains unexpected fields");
  }
}

async function prepareRetainedStage(
  checkpointsDir: string,
  objectStore: string,
  manifest: CheckpointManifest,
): Promise<string> {
  const retainedStage = path.join(
    checkpointsDir,
    `.rollback-${manifest.hash}`,
  );
  if (await pathExists(retainedStage)) {
    await assertPrivateContainer(retainedStage);
    await assertStagedCheckpoint(path.join(retainedStage, "tree"), manifest);
    return retainedStage;
  }

  const buildContainer = await mkdtemp(
    path.join(checkpointsDir, `.rollback-build-${manifest.hash}-`),
  );
  await chmod(buildContainer, 0o700);
  try {
    const tree = path.join(buildContainer, "tree");
    await materializeCheckpoint(tree, objectStore, manifest);
    await syncDirectory(buildContainer);
    try {
      await rename(buildContainer, retainedStage);
      await syncDirectory(checkpointsDir);
      return retainedStage;
    } catch (error) {
      if (!(await pathExists(retainedStage))) throw error;
      await assertPrivateContainer(retainedStage);
      await assertStagedCheckpoint(path.join(retainedStage, "tree"), manifest);
      await rm(buildContainer, { recursive: true, force: true });
      return retainedStage;
    }
  } catch (error) {
    await rm(buildContainer, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function prepareInstallStage(
  root: string,
  retainedStage: string,
  manifest: CheckpointManifest,
): Promise<string> {
  const installContainer = await mkdtemp(
    path.join(
      path.dirname(root),
      `.taskfence-rollback-${path.basename(root)}-`,
    ),
  );
  await chmod(installContainer, 0o700);
  const installTree = path.join(installContainer, "tree");
  const backupTree = path.join(installContainer, "backup");
  try {
    await cp(path.join(retainedStage, "tree"), installTree, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await syncTree(installTree);
    await assertStagedCheckpoint(installTree, manifest);
    await mkdir(backupTree, { mode: 0o700 });
    await syncDirectory(backupTree);
    await syncDirectory(installContainer);
    await syncDirectory(path.dirname(root));
    return installContainer;
  } catch (error) {
    await rm(installContainer, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function materializeCheckpoint(
  tree: string,
  objectStore: string,
  manifest: CheckpointManifest,
): Promise<void> {
  await mkdir(tree, { mode: 0o700 });
  const directories = manifest.entries.filter(
    (entry): entry is CheckpointEntry & { type: "directory" } =>
      entry.type === "directory",
  );
  directories.sort((left, right) => {
    const depthDifference = pathDepth(left.path) - pathDepth(right.path);
    return depthDifference || left.path.localeCompare(right.path, "en");
  });
  for (const entry of directories) {
    if (entry.path === ".") continue;
    await mkdir(toAbsolute(tree, entry.path), {
      recursive: false,
      mode: 0o700,
    });
  }

  for (const entry of manifest.entries) {
    if (entry.type === "directory") continue;
    const destination = toAbsolute(tree, entry.path);
    if (entry.type === "file") {
      await restoreObject(
        objectStore,
        entry.hash,
        entry.size!,
        destination,
        entry.mode,
      );
    } else {
      await symlink(entry.link!, destination);
      const recreatedTarget = await readlink(destination);
      if (recreatedTarget !== entry.link) {
        throw new Error(`Failed to stage symlink exactly: ${entry.path}`);
      }
      const recreated = await lstat(destination, { bigint: true });
      if (Number(recreated.mode & 0o7777n) !== entry.mode) {
        await setSymlinkMode(destination, entry.mode);
      }
    }
  }

  directories.sort((left, right) => {
    const depthDifference = pathDepth(right.path) - pathDepth(left.path);
    return depthDifference || right.path.localeCompare(left.path, "en");
  });
  for (const entry of directories) {
    await chmod(toAbsolute(tree, entry.path), entry.mode);
  }

  await syncTree(tree);
  await assertStagedCheckpoint(tree, manifest);
}

async function assertStagedCheckpoint(
  tree: string,
  manifest: CheckpointManifest,
): Promise<void> {
  const metadata = await lstat(tree);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(tree)) !== tree
  ) {
    throw new Error(`Unsafe staged rollback tree: ${tree}`);
  }
  const comparison = await compareCheckpointTree(tree, manifest);
  if (!comparison.matches) {
    const first = comparison.differences[0];
    throw new Error(
      `Staged rollback verification failed${first ? ` at ${first.path} (${first.reason})` : ""}`,
    );
  }
}

async function syncTree(target: string): Promise<void> {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    const names = await readdir(target);
    names.sort();
    for (const name of names) {
      await syncTree(path.join(target, name));
    }
    await syncDirectory(target);
    return;
  }
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPrivateContainer(container: string): Promise<void> {
  const metadata = await lstat(container);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.nlink < 1 ||
    (metadata.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (await realpath(container)) !== container
  ) {
    throw new Error(`Unsafe private rollback container: ${container}`);
  }
}

async function assertCanonicalRoot(
  root: string,
  expected?: BigIntStats,
): Promise<BigIntStats> {
  const resolved = await realpath(root);
  const metadata = await lstat(root, { bigint: true });
  if (
    resolved !== root ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (expected !== undefined && identity(metadata) !== identity(expected))
  ) {
    throw new Error("Checkpoint root changed during rollback");
  }
  return metadata;
}

async function assertCanonicalRootNode(
  root: string,
  expected: BigIntStats,
): Promise<BigIntStats> {
  const resolved = await realpath(root);
  const metadata = await lstat(root, { bigint: true });
  if (
    resolved !== root ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameNode(metadata, expected)
  ) {
    throw new Error("Checkpoint root changed during rollback");
  }
  return metadata;
}

function topLevelCheckpointNames(
  manifest: CheckpointManifest,
): Set<string> {
  return new Set(
    manifest.entries
      .filter((entry) => entry.path !== ".")
      .map((entry) => entry.path.split("/", 1)[0]!),
  );
}

function decodeCheckpointName(name: Buffer): string | undefined {
  const decoded = name.toString("utf8");
  return Buffer.from(decoded).equals(name) ? decoded : undefined;
}

async function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    },
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}



async function setSymlinkMode(target: string, mode: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    lchmodCallback(target, mode, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const updated = await lstat(target, { bigint: true });
  if (
    !updated.isSymbolicLink() ||
    Number(updated.mode & 0o7777n) !== mode
  ) {
    throw new Error(`Unable to restore symlink mode: ${target}`);
  }
}


function assertOutsideRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  ) {
    throw new Error("Checkpoint object store must be outside the worktree");
  }
}


function toAbsolute(root: string, relativePath: string): string {
  return relativePath === "."
    ? root
    : path.join(root, ...relativePath.split("/"));
}

function pathDepth(relativePath: string): number {
  return relativePath === "." ? 0 : relativePath.split("/").length;
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.mode}:${stats.ctimeNs}`;
}
