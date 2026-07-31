import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  amendPlan,
  approvePlan,
  canonicalStringify,
  completePlan,
  getStatus,
  loadProjectState,
  postToolCall,
  preToolCall,
  saveProjectState,
  sha256,
  stateLayout,
  verifyReceiptLedger,
  type CheckpointManifest,
  type ProjectState,
} from "../src/index.js";

const ORIGINAL_TASKFENCE_STATE_DIR = process.env.TASKFENCE_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;

let sandbox: string;

function plan(protectedSelectors = ["src/protected/**"]): string {
  return [
    "Transaction recovery test plan",
    "```taskfence-contract",
    JSON.stringify({
      version: 1,
      write: ["src/**"],
      create: ["src/**"],
      delete: ["src/**"],
      protected: protectedSelectors,
      commands: [{ argv: ["node", "--version"], cwd: "." }],
      packageManager: "none",
    }),
    "```",
  ].join("\n");
}

async function createWorktree(name: string): Promise<string> {
  const root = path.join(sandbox, name);
  await mkdir(path.join(root, "src", "protected"), { recursive: true });
  await writeFile(path.join(root, "src", "allowed.txt"), "baseline\n");
  await writeFile(path.join(root, "src", "protected", "secret.txt"), "secret\n");
  return realpath(root);
}

async function makeReceiptPersistenceReject(root: string): Promise<() => Promise<void>> {
  const layout = await stateLayout(root);
  const intact = await readFile(layout.receiptsFile);
  const decoy = path.join(sandbox, `${layout.rootHash}.receipt-decoy`);
  await writeFile(decoy, intact, { mode: 0o600 });
  await unlink(layout.receiptsFile);
  await symlink(decoy, layout.receiptsFile);
  return async () => {
    await unlink(layout.receiptsFile);
    await writeFile(layout.receiptsFile, intact, { mode: 0o600 });
  };
}

async function expectAnchorMatchesVerification(root: string): Promise<ProjectState> {
  const verification = await verifyReceiptLedger(root);
  expect(verification.valid).toBe(true);
  if (!verification.valid) throw new Error(verification.reason);

  const state = await getStatus(root);
  expect(state.receiptAnchor).toEqual({
    count: verification.count,
    lastHash: verification.lastHash,
    byteLength: verification.byteLength,
  });
  return state;
}

function rehashManifest(manifest: CheckpointManifest): CheckpointManifest {
  const unsigned = {
    version: manifest.version,
    root: manifest.root,
    entries: manifest.entries,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
  };
  return { ...manifest, hash: sha256(canonicalStringify(unsigned)) };
}

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "taskfence-transaction-recovery-test-"));
  process.env.TASKFENCE_STATE_DIR = path.join(sandbox, "durable-state");
  delete process.env.XDG_STATE_HOME;
});

