import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approvePlan,
  completePlan,
  getStatus,
  IndeterminateTransactionError,
  loadProjectState,
  preToolCall,
  stateLayout,
  verifyReceiptLedger,
  withProjectLock,
} from "../src/index.js";
import {
  __setTransactionFaultHooks,
  recoverProjectTransactionUnderLock,
} from "../src/receipts/ledger.js";

const ORIGINAL_TASKFENCE_STATE_DIR = process.env.TASKFENCE_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;

let sandbox: string;

function plan(): string {
  return [
    "Durable transaction test plan",
    "```taskfence-contract",
    JSON.stringify({
      version: 1,
      write: ["src/**"],
      create: ["src/**"],
      delete: ["src/**"],
      protected: ["src/protected/**"],
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

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "taskfence-durable-transactions-"));
  process.env.TASKFENCE_STATE_DIR = path.join(sandbox, "durable-state");
  delete process.env.XDG_STATE_HOME;
});

afterEach(async () => {
  __setTransactionFaultHooks(null);
  if (ORIGINAL_TASKFENCE_STATE_DIR === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = ORIGINAL_TASKFENCE_STATE_DIR;
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

describe("post-WAL definitive transaction outcomes", () => {
  it("drives a committed transition even when receipt append fails after the WAL is durable", async () => {
    const root = await createWorktree("append-failure");
    const active = await approvePlan(plan(), root);

    // Simulate a transient receipt-append failure after the WAL commit point.
    __setTransactionFaultHooks({
      beforeReceiptAppend: async () => {
        throw new Error("simulated receipt append failure");
      },
    });

    // The caller must not receive an ordinary rejection: the WAL is durable, so
    // the transaction is committed-in-intent and must reach a committed result.
    const completed = await completePlan(root);
    expect(completed.status).toBe("completed");
    expect(completed.generation).toBeGreaterThan(active.generation);

    // No WAL should remain; recovery has nothing to replay.
    const layout = await stateLayout(root);
    await expect(readFile(layout.transactionFile)).rejects.toThrow();
  });

  it("does not leave a pending mutation when a post-WAL failure is recovered inline", async () => {
    const root = await createWorktree("mutation-append-failure");
    await approvePlan(plan(), root);

    let appendedOnce = false;
    __setTransactionFaultHooks({
      beforeReceiptAppend: async () => {
        if (!appendedOnce) {
          appendedOnce = true;
          throw new Error("simulated receipt append failure");
        }
      },
    });

    // A preToolCall whose receipt append fails post-WAL must still reach the
    // mutation_pending committed state rather than leaving an unexecuted tool
    // call reported as rejected but later committed by recovery.
    const pending = await preToolCall({
      runtime: "opencode",
      toolName: "write",
      input: { path: "src/allowed.txt", content: "changed" },
      cwd: root,
      sessionId: "session-recovered",
      parentSessionId: null,
      callId: "call-recovered",
    });
    expect(pending.status).toBe("mutation_pending");
    expect(pending.decision).toMatchObject({ allowed: true });

    __setTransactionFaultHooks(null);
    const state = await getStatus(root);
    expect(state.status).toBe("mutation_pending");
  });

  it("surfaces an indeterminate result, not an ordinary rejection, when recovery cannot finish", async () => {
    const root = await createWorktree("indeterminate");
    await approvePlan(plan(), root);

    // Corrupt the receipts file so that both the fast append path and the
    // recovery reconciliation fail after the WAL is durable.
    const layout = await stateLayout(root);
    const originalReceipts = await readFile(layout.receiptsFile);
    const failingHook = async () => {
      // Replace the ledger tail with bytes that diverge from the WAL segment so
      // recovery's prefix-consistency check cannot succeed either.
      await writeFile(
        layout.receiptsFile,
        `${originalReceipts}{"tampered":true}\n`,
        { mode: 0o600 },
      );
      throw new Error("simulated post-WAL failure");
    };

    __setTransactionFaultHooks({
      beforeWalClear: failingHook,
    });

    await expect(completePlan(root)).rejects.toBeInstanceOf(IndeterminateTransactionError);

    // Restore the ledger so recovery can complete during explicit recovery.
    await writeFile(layout.receiptsFile, originalReceipts, { mode: 0o600 });

    // The WAL must still be present (recoverability preserved) and finishable.
    await withProjectLock(root, () => recoverProjectTransactionUnderLock(root));
    const recovered = await getStatus(root);
    expect(recovered.status).toBe("completed");
  });

  it("keeps the durable anchor consistent with explicit verification across recovered transactions", async () => {
    const root = await createWorktree("anchor-parity-recovered");
    await approvePlan(plan(), root);

    __setTransactionFaultHooks({
      beforeStateInstall: async () => {
        throw new Error("simulated state install failure");
      },
    });

    await completePlan(root);
    __setTransactionFaultHooks(null);

    const verification = await verifyReceiptLedger(root);
    expect(verification.valid).toBe(true);
    if (!verification.valid) throw new Error(verification.reason);
    const state = await loadProjectState(root);
    expect(state?.receiptAnchor).toEqual({
      count: verification.count,
      lastHash: verification.lastHash,
      byteLength: verification.byteLength,
    });
  });

  it("does not re-commit a transaction whose WAL was already cleared", async () => {
    const root = await createWorktree("clear-then-recover");
    await approvePlan(plan(), root);
    await completePlan(root);

    const before = await getStatus(root);
    // Recovery on a cleanly committed state (no WAL) is a no-op.
    await withProjectLock(root, () => recoverProjectTransactionUnderLock(root));
    const after = await getStatus(root);
    expect(after).toEqual(before);
  });
});
