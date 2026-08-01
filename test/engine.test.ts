import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readlink,
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
  completePlan,
  getStatus,
  loadProjectState,
  postToolCall,
  preToolCall,
  previewRollback,
  readReceipts,
  saveProjectState,
  revokePlan,
  rollbackPlan,
  stateLayout,
  transition,
  verifyReceiptLedger,
  type PostToolCallInput,
  type PreToolCallInput,
  type PreToolCallResult,
} from "../src/index.js";
import { __setApprovalFaultHooks } from "../src/engine.js";

let sandbox: string;
let stateDirectory: string;
let previousStateDirectory: string | undefined;

beforeEach(async () => {
  previousStateDirectory = process.env.TASKFENCE_STATE_DIR;
  sandbox = await mkdtemp(path.join(tmpdir(), "taskfence-engine-test-"));
  stateDirectory = path.join(sandbox, "state");
  process.env.TASKFENCE_STATE_DIR = stateDirectory;
});

afterEach(async () => {
  __setApprovalFaultHooks(null);
  if (previousStateDirectory === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = previousStateDirectory;
  await rm(sandbox, { recursive: true, force: true });
});

async function createWorktree(name: string): Promise<string> {
  const root = path.join(sandbox, name);
  await mkdir(path.join(root, "src", "protected"), { recursive: true });
  await writeFile(path.join(root, "src", "allowed.txt"), "baseline", { mode: 0o640 });
  await writeFile(path.join(root, "src", "delete-me.txt"), "delete me");
  await writeFile(path.join(root, "src", "protected", "secret.txt"), "secret");
  return realpath(root);
}
function plan(protectedSelectors = ["src/protected/**"]): string {
  return [
    "Test plan",
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

function nestedCwdPlan(): string {
  return [
    "Nested cwd test plan",
    "```taskfence-contract",
    JSON.stringify({
      version: 1,
      write: ["src/**"],
      create: ["src/**"],
      delete: ["src/**"],
      protected: [],
      commands: [{ argv: ["node", "--version"], cwd: "src" }],
      packageManager: "none",
    }),
    "```",
  ].join("\n");
}

async function call(
  root: string,
  toolName: string,
  input: Record<string, unknown>,
  callId?: string,
): Promise<PreToolCallResult> {
  const request: PreToolCallInput = {
    runtime: "opencode",
    toolName,
    input,
    cwd: root,
    sessionId: callId === undefined ? undefined : "session-1",
    parentSessionId: callId === undefined ? undefined : null,
    callId,
  };
  return preToolCall(request);
}

async function closeMutation(
  root: string,
  result: PreToolCallResult,
  callId: string,
  overrides: Partial<Pick<PostToolCallInput, "success" | "observedViolation">> = {},
) {
  expect(result.inputHash).not.toBeNull();
  return postToolCall({
    root,
    runtime: "opencode",
    sessionId: "session-1",
    callId,
    inputHash: result.inputHash!,
    success: true,
    ...overrides,
  });
}

describe("engine activation and authorization", () => {
  it("starts absent and read-only, then approval captures a checkpoint and activates the contract", async () => {
    const root = await createWorktree("activation");

    expect(await getStatus(root)).toMatchObject({ status: "absent", contract: null });
    await expect(call(root, "read", { path: "src/allowed.txt" })).resolves.toMatchObject({
      status: "absent",
      inputHash: null,
      decision: { allowed: true, code: "allow_read_only" },
    });
    await expect(call(root, "write", { path: "src/allowed.txt" }, "before-approval")).resolves.toMatchObject({
      status: "absent",
      inputHash: null,
      decision: { allowed: false, code: "deny_contract_required" },
    });

    const active = await approvePlan(plan(), root);
    expect(active.status).toBe("active");
    expect(active.revision).toBe(1);
    expect(active.checkpoint).not.toBeNull();
    expect(active.checkpoint?.entries.map((entry) => entry.path)).toContain("src/allowed.txt");
    expect((await getStatus(root)).checkpoint?.hash).toBe(active.checkpoint?.hash);
  });

  it("resumes approval after a crash with the staged state already durable", async () => {
    const root = await createWorktree("approval-staged-resume");
    __setApprovalFaultHooks({
      afterStage: () => {
        throw new Error("simulated process exit after staging");
      },
    });

    await expect(approvePlan(plan(), root)).rejects.toThrow(
      "simulated process exit after staging",
    );
    expect(await getStatus(root)).toMatchObject({
      status: "staged",
      revision: 1,
    });

    __setApprovalFaultHooks(null);
    const active = await approvePlan(plan(), root);
    expect(active).toMatchObject({ status: "active", revision: 1 });
    expect(active.checkpoint).not.toBeNull();

    const receiptCount = (await readReceipts(root)).length;
    const repeated = await approvePlan(plan(), root);
    expect(repeated).toEqual(active);
    expect(await readReceipts(root)).toHaveLength(receiptCount);
    expect((await verifyReceiptLedger(root)).valid).toBe(true);
  });

  it("resumes approval after a crash with checkpointing already durable", async () => {
    const root = await createWorktree("approval-checkpointing-resume");
    __setApprovalFaultHooks({
      afterCheckpointing: () => {
        throw new Error("simulated process exit before checkpoint creation");
      },
    });

    await expect(approvePlan(plan(), root)).rejects.toThrow(
      "simulated process exit before checkpoint creation",
    );
    expect(await getStatus(root)).toMatchObject({
      status: "checkpointing",
      revision: 1,
    });

    __setApprovalFaultHooks(null);
    const active = await approvePlan(plan(), root);
    expect(active).toMatchObject({ status: "active", revision: 1 });
    expect(active.checkpoint).not.toBeNull();
    expect((await verifyReceiptLedger(root)).valid).toBe(true);
  });

  it("does not let another trusted identity resume checkpointing approval", async () => {
    const root = await createWorktree("approval-identity-resume");
    const owner = { runtime: "claude" as const, sessionId: "approval-owner" };
    __setApprovalFaultHooks({
      afterCheckpointing: () => {
        throw new Error("simulated owner exit during approval");
      },
    });

    await expect(approvePlan(plan(), root, owner)).rejects.toThrow(
      "simulated owner exit during approval",
    );
    __setApprovalFaultHooks(null);
    await expect(
      approvePlan(plan(), root, {
        runtime: "claude",
        sessionId: "approval-other",
      }),
    ).rejects.toThrow(/identity does not match the checkpointing contract/iu);

    const active = await approvePlan(plan(), root, owner);
    expect(active).toMatchObject({
      status: "active",
      authority: {
        runtime: "claude",
        rootSessionId: owner.sessionId,
      },
    });
  });

  it("converges concurrent approvals of the same contract", async () => {
    const root = await createWorktree("approval-concurrent");
    const [first, second] = await Promise.all([
      approvePlan(plan(), root),
      approvePlan(plan(), root),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "active", revision: 1 });
    expect(first.checkpoint).not.toBeNull();
    expect((await verifyReceiptLedger(root)).valid).toBe(true);
  });

  it("rejects a stale checkpoint after the same approval is revoked and restarted", async () => {
    const root = await createWorktree("approval-checkpoint-aba");
    let markCheckpointReady!: () => void;
    let releaseOldCheckpoint!: () => void;
    const checkpointReady = new Promise<void>((resolve) => {
      markCheckpointReady = resolve;
    });
    const holdOldCheckpoint = new Promise<void>((resolve) => {
      releaseOldCheckpoint = resolve;
    });
    let oldCheckpointHash: string | undefined;
    __setApprovalFaultHooks({
      afterCheckpointCreated: async (checkpoint) => {
        oldCheckpointHash = checkpoint.hash;
        markCheckpointReady();
        await holdOldCheckpoint;
      },
    });

    const oldApproval = approvePlan(plan(), root);
    const oldRejection = expect(oldApproval).rejects.toThrow(
      /checkpoint success cannot be applied because approval state changed/iu,
    );
    await checkpointReady;
    __setApprovalFaultHooks(null);

    await revokePlan(root, "superseded checkpointing attempt");
    await writeFile(path.join(root, "src", "allowed.txt"), "replacement baseline");
    const replacement = await approvePlan(plan(), root);
    expect(replacement.checkpoint?.hash).not.toBe(oldCheckpointHash);

    releaseOldCheckpoint();
    await oldRejection;
    expect(await getStatus(root)).toEqual(replacement);

    await writeFile(path.join(root, "src", "allowed.txt"), "later drift");
    await rollbackPlan(root);
    expect(
      await readFile(path.join(root, "src", "allowed.txt"), "utf8"),
    ).toBe("replacement baseline");
  });

  it("enforces read, create, write, delete, protected-path, path, command, and identity decisions", async () => {
    const root = await createWorktree("matrix");
    await approvePlan(plan(), root);

    await expect(call(root, "read", { path: "src/allowed.txt" }, "read")).resolves.toMatchObject({
      decision: { allowed: true, code: "allow_read_only" },
      inputHash: null,
    });
    await expect(call(root, "write", { path: "src/protected/secret.txt" }, "protected")).resolves.toMatchObject({
      decision: { allowed: false, code: "deny_protected_path" },
      inputHash: null,
    });
    await expect(call(root, "write", { path: "outside.txt" }, "outside")).resolves.toMatchObject({
      decision: { allowed: false, code: "deny_path" },
      inputHash: null,
    });
    await expect(call(root, "bash", { command: "node --help" }, "wrong-command")).resolves.toMatchObject({
      decision: { allowed: false, code: "deny_command_not_approved" },
      inputHash: null,
    });
    await expect(call(root, "write", { path: "src/allowed.txt" })).resolves.toMatchObject({
      decision: { allowed: false, code: "deny_authority" },
      inputHash: null,
    });

    const write = await call(root, "write", { path: "src/allowed.txt" }, "write");
    expect(write.decision).toMatchObject({ allowed: true, code: "allow_mutation" });
    expect((await closeMutation(root, write, "write")).status).toBe("active");

    const create = await call(root, "write", { path: "src/new.txt" }, "create");
    expect(create.decision).toMatchObject({ allowed: true, code: "allow_mutation" });
    expect((await closeMutation(root, create, "create")).status).toBe("active");

    const remove = await call(root, "delete", { path: "src/delete-me.txt" }, "delete");
    expect(remove.decision).toMatchObject({ allowed: true, code: "allow_mutation" });
    expect((await closeMutation(root, remove, "delete")).status).toBe("active");

    const command = await call(root, "bash", { command: "node --version" }, "command");
    expect(command.decision).toMatchObject({ allowed: true, code: "allow_command" });
    expect((await closeMutation(root, command, "command")).status).toBe("active");
  });

  it("uses the nearest ancestor state boundary and evaluates from the actual nested cwd", async () => {
    const root = await createWorktree("ancestor-boundary");
    const child = await realpath(path.join(root, "src"));
    await approvePlan(nestedCwdPlan(), root);

    const mutation = await call(
      child,
      "write",
      { path: "allowed.txt" },
      "nested-write",
    );
    expect(mutation).toMatchObject({
      root,
      decision: { allowed: true, code: "allow_mutation" },
    });
    expect((await closeMutation(root, mutation, "nested-write")).status).toBe("active");

    const command = await call(
      child,
      "bash",
      { command: "node --version" },
      "nested-command",
    );
    expect(command).toMatchObject({
      root,
      decision: { allowed: true, code: "allow_command" },
    });
    expect((await closeMutation(root, command, "nested-command")).status).toBe("active");

    await approvePlan(plan(), child);
    await completePlan(child);
    const stoppedAtChild = await call(
      child,
      "write",
      { path: "allowed.txt" },
      "nearer-completed",
    );
    expect(stoppedAtChild).toMatchObject({
      root: child,
      status: "completed",
      inputHash: null,
      decision: { allowed: false, code: "deny_contract_inactive" },
    });
    expect((await getStatus(child)).status).toBe("completed");
    expect((await getStatus(root)).status).toBe("active");
  });

  it("grants exactly one mutation lease and closes it only with matching success", async () => {
    const root = await createWorktree("lease");
    await approvePlan(plan(), root);

    const first = await call(root, "write", { path: "src/allowed.txt" }, "first");
    expect(first).toMatchObject({
      status: "mutation_pending",
      decision: { allowed: true, code: "allow_mutation" },
    });
    await expect(call(root, "write", { path: "src/allowed.txt" }, "second")).resolves.toMatchObject({
      status: "mutation_pending",
      decision: { allowed: false, code: "deny_pending_mutation" },
    });
    await expect(
      postToolCall({
        root,
        runtime: "opencode",
        sessionId: "session-1",
        callId: "wrong",
        inputHash: first.inputHash!,
        success: true,
      }),
    ).rejects.toThrow(/does not match/i);
    expect((await getStatus(root)).status).toBe("mutation_pending");

    const active = await closeMutation(root, first, "first");
    expect(active).toMatchObject({ status: "active", pendingMutation: null });
  });
});

describe("engine recovery and lifecycle", () => {
  it.each([
    ["reported failure", { success: false }, "recovery_required"],
    ["observed violation", { observedViolation: "outside contract" }, "violated"],
  ] as const)("requires recovery after %s", async (_label, outcome, expectedStatus) => {
    const root = await createWorktree(`recovery-${expectedStatus}`);
    await approvePlan(plan(), root);
    const pending = await call(root, "write", { path: "src/allowed.txt" }, "uncertain");

    const failed = await closeMutation(root, pending, "uncertain", outcome);
    expect(failed.status).toBe(expectedStatus);
    await expect(call(root, "write", { path: "src/allowed.txt" }, "blocked")).resolves.toMatchObject({
      decision: { allowed: false, code: "deny_recovery_required" },
      inputHash: null,
    });
    await expect(completePlan(root)).rejects.toThrow(/illegal/i);
    await expect(amendPlan(plan(["src/protected/**", "src/extra/**"]), root)).rejects.toThrow(/illegal/i);
  });

  it("allows active amendments only when protections do not weaken, and applies complete and revoke terminal rules", async () => {
    const amendRoot = await createWorktree("amend");
    const original = await approvePlan(plan(), amendRoot);
    await expect(amendPlan(plan([]), amendRoot)).rejects.toThrow(/cannot remove or weaken/i);
    const amended = await amendPlan(
      plan(["src/protected/**", "src/additional-protected/**"]),
      amendRoot,
    );
    expect(amended).toMatchObject({ status: "active", revision: 2 });
    expect(amended.checkpoint?.hash).toBe(original.checkpoint?.hash);

    const completeRoot = await createWorktree("complete");
    await approvePlan(plan(), completeRoot);
    expect(await completePlan(completeRoot)).toMatchObject({
      status: "completed",
      reason: "completed",
    });
    await expect(completePlan(completeRoot)).rejects.toThrow(/illegal/i);
    await expect(revokePlan(completeRoot, "too late")).rejects.toThrow(/illegal/i);

    const revokeRoot = await createWorktree("revoke");
    await approvePlan(plan(), revokeRoot);
    expect(await revokePlan(revokeRoot, "operator cancelled")).toMatchObject({
      status: "revoked",
      reason: "operator cancelled",
    });
    await expect(amendPlan(plan(), revokeRoot)).rejects.toThrow(/illegal/i);
  });

  it("previews drift and rolls the real worktree back exactly", async () => {
    const root = await createWorktree("rollback");
    await writeFile(path.join(root, "src", "executable"), "#!/bin/sh\n", { mode: 0o751 });
    await symlink("allowed.txt", path.join(root, "src", "allowed-link"));
    await approvePlan(plan(), root);

    await writeFile(path.join(root, "src", "allowed.txt"), "drifted");
    await chmod(path.join(root, "src", "executable"), 0o600);
    await unlink(path.join(root, "src", "delete-me.txt"));
    await unlink(path.join(root, "src", "allowed-link"));
    await mkdir(path.join(root, "src", "allowed-link"));
    await writeFile(path.join(root, "src", "allowed-link", "new"), "type drift");
    await writeFile(path.join(root, "src", "added.txt"), "added");

    const preview = await previewRollback(root);
    expect(preview.matches).toBe(false);
    expect(preview.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/allowed.txt", reason: "hash" }),
        expect.objectContaining({ path: "src/executable", reason: "mode" }),
        expect.objectContaining({ path: "src/delete-me.txt", reason: "removed" }),
        expect.objectContaining({ path: "src/allowed-link", reason: "type" }),
        expect.objectContaining({ path: "src/added.txt", reason: "added" }),
      ]),
    );

    expect(await rollbackPlan(root)).toMatchObject({ status: "rolled_back" });
    expect(await previewRollback(root)).toEqual({ matches: true, differences: [] });
    expect(await readFile(path.join(root, "src", "allowed.txt"), "utf8")).toBe("baseline");
    expect(await readFile(path.join(root, "src", "delete-me.txt"), "utf8")).toBe("delete me");
    expect((await lstat(path.join(root, "src", "allowed-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(root, "src", "allowed-link"))).toBe("allowed.txt");
    expect((await lstat(path.join(root, "src", "executable"))).mode & 0o7777).toBe(0o751);
    await expect(lstat(path.join(root, "src", "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a durable rolling_back state instead of attempting begin_rollback again", async () => {
    const root = await createWorktree("rollback-resume");
    await approvePlan(plan(), root);
    await writeFile(path.join(root, "src", "allowed.txt"), "drifted");

    const current = await loadProjectState(root);
    expect(current).not.toBeNull();
    const rollingBack = transition(current!, {
      type: "begin_rollback",
      expectedGeneration: current!.generation,
      expectedRevision: current!.revision,
      at: new Date().toISOString(),
    });
    await saveProjectState(rollingBack);
    expect((await getStatus(root)).status).toBe("rolling_back");

    const restored = await rollbackPlan(root);

    expect(restored.status).toBe("rolled_back");
    expect(await readFile(path.join(root, "src", "allowed.txt"), "utf8")).toBe(
      "baseline",
    );
    const layout = await stateLayout(root);
    await expect(
      lstat(path.join(layout.projectDir, "rollback-journal.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records and verifies checkpoint, decision, mutation, and terminal lifecycle receipts", async () => {
    const root = await createWorktree("receipts");
    await approvePlan(plan(), root);
    const pending = await call(root, "write", { path: "src/allowed.txt" }, "receipt-call");
    await closeMutation(root, pending, "receipt-call");
    await completePlan(root);

    const receipts = await readReceipts(root);
    const verification = await verifyReceiptLedger(root);
    expect(verification).toMatchObject({ valid: true, count: receipts.length });
    expect(receipts.map((receipt) => receipt.event)).toEqual([
      "lifecycle",
      "lifecycle",
      "lifecycle",
      "checkpoint",
      "authority",
      "decision",
      "lifecycle",
      "lifecycle",
    ]);
    expect(
      receipts
        .filter((receipt) => receipt.event === "lifecycle")
        .map((receipt) => receipt.metadata.action),
    ).toEqual([
      "approve.stage",
      "approve.checkpoint.begin",
      "approve.checkpoint.succeeded",
      "tool.mutation_completed",
      "complete",
    ]);
    expect(receipts[5]).toMatchObject({
      event: "decision",
      callId: "receipt-call",
      decision: { allowed: true, code: "allow_mutation" },
      lifecycle: { from: "active", to: "mutation_pending" },
    });
  });
});
