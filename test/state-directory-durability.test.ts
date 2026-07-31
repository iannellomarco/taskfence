import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashProjectRoot, stateLayout } from "../src/index.js";

const ORIGINAL_TASKFENCE_STATE_DIR = process.env.TASKFENCE_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "taskfence-state-dir-durability-"));
});

afterEach(async () => {
  if (ORIGINAL_TASKFENCE_STATE_DIR === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = ORIGINAL_TASKFENCE_STATE_DIR;
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

async function makeWorktree(): Promise<string> {
  const root = path.join(sandbox, "worktree");
  await mkdir(root, { recursive: true });
  return realpath(root);
}

describe("first-use state directory durability", () => {
  it("creates every state-directory component on first use with restrictive 0700 modes", async () => {
    process.env.TASKFENCE_STATE_DIR = path.join(sandbox, "fresh", "state", "tree");
    delete process.env.XDG_STATE_HOME;

    const root = await makeWorktree();
    const layout = await stateLayout(root);

    const components = [
      path.join(sandbox, "fresh"),
      path.join(sandbox, "fresh", "state"),
      layout.baseDir,
      layout.projectsDir,
      layout.projectDir,
      layout.checkpointsDir,
    ];

    for (const component of components) {
      const metadata = await stat(component);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o700);
      if (typeof process.getuid === "function") {
        expect(metadata.uid).toBe(process.getuid());
      }
    }
  });

  it("places the project directory at the hashed root under projects", async () => {
    process.env.TASKFENCE_STATE_DIR = path.join(sandbox, "state");
    delete process.env.XDG_STATE_HOME;

    const root = await makeWorktree();
    const expectedHash = hashProjectRoot(root);
    const layout = await stateLayout(root);

    expect(layout.rootHash).toBe(expectedHash);
    expect(layout.projectDir).toBe(path.join(layout.projectsDir, expectedHash));
    expect(layout.stateFile).toBe(path.join(layout.projectDir, "state.json"));
    expect(layout.receiptsFile).toBe(path.join(layout.projectDir, "receipts.jsonl"));
    expect(layout.transactionFile).toBe(path.join(layout.projectDir, "transaction.json"));
  });

  it("secures a pre-existing directory whose mode was widened without recreating it", async () => {
    const stateBase = path.join(sandbox, "existing-state");
    await mkdir(stateBase, { recursive: true, mode: 0o755 });
    process.env.TASKFENCE_STATE_DIR = stateBase;
    delete process.env.XDG_STATE_HOME;

    const root = await makeWorktree();
    await stateLayout(root);

    const metadata = await stat(stateBase);
    expect(metadata.mode & 0o777).toBe(0o700);
  });

  it("rejects a state directory component replaced by a symlink mid-chain", async () => {
    const realBase = path.join(sandbox, "real-state");
    const symlinkedBase = path.join(sandbox, "linked-state");
    await mkdir(realBase, { recursive: true, mode: 0o700 });
    await symlink(realBase, symlinkedBase);
    process.env.TASKFENCE_STATE_DIR = symlinkedBase;
    delete process.env.XDG_STATE_HOME;

    const root = await makeWorktree();
    await expect(stateLayout(root)).rejects.toThrow("State path is not a real directory");
  });
});

describe("restrictive umask state directory creation", () => {
  const ORIGINAL_UMASK = process.umask();

  afterEach(() => {
    process.umask(ORIGINAL_UMASK);
  });

  it("creates every state-directory component at mode 0700 even when umask would strip owner bits", async () => {
    process.umask(0o077);
    process.env.TASKFENCE_STATE_DIR = path.join(sandbox, "umasked", "state");
    delete process.env.XDG_STATE_HOME;

    const root = await makeWorktree();
    const layout = await stateLayout(root);

    for (const component of [layout.baseDir, layout.projectsDir, layout.projectDir, layout.checkpointsDir]) {
      const metadata = await stat(component);
      expect(metadata.mode & 0o777).toBe(0o700);
    }
  });
});
