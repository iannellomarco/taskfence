import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalStringify,
  compareCheckpoint,
  createCheckpoint,
  rollbackCheckpoint,
  stateLayout,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

let sandbox: string;
let root: string;
let previousStateDirectory: string | undefined;

beforeEach(async () => {
  previousStateDirectory = process.env.TASKFENCE_STATE_DIR;
  sandbox = await mkdtemp(path.join(tmpdir(), "taskfence-checkpoint-test-"));
  root = path.join(sandbox, "worktree");
  await mkdir(root);
  process.env.TASKFENCE_STATE_DIR = path.join(sandbox, "state");
});

afterEach(async () => {
  if (previousStateDirectory === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = previousStateDirectory;
  await rm(sandbox, { recursive: true, force: true });
});

function permissionMode(mode: number): number {
  return mode & 0o7777;
}

describe("checkpoint creation", () => {
  it("captures directories, symlinks, executable modes, bounded contents, and deduplicates CAS objects", async () => {
    const bin = path.join(root, "bin");
    await mkdir(bin, { mode: 0o750 });
    await writeFile(path.join(bin, "run"), "echo\n", { mode: 0o751 });
    await writeFile(path.join(root, "copy"), "echo\n", { mode: 0o640 });
    await symlink("bin/run", path.join(root, "run-link"));

    const checkpoint = await createCheckpoint(root, {
      maxFiles: 4,
      maxFileBytes: 5,
      maxBytes: 10,
    });
    const byPath = new Map(checkpoint.entries.map((entry) => [entry.path, entry]));

    expect(checkpoint.totalFiles).toBe(2);
    expect(checkpoint.totalBytes).toBe(10);
    expect(byPath.get("bin")).toMatchObject({ type: "directory", mode: 0o750 });
    expect(byPath.get("bin/run")).toMatchObject({
      type: "file",
      mode: 0o751,
      size: 5,
    });
    expect(byPath.get("run-link")).toMatchObject({
      type: "symlink",
      link: "bin/run",
    });
    expect(byPath.get("copy")?.hash).toBe(byPath.get("bin/run")?.hash);

    const layout = await stateLayout(root);
    const hash = byPath.get("copy")?.hash;
    expect(hash).toBeDefined();
    expect(await readdir(path.join(layout.checkpointsDir, "objects"))).toEqual([
      ".tmp",
      hash!.slice(0, 2),
    ]);
    expect(
      await readdir(
        path.join(layout.checkpointsDir, "objects", hash!.slice(0, 2)),
      ),
    ).toEqual([hash!.slice(2)]);
  });

  it.each([
    [{ maxFiles: 3, maxFileBytes: 5, maxBytes: 10 }, /entry limit exceeded/],
    [{ maxFiles: 4, maxFileBytes: 4, maxBytes: 10 }, /file byte limit exceeded/],
    [{ maxFiles: 4, maxFileBytes: 5, maxBytes: 9 }, /total byte limit exceeded/],
  ] as const)("rejects worktrees outside configured limits %#", async (limits, error) => {
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "run"), "echo\n");
    await writeFile(path.join(root, "copy"), "echo\n");
    await symlink("bin/run", path.join(root, "run-link"));

    await expect(createCheckpoint(root, limits)).rejects.toThrow(error);
  });

  it("fails closed on unsupported special nodes without removing them", async () => {
    const fifo = path.join(root, "events.fifo");
    await execFileAsync("mkfifo", [fifo]);

    await expect(createCheckpoint(root)).rejects.toThrow(
      "Unsupported special file in checkpoint: events.fifo",
    );
    expect((await lstat(fifo)).isFIFO()).toBe(true);
  });

  it("rejects hard-linked regular files that rollback cannot reproduce", async () => {
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await writeFile(first, "shared inode\n");
    await link(first, second);

    await expect(createCheckpoint(root)).rejects.toThrow(
      "Checkpoint cannot represent hard-linked file: first.txt",
    );
    expect((await lstat(first)).nlink).toBe(2);
    expect((await lstat(second)).nlink).toBe(2);
  });

  it("rejects an object-store symlink without writing outside the checkpoint directory", async () => {
    const layout = await stateLayout(root);
    const outsideStore = path.join(sandbox, "outside-objects");
    await mkdir(outsideStore, { mode: 0o700 });
    await symlink(
      outsideStore,
      path.join(layout.checkpointsDir, "objects"),
      "dir",
    );
    await writeFile(path.join(root, "tracked.txt"), "do not redirect\n");

    await expect(createCheckpoint(root)).rejects.toThrow(
      "Checkpoint storage path is not a real directory",
    );
    expect(await readdir(outsideStore)).toEqual([]);
  });

  it("rejects symlinked object-store components", async () => {
    const layout = await stateLayout(root);
    const objectStore = path.join(layout.checkpointsDir, "objects");
    const outsideTemp = path.join(sandbox, "outside-temp");
    await mkdir(objectStore, { mode: 0o700 });
    await mkdir(outsideTemp, { mode: 0o700 });
    await symlink(outsideTemp, path.join(objectStore, ".tmp"), "dir");
    await writeFile(path.join(root, "tracked.txt"), "do not redirect\n");

    await expect(createCheckpoint(root)).rejects.toThrow(
      "Checkpoint storage path is not a real directory",
    );
    expect(await readdir(outsideTemp)).toEqual([]);
  });
});

