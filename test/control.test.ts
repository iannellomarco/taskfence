import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  amendPlan,
  approvePlan,
  completePlan,
  confirmTTY,
  getStatus,
  readReceipts,
  revokePlan,
  rollbackPlan,
  verifyReceiptLedger,
} from "../src/index.js";

let sandbox: string;
let projectNumber = 0;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "taskfence-control-"));
  vi.stubEnv("TASKFENCE_STATE_DIR", join(sandbox, "state"));
  vi.stubEnv("XDG_STATE_HOME", join(sandbox, "xdg-state"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandbox, { recursive: true, force: true });
});

function plan(create: string[] = ["created.txt"]): string {
  return [
    "Control API test plan.",
    "```taskfence-contract",
    JSON.stringify({
      version: 1,
      write: ["seed.txt"],
      create,
      delete: [],
      protected: [],
      commands: [],
      packageManager: "none",
    }),
    "```",
  ].join("\n");
}

async function createProject(): Promise<string> {
  projectNumber += 1;
  const root = join(sandbox, `project-${projectNumber}`);
  await mkdir(root);
  await writeFile(join(root, "seed.txt"), "original\n");
  return root;
}

async function confirmed<T>(prompt: string, operation: () => Promise<T>): Promise<T> {
  expect(await confirmTTY(prompt, { yes: true })).toBe(true);
  return operation();
}

function terminalPair(answer: string): {
  input: PassThrough & { isTTY: boolean; setRawMode(mode: boolean): PassThrough };
  output: PassThrough & { isTTY: boolean; columns: number; rows: number };
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(mode: boolean): PassThrough;
  };
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  input.end(`${answer}\n`);
  return { input, output };
}

describe("deterministic control confirmations", () => {
  it("accepts explicit non-interactive confirmation and deterministic TTY yes/no answers", async () => {
    expect(await confirmTTY("Approve?", { yes: true })).toBe(true);

    const yes = terminalPair("yes");
    expect(await confirmTTY("Approve?", yes)).toBe(true);

    const no = terminalPair("no");
    expect(await confirmTTY("Approve?", no)).toBe(false);
  });

  it("fails closed for non-interactive streams without explicit confirmation", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    output.isTTY = false;

    await expect(confirmTTY("Approve?", { input, output })).rejects.toThrow(
      /Interactive TTY confirmation is required/,
    );
  });
});

describe("control APIs", () => {
  it("approves, reports status, amends, completes, and preserves a verifiable receipt chain", async () => {
    const root = await createProject();

    const approved = await confirmed("Approve plan?", () => approvePlan(plan(), root));
    expect(approved.status).toBe("active");
    expect(approved.revision).toBe(1);

    const active = await getStatus(root);
    expect(active.status).toBe("active");
    expect(active.contract?.document.create).toEqual([
      { kind: "exact", path: "created.txt" },
    ]);

    const amended = await confirmed("Amend plan?", () =>
      amendPlan(plan(["created.txt", "extra.txt"]), root));
    expect(amended.status).toBe("active");
    expect(amended.revision).toBe(2);
    expect(amended.contract?.document.create).toEqual([
      { kind: "exact", path: "created.txt" },
      { kind: "exact", path: "extra.txt" },
    ]);

    const completed = await confirmed("Complete plan?", () => completePlan(root));
    expect(completed.status).toBe("completed");
    expect((await getStatus(root)).status).toBe("completed");

    const receipts = await readReceipts(root);
    const verification = await verifyReceiptLedger(root);
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.some(({ event }) => event === "amendment")).toBe(true);
    expect(receipts.some(({ metadata }) => metadata.action === "complete")).toBe(true);
    expect(verification).toEqual({
      valid: true,
      count: receipts.length,
      lastHash: receipts.at(-1)?.recordHash ?? null,
    });
  });

  it("revokes an active plan with the confirmed reason and writes verifiable receipts", async () => {
    const root = await createProject();
    await confirmed("Approve plan?", () => approvePlan(plan(), root));

    const revoked = await confirmed("Revoke plan?", () =>
      revokePlan(root, "operator stopped execution"));
    expect(revoked.status).toBe("revoked");
    expect(revoked.reason).toBe("operator stopped execution");
    expect((await getStatus(root)).status).toBe("revoked");

    const receipts = await readReceipts(root);
    expect(receipts.some(({ metadata }) => metadata.action === "revoke")).toBe(true);
    expect(await verifyReceiptLedger(root)).toMatchObject({
      valid: true,
      count: receipts.length,
    });
  });

  it("rolls the project back to its checkpoint and verifies the resulting receipt chain", async () => {
    const root = await createProject();
    await confirmed("Approve plan?", () => approvePlan(plan(), root));
    await writeFile(join(root, "seed.txt"), "changed outside checkpoint\n");
    await writeFile(join(root, "untracked.txt"), "remove on rollback\n");

    const rolledBack = await confirmed("Rollback plan?", () => rollbackPlan(root));
    expect(rolledBack.status).toBe("rolled_back");
    expect((await getStatus(root)).status).toBe("rolled_back");
    expect(await readFile(join(root, "seed.txt"), "utf8")).toBe("original\n");
    await expect(readFile(join(root, "untracked.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const receipts = await readReceipts(root);
    expect(receipts.some(({ event, metadata }) =>
      event === "rollback" && metadata.outcome === "succeeded"
    )).toBe(true);
    expect(await verifyReceiptLedger(root)).toEqual({
      valid: true,
      count: receipts.length,
      lastHash: receipts.at(-1)?.recordHash ?? null,
    });
  });
});