afterEach(async () => {
  if (ORIGINAL_TASKFENCE_STATE_DIR === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = ORIGINAL_TASKFENCE_STATE_DIR;
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

describe("receipt-coupled state transactions", () => {
  it("does not expose a lifecycle transition when its receipt cannot be persisted", async () => {
    const root = await createWorktree("lifecycle-rejection");
    const before = await approvePlan(plan(), root);
    const restoreReceipts = await makeReceiptPersistenceReject(root);

    await expect(completePlan(root)).rejects.toThrow();
    await restoreReceipts();

    await expect(getStatus(root)).resolves.toEqual(before);
    await expectAnchorMatchesVerification(root);
  });

  it("does not expose a mutation transition when its decision receipt cannot be persisted", async () => {
    const root = await createWorktree("mutation-rejection");
    const before = await approvePlan(plan(), root);
    const restoreReceipts = await makeReceiptPersistenceReject(root);

    await expect(preToolCall({
      runtime: "opencode",
      toolName: "write",
      input: { path: "src/allowed.txt", content: "changed" },
      cwd: root,
      sessionId: "session-rejected",
      parentSessionId: null,
      callId: "call-rejected",
    })).rejects.toThrow();
    await restoreReceipts();

    await expect(getStatus(root)).resolves.toEqual(before);
    await expectAnchorMatchesVerification(root);
  });

  it("keeps the durable receipt anchor equal to explicit verification across valid engine operations", async () => {
    const root = await createWorktree("anchor-parity");
    await approvePlan(plan(), root);
    await expectAnchorMatchesVerification(root);

    const pending = await preToolCall({
      runtime: "opencode",
      toolName: "write",
      input: { path: "src/allowed.txt", content: "changed" },
      cwd: root,
      sessionId: "session-valid",
      parentSessionId: null,
      callId: "call-valid",
    });
    expect(pending).toMatchObject({
      status: "mutation_pending",
      decision: { allowed: true, code: "allow_mutation" },
    });
    await expectAnchorMatchesVerification(root);

    expect(pending.inputHash).not.toBeNull();
    await postToolCall({
      root,
      runtime: "opencode",
      sessionId: "session-valid",
      callId: "call-valid",
      inputHash: pending.inputHash!,
      success: true,
    });
    await expectAnchorMatchesVerification(root);

    await amendPlan(plan(["src/protected/**", "src/more-protected/**"]), root);
    await expectAnchorMatchesVerification(root);

    await completePlan(root);
    const completed = await expectAnchorMatchesVerification(root);
    expect(completed.status).toBe("completed");
  });

  it("refuses to replace newer lifecycle or contract state with an older snapshot", async () => {
    const generationRoot = await createWorktree("stale-generation");
    const olderGeneration = await approvePlan(plan(), generationRoot);
    const completed = await completePlan(generationRoot);
    expect(completed.generation).toBeGreaterThan(olderGeneration.generation);

    await expect(saveProjectState(olderGeneration)).rejects.toThrow();
    await expect(getStatus(generationRoot)).resolves.toEqual(completed);

    const revisionRoot = await createWorktree("stale-revision");
    const olderRevision = await approvePlan(plan(), revisionRoot);
    const newerRevision = await amendPlan(
      plan(["src/protected/**", "src/new-protected/**"]),
      revisionRoot,
    );
    expect(newerRevision.revision).toBeGreaterThan(olderRevision.revision);

    await expect(saveProjectState(olderRevision)).rejects.toThrow();
    await expect(getStatus(revisionRoot)).resolves.toEqual(newerRevision);
  });
});

describe("checkpoint validation during state loading", () => {
  it.each([
    ["an empty entry set", (manifest: CheckpointManifest) => rehashManifest({
      ...manifest,
      entries: [],
      totalFiles: 0,
      totalBytes: 0,
    })],
    ["totals inconsistent with entries", (manifest: CheckpointManifest) => rehashManifest({
      ...manifest,
      totalFiles: manifest.totalFiles + 1,
    })],
    ["an unsafe traversal path", (manifest: CheckpointManifest) => {
      const entries = manifest.entries.map((entry) =>
        entry.type === "file" && entry.path.endsWith("allowed.txt")
          ? { ...entry, path: "../escape" }
          : entry);
      return rehashManifest({ ...manifest, entries });
    }],
  ] as const)("rejects a state containing %s even when its manifest hash is recomputed", async (_label, mutate) => {
    const root = await createWorktree(`invalid-checkpoint-${_label.replaceAll(" ", "-")}`);
    const active = await approvePlan(plan(), root);
    expect(active.checkpoint).not.toBeNull();
    const layout = await stateLayout(root);
    const serialized = JSON.parse(await readFile(layout.stateFile, "utf8")) as ProjectState;
    serialized.checkpoint = mutate(structuredClone(active.checkpoint!));
    await writeFile(layout.stateFile, `${JSON.stringify(serialized)}\n`, { mode: 0o600 });

    await expect(loadProjectState(root)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
  });
});
