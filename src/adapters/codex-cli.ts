import {
  getStatus,
  hashRawToolCall,
  postToolCall,
  preToolCall,
  type PreToolCallInput,
} from "../engine.js";

export interface HookExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type CodexHookEventName = "PreToolUse" | "PermissionRequest" | "PostToolUse";
type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

interface CodexToolHookInput {
  sessionId: string;
  cwd: string;
  eventName: CodexHookEventName;
  toolName: string;
  toolUseId?: string;
  toolInput: unknown;
  toolResponse?: unknown;
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_COLLECTION_ENTRIES = 10_000;
const MAX_STRING_BYTES = MAX_JSON_BYTES;
const MAX_PROPERTY_NAME_BYTES = 4 * 1024;
const MAX_ERROR_BYTES = 2 * 1024;

const COMMON_KEYS: Record<string, true> = {
  agent_id: true,
  agent_type: true,
  cwd: true,
  hook_event_name: true,
  model: true,
  permission_mode: true,
  session_id: true,
  tool_input: true,
  tool_name: true,
  tool_use_id: true,
  transcript_path: true,
  turn_id: true,
};

const PERMISSION_MODES: Record<PermissionMode, true> = {
  default: true,
  acceptEdits: true,
  plan: true,
  dontAsk: true,
  bypassPermissions: true,
};

const CODEX_COMMAND_TOOLS: Readonly<Record<string, true>> = Object.freeze({
  Bash: true,
  bash: true,
  exec_command: true,
  local_shell: true,
  shell: true,
  shell_command: true,
});

function silent(): HookExecutionResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function preToolUseDeny(reason: string): HookExecutionResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    stderr: "",
  };
}

function permissionRequestDeny(reason: string): HookExecutionResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: reason,
        },
      },
    }),
    stderr: "",
  };
}

