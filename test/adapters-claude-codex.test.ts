import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runClaudeHook } from "../src/adapters/claude-code.js";
import { MAX_PLAN_BYTES } from "../src/contract/limits.js";
import { runCodexHook } from "../src/adapters/codex-cli.js";
import { approvePlan, getStatus } from "../src/engine.js";

const originalTaskFenceStateDirectory = process.env.TASKFENCE_STATE_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;

let temporaryDirectory: string;
let projectRoot: string;

function contractPlan(): string {
  return `# Test plan

\`\`\`taskfence-contract
${JSON.stringify(
    {
      version: 1,
      write: ["tracked.txt"],
      create: ["created.txt"],
      delete: [],
      protected: [],
      commands: [{ argv: ["echo", "ok"], cwd: "." }],
      packageManager: "none",
    },
    null,
    2,
  )}
\`\`\``;
}

function claudePayload(
  hookEventName: "PreToolUse" | "PostToolUse",
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = "claude-call-1",
): Record<string, unknown> {
  return {
    session_id: "claude-session-1",
    prompt_id: "claude-prompt-1",
    transcript_path: join(projectRoot, "claude-transcript.jsonl"),
    cwd: projectRoot,
    permission_mode: "default",
    effort: "medium",
    hook_event_name: hookEventName,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

function codexPayload(
  hookEventName: "PreToolUse" | "PostToolUse",
  toolName: string,
  toolInput: unknown,
  toolUseId = "codex-call-1",
): Record<string, unknown> {
  return {
    session_id: "codex-session-1",
    turn_id: "codex-turn-1",
    transcript_path: null,
    cwd: projectRoot,
    hook_event_name: hookEventName,
    model: "gpt-5.4",
    permission_mode: "default",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

function codexPermissionPayload(
  toolName: string,
  toolInput: unknown,
): Record<string, unknown> {
  return {
    session_id: "codex-session-1",
    turn_id: "codex-turn-1",
    transcript_path: null,
    cwd: projectRoot,
    hook_event_name: "PermissionRequest",
    model: "gpt-5.4",
    permission_mode: "default",
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function parsedStdout(result: { stdout: string }): unknown {
  expect(result.stdout).not.toBe("");
  return JSON.parse(result.stdout);
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "taskfence-host-adapters-"));
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

describe("Claude Code adapter", () => {
  it("accepts the verified Claude 2.1.220 common payload and fails closed when it is malformed", async () => {
    const valid = await runClaudeHook(
      claudePayload("PreToolUse", "Read", { file_path: "tracked.txt" }),
    );
    expect(valid).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const missingEffort = claudePayload("PreToolUse", "Read", {
      file_path: "tracked.txt",
    });
    delete missingEffort.effort;
    const malformed = await runClaudeHook(missingEffort);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toMatch(/TaskFence Claude hook internal error:.+\n$/u);
  });

  it("asks for ExitPlanMode approval and activates only after its successful post hook", async () => {
    const plan = contractPlan();
    const pre = await runClaudeHook(
      claudePayload("PreToolUse", "ExitPlanMode", {
        plan,
        planFilePath: join(projectRoot, "plan.md"),
        allowedPrompts: [],
      }),
    );
    expect(pre).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            "TaskFence contract is valid; user approval is required before activation",
        },
      }),
      stderr: "",
    });
    expect((await getStatus(projectRoot)).status).toBe("absent");

    const post = await runClaudeHook({
      ...claudePayload("PostToolUse", "ExitPlanMode", {
        plan,
        planFilePath: join(projectRoot, "plan.md"),
        allowedPrompts: [],
      }),
      tool_response: {
        plan,
        filePath: join(projectRoot, "plan.md"),
      },
    });
    expect(post).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await getStatus(projectRoot)).status).toBe("active");
  });

  it("returns the exact Claude deny object and remains silent for allowed calls", async () => {
    await approvePlan(contractPlan(), projectRoot);

    const denied = await runClaudeHook(
      claudePayload("PreToolUse", "Write", {
        file_path: "outside.txt",
        content: "blocked\n",
      }),
    );
    expect(parsedStdout(denied)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.any(String),
      },
    });
    expect(denied.exitCode).toBe(0);
    expect(denied.stderr).toBe("");

    const allowed = await runClaudeHook(
      claudePayload("PreToolUse", "Read", { file_path: "tracked.txt" }, "claude-read-2"),
    );
    expect(allowed).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("correlates an allowed mutation with the exact PostToolUse input", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const toolInput = { file_path: "tracked.txt", content: "after\n" };

    const pre = await runClaudeHook(
      claudePayload("PreToolUse", "Write", toolInput, "claude-write-1"),
    );
    expect(pre).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await getStatus(projectRoot)).status).toBe("mutation_pending");

    const post = await runClaudeHook({
      ...claudePayload("PostToolUse", "Write", toolInput, "claude-write-1"),
      tool_response: { filePath: join(projectRoot, "tracked.txt"), success: true },
    });
    expect(post).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await getStatus(projectRoot)).status).toBe("active");
  });

  it("fails closed on a malformed or mismatched PostToolUse payload", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const toolInput = { file_path: "tracked.txt", content: "after\n" };
    await runClaudeHook(
      claudePayload("PreToolUse", "Write", toolInput, "claude-write-mismatch"),
    );

    const mismatch = await runClaudeHook({
      ...claudePayload(
        "PostToolUse",
        "Write",
        { ...toolInput, content: "different\n" },
        "claude-write-mismatch",
      ),
      tool_response: { success: true },
    });
    expect(mismatch.exitCode).toBe(2);
    expect(mismatch.stdout).toBe("");
    expect(mismatch.stderr).not.toBe("");
    expect((await getStatus(projectRoot)).status).toBe("mutation_pending");

    const nonObjectResponse = await runClaudeHook({
      ...claudePayload("PostToolUse", "Read", { file_path: "tracked.txt" }, "bad-response"),
      tool_response: "not-an-object",
    });
    expect(nonObjectResponse.exitCode).toBe(2);
    expect(nonObjectResponse.stderr).not.toBe("");
  });

  it("fails a child closed before root binding and delegates a stable child identity afterward", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const childInput = { file_path: "tracked.txt", content: "child\n" };
    const childPayload = {
      ...claudePayload("PreToolUse", "Write", childInput, "claude-child-unbound"),
      agent_id: "agent-123",
      agent_type: "general-purpose",
    };

    const unbound = await runClaudeHook(childPayload);
    expect(parsedStdout(unbound)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/child session cannot claim/iu),
      },
    });
    expect((await getStatus(projectRoot)).authority).toBeNull();

    await expect(
      runClaudeHook(
        claudePayload(
          "PreToolUse",
          "Read",
          { file_path: "tracked.txt" },
          "claude-root-bind",
        ),
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const childPre = await runClaudeHook({
      ...childPayload,
      tool_use_id: "claude-child-write",
    });
    expect(childPre).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const pending = await getStatus(projectRoot);
    const childAuthority = pending.authority?.sessions.find(
      ({ parentSessionId }) => parentSessionId === "claude-session-1",
    );
    expect(pending.authority?.rootSessionId).toBe("claude-session-1");
    expect(childAuthority?.sessionId).toMatch(/^claude-agent:[a-f0-9]{64}$/u);
    expect(childAuthority?.sessionId).not.toBe("claude-session-1");

    const childPost = await runClaudeHook({
      ...claudePayload(
        "PostToolUse",
        "Write",
        childInput,
        "claude-child-write",
      ),
      agent_id: "agent-123",
      agent_type: "general-purpose",
      tool_response: { success: true },
    });
    expect(childPost).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await getStatus(projectRoot)).status).toBe("active");
  });

  it("bounds Claude plans by UTF-8 bytes before contract parsing", async () => {
    const oversized = "é".repeat(Math.floor(MAX_PLAN_BYTES / 2) + 1);
    const result = await runClaudeHook(
      claudePayload("PreToolUse", "ExitPlanMode", {
        plan: oversized,
        planFilePath: join(projectRoot, "plan.md"),
        allowedPrompts: [],
      }),
    );
    expect(parsedStdout(result)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/exceeds.+bytes/iu),
      },
    });
  });
});

