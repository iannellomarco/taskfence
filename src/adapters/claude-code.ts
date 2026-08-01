import { createHash } from "node:crypto";

import { compileContract } from "../contract/compile.js";
import { requireBoundedPlanText } from "../contract/limits.js";
import {
  approvePlan,
  getStatus,
  hashRawToolCall,
  postToolCall,
  preToolCall,
  type PreToolCallInput,
} from "../engine.js";
import { normalizeToolCall } from "../policy/tools.js";

export interface HookExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type JsonRecord = Record<string, unknown>;

type ClaudeToolHookPayload = {
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd: string;
  event: "PreToolUse" | "PostToolUse";
  toolName: string;
  toolInput: JsonRecord;
  toolUseId: string;
  toolResponse?: JsonRecord;
};

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_STRING_LENGTH = 8 * 1024 * 1024;
const MAX_JSON_TOTAL_STRING_LENGTH = 16 * 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 4_096;
const MAX_PATH_LENGTH = 65_536;
const MAX_SHORT_FIELD_LENGTH = 1_024;

class ClaudeHookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeHookInputError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new ClaudeHookInputError(`${label} must be an object`);
  }
  return value;
}

function requireString(
  object: JsonRecord,
  field: string,
  maximumLength: number,
): string {
  const value = object[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw new ClaudeHookInputError(
      `${field} must be a non-empty, bounded, NUL-free string`,
    );
  }
  return value;
}

function optionalString(
  object: JsonRecord,
  field: string,
  maximumLength: number,
): string | undefined {
  if (object[field] === undefined) return undefined;
  return requireString(object, field, maximumLength);
}

function requireEffort(object: JsonRecord): void {
  if (typeof object.effort === "string") {
    requireString(object, "effort", MAX_SHORT_FIELD_LENGTH);
    return;
  }

  const effort = requireRecord(object.effort, "effort");
  requireString(effort, "level", MAX_SHORT_FIELD_LENGTH);
}

function validateBoundedJson(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let totalStringLength = 0;

  while (stack.length !== 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new ClaudeHookInputError("Hook payload contains too many JSON values");
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new ClaudeHookInputError("Hook payload exceeds the maximum JSON depth");
    }

    if (typeof current.value === "string") {
      if (current.value.length > MAX_JSON_STRING_LENGTH) {
        throw new ClaudeHookInputError("Hook payload contains an oversized string");
      }
      totalStringLength += current.value.length;
      if (totalStringLength > MAX_JSON_TOTAL_STRING_LENGTH) {
        throw new ClaudeHookInputError("Hook payload contains too much string data");
      }
      continue;
    }

    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }

    if (typeof current.value !== "object") {
      throw new ClaudeHookInputError("Hook payload must contain only JSON values");
    }
    if (seen.has(current.value)) {
      throw new ClaudeHookInputError("Hook payload must not contain cycles or aliases");
    }
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    for (const [key, item] of Object.entries(current.value)) {
      if (key.length === 0 || key.length > MAX_SHORT_FIELD_LENGTH || key.includes("\0")) {
        throw new ClaudeHookInputError("Hook payload contains an invalid object key");
      }
      totalStringLength += key.length;
      if (totalStringLength > MAX_JSON_TOTAL_STRING_LENGTH) {
        throw new ClaudeHookInputError("Hook payload contains too much string data");
      }
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
}

function parsePayload(payload: unknown): ClaudeToolHookPayload {
  validateBoundedJson(payload);
  const object = requireRecord(payload, "Claude hook payload");

  const sessionId = requireString(object, "session_id", MAX_IDENTIFIER_LENGTH);
  requireString(object, "prompt_id", MAX_IDENTIFIER_LENGTH);
  requireString(object, "transcript_path", MAX_PATH_LENGTH);
  const cwd = requireString(object, "cwd", MAX_PATH_LENGTH);
  requireString(object, "permission_mode", MAX_SHORT_FIELD_LENGTH);
  requireEffort(object);
  const agentId = optionalString(object, "agent_id", MAX_IDENTIFIER_LENGTH);
  const agentType = optionalString(object, "agent_type", MAX_SHORT_FIELD_LENGTH);

  const event = requireString(object, "hook_event_name", MAX_SHORT_FIELD_LENGTH);
  if (event !== "PreToolUse" && event !== "PostToolUse") {
    throw new ClaudeHookInputError(`Unsupported Claude hook event: ${event}`);
  }

  const toolName = requireString(object, "tool_name", MAX_SHORT_FIELD_LENGTH);
  const toolInput = requireRecord(object.tool_input, "tool_input");
  const toolUseId = requireString(object, "tool_use_id", MAX_IDENTIFIER_LENGTH);

  if (event === "PostToolUse") {
    return {
      sessionId,
      ...(agentId === undefined ? {} : { agentId }),
      ...(agentType === undefined ? {} : { agentType }),
      cwd,
      event,
      toolName,
      toolInput,
      toolUseId,
      toolResponse: requireRecord(object.tool_response, "tool_response"),
    };
  }

  return {
    sessionId,
    ...(agentId === undefined ? {} : { agentId }),
    ...(agentType === undefined ? {} : { agentType }),
    cwd,
    event,
    toolName,
    toolInput,
    toolUseId,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length !== 0) {
    return error.message.trim();
  }
  return "Unknown internal error";
}