describe("checkpoint rollback", () => {
  it("installs a validated staged tree across file, directory, and symlink type changes", async () => {
    const nested = path.join(root, "nested");
    await mkdir(nested, { mode: 0o750 });
    await writeFile(path.join(root, "modified.txt"), "original", { mode: 0o640 });
    await writeFile(path.join(root, "deleted.txt"), "bring me back", { mode: 0o600 });
    await writeFile(path.join(root, "executable"), "#!/bin/sh\n", { mode: 0o751 });
    await writeFile(path.join(root, "type-file"), "regular", { mode: 0o644 });
    await writeFile(path.join(nested, "inside.txt"), "nested original", { mode: 0o640 });
    await symlink("modified.txt", path.join(root, "type-link"));

    const checkpoint = await createCheckpoint(root);
    const outsideFile = path.join(sandbox, "outside.txt");
    await writeFile(outsideFile, "must survive");

    await writeFile(path.join(root, "modified.txt"), "changed");
    await chmod(path.join(root, "modified.txt"), 0o777);
    await unlink(path.join(root, "deleted.txt"));
    await chmod(path.join(root, "executable"), 0o600);
    await rm(path.join(root, "type-file"));
    await symlink(outsideFile, path.join(root, "type-file"));
    await unlink(path.join(root, "type-link"));
    await mkdir(path.join(root, "type-link"));
    await writeFile(path.join(root, "type-link", "intruder"), "new");
    await rm(nested, { recursive: true });
    await writeFile(nested, "directory became a file");
    await mkdir(path.join(root, "added-dir"));
    await writeFile(path.join(root, "added-dir", "added.txt"), "new");
    await symlink(outsideFile, path.join(root, "added-link"));

    await rollbackCheckpoint(root, checkpoint);

    expect(await readFile(path.join(root, "modified.txt"), "utf8")).toBe("original");
    expect(await readFile(path.join(root, "deleted.txt"), "utf8")).toBe("bring me back");
    expect(await readFile(path.join(root, "type-file"), "utf8")).toBe("regular");
    expect((await lstat(path.join(root, "type-file"))).isFile()).toBe(true);
    expect((await lstat(nested)).isDirectory()).toBe(true);
    expect(await readFile(path.join(nested, "inside.txt"), "utf8")).toBe("nested original");
    expect((await lstat(path.join(root, "type-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(root, "type-link"))).toBe("modified.txt");
    await expect(lstat(path.join(root, "added-dir"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "added-link"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outsideFile, "utf8")).toBe("must survive");
    expect(permissionMode((await lstat(path.join(root, "modified.txt"))).mode)).toBe(0o640);
    expect(permissionMode((await lstat(path.join(root, "executable"))).mode)).toBe(0o751);
    expect(permissionMode((await lstat(nested)).mode)).toBe(0o750);
    expect((await compareCheckpoint(root, checkpoint)).matches).toBe(true);
  });

  it("leaves every live entry unchanged when CAS validation fails before installation", async () => {
    await writeFile(path.join(root, "tracked.txt"), "checkpointed");
    const checkpoint = await createCheckpoint(root);
    const tracked = checkpoint.entries.find((entry) => entry.path === "tracked.txt");
    expect(tracked?.type).toBe("file");

    await writeFile(path.join(root, "tracked.txt"), "current work");
    await writeFile(path.join(root, "untracked.txt"), "keep on failure");
    await mkdir(path.join(root, "live-directory"));
    await writeFile(
      path.join(root, "live-directory", "nested.txt"),
      "nested live work",
    );
    await symlink("tracked.txt", path.join(root, "live-symlink"));
    const rootModeBefore = permissionMode((await lstat(root)).mode);

    const layout = await stateLayout(root);
    await writeFile(
      path.join(
        layout.checkpointsDir,
        "objects",
        tracked!.hash.slice(0, 2),
        tracked!.hash.slice(2),
      ),
      "corrupt object",
    );

    await expect(rollbackCheckpoint(root, checkpoint)).rejects.toThrow(
      "Checkpoint object is missing or corrupt",
    );
    expect(permissionMode((await lstat(root)).mode)).toBe(rootModeBefore);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe(
      "current work",
    );
    expect(await readFile(path.join(root, "untracked.txt"), "utf8")).toBe(
      "keep on failure",
    );
    expect(
      await readFile(
        path.join(root, "live-directory", "nested.txt"),
        "utf8",
      ),
    ).toBe("nested live work");
    expect(await readlink(path.join(root, "live-symlink"))).toBe(
      "tracked.txt",
    );
  });
  it.each([
    "after:0:backup:extra.txt",
    "after:1:install:nested",
    "after:2:backup:tracked.txt",
    "after:2:install:tracked.txt",
  ])("resumes from a durable journal after crashing at %s", async (boundary) => {
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(root, "tracked.txt"), "checkpointed\n", {
      mode: 0o640,
    });
    await mkdir(path.join(root, "nested"), { mode: 0o750 });
    await writeFile(path.join(root, "nested", "inside.txt"), "nested\n");
    const checkpoint = await createCheckpoint(root);

    await writeFile(path.join(root, "tracked.txt"), "changed\n");
    await rm(path.join(root, "nested"), { recursive: true });
    await writeFile(path.join(root, "extra.txt"), "remove me\n");
    const layout = await stateLayout(root);
    const journalPath = path.join(layout.projectDir, "rollback-journal.json");

    await expect(
      rollbackCheckpoint(root, checkpoint, {
        onBoundary(current) {
          if (current === boundary) {
            throw new Error(`injected crash at ${boundary}`);
          }
        },
      }),
    ).rejects.toThrow(`injected crash at ${boundary}`);
    expect((await lstat(journalPath)).isFile()).toBe(true);
    const serializedJournal = await readFile(journalPath, "utf8");
    const journal = JSON.parse(serializedJournal) as {
      backupTree: string;
      canonicalRoot: string;
      cursor: number;
      entries: unknown[];
      installContainer: string;
      installTree: string;
      manifestHash: string;
      retainedStage: string;
      rootIdentity: { dev: string; ino: string };
    };
    expect(serializedJournal).toBe(`${canonicalStringify(journal)}\n`);
    expect(journal).toMatchObject({
      canonicalRoot: layout.canonicalRoot,
      manifestHash: checkpoint.hash,
      retainedStage: path.join(
        layout.checkpointsDir,
        `.rollback-${checkpoint.hash}`,
      ),
      installTree: path.join(journal.installContainer, "tree"),
      backupTree: path.join(journal.installContainer, "backup"),
      rootIdentity: {
        dev: expect.stringMatching(/^\d+$/u),
        ino: expect.stringMatching(/^\d+$/u),
      },
    });
    expect(path.dirname(journal.installContainer)).toBe(
      path.dirname(layout.canonicalRoot),
    );
    expect(journal.cursor).toBeGreaterThanOrEqual(0);
    expect(journal.entries).toHaveLength(3);

    await rollbackCheckpoint(root, checkpoint);

    expect(await compareCheckpoint(root, checkpoint)).toEqual({
      matches: true,
      differences: [],
    });
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe(
      "checkpointed\n",
    );
    expect(
      await readFile(path.join(root, "nested", "inside.txt"), "utf8"),
    ).toBe("nested\n");
    expect(await readFile(path.join(root, ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/main\n",
    );
    await expect(lstat(path.join(root, "extra.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the canonical root is replaced before a live rename", async () => {
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".git", "HEAD"), "original git\n");
    await writeFile(path.join(root, "tracked.txt"), "checkpointed\n");
    const checkpoint = await createCheckpoint(root);
    await writeFile(path.join(root, "tracked.txt"), "changed\n");

    const displacedRoot = path.join(sandbox, "displaced-worktree");
    let replaced = false;
    await expect(
      rollbackCheckpoint(root, checkpoint, {
        async onBoundary(boundary) {
          if (!replaced && boundary === "before:backup:tracked.txt") {
            replaced = true;
            await rename(root, displacedRoot);
            await mkdir(root);
            await writeFile(path.join(root, "unrelated.txt"), "replacement\n");
          }
        },
      }),
    ).rejects.toThrow("Checkpoint root changed during rollback");

    expect(await readFile(path.join(root, "unrelated.txt"), "utf8")).toBe(
      "replacement\n",
    );
    await expect(lstat(path.join(root, "tracked.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(rollbackCheckpoint(root, checkpoint)).rejects.toThrow(
      "rollback root identity changed",
    );
    expect(await readFile(path.join(root, "unrelated.txt"), "utf8")).toBe(
      "replacement\n",
    );
    expect(
      await readFile(path.join(displacedRoot, "tracked.txt"), "utf8"),
    ).toBe("changed\n");
    expect(
      await readFile(path.join(displacedRoot, ".git", "HEAD"), "utf8"),
    ).toBe("original git\n");
  });
});
