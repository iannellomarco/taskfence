import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateLayout } from "../src/index.js";
import {
  commitObjectTemp,
  createObjectTemp,
  discardObjectTemp,
  restoreObject,
  verifyObject,
} from "../src/checkpoint/cas.js";

const execFileAsync = promisify(execFile);

const ORIGINAL_TASKFENCE_STATE_DIR = process.env.TASKFENCE_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const ORIGINAL_UMASK = process.umask();

let sandbox: string;
let objectStore: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "taskfence-cas-hardening-"));
  process.env.TASKFENCE_STATE_DIR = path.join(sandbox, "state");
  delete process.env.XDG_STATE_HOME;
  const root = path.join(sandbox, "worktree");
  await mkdir(root, { recursive: true });
  const layout = await stateLayout(root);
  objectStore = path.join(layout.checkpointsDir, "objects");
  await mkdir(objectStore, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  process.umask(ORIGINAL_UMASK);
  if (ORIGINAL_TASKFENCE_STATE_DIR === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = ORIGINAL_TASKFENCE_STATE_DIR;
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

const OBJECT_CONTENT = Buffer.from("checkpointed content\n");
const OBJECT_HASH = createHash("sha256").update(OBJECT_CONTENT).digest("hex");
const OBJECT_SIZE = OBJECT_CONTENT.length;

function objectFilePath(): string {
  return path.join(objectStore, OBJECT_HASH.slice(0, 2), OBJECT_HASH.slice(2));
}

async function writeCommittedObject(hash: string, content: Buffer): Promise<void> {
  const temp = await createObjectTemp(objectStore);
  try {
    await temp.handle.writeFile(content);
    await temp.handle.sync();
    await temp.handle.close();
    await commitObjectTemp(objectStore, temp.path, hash);
  } catch (error) {
    await temp.handle.close().catch(() => undefined);
    await discardObjectTemp(temp.path).catch(() => undefined);
    throw error;
  }
}

describe("CAS temp creation hardening", () => {
  it("establishes mode 0600 on the temp inode even under a restrictive umask", async () => {
    process.umask(0o077);
    const temp = await createObjectTemp(objectStore);
    try {
      const metadata = await stat(temp.path);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
    } finally {
      await temp.handle.close();
      await discardObjectTemp(temp.path);
    }
  });

  it("creates a current-user regular temp with exactly zero bytes", async () => {
    const temp = await createObjectTemp(objectStore);
    try {
      const metadata = await stat(temp.path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.size).toBe(0);
      if (typeof process.getuid === "function") {
        expect(metadata.uid).toBe(process.getuid());
      }
    } finally {
      await temp.handle.close();
      await discardObjectTemp(temp.path);
    }
  });
});

describe("CAS object read hardening", () => {
  beforeEach(async () => {
    await writeCommittedObject(OBJECT_HASH, OBJECT_CONTENT);
  });

  it("verifies a well-formed object", async () => {
    await verifyObject(objectStore, OBJECT_HASH, OBJECT_SIZE);
  });

  it("fails promptly when a CAS object is replaced by a FIFO instead of blocking on open", async () => {
    const target = objectFilePath();
    await rm(target);
    await execFileAsync("mkfifo", [target]);

    await expect(verifyObject(objectStore, OBJECT_HASH, OBJECT_SIZE)).rejects.toThrow(
      "Checkpoint object is missing or corrupt",
    );
    await expect(
      restoreObject(objectStore, OBJECT_HASH, OBJECT_SIZE, path.join(sandbox, "dest"), 0o600),
    ).rejects.toThrow("Checkpoint object is missing or corrupt");
  });

  it("fails promptly when a CAS object is replaced by a symlink", async () => {
    const target = objectFilePath();
    const decoy = path.join(sandbox, "decoy");
    await writeFile(decoy, "decoy content", { mode: 0o600 });
    await rm(target);
    await symlink(decoy, target);

    await expect(verifyObject(objectStore, OBJECT_HASH, OBJECT_SIZE)).rejects.toThrow(
      "Checkpoint object is missing or corrupt",
    );
  });

  it("rejects a hard-linked CAS object before reading it", async () => {
    const target = objectFilePath();
    const alias = path.join(sandbox, "hardlink-alias");
    await link(target, alias);

    await expect(verifyObject(objectStore, OBJECT_HASH, OBJECT_SIZE)).rejects.toThrow(
      "Checkpoint object is missing or corrupt",
    );
    expect((await stat(target)).nlink).toBe(2);
  });

  it("rejects a CAS object whose on-disk mode was widened", async () => {
    await chmod(objectFilePath(), 0o644);

    await expect(verifyObject(objectStore, OBJECT_HASH, OBJECT_SIZE)).rejects.toThrow(
      "Checkpoint object is missing or corrupt",
    );
  });

  it("rejects a CAS object whose size does not match the manifest bound before reading", async () => {
    await expect(verifyObject(objectStore, OBJECT_HASH, OBJECT_SIZE + 1)).rejects.toThrow(
      "Checkpoint object is missing or corrupt",
    );
  });
});
