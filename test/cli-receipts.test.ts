import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalStringify, sha256 } from "../src/contract/canonical.js";
import { appendReceipt, type ReceiptInput } from "../src/receipts/ledger.js";
import {
  DEFAULT_RECEIPT_PAGE_SIZE,
  listReceipts,
  MAX_RECEIPT_PAGE_SIZE,
  MAX_RECEIPTS_COLLECTED,
  ReceiptLedgerError,
  readReceipts,
  streamReceipts,
  validateReceiptRecord,
} from "../src/receipts/verify.js";
import { stateLayout } from "../src/state/layout.js";
import { createProjectState } from "../src/state/model.js";
import { loadProjectState, saveProjectState } from "../src/state/store.js";
import type { ReceiptRecord } from "../src/types.js";
import { runCli } from "../src/cli.js";
import { makeTempProject, minimalPlan } from "./helpers.js";

const ORIGINAL_TASKFENCE_STATE_DIR = process.env.TASKFENCE_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;

const CONTRACT_HASH = "a".repeat(64);
const CHECKPOINT_HASH = "b".repeat(64);

let sandbox: string;
let projectRoot: string;

function receiptInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    event: "decision",
    contractHash: CONTRACT_HASH,
    checkpointHash: CHECKPOINT_HASH,
    revision: 1,
    runtime: "codex",
    sessionId: "session-1",
    callId: "call-1",
    toolName: "write",
    inputHash: "c".repeat(64),
    decision: {
      allowed: true,
      code: "allow_mutation",
      reason: "approved by the active contract",
    },
    lifecycle: null,
    resultHash: "d".repeat(64),
    metadata: { operation: "write", target: "src/index.ts" },
    ...overrides,
  };
}

async function appendReceipts(root: string, count: number): Promise<void> {
  // Append in bounded-concurrency batches to avoid hammering the lock while
  // keeping the test fast enough for large counts.
  const batchSize = 32;
  for (let base = 0; base < count; base += batchSize) {
    const end = Math.min(base + batchSize, count);
    await Promise.all(
      Array.from({ length: end - base }, (_, offset) => {
        const index = base + offset;
        return appendReceipt(
          root,
          receiptInput({
            timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index).toISOString(),
            callId: `call-${index}`,
            inputHash: "e".repeat(64),
          }),
        );
      }),
    );
  }
}

/**
 * Builds `count` receipts directly in memory and writes them to the ledger file
 * in a single bulk write, then persists the matching anchor. Far faster than
 * calling `appendReceipt` for each record (which locks + fsyncs per receipt).
 * Produces a fully valid, verifiable hash chain.
 */
async function buildLargeLedger(root: string, count: number): Promise<void> {
  const layout = await stateLayout(root);
  const lines: string[] = [];
  let sequence = 1;
  let previousHash: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const unsigned: Omit<ReceiptRecord, "recordHash"> = {
      version: 1,
      sequence,
      timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index).toISOString(),
      event: "decision",
      root: layout.canonicalRoot,
      rootHash: layout.rootHash,
      contractHash: CONTRACT_HASH,
      checkpointHash: CHECKPOINT_HASH,
      revision: 1,
      runtime: "codex",
      sessionId: "session-1",
      callId: `call-${index}`,
      toolName: "write",
      inputHash: "e".repeat(64),
      decision: {
        allowed: true,
        code: "allow_mutation",
        reason: "approved by the active contract",
      },
      lifecycle: null,
      resultHash: "d".repeat(64),
      metadata: { operation: "write", target: "src/index.ts" },
      previousHash,
    };
    const recordHash = sha256(canonicalStringify(unsigned));
    const record: ReceiptRecord = { ...unsigned, recordHash };
    const failure = validateReceiptRecord(record);
    if (failure !== null) throw new Error(`invalid receipt ${index}: ${failure}`);
    lines.push(canonicalStringify(record));
    previousHash = recordHash;
    sequence += 1;
  }
  const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  await writeFile(layout.receiptsFile, bytes, { mode: 0o600 });
  const existing = await loadProjectState(layout.canonicalRoot);
  const state = existing ??
    createProjectState(layout.canonicalRoot, layout.rootHash, new Date().toISOString());
  state.receiptAnchor = {
    count,
    lastHash: previousHash,
    byteLength: bytes.length,
  };
  await saveProjectState(state);
}

