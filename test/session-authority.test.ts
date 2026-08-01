import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runClaudeHook } from "../src/adapters/claude-code.js";
import TaskFencePlugin from "../src/adapters/opencode.js";
import {
  approvePlan,
  completePlan,
  getStatus,
  postToolCall,
  preToolCall,
  readReceipts,
  type PostToolCallInput,
  type PreToolCallInput,
  type RuntimeName,
} from "../src/index.js";

const originalTaskFenceStateDirectory = process.env.TASKFENCE_STATE_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;

let temporaryDirectory: string;
let projectRoot: string;

function plan(overrides: Record<string, unknown> = {}): string {
  return [
    "# Session authority contract",
    "",
    "```taskfence-contract",
    JSON.stringify({
      version: 1,
      write: ["tracked.txt"],
      create: ["created.txt"],
      delete: [],
      protected: [],
      commands: [{ argv: ["echo", "ok"], cwd: "." }],
      packageManager: "none",
      ...overrides,
    }),
    "```",
  ].join("\n");
}

function preflight(
  runtime: RuntimeName,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  callId: string,
  parentSessionId?: string | null,
) {
  const request: PreToolCallInput = {
    runtime,
    sessionId,
    toolName,
    input,
    cwd: projectRoot,
    callId,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  };
  return preToolCall(request);
}

function matchingPost(
  runtime: RuntimeName,
  sessionId: string,
  callId: string,
  inputHash: string,
): PostToolCallInput {
  return {
    root: projectRoot,
    runtime,
    sessionId,
    callId,
    inputHash,
    success: true,
  };
}

function claudePayload(
  event: "PreToolUse" | "PostToolUse",
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  toolResponse?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    prompt_id: "claude-prompt",
    transcript_path: join(projectRoot, "claude-transcript.jsonl"),
    cwd: projectRoot,
    permission_mode: "default",
    effort: { level: "high" },
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    ...(toolResponse === undefined ? {} : { tool_response: toolResponse }),
  };
}

function beforeHook(hooks: Hooks): NonNullable<Hooks["tool.execute.before"]> {
  expect(hooks["tool.execute.before"]).toBeTypeOf("function");
  return hooks["tool.execute.before"]!;
}

function afterHook(hooks: Hooks): NonNullable<Hooks["tool.execute.after"]> {
  expect(hooks["tool.execute.after"]).toBeTypeOf("function");
  return hooks["tool.execute.after"]!;
}

const openCodeOutput = { title: "completed", output: "ok", metadata: {} };

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "taskfence-session-authority-"));
  projectRoot = join(temporaryDirectory, "project");
  await mkdir(projectRoot);
  projectRoot = await realpath(projectRoot);
  await writeFile(join(projectRoot, "tracked.txt"), "before\n");
  process.env.TASKFENCE_STATE_DIR = join(temporaryDirectory, "state");
  process.env.XDG_STATE_HOME = join(temporaryDirectory, "xdg-state");
});