function silentSuccess(): HookExecutionResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function structuredDecision(
  decision: "ask" | "deny",
  reason: string,
): HookExecutionResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
    stderr: "",
  };
}

function internalFailure(error: unknown): HookExecutionResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `TaskFence Claude hook internal error: ${errorMessage(error)}\n`,
  };
}

function authorityIdentity(payload: ClaudeToolHookPayload): {
  sessionId: string;
  parentSessionId?: string;
} {
  if (payload.agentId === undefined) return { sessionId: payload.sessionId };
  const digest = createHash("sha256")
    .update(payload.sessionId, "utf8")
    .update("\0", "utf8")
    .update(payload.agentId, "utf8")
    .digest("hex");
  return {
    sessionId: `claude-agent:${digest}`,
    parentSessionId: payload.sessionId,
  };
}

function preflightInput(payload: ClaudeToolHookPayload): PreToolCallInput {
  return {
    runtime: "claude",
    toolName: payload.toolName,
    input: payload.toolInput,
    cwd: payload.cwd,
    ...authorityIdentity(payload),
    callId: payload.toolUseId,
  };
}

function requirePlan(object: JsonRecord, field: string): string {
  try {
    return requireBoundedPlanText(object[field], field);
  } catch (error) {
    throw new ClaudeHookInputError(
      error instanceof Error ? error.message : `${field} is invalid`,
    );
  }
}

async function runPreToolUse(
  payload: ClaudeToolHookPayload,
): Promise<HookExecutionResult> {
  if (payload.toolName === "ExitPlanMode") {
    if (payload.agentId !== undefined) {
      return structuredDecision(
        "deny",
        "A Claude child agent cannot activate a root TaskFence contract",
      );
    }
    let plan: string;
    try {
      plan = requirePlan(payload.toolInput, "plan");
      optionalString(payload.toolInput, "planFilePath", MAX_PATH_LENGTH);
      if (
        payload.toolInput.allowedPrompts !== undefined &&
        !Array.isArray(payload.toolInput.allowedPrompts)
      ) {
        throw new ClaudeHookInputError("allowedPrompts must be an array when present");
      }
      compileContract(plan, payload.cwd);
    } catch (error) {
      return structuredDecision(
        "deny",
        `Invalid TaskFence contract: ${errorMessage(error)}`,
      );
    }
    return structuredDecision(
      "ask",
      "TaskFence contract is valid; user approval is required before activation",
    );
  }

  const result = await preToolCall(preflightInput(payload));
  if (result.decision.allowed) return silentSuccess();
  return structuredDecision("deny", result.decision.reason);
}

async function runPostToolUse(
  payload: ClaudeToolHookPayload,
): Promise<HookExecutionResult> {
  if (payload.toolResponse === undefined) {
    throw new ClaudeHookInputError("PostToolUse requires tool_response");
  }

  if (payload.toolName === "ExitPlanMode") {
    if (payload.agentId !== undefined) {
      throw new ClaudeHookInputError(
        "A Claude child agent cannot activate a root TaskFence contract",
      );
    }
    const approvedPlan = requirePlan(payload.toolResponse, "plan");
    requireString(payload.toolResponse, "filePath", MAX_PATH_LENGTH);
    await approvePlan(approvedPlan, payload.cwd, {
      runtime: "claude",
      sessionId: payload.sessionId,
    });
    return silentSuccess();
  }

  const input = preflightInput(payload);
  const normalized = normalizeToolCall(
    input.runtime,
    input.toolName,
    input.input,
    input.cwd,
    input.sessionId,
    input.callId,
  );
  if (normalized.kind !== "command" && normalized.kind !== "mutation") {
    return silentSuccess();
  }

  const state = await getStatus(payload.cwd);
  await postToolCall({
    root: state.root,
    runtime: "claude",
    sessionId: input.sessionId!,
    callId: payload.toolUseId,
    inputHash: hashRawToolCall(input),
    success: true,
  });
  return silentSuccess();
}

export async function runClaudeHook(
  payload: unknown,
): Promise<HookExecutionResult> {
  try {
    const parsed = parsePayload(payload);
    return parsed.event === "PreToolUse"
      ? await runPreToolUse(parsed)
      : await runPostToolUse(parsed);
  } catch (error) {
    return internalFailure(error);
  }
}