/**
 * Forges a cursor with a recomputed valid digest over arbitrary fields,
 * simulating an attacker who knows the deterministic, keyless digest. Prefix
 * re-verification (not the digest) must catch the mismatch with the live ledger.
 */
function encodeCursorRaw(
  offset: number,
  count: number,
  previousHash: string | null,
  byteLength: number,
): string {
  const digest = createHash("sha256")
    .update("taskfence:receipt-cursor:v1")
    .update("\noffset:")
    .update(offset.toString())
    .update("\ncount:")
    .update(count.toString())
    .update("\npreviousHash:")
    .update(previousHash ?? "")
    .update("\nbyteLength:")
    .update(byteLength.toString())
    .digest("hex");
  return Buffer.from(
    JSON.stringify({
      v: 1,
      offset,
      count,
      previousHash,
      byteLength,
      digest,
    }),
    "utf8",
  ).toString("base64url");
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "taskfence-cli-receipts-test-"));
  projectRoot = join(sandbox, "project");
  await mkdir(projectRoot, { recursive: true });
  process.env.TASKFENCE_STATE_DIR = join(sandbox, "durable-state");
  delete process.env.XDG_STATE_HOME;
});

afterEach(async () => {
  if (ORIGINAL_TASKFENCE_STATE_DIR === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = ORIGINAL_TASKFENCE_STATE_DIR;
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

describe("bounded receipt paging", () => {
  it("returns the default page size and a cursor when more receipts remain", async () => {
    await buildLargeLedger(projectRoot, DEFAULT_RECEIPT_PAGE_SIZE + 5);

    const page = await listReceipts(projectRoot);

    expect(page.records).toHaveLength(DEFAULT_RECEIPT_PAGE_SIZE);
    expect(page.records.map((receipt) => receipt.sequence)).toEqual(
      Array.from({ length: DEFAULT_RECEIPT_PAGE_SIZE }, (_, index) => index + 1),
    );
    expect(page.cursor).not.toBeNull();
  });

  it("resumes from a cursor and reaches a final page with a null cursor", async () => {
    const total = 7;
    await appendReceipts(projectRoot, total);

    const first = await listReceipts(projectRoot, { limit: 3 });
    expect(first.records.map((receipt) => receipt.sequence)).toEqual([1, 2, 3]);
    expect(first.cursor).not.toBeNull();

    const second = await listReceipts(projectRoot, { limit: 3, cursor: first.cursor });
    expect(second.records.map((receipt) => receipt.sequence)).toEqual([4, 5, 6]);
    expect(second.cursor).not.toBeNull();

    const third = await listReceipts(projectRoot, { limit: 3, cursor: second.cursor });
    expect(third.records.map((receipt) => receipt.sequence)).toEqual([7]);
    expect(third.cursor).toBeNull();
  });

  it("verifies hash-chain continuity across pages", async () => {
    await appendReceipts(projectRoot, 5);

    const first = await listReceipts(projectRoot, { limit: 2 });
    const second = await listReceipts(projectRoot, { limit: 2, cursor: first.cursor });
    const third = await listReceipts(projectRoot, { limit: 2, cursor: second.cursor });

    const all = [...first.records, ...second.records, ...third.records];
    expect(all).toHaveLength(5);
    for (let index = 1; index < all.length; index += 1) {
      expect(all[index].previousHash).toBe(all[index - 1].recordHash);
    }
  });

  it("clamps an oversized limit to the maximum page size", async () => {
    await buildLargeLedger(projectRoot, MAX_RECEIPT_PAGE_SIZE + 3);

    const page = await listReceipts(projectRoot, {
      limit: MAX_RECEIPT_PAGE_SIZE * 10,
    });

    expect(page.records).toHaveLength(MAX_RECEIPT_PAGE_SIZE);
    expect(page.cursor).not.toBeNull();
  });

  it("rejects a non-positive limit", async () => {
    await appendReceipts(projectRoot, 1);
    await expect(listReceipts(projectRoot, { limit: 0 })).rejects.toThrow(ReceiptLedgerError);
    await expect(listReceipts(projectRoot, { limit: -1 })).rejects.toThrow(ReceiptLedgerError);
  });

  it("rejects a corrupted cursor token", async () => {
    await appendReceipts(projectRoot, 3);
    const page = await listReceipts(projectRoot, { limit: 1 });
    expect(page.cursor).not.toBeNull();

    const forged = page.cursor!.replace(/.$/, (ch) =>
      ch === "a" ? "b" : "a",
    );
    await expect(listReceipts(projectRoot, { cursor: forged })).rejects.toThrow(
      /cursor_digest_mismatch|invalid_cursor/,
    );
  });

  it("rejects a forged cursor with a valid digest but content that does not match the ledger", async () => {
    // An attacker who knows the deterministic, keyless digest algorithm crafts
    // a cursor whose fields are self-consistent (digest validates) but whose
    // offset/count/hash point somewhere the live ledger does not. Prefix
    // re-verification must reject it before any record is emitted.
    await appendReceipts(projectRoot, 5);
    const page = await listReceipts(projectRoot, { limit: 2 });
    expect(page.cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(page.cursor!, "base64url").toString("utf8"),
    ) as { byteLength: number };

    // Claim the prefix has 5 records ending in a fabricated hash, at an offset
    // far past the real 2-record mark, while keeping byteLength consistent.
    const forgedSkip = encodeCursorRaw(
      decoded.byteLength,
      5,
      "0".repeat(64),
      decoded.byteLength,
    );
    await expect(listReceipts(projectRoot, { cursor: forgedSkip })).rejects.toThrow(
      /cursor_offset_mismatch|cursor_prefix_invalid|cursor_hash_mismatch|cursor_count_mismatch|unexpected_eof/,
    );

    // Claim the prefix has exactly 2 records but a fabricated terminating hash.
    const realOffset = JSON.parse(
      Buffer.from(page.cursor!, "base64url").toString("utf8"),
    ) as { offset: number; count: number };
    const forgedHash = encodeCursorRaw(
      realOffset.offset,
      realOffset.count,
      "f".repeat(64),
      decoded.byteLength,
    );
    await expect(listReceipts(projectRoot, { cursor: forgedHash })).rejects.toThrow(
      /cursor_hash_mismatch/,
    );
  });

  it("rejects a stale cursor after the ledger grows", async () => {
    await appendReceipts(projectRoot, 2);
    const page = await listReceipts(projectRoot, { limit: 1 });
    expect(page.cursor).not.toBeNull();

    // The ledger now grows, changing its byte length.
    await appendReceipts(projectRoot, 1);

    await expect(
      listReceipts(projectRoot, { cursor: page.cursor }),
    ).rejects.toThrow(/cursor_ledger_changed|anchor_byte_length_mismatch|previous_hash_mismatch/);
  });

  it("rejects a malformed cursor string", async () => {
    await appendReceipts(projectRoot, 1);
    await expect(listReceipts(projectRoot, { cursor: "not-a-valid-cursor" })).rejects.toThrow(
      ReceiptLedgerError,
    );
    await expect(listReceipts(projectRoot, { cursor: "####" })).rejects.toThrow(ReceiptLedgerError);
  });

  it("returns an empty final page for an empty ledger", async () => {
    const page = await listReceipts(projectRoot);
    expect(page.records).toEqual([]);
    expect(page.cursor).toBeNull();
  });
});

describe("bounded readReceipts compatibility", () => {
  it("returns all receipts for a small ledger", async () => {
    await appendReceipts(projectRoot, 5);
    const receipts = await readReceipts(projectRoot);
    expect(receipts).toHaveLength(5);
    expect(receipts.map((receipt) => receipt.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects a ledger exceeding the collect limit instead of allocating it all", async () => {
    await buildLargeLedger(projectRoot, MAX_RECEIPTS_COLLECTED + 1);
    await expect(readReceipts(projectRoot)).rejects.toThrow(/ledger_exceeds_collect_limit/);
  });
});

describe("streamReceipts constant-memory traversal", () => {
  it("streams every receipt exactly once and verifies the chain", async () => {
    const count = 50;
    await appendReceipts(projectRoot, count);

    const sequences: number[] = [];
    const result = await streamReceipts(projectRoot, (receipt) => {
      sequences.push(receipt.sequence);
    });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("verification failed");
    expect(result.count).toBe(count);
    expect(sequences).toEqual(Array.from({ length: count }, (_, index) => index + 1));
  }, 30_000);

  it("traverses a large valid ledger with bounded memory", async () => {
    const count = 600;
    await buildLargeLedger(projectRoot, count);

    let seen = 0;
    let lastSequence = 0;
    const result = await streamReceipts(projectRoot, (receipt) => {
      seen += 1;
      expect(receipt.sequence).toBe(lastSequence + 1);
      lastSequence = receipt.sequence;
    });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("verification failed");
    expect(result.count).toBe(count);
    expect(seen).toBe(count);
  });
});

describe("CLI receipts list with paging controls", () => {
  it("prints a bounded page and a next-page cursor hint", async () => {
    await appendReceipts(projectRoot, 5);
    const { chunks, restore } = captureStdout();

    try {
      const exitCode = await runCli([
        "receipts",
        "list",
        "--root",
        projectRoot,
        "--limit",
        "2",
      ]);
      expect(exitCode).toBe(0);
      const output = chunks.join("");
      const lines = output.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0].startsWith("1\t")).toBe(true);
      expect(lines[1].startsWith("2\t")).toBe(true);
      expect(lines[2]).toMatch(/^-- next page: --cursor /);
    } finally {
      restore();
    }
  });

  it("prints JSON with records and a cursor", async () => {
    await appendReceipts(projectRoot, 5);
    const { chunks, restore } = captureStdout();

    try {
      const exitCode = await runCli([
        "receipts",
        "list",
        "--root",
        projectRoot,
        "--limit",
        "2",
        "--json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(chunks.join("")) as {
        records: Array<{ sequence: number }>;
        cursor: string | null;
      };
      expect(parsed.records.map((receipt) => receipt.sequence)).toEqual([1, 2]);
      expect(parsed.cursor).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("reports 'No receipts.' for an empty ledger", async () => {
    const { chunks, restore } = captureStdout();
    try {
      const exitCode = await runCli(["receipts", "list", "--root", projectRoot]);
      expect(exitCode).toBe(0);
      expect(chunks.join("").trim()).toBe("No receipts.");
    } finally {
      restore();
    }
  });

  it("rejects a limit above the maximum with a usage error", async () => {
    await appendReceipts(projectRoot, 1);
    const stderr: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await runCli([
        "receipts",
        "list",
        "--root",
        projectRoot,
        "--limit",
        String(MAX_RECEIPT_PAGE_SIZE + 1),
      ]);
      expect(exitCode).toBe(2);
      expect(stderr.join("")).toContain("must not exceed");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("resumes from a printed cursor to the next page", async () => {
    await appendReceipts(projectRoot, 5);

    const first = captureStdout();
    let cursor: string;
    try {
      await runCli(["receipts", "list", "--root", projectRoot, "--limit", "2"]);
      const match = first.chunks.join("").match(/--cursor (\S+)/);
      expect(match).not.toBeNull();
      cursor = match![1];
    } finally {
      first.restore();
    }

    const second = captureStdout();
    try {
      await runCli([
        "receipts",
        "list",
        "--root",
        projectRoot,
        "--limit",
        "2",
        "--cursor",
        cursor,
      ]);
      const lines = second.chunks.join("").trim().split("\n");
      expect(lines[0].startsWith("3\t")).toBe(true);
      expect(lines[1].startsWith("4\t")).toBe(true);
    } finally {
      second.restore();
    }
  });
});

describe("bounded plan-file reading in the CLI", () => {
  it("validates a normal plan file through the bounded reader", async () => {
    const project = await makeTempProject("taskfence-bounded-plan-valid-");
    try {
      const planFile = join(project.root, "plan.md");
      await writeFile(planFile, minimalPlan(project.root), { mode: 0o600 });
      const { chunks, restore } = captureStdout();
      try {
        const exitCode = await runCli([
          "contract",
          "validate",
          planFile,
          "--root",
          project.root,
        ]);
        expect(exitCode).toBe(0);
        expect(chunks.join("")).toContain("Contract valid");
      } finally {
        restore();
      }
    } finally {
      await project.cleanup();
    }
  });

  it("rejects an oversized plan file before decoding it", async () => {
    const project = await makeTempProject("taskfence-bounded-plan-oversized-");
    try {
      const planFile = join(project.root, "plan.md");
      // Write a plan file larger than the 8 MiB bound.
      const oversized = `${minimalPlan(project.root)}\n${"x".repeat(8 * 1024 * 1024 + 1024)}`;
      await writeFile(planFile, oversized, { mode: 0o600 });

      const stderr: string[] = [];
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        const exitCode = await runCli([
          "contract",
          "validate",
          planFile,
          "--root",
          project.root,
        ]);
        expect(exitCode).toBe(2);
        expect(stderr.join("")).toMatch(/exceeds|bytes/i);
      } finally {
        errSpy.mockRestore();
      }
    } finally {
      await project.cleanup();
    }
  });

  it("rejects a NUL byte in the plan file path", async () => {
    const stderr: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await runCli([
        "contract",
        "validate",
        `bad${"\0"}path`,
        "--root",
        projectRoot,
      ]);
      expect(exitCode).toBe(2);
      expect(stderr.join("")).toContain("NUL");
    } finally {
      errSpy.mockRestore();
    }
  });
});
const execFileAsync = promisify(execFile);
const COMMITTED_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/**
 * Runs the committed TaskFence CLI in a fresh Node process. Each call has its
 * own module registry, proving cursors survive across process boundaries.
 */
async function runCliProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(process.execPath, [COMMITTED_CLI, ...args], {
      encoding: "utf8",
      env,
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
      exitCode: typeof execError.code === "number" ? execError.code : 1,
    };
  }
}

describe("two-process CLI cursor resume", () => {
  let twoProcessSandbox: string;
  let twoProcessRoot: string;
  let twoProcessEnv: NodeJS.ProcessEnv;
  let previousTaskFenceStateDir: string | undefined;
  let previousXdgStateHome: string | undefined;

  beforeEach(async () => {
    twoProcessSandbox = await mkdtemp(join(tmpdir(), "taskfence-two-process-"));
    twoProcessRoot = join(twoProcessSandbox, "project");
    await mkdir(twoProcessRoot, { recursive: true });
    const stateDir = join(twoProcessSandbox, "state");
    previousTaskFenceStateDir = process.env.TASKFENCE_STATE_DIR;
    previousXdgStateHome = process.env.XDG_STATE_HOME;
    process.env.TASKFENCE_STATE_DIR = stateDir;
    delete process.env.XDG_STATE_HOME;
    twoProcessEnv = {
      ...process.env,
      TASKFENCE_STATE_DIR: stateDir,
    };
    delete twoProcessEnv.XDG_STATE_HOME;
  });

  afterEach(async () => {
    if (previousTaskFenceStateDir === undefined) delete process.env.TASKFENCE_STATE_DIR;
    else process.env.TASKFENCE_STATE_DIR = previousTaskFenceStateDir;
    if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousXdgStateHome;
    await rm(twoProcessSandbox, { recursive: true, force: true });
  });

  it("process 1 emits a cursor and process 2 resumes to the next page", async () => {
    await buildLargeLedger(twoProcessRoot, 5);

    const first = await runCliProcess(
      ["receipts", "list", "--root", twoProcessRoot, "--limit", "2", "--json"],
      twoProcessEnv,
    );
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    const firstParsed = JSON.parse(first.stdout) as {
      records: Array<{ sequence: number }>;
      cursor: string | null;
    };
    expect(firstParsed.records.map((r) => r.sequence)).toEqual([1, 2]);
    expect(firstParsed.cursor).not.toBeNull();

    const second = await runCliProcess(
      ["receipts", "list", "--root", twoProcessRoot, "--limit", "2", "--json", "--cursor", firstParsed.cursor!],
      twoProcessEnv,
    );
    expect(second.exitCode).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as {
      records: Array<{ sequence: number }>;
      cursor: string | null;
    };
    expect(secondParsed.records.map((r) => r.sequence)).toEqual([3, 4]);
    expect(secondParsed.cursor).not.toBeNull();

    const third = await runCliProcess(
      ["receipts", "list", "--root", twoProcessRoot, "--limit", "2", "--json", "--cursor", secondParsed.cursor!],
      twoProcessEnv,
    );
    expect(third.exitCode).toBe(0);
    const thirdParsed = JSON.parse(third.stdout) as {
      records: Array<{ sequence: number }>;
      cursor: string | null;
    };
    expect(thirdParsed.records.map((r) => r.sequence)).toEqual([5]);
    expect(thirdParsed.cursor).toBeNull();
  }, 60_000);

  it("a stale cursor from process 1 fails in process 2 after the ledger grows", async () => {
    await buildLargeLedger(twoProcessRoot, 3);

    const first = await runCliProcess(
      ["receipts", "list", "--root", twoProcessRoot, "--limit", "1", "--json"],
      twoProcessEnv,
    );
    expect(first.exitCode).toBe(0);
    const firstParsed = JSON.parse(first.stdout) as { cursor: string | null };
    expect(firstParsed.cursor).not.toBeNull();

    await appendReceipt(twoProcessRoot, receiptInput({ callId: "extra" }));

    const second = await runCliProcess(
      ["receipts", "list", "--root", twoProcessRoot, "--limit", "1", "--json", "--cursor", firstParsed.cursor!],
      twoProcessEnv,
    );
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/cursor_ledger_changed|cursor_prefix_invalid|cursor_hash_mismatch|cursor_count_mismatch|cursor_offset_mismatch/);
  }, 60_000);

  it("a forged cursor fails in process 2", async () => {
    await buildLargeLedger(twoProcessRoot, 5);

    const first = await runCliProcess(
      ["receipts", "list", "--root", twoProcessRoot, "--limit", "2", "--json"],
      twoProcessEnv,
    );
    expect(first.exitCode).toBe(0);
    const firstParsed = JSON.parse(first.stdout) as {
      cursor: string | null;
    };
    expect(firstParsed.cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(firstParsed.cursor!, "base64url").toString("utf8"),
    ) as { byteLength: number };

    const forged = encodeCursorRaw(decoded.byteLength, 5, "0".repeat(64), decoded.byteLength);

    const second = await runCliProcess(
      ["receipts", "list", "--root", twoProcessRoot, "--limit", "2", "--json", "--cursor", forged],
      twoProcessEnv,
    );
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/cursor_offset_mismatch|cursor_prefix_invalid|cursor_hash_mismatch|cursor_count_mismatch|unexpected_eof/);
  }, 60_000);
});