afterEach(async () => {
  if (originalTaskFenceStateDirectory === undefined) {
    delete process.env.TASKFENCE_STATE_DIR;
  } else {
    process.env.TASKFENCE_STATE_DIR = originalTaskFenceStateDirectory;
  }
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("session authority", () => {
  it("binds an externally approved contract on first verified preflight and rejects other identities", async () => {
    const approved = await approvePlan(plan(), projectRoot);
    expect(approved.status).toBe("active");
    expect(approved.authority).toBeNull();
    expect(
      (await readReceipts(projectRoot)).filter((receipt) => String(receipt.event) === "authority"),
    ).toEqual([]);

    const first = await preflight(
      "opencode",
      "root-session",
      "write",
      { path: "tracked.txt", content: "first\n" },
      "root-write-1",
      null,
    );
    expect(first).toMatchObject({
      decision: { allowed: true, code: "allow_mutation" },
      status: "mutation_pending",
    });
    expect(first.inputHash).not.toBeNull();
    await expect(
      postToolCall(matchingPost("opencode", "root-session", "root-write-1", first.inputHash!)),
    ).resolves.toMatchObject({ status: "active" });

    await expect(
      preflight(
        "opencode",
        "root-session",
        "read",
        { path: "tracked.txt" },
        "root-read",
        null,
      ),
    ).resolves.toMatchObject({ decision: { allowed: true } });
    await expect(
      preflight("codex", "root-session", "read_file", { path: "tracked.txt" }, "wrong-runtime"),
    ).resolves.toMatchObject({ decision: { allowed: false }, inputHash: null });
    await expect(
      preflight(
        "opencode",
        "sibling-session",
        "read",
        { path: "tracked.txt" },
        "sibling",
        null,
      ),
    ).resolves.toMatchObject({ decision: { allowed: false }, inputHash: null });

    const bindings = (await readReceipts(projectRoot)).filter(
      (receipt) => String(receipt.event) === "authority",
    );
    expect(bindings).toEqual([
      expect.objectContaining({
        runtime: "opencode",
        sessionId: "root-session",
      }),
    ]);
    await expect(getStatus(projectRoot)).resolves.toMatchObject({
      authority: {
        runtime: "opencode",
        rootSessionId: "root-session",
        sessions: [{ sessionId: "root-session", parentSessionId: null }],
      },
      contract: { contractHash: approved.contract?.contractHash },
    });
  });

  it("persists one exact child inheritance and denies absent or unknown ancestry without widening", async () => {
    const approved = await approvePlan(plan(), projectRoot);
    const root = await preflight(
      "opencode",
      "parent-session",
      "write",
      { path: "tracked.txt", content: "parent\n" },
      "parent-write",
      null,
    );
    await postToolCall(
      matchingPost("opencode", "parent-session", "parent-write", root.inputHash!),
    );

    await expect(
      preflight("opencode", "missing-parent", "read", { path: "tracked.txt" }, "missing-parent"),
    ).resolves.toMatchObject({ decision: { allowed: false }, inputHash: null });
    await expect(
      preflight(
        "opencode",
        "orphan-session",
        "read",
        { path: "tracked.txt" },
        "unknown-parent",
        "does-not-exist",
      ),
    ).resolves.toMatchObject({ decision: { allowed: false }, inputHash: null });

    const child = await preflight(
      "opencode",
      "child-session",
      "write",
      { path: "tracked.txt", content: "child\n" },
      "child-write",
      "parent-session",
    );
    expect(child).toMatchObject({ decision: { allowed: true }, status: "mutation_pending" });
    await postToolCall(
      matchingPost("opencode", "child-session", "child-write", child.inputHash!),
    );

    await expect(
      preflight(
        "opencode",
        "child-session",
        "read",
        { path: "tracked.txt" },
        "child-persisted",
        "parent-session",
      ),
    ).resolves.toMatchObject({ decision: { allowed: true } });
    await expect(
      preflight(
        "opencode",
        "child-session",
        "write",
        { path: "outside.txt", content: "widened\n" },
        "child-outside",
        "parent-session",
      ),
    ).resolves.toMatchObject({ decision: { allowed: false, code: "deny_path" }, inputHash: null });
    await expect(
      preflight(
        "opencode",
        "child-session",
        "bash",
        { command: "echo widened" },
        "child-command",
        "parent-session",
      ),
    ).resolves.toMatchObject({
      decision: { allowed: false, code: "deny_command_not_approved" },
      inputHash: null,
    });

    const after = await getStatus(projectRoot);
    expect(after.contract).toEqual(approved.contract);
    expect(after.authority).toMatchObject({
      runtime: "opencode",
      rootSessionId: "parent-session",
      sessions: expect.arrayContaining([
        { sessionId: "parent-session", parentSessionId: null },
        { sessionId: "child-session", parentSessionId: "parent-session" },
      ]),
    });
    expect(after.authority?.sessions).toHaveLength(2);
    const childBindings = (await readReceipts(projectRoot)).filter(
      (receipt) =>
        String(receipt.event) === "authority" && receipt.sessionId === "child-session",
    );
    expect(childBindings).toHaveLength(1);
    expect(childBindings[0]).toMatchObject({
      runtime: "opencode",
      sessionId: "child-session",
      metadata: expect.objectContaining({ parentSessionId: "parent-session" }),
    });
  });

  it("requires the pending mutation's runtime and session before closing it", async () => {
    await approvePlan(plan(), projectRoot);
    const pending = await preflight(
      "opencode",
      "mutation-session",
      "write",
      { path: "tracked.txt", content: "pending\n" },
      "pending-write",
      null,
    );
    expect(pending.inputHash).not.toBeNull();

    await expect(
      postToolCall(
        matchingPost("codex", "mutation-session", "pending-write", pending.inputHash!),
      ),
    ).rejects.toThrow();
    await expect(getStatus(projectRoot)).resolves.toMatchObject({ status: "mutation_pending" });

    await expect(
      postToolCall(
        matchingPost("opencode", "other-session", "pending-write", pending.inputHash!),
      ),
    ).rejects.toThrow();
    await expect(getStatus(projectRoot)).resolves.toMatchObject({ status: "mutation_pending" });

    await expect(
      postToolCall(
        matchingPost("opencode", "mutation-session", "pending-write", pending.inputHash!),
      ),
    ).resolves.toMatchObject({ status: "active", pendingMutation: null });
  });

  it("starts a new activation unbound instead of reusing a terminal binding", async () => {
    const firstApproval = await approvePlan(plan(), projectRoot);
    const first = await preflight(
      "opencode",
      "stale-session",
      "write",
      { path: "tracked.txt", content: "first activation\n" },
      "first-activation",
      null,
    );
    await postToolCall(
      matchingPost("opencode", "stale-session", "first-activation", first.inputHash!),
    );
    await completePlan(projectRoot);

    const secondApproval = await approvePlan(plan(), projectRoot);
    expect(secondApproval.generation).toBeGreaterThan(firstApproval.generation);
    expect(secondApproval.authority).toBeNull();
    const fresh = await preflight(
      "opencode",
      "fresh-session",
      "write",
      { path: "tracked.txt", content: "second activation\n" },
      "second-activation",
      null,
    );
    expect(fresh.decision.allowed).toBe(true);
    await postToolCall(
      matchingPost("opencode", "fresh-session", "second-activation", fresh.inputHash!),
    );
    await expect(
      preflight(
        "opencode",
        "stale-session",
        "read",
        { path: "tracked.txt" },
        "stale-retry",
        null,
      ),
    ).resolves.toMatchObject({ decision: { allowed: false }, inputHash: null });
  });

  it("binds the Claude session that receives approved ExitPlanMode authority", async () => {
    const contractPlan = plan();
    const toolInput = {
      plan: contractPlan,
      allowedPrompts: [],
    };
    const toolUseId = "claude-exit-plan";

    const pre = await runClaudeHook(
      claudePayload(
        "PreToolUse",
        "claude-authority-session",
        "ExitPlanMode",
        toolInput,
        toolUseId,
      ),
    );
    expect(pre.exitCode).toBe(0);
    expect(JSON.parse(pre.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    });

    await expect(
      runClaudeHook(
        claudePayload(
          "PostToolUse",
          "claude-authority-session",
          "ExitPlanMode",
          toolInput,
          toolUseId,
          { plan: contractPlan },
        ),
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    await expect(getStatus(projectRoot)).resolves.toMatchObject({
      authority: {
        runtime: "claude",
        rootSessionId: "claude-authority-session",
        sessions: [
          { sessionId: "claude-authority-session", parentSessionId: null },
        ],
      },
    });

    await expect(
      preflight(
        "claude",
        "claude-authority-session",
        "Read",
        { file_path: "tracked.txt" },
        "claude-read",
      ),
    ).resolves.toMatchObject({ decision: { allowed: true } });
    await expect(
      preflight(
        "claude",
        "other-claude-session",
        "Read",
        { file_path: "tracked.txt" },
        "other-claude-read",
      ),
    ).resolves.toMatchObject({ decision: { allowed: false }, inputHash: null });
    expect(
      (await readReceipts(projectRoot)).filter(
        (receipt) =>
          String(receipt.event) === "authority" &&
          receipt.runtime === "claude" &&
          receipt.sessionId === "claude-authority-session",
      ),
    ).toHaveLength(1);
  });

  it("lets OpenCode plan_exit bind only an already externally approved exact contract", async () => {
    const contractPlan = plan();
    const widenedPlan = plan({
      write: ["tracked.txt", "outside.txt"],
      commands: [
        { argv: ["echo", "ok"], cwd: "." },
        { argv: ["echo", "widened"], cwd: "." },
      ],
    });
    const hooks = await TaskFencePlugin({
      directory: projectRoot,
      client: {
        session: {
          get: async ({ path: requestPath }: { path: { id: string } }) => ({
            data: {
              id: requestPath.id,
              projectID: "test-project",
              directory: projectRoot,
              title: "Test session",
              version: "1",
              time: { created: 1, updated: 1 },
            },
          }),
        },
      },
    } as unknown as PluginInput);
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const identity = {
      tool: "plan_exit",
      sessionID: "opencode-plan-session",
      callID: "opencode-plan-call",
    };

    await expect(before(identity, { args: { plan: contractPlan } })).rejects.toThrow();
    await expect(getStatus(projectRoot)).resolves.toMatchObject({ status: "absent", contract: null });

    const externallyApproved = await approvePlan(contractPlan, projectRoot);
    await expect(
      before(
        { ...identity, callID: "widened-plan-call" },
        { args: { plan: widenedPlan } },
      ),
    ).rejects.toThrow();
    await expect(getStatus(projectRoot)).resolves.toMatchObject({
      contract: { contractHash: externallyApproved.contract?.contractHash },
    });

    const args = { plan: contractPlan };
    await expect(before(identity, { args })).resolves.toBeUndefined();
    await expect(after({ ...identity, args }, openCodeOutput)).resolves.toBeUndefined();

    const bound = await getStatus(projectRoot);
    expect(bound.contract).toEqual(externallyApproved.contract);
    expect(bound.authority).toEqual({
      runtime: "opencode",
      rootSessionId: "opencode-plan-session",
      sessions: [
        { sessionId: "opencode-plan-session", parentSessionId: null },
      ],
    });
    await expect(
      preflight(
        "opencode",
        "opencode-plan-session",
        "read",
        { path: "tracked.txt" },
        "opencode-plan-read",
        null,
      ),
    ).resolves.toMatchObject({ decision: { allowed: true } });
    await expect(
      preflight(
        "opencode",
        "different-opencode-session",
        "read",
        { path: "tracked.txt" },
        "opencode-other-read",
        null,
      ),
    ).resolves.toMatchObject({ decision: { allowed: false }, inputHash: null });
    expect(
      (await readReceipts(projectRoot)).filter(
        (receipt) =>
          String(receipt.event) === "authority" &&
          receipt.runtime === "opencode" &&
          receipt.sessionId === "opencode-plan-session",
      ),
    ).toHaveLength(1);
  });
});