function failClosed(context: string, error: unknown): HookExecutionResult {
  const detail = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "unknown internal error";
  const normalized = `${context}: ${detail}`
    .replaceAll("\0", "")
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
  const bounded = Buffer.from(normalized, "utf8").subarray(0, MAX_ERROR_BYTES).toString("utf8").trim();
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${bounded || "TaskFence hook failed closed"}\n`,
  };
}

function assertPlainJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
}

function assertBoundedJson(value: unknown): void {
  let bytes = 0;
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new TypeError("Hook payload contains too many JSON values");
    if (current.depth > MAX_JSON_DEPTH) throw new TypeError("Hook payload exceeds the JSON nesting limit");

    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new TypeError("Hook payload contains a non-finite number");
      continue;
    }
    if (typeof current.value === "string") {
      const fieldBytes = Buffer.byteLength(current.value, "utf8");
      if (fieldBytes > MAX_STRING_BYTES) throw new TypeError("Hook payload contains an oversized string field");
      bytes += fieldBytes;
      if (bytes > MAX_JSON_BYTES) throw new TypeError("Hook payload exceeds the JSON byte limit");
      continue;
    }
    if (typeof current.value !== "object") {
      throw new TypeError("Hook payload contains a non-JSON value");
    }

    if (seen.has(current.value)) throw new TypeError("Hook payload contains a cycle");
    seen.add(current.value);
    const ownKeys = Reflect.ownKeys(current.value);
    if (ownKeys.length > MAX_COLLECTION_ENTRIES) {
      throw new TypeError("Hook payload contains an oversized collection");
    }

    if (Array.isArray(current.value)) {
      for (const key of ownKeys) {
        if (typeof key === "symbol" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
          throw new TypeError("Hook payload array contains a non-JSON property");
        }
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(current.value, index)) throw new TypeError("Hook payload contains a sparse array");
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }

    assertPlainJsonObject(current.value, "Hook payload value");
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    for (const key of ownKeys) {
      if (typeof key === "symbol") throw new TypeError("Hook payload contains a symbol key");
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new TypeError("Hook payload contains an accessor property");
      }
      const keyBytes = Buffer.byteLength(key, "utf8");
      if (keyBytes > MAX_PROPERTY_NAME_BYTES) {
        throw new TypeError("Hook payload contains an oversized property name");
      }
      bytes += keyBytes;
      if (bytes > MAX_JSON_BYTES) throw new TypeError("Hook payload exceeds the JSON byte limit");
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function requireString(
  payload: Record<string, unknown>,
  key: string,
  options: { nullable?: boolean } = {},
): string | null {
  if (!Object.hasOwn(payload, key)) throw new TypeError(`Missing Codex hook field: ${key}`);
  const value = payload[key];
  if (options.nullable === true && value === null) return null;
  if (typeof value !== "string") throw new TypeError(`Codex hook field ${key} must be a string`);
  return value;
}

function parseCodexPayload(payload: unknown): CodexToolHookInput {
  assertBoundedJson(payload);
  assertPlainJsonObject(payload, "Codex hook payload");

  const eventName = requireString(payload, "hook_event_name");
  if (
    eventName !== "PreToolUse" &&
    eventName !== "PermissionRequest" &&
    eventName !== "PostToolUse"
  ) {
    throw new TypeError(
      "Codex hook_event_name must be PreToolUse, PermissionRequest, or PostToolUse",
    );
  }

  for (const key of Object.keys(payload)) {
    const isPostResponse = eventName === "PostToolUse" && key === "tool_response";
    const isCommonField = COMMON_KEYS[key] === true;
    const isPermissionOnlyMismatch =
      eventName === "PermissionRequest" && key === "tool_use_id";
    if ((!isCommonField && !isPostResponse) || isPermissionOnlyMismatch) {
      throw new TypeError(`Unexpected Codex ${eventName} field: ${key}`);
    }
  }

  requireString(payload, "model");
  requireString(payload, "turn_id");
  requireString(payload, "transcript_path", { nullable: true });
  const permissionMode = requireString(payload, "permission_mode");
  if (
    permissionMode === null ||
    PERMISSION_MODES[permissionMode as PermissionMode] !== true
  ) {
    throw new TypeError("Codex permission_mode is invalid for CLI 0.146.0");
  }
  for (const optionalAgentField of ["agent_id", "agent_type"] as const) {
    if (Object.hasOwn(payload, optionalAgentField) && typeof payload[optionalAgentField] !== "string") {
      throw new TypeError(`Codex hook field ${optionalAgentField} must be a string`);
    }
  }
  if (!Object.hasOwn(payload, "tool_input")) throw new TypeError("Missing Codex hook field: tool_input");
  if (eventName === "PostToolUse" && !Object.hasOwn(payload, "tool_response")) {
    throw new TypeError("Missing Codex hook field: tool_response");
  }

  const sessionId = requireString(payload, "session_id");
  const cwd = requireString(payload, "cwd");
  const toolName = requireString(payload, "tool_name");
  const toolUseId = eventName === "PermissionRequest"
    ? undefined
    : requireString(payload, "tool_use_id");
  if (
    sessionId === null ||
    cwd === null ||
    toolName === null ||
    toolUseId === null
  ) {
    throw new TypeError("Required Codex hook string field is null");
  }

  return {
    sessionId,
    cwd,
    eventName,
    toolName,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    toolInput: payload.tool_input,
    ...(eventName === "PostToolUse" ? { toolResponse: payload.tool_response } : {}),
  };
}

function engineInput(payload: CodexToolHookInput): PreToolCallInput {
  return {
    runtime: "codex",
    toolName: payload.toolName === "Bash" ? "bash" : payload.toolName,
    input: payload.toolInput,
    cwd: payload.cwd,
    sessionId: payload.sessionId,
    ...(payload.toolUseId === undefined ? {} : { callId: payload.toolUseId }),
  };
}

async function runPreToolUse(payload: CodexToolHookInput): Promise<HookExecutionResult> {
  if (CODEX_COMMAND_TOOLS[payload.toolName] === true) {
    return preToolUseDeny(
      "TaskFence denies Codex command execution because Codex CLI 0.146.0 has no hook for subsequent write_stdin calls",
    );
  }
  const result = await preToolCall(engineInput(payload));
  return result.decision.allowed ? silent() : preToolUseDeny(result.decision.reason);
}

async function runPermissionRequest(
  payload: CodexToolHookInput,
): Promise<HookExecutionResult> {
  const result = await preToolCall(engineInput(payload));
  return result.decision.allowed
    ? silent()
    : permissionRequestDeny(result.decision.reason);
}

async function runPostToolUse(payload: CodexToolHookInput): Promise<HookExecutionResult> {
  // Codex 0.146.0 serializes both Bash and apply_patch responses as strings.
  // Bash PostToolUse is emitted even for non-zero exits and omits the exit code,
  // so neither event delivery nor response text proves success. By contrast,
  // apply_patch failure paths do not construct a post payload; a string response
  // therefore proves that the handler reached ApplyPatchToolOutput.
  const input = engineInput(payload);
  const inputHash = hashRawToolCall(input);
  const state = await getStatus(payload.cwd);
  const pending = state.pendingMutation;
  if (pending === null) return silent();
  if (
    pending.runtime !== "codex" ||
    pending.sessionId !== payload.sessionId ||
    pending.callId !== payload.toolUseId ||
    pending.inputHash !== inputHash
  ) {
    throw new Error("PostToolUse does not match the pending TaskFence mutation");
  }

  const responseInput = payload.toolInput;
  const success =
    payload.toolName === "apply_patch" &&
    typeof payload.toolResponse === "string" &&
    typeof responseInput === "object" &&
    responseInput !== null &&
    !Array.isArray(responseInput) &&
    Object.keys(responseInput).length === 1 &&
    typeof (responseInput as Record<string, unknown>).command === "string";

  await postToolCall({
    root: state.root,
    runtime: "codex",
    sessionId: payload.sessionId,
    callId: payload.toolUseId,
    inputHash,
    success,
  });
  return silent();
}

export async function runCodexHook(payload: unknown): Promise<HookExecutionResult> {
  let parsed: CodexToolHookInput;
  try {
    parsed = parseCodexPayload(payload);
  } catch (error) {
    return failClosed("TaskFence rejected malformed Codex CLI 0.146.0 hook input", error);
  }

  try {
    if (parsed.eventName === "PermissionRequest") {
      return await runPermissionRequest(parsed);
    }
    return parsed.eventName === "PreToolUse"
      ? await runPreToolUse(parsed)
      : await runPostToolUse(parsed);
  } catch (error) {
    return failClosed(`TaskFence ${parsed.eventName} failed closed`, error);
  }
}