describe("Codex CLI adapter", () => {
  it("accepts the exact 0.146.0 payload and rejects missing or unexpected fields", async () => {
    const exact = await runCodexHook(
      codexPayload("PreToolUse", "read_file", { path: "tracked.txt" }),
    );
    expect(exact).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const missingModel = codexPayload("PreToolUse", "read_file", { path: "tracked.txt" });
    delete missingModel.model;
    const missing = await runCodexHook(missingModel);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toMatch(/rejected malformed Codex CLI 0\.146\.0 hook input/u);

    const extraField = {
      ...codexPayload("PreToolUse", "read_file", { path: "tracked.txt" }),
      unverified_field: true,
    };
    const extra = await runCodexHook(extraField);
    expect(extra.exitCode).toBe(2);
    expect(extra.stdout).toBe("");
    expect(extra.stderr).toMatch(/Unexpected Codex PreToolUse field/u);
  });

  it("denies a disallowed PermissionRequest and defers silently when policy allows", async () => {
    await approvePlan(contractPlan(), projectRoot);

    const denied = await runCodexHook(
      codexPermissionPayload("write_file", {
        path: "outside.txt",
        content: "blocked\n",
      }),
    );
    expect(denied.exitCode).toBe(0);
    expect(denied.stderr).toBe("");
    expect(parsedStdout(denied)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.any(String),
        },
      },
    });

    const deferred = await runCodexHook(
      codexPermissionPayload("read_file", { path: "tracked.txt" }),
    );
    expect(deferred).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it.each([
    "Bash",
    "bash",
    "exec_command",
    "local_shell",
    "shell",
    "shell_command",
  ])("denies Codex command tool %s because write_stdin cannot be hooked", async (toolName) => {
    await approvePlan(contractPlan(), projectRoot);

    const pre = await runCodexHook(
      codexPayload("PreToolUse", toolName, { command: "echo ok" }, `codex-${toolName}-1`),
    );
    expect(pre.exitCode).toBe(0);
    expect(pre.stderr).toBe("");
    expect(parsedStdout(pre)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/no hook.*write_stdin/iu),
      },
    });
    expect(await getStatus(projectRoot)).toMatchObject({
      status: "active",
      pendingMutation: null,
    });
  });

  it("accepts the verified apply_patch PostToolUse string as completion", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const toolInput = { command: patch };

    const pre = await runCodexHook(
      codexPayload("PreToolUse", "apply_patch", toolInput, "codex-patch-1"),
    );
    expect(pre).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const post = await runCodexHook({
      ...codexPayload("PostToolUse", "apply_patch", toolInput, "codex-patch-1"),
      tool_response: "Success. Updated files.",
    });
    expect(post).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await getStatus(projectRoot)).status).toBe("active");
  });

  it("fails closed when a post hook does not correlate to the pending call", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    await runCodexHook(
      codexPayload("PreToolUse", "apply_patch", { command: patch }, "codex-patch-mismatch"),
    );

    const mismatch = await runCodexHook({
      ...codexPayload(
        "PostToolUse",
        "apply_patch",
        { command: patch.replace("created", "changed") },
        "codex-patch-mismatch",
      ),
      tool_response: "Success. Updated files.",
    });
    expect(mismatch.exitCode).toBe(2);
    expect(mismatch.stdout).toBe("");
    expect(mismatch.stderr).toMatch(/PostToolUse failed closed/u);
    expect((await getStatus(projectRoot)).status).toBe("mutation_pending");
  });
});
