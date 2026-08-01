import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runClaudeHook } from "../src/adapters/claude-code.js";
import { MAX_PLAN_BYTES } from "../src/contract/limits.js";
import { runCodexHook } from "../src/adapters/codex-cli.js";
import { approvePlan, getStatus } from "../src/engine.js";

const originalTaskFenceStateDirectory = process.env.TASKFENCE_STATE_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalClaudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR;

let temporaryDirectory: string;
let projectRoot: string;
let claudePlansDirectory: string;

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
    effort: { level: "high" },
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
  process.env.CLAUDE_CONFIG_DIR = join(temporaryDirectory, "claude-config");
  claudePlansDirectory = join(process.env.CLAUDE_CONFIG_DIR, "plans");
  await mkdir(claudePlansDirectory, { recursive: true });
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
  if (originalClaudeConfigDirectory === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDirectory;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Claude Code adapter", () => {
  it("accepts current and legacy effort payloads and fails closed for malformed effort", async () => {
    const current = await runClaudeHook(
      claudePayload("PreToolUse", "Read", { file_path: "tracked.txt" }),
    );
    expect(current).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const legacyPayload = claudePayload("PreToolUse", "Read", {
      file_path: "tracked.txt",
    });
    legacyPayload.effort = "high";
    const legacy = await runClaudeHook(legacyPayload);
    expect(legacy).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const extendedPayload = claudePayload("PreToolUse", "Read", {
      file_path: "tracked.txt",
    });
    extendedPayload.effort = {
      level: "future-level",
      future_option: { enabled: true },
    };
    const extended = await runClaudeHook(extendedPayload);
    expect(extended).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const missingEffort = claudePayload("PreToolUse", "Read", {
      file_path: "tracked.txt",
    });
    delete missingEffort.effort;

    const malformedEfforts: Array<[string, unknown]> = [
      ["missing", undefined],
      ["null", null],
      ["empty legacy string", ""],
      ["overlong legacy string", "x".repeat(1_025)],
      ["NUL-containing legacy string", "high\0"],
      ["array", [{ level: "high" }]],
      ["unrelated number scalar", 42],
      ["unrelated boolean scalar", true],
      ["object missing level", {}],
      ["object with empty level", { level: "" }],
      ["object with non-string level", { level: 42 }],
      ["object with overlong level", { level: "x".repeat(1_025) }],
      ["object with NUL-containing level", { level: "high\0" }],
    ];

    for (const [label, effort] of malformedEfforts) {
      const payload =
        label === "missing"
          ? missingEffort
          : {
              ...claudePayload("PreToolUse", "Read", {
                file_path: "tracked.txt",
              }),
              effort,
            };
      const malformed = await runClaudeHook(payload);
      expect(malformed.exitCode, label).toBe(2);
      expect(malformed.stdout, label).toBe("");
      expect(malformed.stderr, label).toMatch(
        /TaskFence Claude hook internal error:.+\n$/u,
      );
    }
  });

  it("allows Claude's control tools required to enter plan mode", async () => {
    const search = await runClaudeHook(
      claudePayload("PreToolUse", "ToolSearch", {
        query: "select:EnterPlanMode,ExitPlanMode",
        max_results: 2,
      }),
    );
    expect(search).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const enter = await runClaudeHook(
      claudePayload("PreToolUse", "EnterPlanMode", {}, "claude-enter-plan"),
    );
    expect(enter).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("supports Claude's native plan file and activates from its current post payload", async () => {
    const plan = contractPlan();
    const planPath = join(claudePlansDirectory, "quiet-test-plan.md");
    const planFileInput = { file_path: planPath, content: plan };
    const planFilePrePayload = claudePayload(
      "PreToolUse",
      "Write",
      planFileInput,
      "claude-plan-file-write",
    );
    planFilePrePayload.permission_mode = "plan";

    const planFilePre = await runClaudeHook(planFilePrePayload);
    expect(planFilePre).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    await writeFile(planPath, plan);
    const planFilePostPayload = {
      ...claudePayload(
        "PostToolUse",
        "Write",
        planFileInput,
        "claude-plan-file-write",
      ),
      permission_mode: "plan",
      tool_response: { filePath: planPath },
    };
    const planFilePost = await runClaudeHook(planFilePostPayload);
    expect(planFilePost).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const pre = await runClaudeHook(
      claudePayload("PreToolUse", "ExitPlanMode", {
        plan,
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

    const postPayload = {
      ...claudePayload("PostToolUse", "ExitPlanMode", {}),
      tool_response: {
        plan: null,
        isAgent: false,
        filePath: planPath,
      },
    };
    const post = await runClaudeHook(postPayload);
    expect(post).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await getStatus(projectRoot)).status).toBe("active");
    expect(await runClaudeHook(postPayload)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("fails closed when the written native plan differs from its tool input", async () => {
    const plan = contractPlan();
    const planPath = join(claudePlansDirectory, "changed-during-write.md");
    const planFileInput = { file_path: planPath, content: plan };
    const prePayload = claudePayload(
      "PreToolUse",
      "Write",
      planFileInput,
      "claude-changed-plan-write",
    );
    prePayload.permission_mode = "plan";
    expect(await runClaudeHook(prePayload)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    await writeFile(planPath, plan.replace("tracked.txt", "outside.txt"));
    const post = await runClaudeHook({
      ...claudePayload(
        "PostToolUse",
        "Write",
        planFileInput,
        "claude-changed-plan-write",
      ),
      permission_mode: "plan",
      tool_response: { filePath: planPath },
    });
    expect(post.exitCode).toBe(2);
    expect(post.stderr).toMatch(
      /Written Claude plan file does not match its pre-tool input/u,
    );
  });

  it("rejects a native plan file that differs from the pre-approved input", async () => {
    const approvedPlan = contractPlan();
    const substitutedPlan = approvedPlan.replace("tracked.txt", "outside.txt");
    const planPath = join(claudePlansDirectory, "substituted-plan.md");
    await writeFile(planPath, substitutedPlan);

    const pre = await runClaudeHook(
      claudePayload(
        "PreToolUse",
        "ExitPlanMode",
        { plan: approvedPlan, allowedPrompts: [] },
        "claude-substituted-plan",
      ),
    );
    expect(parsedStdout(pre)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "ask",
      },
    });

    const postPayload = {
      ...claudePayload(
        "PostToolUse",
        "ExitPlanMode",
        {},
        "claude-substituted-plan",
      ),
      tool_response: {
        plan: null,
        isAgent: false,
        filePath: planPath,
      },
    };
    const post = await runClaudeHook(postPayload);
    expect(post.exitCode).toBe(2);
    expect(post.stderr).toMatch(
      /does not match the pre-approved ExitPlanMode input/u,
    );
    expect((await getStatus(projectRoot)).status).toBe("absent");

    await writeFile(planPath, approvedPlan);
    expect(await runClaudeHook(postPayload)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect((await getStatus(projectRoot)).status).toBe("active");
  });

  it("rejects a current ExitPlanMode post without a matching pre hook", async () => {
    const planPath = join(claudePlansDirectory, "missing-pre-hook.md");
    await writeFile(planPath, contractPlan());
    const post = await runClaudeHook({
      ...claudePayload(
        "PostToolUse",
        "ExitPlanMode",
        {},
        "claude-missing-pre-hook",
      ),
      tool_response: {
        plan: null,
        isAgent: false,
        filePath: planPath,
      },
    });
    expect(post.exitCode).toBe(2);
    expect(post.stderr).toMatch(/Claude approval correlation/u);
    expect((await getStatus(projectRoot)).status).toBe("absent");
  });

  it("does not exempt ordinary writes from pre-approval enforcement", async () => {
    const planPath = join(claudePlansDirectory, "not-in-plan-mode.md");
    const ordinary = await runClaudeHook(
      claudePayload("PreToolUse", "Write", {
        file_path: planPath,
        content: contractPlan(),
      }),
    );
    expect(parsedStdout(ordinary)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });

    const outsidePayload = claudePayload(
      "PreToolUse",
      "Write",
      {
        file_path: join(temporaryDirectory, "outside-plans.md"),
        content: contractPlan(),
      },
      "claude-non-plan-file-write",
    );
    outsidePayload.permission_mode = "plan";
    const outside = await runClaudeHook(outsidePayload);
    expect(parsedStdout(outside)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });

    const existingPlanPath = join(claudePlansDirectory, "existing-plan.md");
    await writeFile(existingPlanPath, "existing plan\n");
    const existingPayload = claudePayload(
      "PreToolUse",
      "Write",
      {
        file_path: existingPlanPath,
        content: contractPlan(),
      },
      "claude-existing-plan-write",
    );
    existingPayload.permission_mode = "plan";
    const existing = await runClaudeHook(existingPayload);
    expect(parsedStdout(existing)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/fresh file/u),
      },
    });

    const reservedPlanPath = join(claudePlansDirectory, "reserved-plan.md");
    const firstReservation = claudePayload(
      "PreToolUse",
      "Write",
      {
        file_path: reservedPlanPath,
        content: contractPlan(),
      },
      "claude-first-plan-reservation",
    );
    firstReservation.permission_mode = "plan";
    expect(await runClaudeHook(firstReservation)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const conflictingReservation = claudePayload(
      "PreToolUse",
      "Write",
      {
        file_path: reservedPlanPath,
        content: contractPlan(),
      },
      "claude-conflicting-plan-reservation",
    );
    conflictingReservation.permission_mode = "plan";
    const conflict = await runClaudeHook(conflictingReservation);
    expect(parsedStdout(conflict)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });

    const childPayload = claudePayload(
      "PreToolUse",
      "Write",
      {
        file_path: join(claudePlansDirectory, "child-plan.md"),
        content: contractPlan(),
      },
      "claude-child-plan-write",
    );
    childPayload.permission_mode = "plan";
    childPayload.agent_id = "child-agent";
    const child = await runClaudeHook(childPayload);
    expect(parsedStdout(child)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
  });

  it("does not exempt a Claude plan directory inside the project", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(projectRoot, ".claude");
    const projectPlansDirectory = join(
      process.env.CLAUDE_CONFIG_DIR,
      "plans",
    );
    await mkdir(projectPlansDirectory, { recursive: true });
    const payload = claudePayload(
      "PreToolUse",
      "Write",
      {
        file_path: join(projectPlansDirectory, "project-plan.md"),
        content: contractPlan(),
      },
      "claude-project-plan-write",
    );
    payload.permission_mode = "plan";

    const result = await runClaudeHook(payload);
    expect(parsedStdout(result)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect((await getStatus(projectRoot)).status).toBe("absent");
  });

  it("does not exempt symlinked or hard-linked native plan destinations", async () => {
    const trackedPath = join(projectRoot, "tracked.txt");
    const symlinkPath = join(claudePlansDirectory, "symlinked-plan.md");
    const hardlinkPath = join(claudePlansDirectory, "hard-linked-plan.md");
    await symlink(trackedPath, symlinkPath);
    await link(trackedPath, hardlinkPath);

    for (const [label, planPath] of [
      ["symlink", symlinkPath],
      ["hard link", hardlinkPath],
    ] as const) {
      const payload = claudePayload(
        "PreToolUse",
        "Write",
        { file_path: planPath, content: contractPlan() },
        `claude-${label}-plan-write`,
      );
      payload.permission_mode = "plan";
      const result = await runClaudeHook(payload);
      expect(parsedStdout(result), label).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
        },
      });
    }
  });

  it("fails closed when an ExitPlanMode response changes the approved input", async () => {
    const plan = contractPlan();
    const changed = plan.replace("tracked.txt", "outside.txt");
    const result = await runClaudeHook({
      ...claudePayload(
        "PostToolUse",
        "ExitPlanMode",
        { plan },
        "claude-plan-mismatch",
      ),
      tool_response: {
        plan: changed,
        filePath: join(projectRoot, "plan.md"),
      },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/does not match the approved ExitPlanMode input/u);
    expect((await getStatus(projectRoot)).status).toBe("absent");
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
