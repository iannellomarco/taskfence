import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvePlan,
  canonicalStringify,
  completePlan,
  getStatus,
  postToolCall,
  preToolCall,
  readReceipts,
  stateLayout,
  verifyReceiptLedger,
  type ReceiptVerificationResult,
} from "../src/index.js";

const ORIGINAL_TASKFENCE_STATE_DIR = process.env.TASKFENCE_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const PUBLIC_API_URL = new URL("../dist/index.js", import.meta.url).href;
const VERIFY_RECEIPTS_SCRIPT = [
  `import { verifyReceiptLedger } from ${JSON.stringify(PUBLIC_API_URL)};`,
  "const result = await verifyReceiptLedger(process.argv[1]);",
  "process.stdout.write(JSON.stringify(result));",
].join("\n");
const execFileAsync = promisify(execFile);

let sandbox: string;

function plan(): string {
  return [
    "Receipt hardening test plan",
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

async function verifyInDisposableProcess(root: string): Promise<ReceiptVerificationResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", VERIFY_RECEIPTS_SCRIPT, root],
    {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 2_000,
      killSignal: "SIGKILL",
    },
  );
  try {
    return JSON.parse(stdout.trim()) as ReceiptVerificationResult;
  } catch (parseError) {
    throw new Error(`receipt verification emitted an invalid result: ${stdout}`, { cause: parseError });
  }
}

async function expectInvalidPromptly(root: string): Promise<void> {
  const started = performance.now();
  const verification = await verifyInDisposableProcess(root);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(verification.valid).toBe(false);
}

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "taskfence-receipt-hardening-test-"));
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

describe("anchored receipt verification", () => {
  it("rejects removal of a complete final receipt even though the remaining prefix is valid", async () => {
    const root = await createWorktree("removed-final-receipt");
    await approvePlan(plan(), root);
    await completePlan(root);
    const layout = await stateLayout(root);
    const intact = await readFile(layout.receiptsFile, "utf8");
    const lines = intact.trimEnd().split("\n");
    expect(JSON.parse(lines.at(-1)!).metadata).toEqual({ action: "complete" });

    await writeFile(layout.receiptsFile, `${lines.slice(0, -1).join("\n")}\n`, { mode: 0o600 });

    await expect(verifyReceiptLedger(root)).resolves.toMatchObject({
      valid: false,
      reason: "anchor_count_mismatch",
    });
  });

  it("rejects replay of an earlier complete and internally valid receipt prefix", async () => {
    const root = await createWorktree("replayed-prefix");
    await approvePlan(plan(), root);
    const layout = await stateLayout(root);
    const earlierPrefix = await readFile(layout.receiptsFile);

    const denied = await preToolCall({
      runtime: "opencode",
      toolName: "write",
      input: { path: "src/protected/secret.txt", content: "not persisted" },
      cwd: root,
      sessionId: "replay-session",
      parentSessionId: null,
      callId: "replay-denied",
    });
    expect(denied.decision.allowed).toBe(false);
    await completePlan(root);
    await writeFile(layout.receiptsFile, earlierPrefix, { mode: 0o600 });

    const verification = await verifyReceiptLedger(root);
    expect(verification).toMatchObject({ valid: false, reason: "anchor_count_mismatch" });
  });

  it("detects same-size record tampering", async () => {
    const root = await createWorktree("same-size-tamper");
    await approvePlan(plan(), root);
    await completePlan(root);
    const layout = await stateLayout(root);
    const intact = await readFile(layout.receiptsFile, "utf8");
    const originalSize = (await stat(layout.receiptsFile)).size;
    const lines = intact.trimEnd().split("\n");
    const finalRecord = JSON.parse(lines.at(-1)!) as {
      metadata: { action: string };
    };
    expect(finalRecord.metadata.action).toBe("complete");
    finalRecord.metadata.action = "comp1ete";
    lines[lines.length - 1] = canonicalStringify(finalRecord);
    const tampered = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(tampered)).toBe(originalSize);
    await writeFile(layout.receiptsFile, tampered, { mode: 0o600 });

    await expect(verifyReceiptLedger(root)).resolves.toMatchObject({
      valid: false,
      reason: "record_hash_mismatch",
    });
  });
});

