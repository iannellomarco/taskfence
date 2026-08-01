import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify, sha256 } from "../src/contract/canonical.js";
import { appendReceipt, type ReceiptInput } from "../src/receipts/ledger.js";
import { readReceipts, verifyReceiptLedger } from "../src/receipts/verify.js";
import { stateLayout } from "../src/state/layout.js";
import type { ReceiptRecord } from "../src/types.js";

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

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "taskfence-receipts-test-"));
  projectRoot = join(sandbox, "project");
  await mkdir(projectRoot);
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

describe("receipt ledger integrity", () => {
  it("appends a canonical hash chain without rewriting existing receipt bytes", async () => {
    const first = await appendReceipt(projectRoot, receiptInput({
      timestamp: "2026-01-01T00:00:00.000Z",
      callId: "call-1",
    }));
    const second = await appendReceipt(projectRoot, receiptInput({
      timestamp: "2026-01-01T00:00:01.000Z",
      callId: "call-2",
      inputHash: "e".repeat(64),
    }));
    const layout = await stateLayout(projectRoot);
    const originalBytes = await readFile(layout.receiptsFile, "utf8");
    const third = await appendReceipt(projectRoot, receiptInput({
      timestamp: "2026-01-01T00:00:02.000Z",
      callId: "call-3",
      inputHash: "f".repeat(64),
    }));
    const appendedBytes = await readFile(layout.receiptsFile, "utf8");

    expect(appendedBytes.startsWith(originalBytes)).toBe(true);
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first.previousHash).toBeNull();
    expect(second.previousHash).toBe(first.recordHash);
    expect(third.previousHash).toBe(second.recordHash);

    const receipts = await readReceipts(projectRoot);
    for (const receipt of receipts) {
      const unsigned: Partial<ReceiptRecord> = { ...receipt };
      delete unsigned.recordHash;
      expect(receipt.recordHash).toBe(sha256(canonicalStringify(unsigned)));
    }
    await expect(verifyReceiptLedger(projectRoot)).resolves.toEqual({
      valid: true,
      count: 3,
      lastHash: third.recordHash,
    });
  });

  it("detects content tampering, physical truncation, and record reordering", async () => {
    await appendReceipt(projectRoot, receiptInput({
      timestamp: "2026-01-01T00:00:00.000Z",
      callId: "call-1",
    }));
    await appendReceipt(projectRoot, receiptInput({
      timestamp: "2026-01-01T00:00:01.000Z",
      callId: "call-2",
      inputHash: "e".repeat(64),
    }));
    await appendReceipt(projectRoot, receiptInput({
      timestamp: "2026-01-01T00:00:02.000Z",
      callId: "call-3",
      inputHash: "f".repeat(64),
    }));
    const layout = await stateLayout(projectRoot);
    const intact = await readFile(layout.receiptsFile, "utf8");
    const lines = intact.trimEnd().split("\n");

    const tampered = JSON.parse(lines[1]) as ReceiptRecord;
    tampered.metadata = { operation: "delete", target: "secrets.txt" };
    const tamperedLines = [...lines];
    tamperedLines[1] = canonicalStringify(tampered);
    await writeFile(layout.receiptsFile, `${tamperedLines.join("\n")}\n`);
    await expect(verifyReceiptLedger(projectRoot)).resolves.toMatchObject({
      valid: false,
      index: 1,
      reason: "record_hash_mismatch",
    });

    await writeFile(layout.receiptsFile, intact.slice(0, -12));
    await expect(verifyReceiptLedger(projectRoot)).resolves.toMatchObject({
      valid: false,
      reason: "unterminated_line",
    });

    await writeFile(layout.receiptsFile, `${[lines[1], lines[0], lines[2]].join("\n")}\n`);
    await expect(verifyReceiptLedger(projectRoot)).resolves.toMatchObject({
      valid: false,
      index: 0,
      reason: "sequence_expected:1",
    });
  });

  it("serializes concurrent appenders into one complete, gap-free chain", async () => {
    const count = 32;
    await Promise.all(
      Array.from({ length: count }, (_, index) => appendReceipt(projectRoot, receiptInput({
        timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index).toISOString(),
        sessionId: `session-${index}`,
        callId: `call-${index}`,
        inputHash: sha256(`input-${index}`),
        resultHash: sha256(`result-${index}`),
      }))),
    );

    const verification = await verifyReceiptLedger(projectRoot);
    expect(verification).toMatchObject({ valid: true, count });
    const receipts = await readReceipts(projectRoot);
    expect(receipts.map((receipt) => receipt.sequence)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
    expect(new Set(receipts.map((receipt) => receipt.callId)).size).toBe(count);
    for (let index = 1; index < receipts.length; index += 1) {
      expect(receipts[index].previousHash).toBe(receipts[index - 1].recordHash);
    }
    expect(verification).toMatchObject({ lastHash: receipts.at(-1)?.recordHash });
  });
});

describe("receipt confidentiality", () => {
  it("redacts secret metadata and excludes raw prompt and tool payloads from durable bytes", async () => {
    const rawPrompt = "RAW_PROMPT_SENTINEL: deploy the unreleased plan";
    const rawToolPayload = "RAW_TOOL_PAYLOAD_SENTINEL: overwrite every credential";
    const password = "correct-horse-battery-staple";
    const apiKey = "synthetic-api-key-for-redaction";
    const bearer = "opaqueBearerCredential123";

    const receipt = await appendReceipt(projectRoot, receiptInput({
      timestamp: "2026-01-01T00:00:00.000Z",
      decision: {
        allowed: false,
        code: "deny_protected_path",
        reason: `Authorization: Bearer ${bearer}`,
      },
      metadata: {
        prompt: rawPrompt,
        tool: {
          payload: rawToolPayload,
          arguments: ["--password", password],
        },
        password,
        api_key: apiKey,
        nested: {
          refreshToken: "refresh-token-value",
          note: `Authorization: Bearer ${bearer}`,
          endpoint: "https://operator:super-secret@example.test/path",
        },
      },
    }));

    expect(receipt.metadata).toMatchObject({
      prompt: "[REDACTED]",
      tool: { payload: "[REDACTED]", arguments: "[REDACTED]" },
      password: "[REDACTED]",
      api_key: "[REDACTED]",
      nested: {
        refreshToken: "[REDACTED]",
        note: "Authorization: Bearer [REDACTED]",
        endpoint: "https://[REDACTED]@example.test/path",
      },
    });
    expect(receipt.decision?.reason).toBe("Authorization: Bearer [REDACTED]");

    const layout = await stateLayout(projectRoot);
    const durableBytes = await readFile(layout.receiptsFile, "utf8");
    for (const forbidden of [
      rawPrompt,
      rawToolPayload,
      password,
      apiKey,
      bearer,
      "operator:super-secret",
      "refresh-token-value",
    ]) {
      expect(durableBytes).not.toContain(forbidden);
    }
    expect(durableBytes).toContain("[REDACTED]");
    await expect(verifyReceiptLedger(projectRoot)).resolves.toMatchObject({
      valid: true,
      count: 1,
      lastHash: receipt.recordHash,
    });
  });
});