describe("receipt file hardening", () => {
  it.each([
    ["FIFO", async (receiptsFile: string) => {
      await execFileAsync("mkfifo", [receiptsFile]);
    }],
    ["symlink", async (receiptsFile: string) => {
      const target = path.join(sandbox, "symlink-target.ndjson");
      await writeFile(target, "", { mode: 0o600 });
      await symlink(target, receiptsFile);
    }],
    ["hardlink", async (receiptsFile: string) => {
      const target = path.join(sandbox, "hardlink-target.ndjson");
      await writeFile(target, "", { mode: 0o600 });
      await link(target, receiptsFile);
    }],
    ["unsafe mode", async (receiptsFile: string) => {
      await writeFile(receiptsFile, "", { mode: 0o600 });
      await chmod(receiptsFile, 0o644);
    }],
    ["foreign record shape", async (receiptsFile: string) => {
      await writeFile(receiptsFile, "{}\n", { mode: 0o600 });
    }],
    ["oversized line", async (receiptsFile: string) => {
      await writeFile(receiptsFile, `${JSON.stringify("x".repeat(1024 * 1024))}\n`, { mode: 0o600 });
    }],
  ] as const)("rejects a receipt %s promptly", async (_label, createUnsafeReceipt) => {
    const root = await createWorktree(`unsafe-${_label.replaceAll(" ", "-")}`);
    const layout = await stateLayout(root);
    await createUnsafeReceipt(layout.receiptsFile);

    await expectInvalidPromptly(root);
  }, 10_000);
});

describe("large decision histories", () => {
  it("keeps hundreds of decisions valid and excludes raw tool payloads", async () => {
    const root = await createWorktree("hundreds-of-decisions");
    await approvePlan(plan(), root);
    const decisionCount = 200;

    for (let index = 0; index < decisionCount; index += 1) {
      const result = await preToolCall({
        runtime: "opencode",
        toolName: "write",
        input: {
          path: "src/protected/secret.txt",
          content: `RAW_PAYLOAD_MUST_NOT_LEAK_${index}`,
          password: `PASSWORD_MUST_NOT_LEAK_${index}`,
        },
        cwd: root,
        sessionId: "bulk-session",
        parentSessionId: null,
        callId: `bulk-denied-${index}`,
      });
      expect(result).toMatchObject({
        status: "active",
        decision: { allowed: false, code: "deny_protected_path" },
      });
    }

    const allowed = await preToolCall({
      runtime: "opencode",
      toolName: "write",
      input: {
        path: "src/allowed.txt",
        content: "FINAL_RAW_PAYLOAD_MUST_NOT_LEAK",
      },
      cwd: root,
      sessionId: "bulk-session",
      parentSessionId: null,
      callId: "bulk-allowed",
    });
    expect(allowed).toMatchObject({
      status: "mutation_pending",
      decision: { allowed: true, code: "allow_mutation" },
    });
    expect(allowed.inputHash).not.toBeNull();
    await postToolCall({
      root,
      runtime: "opencode",
      sessionId: "bulk-session",
      callId: "bulk-allowed",
      inputHash: allowed.inputHash!,
      success: true,
    });

    const receipts = await readReceipts(root);
    expect(receipts.filter((receipt) => receipt.event === "decision")).toHaveLength(decisionCount + 1);
    expect(receipts.filter((receipt) => receipt.event === "decision").every((receipt) => receipt.decision !== null)).toBe(true);
    const verification = await verifyReceiptLedger(root);
    expect(verification.valid).toBe(true);
    if (!verification.valid) throw new Error(verification.reason);
    expect((await getStatus(root).then((state) => state.receiptAnchor))).toEqual({
      count: verification.count,
      lastHash: verification.lastHash,
      byteLength: verification.byteLength,
    });

    const ledgerBytes = await readFile((await stateLayout(root)).receiptsFile, "utf8");
    expect(ledgerBytes).not.toContain("RAW_PAYLOAD_MUST_NOT_LEAK");
    expect(ledgerBytes).not.toContain("PASSWORD_MUST_NOT_LEAK");
    expect(ledgerBytes).not.toContain('"content"');
    expect(ledgerBytes).not.toContain('"password"');
  }, 60_000);
});
