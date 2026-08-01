import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { compileContract } from "../contract/compile.js";
import {
  MAX_PLAN_BYTES,
  readBoundedPlanFile,
  requireBoundedPlanText,
} from "../contract/limits.js";
import {
  approvePlan,
  getStatus,
  hashRawToolCall,
  postToolCall,
  preToolCall,
  type PreToolCallInput,
} from "../engine.js";
import { normalizeToolCall } from "../policy/tools.js";
import { isContainedPath } from "../policy/realpath.js";
import {
  createSecureFile,
  isNodeError,
  openSecureFile,
  syncSecureDirectory,
  validateSecureFile,
} from "../state/secure-file.js";
import { canonicalStateRoot, stateLayout } from "../state/layout.js";

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
  permissionMode: string;
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
const CLAUDE_APPROVAL_FILE_MODE = 0o600;
const MAX_CLAUDE_APPROVAL_BYTES = 16 * 1024;
const CLAUDE_PLAN_BINDING_CALL_ID = "plan-binding-v1";
const CLAUDE_PLAN_CLAIMS_DIRECTORY = ".taskfence-plan-claims";
const CLAUDE_APPROVAL_KEYS = [
  "callId",
  "planHash",
  "root",
  "sessionId",
  "version",
] as const;

type ClaudeApprovalRecord = {
  version: 1;
  root: string;
  sessionId: string;
  callId: string;
  planHash: string;
};

type ClaudeCorrelationLocation = {
  path: string;
  projectDirectory: string;
  root: string;
};

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
  const permissionMode = requireString(
    object,
    "permission_mode",
    MAX_SHORT_FIELD_LENGTH,
  );
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
      permissionMode,
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
    permissionMode,
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

function claudePlansDirectory(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const configDirectory =
    configured === undefined || configured.length === 0 || configured.includes("\0")
      ? join(homedir(), ".claude")
      : configured;
  return resolve(configDirectory, "plans");
}

function claudePlanPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return undefined;
  }
  if (!isAbsolute(value)) return undefined;
  const resolved = resolve(value);
  const name = basename(resolved);
  if (
    dirname(resolved) !== claudePlansDirectory() ||
    name.length <= ".md".length ||
    !name.endsWith(".md")
  ) {
    return undefined;
  }
  return resolved;
}

async function claudePlanWritePath(
  payload: ClaudeToolHookPayload,
): Promise<string | undefined> {
  if (
    payload.agentId !== undefined ||
    payload.permissionMode !== "plan" ||
    payload.toolName !== "Write"
  ) {
    return undefined;
  }
  const planPath = claudePlanPath(payload.toolInput.file_path);
  if (planPath === undefined) return undefined;

  const canonicalRoot = await canonicalStateRoot(payload.cwd);
  if (isContainedPath(canonicalRoot, planPath)) return undefined;
  let canonicalPlansDirectory: string;
  try {
    canonicalPlansDirectory = await realpath(dirname(planPath));
    const directoryMetadata = await lstat(canonicalPlansDirectory);
    if (
      !directoryMetadata.isDirectory() ||
      (typeof process.getuid === "function" &&
        directoryMetadata.uid !== process.getuid()) ||
      (directoryMetadata.mode & 0o022) !== 0
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (isContainedPath(canonicalRoot, canonicalPlansDirectory)) return undefined;
  return planPath;
}

async function claudeApprovalLocation(
  payload: ClaudeToolHookPayload,
): Promise<ClaudeCorrelationLocation> {
  const layout = await stateLayout(payload.cwd);
  const key = createHash("sha256")
    .update(payload.sessionId, "utf8")
    .update("\0", "utf8")
    .update(payload.toolUseId, "utf8")
    .digest("hex");
  return {
    path: join(layout.projectDir, `.claude-approval-${key}.json`),
    projectDirectory: layout.projectDir,
    root: layout.canonicalRoot,
  };
}

async function claudePlanWriteLocation(
  payload: ClaudeToolHookPayload,
  planPath: string,
): Promise<ClaudeCorrelationLocation> {
  const layout = await stateLayout(payload.cwd);
  const key = createHash("sha256")
    .update("plan-write", "utf8")
    .update("\0", "utf8")
    .update(planPath, "utf8")
    .digest("hex");
  return {
    path: join(layout.projectDir, `.claude-plan-write-${key}.json`),
    projectDirectory: layout.projectDir,
    root: layout.canonicalRoot,
  };
}

async function claudePlanClaimsDirectory(planPath: string): Promise<string> {
  const plansDirectory = await realpath(dirname(planPath));
  const claimsDirectory = join(
    plansDirectory,
    CLAUDE_PLAN_CLAIMS_DIRECTORY,
  );
  let created = false;
  try {
    await mkdir(claimsDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  if (created) await chmod(claimsDirectory, 0o700);

  const metadata = await lstat(claimsDirectory);
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" &&
      metadata.uid !== process.getuid())
  ) {
    throw new ClaudeHookInputError(
      `Claude plan claim directory is unsafe: ${claimsDirectory}`,
    );
  }
  const canonicalClaimsDirectory = await realpath(claimsDirectory);
  if (dirname(canonicalClaimsDirectory) !== plansDirectory) {
    throw new ClaudeHookInputError(
      `Claude plan claim directory escapes the plans directory: ${claimsDirectory}`,
    );
  }
  if (created) {
    const parentHandle = await open(
      plansDirectory,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
    );
    try {
      const parentMetadata = await parentHandle.stat();
      if (
        !parentMetadata.isDirectory() ||
        (parentMetadata.mode & 0o022) !== 0 ||
        (typeof process.getuid === "function" &&
          parentMetadata.uid !== process.getuid())
      ) {
        throw new ClaudeHookInputError(
          `Claude's plans directory is not safely owned: ${plansDirectory}`,
        );
      }
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  }
  return canonicalClaimsDirectory;
}

async function claudePlanBindingLocation(
  payload: ClaudeToolHookPayload,
  planPath: string,
): Promise<ClaudeCorrelationLocation> {
  const root = await canonicalStateRoot(payload.cwd);
  const claimsDirectory = await claudePlanClaimsDirectory(planPath);
  return {
    path: join(claimsDirectory, basename(planPath)),
    projectDirectory: claimsDirectory,
    root,
  };
}

async function readClaudeApprovalRecord(
  path: string,
): Promise<ClaudeApprovalRecord> {
  const requirements = {
    mode: CLAUDE_APPROVAL_FILE_MODE,
    maxBytes: MAX_CLAUDE_APPROVAL_BYTES,
    label: "Claude approval correlation",
  };
  const { handle, metadata: before } = await openSecureFile(
    path,
    fsConstants.O_RDONLY,
    requirements,
  );
  try {
    const expectedBytes = before.size;
    const bytes = Buffer.allocUnsafe(expectedBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    validateSecureFile(path, after, requirements);
    if (
      offset !== expectedBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new ClaudeHookInputError(
        "Claude approval correlation changed while it was being read",
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      throw new ClaudeHookInputError(
        "Claude approval correlation is not valid UTF-8 text",
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ClaudeHookInputError(
        "Claude approval correlation is not valid JSON",
      );
    }
    validateBoundedJson(value);
    const object = requireRecord(value, "Claude approval correlation");
    const keys = Object.keys(object).sort();
    if (
      keys.length !== CLAUDE_APPROVAL_KEYS.length ||
      keys.some((key, index) => key !== CLAUDE_APPROVAL_KEYS[index])
    ) {
      throw new ClaudeHookInputError(
        "Claude approval correlation has an invalid schema",
      );
    }
    if (object.version !== 1) {
      throw new ClaudeHookInputError(
        "Claude approval correlation has an invalid version",
      );
    }
    const planHash = requireString(object, "planHash", 64);
    if (!/^[0-9a-f]{64}$/u.test(planHash)) {
      throw new ClaudeHookInputError(
        "Claude approval correlation has an invalid plan hash",
      );
    }
    return {
      version: 1,
      root: requireString(object, "root", MAX_PATH_LENGTH),
      sessionId: requireString(object, "sessionId", MAX_IDENTIFIER_LENGTH),
      callId: requireString(object, "callId", MAX_IDENTIFIER_LENGTH),
      planHash,
    };
  } finally {
    await handle.close();
  }
}

async function stageClaudeApproval(
  location: ClaudeCorrelationLocation,
  payload: ClaudeToolHookPayload,
  planHash: string,
): Promise<void> {
  const record: ClaudeApprovalRecord = {
    version: 1,
    root: location.root,
    sessionId: payload.sessionId,
    callId: payload.toolUseId,
    planHash,
  };
  const text = `${JSON.stringify(record)}\n`;
  const requirements = {
    mode: CLAUDE_APPROVAL_FILE_MODE,
    maxBytes: MAX_CLAUDE_APPROVAL_BYTES,
    label: "Claude approval correlation",
  };
  let created;
  try {
    created = await createSecureFile(
      location.path,
      fsConstants.O_WRONLY,
      requirements,
    );
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const existing = await readClaudeApprovalRecord(location.path);
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new ClaudeHookInputError(
        "Claude approval correlation already exists with different content",
      );
    }
    await syncSecureDirectory(location.projectDirectory);
    return;
  }

  const handle = created.handle;
  let closed = false;
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    const after = await handle.stat();
    validateSecureFile(location.path, after, requirements);
    if (after.size !== Buffer.byteLength(text, "utf8")) {
      throw new ClaudeHookInputError(
        "Claude approval correlation write was incomplete",
      );
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    closed = true;
    await unlink(location.path).catch(() => undefined);
    throw error;
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
  }
  await syncSecureDirectory(location.projectDirectory);
}

async function verifyClaudeApproval(
  location: ClaudeCorrelationLocation,
  payload: ClaudeToolHookPayload,
  planHash: string,
  mismatchMessage: string,
): Promise<void> {
  let record: ClaudeApprovalRecord;
  try {
    record = await readClaudeApprovalRecord(location.path);
  } catch (error) {
    throw new ClaudeHookInputError(
      `Could not load Claude approval correlation: ${errorMessage(error)}`,
    );
  }
  const matches =
    record.root === location.root &&
    record.sessionId === payload.sessionId &&
    record.callId === payload.toolUseId &&
    record.planHash === planHash;
  if (!matches) {
    throw new ClaudeHookInputError(mismatchMessage);
  }
}

function planBindingPayload(
  payload: ClaudeToolHookPayload,
): ClaudeToolHookPayload {
  return { ...payload, toolUseId: CLAUDE_PLAN_BINDING_CALL_ID };
}

function planPathHash(planPath: string): string {
  return createHash("sha256").update(planPath, "utf8").digest("hex");
}

function validateClaudePlanMetadata(
  planPath: string,
  metadata: Stats,
): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size < 0 ||
    metadata.size > MAX_PLAN_BYTES ||
    (metadata.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" &&
      metadata.uid !== process.getuid())
  ) {
    throw new ClaudeHookInputError(
      `Claude's native plan must be a current-user regular file with one link, no group or other write access, and at most ${MAX_PLAN_BYTES} bytes: ${planPath}`,
    );
  }
}

async function validateBoundClaudePlanFile(planPath: string): Promise<void> {
  const handle = await open(
    planPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    validateClaudePlanMetadata(planPath, await handle.stat());
  } finally {
    await handle.close();
  }
}

async function verifyClaudePlanBinding(
  payload: ClaudeToolHookPayload,
  planPath: string,
): Promise<void> {
  const location = await claudePlanBindingLocation(payload, planPath);
  await verifyClaudeApproval(
    location,
    planBindingPayload(payload),
    planPathHash(planPath),
    "Claude's native plan path is not bound to this root session",
  );
  await validateBoundClaudePlanFile(planPath);
}

async function reserveClaudePlanPath(
  payload: ClaudeToolHookPayload,
  planPath: string,
): Promise<void> {
  const location = await claudePlanBindingLocation(payload, planPath);
  let bindingExists = true;
  try {
    await lstat(location.path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    bindingExists = false;
  }

  if (bindingExists) {
    await verifyClaudeApproval(
      location,
      planBindingPayload(payload),
      planPathHash(planPath),
      "Claude's native plan path is already bound to another root session",
    );
    try {
      await validateBoundClaudePlanFile(planPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    return;
  }

  try {
    await lstat(planPath);
    throw new ClaudeHookInputError(
      "Claude's native plan path must be a fresh file before it is bound to this session",
    );
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  await stageClaudeApproval(
    location,
    planBindingPayload(payload),
    planPathHash(planPath),
  );
}

async function stageClaudePlanWrite(
  location: ClaudeCorrelationLocation,
  payload: ClaudeToolHookPayload,
  planPath: string,
  planHash: string,
): Promise<void> {
  try {
    await stageClaudeApproval(location, payload, planHash);
    return;
  } catch (error) {
    let existing: ClaudeApprovalRecord;
    try {
      existing = await readClaudeApprovalRecord(location.path);
    } catch {
      throw error;
    }
    if (
      existing.root !== location.root ||
      existing.sessionId !== payload.sessionId ||
      existing.callId === payload.toolUseId
    ) {
      throw error;
    }
    try {
      await validateBoundClaudePlanFile(planPath);
      const observedPlan = await readBoundedPlanFile(planPath);
      if (
        createHash("sha256").update(observedPlan, "utf8").digest("hex") !==
          existing.planHash
      ) {
        throw error;
      }
    } catch {
      throw error;
    }
  }

  await removeClaudeCorrelation(location);
  await stageClaudeApproval(location, payload, planHash);
}

async function removeClaudeCorrelation(
  location: ClaudeCorrelationLocation,
): Promise<void> {
  try {
    await unlink(location.path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    return;
  }
  await syncSecureDirectory(location.projectDirectory);
}

async function claudeApprovalIsAlreadyActive(
  payload: ClaudeToolHookPayload,
  planHash: string,
): Promise<boolean> {
  const state = await getStatus(payload.cwd);
  return (
    (state.status === "active" || state.status === "mutation_pending") &&
    state.contract?.planHash === planHash &&
    state.authority?.runtime === "claude" &&
    state.authority.rootSessionId === payload.sessionId
  );
}

async function runPreToolUse(
  payload: ClaudeToolHookPayload,
): Promise<HookExecutionResult> {
  const planWritePath = await claudePlanWritePath(payload);
  if (planWritePath !== undefined) {
    try {
      const content = requirePlan(payload.toolInput, "content");
      await reserveClaudePlanPath(payload, planWritePath);
      const location = await claudePlanWriteLocation(payload, planWritePath);
      await stageClaudePlanWrite(
        location,
        payload,
        planWritePath,
        createHash("sha256").update(content, "utf8").digest("hex"),
      );
    } catch (error) {
      return structuredDecision(
        "deny",
        `Could not reserve Claude's native plan file: ${errorMessage(error)}`,
      );
    }
    return silentSuccess();
  }
  if (
    payload.agentId === undefined &&
    payload.permissionMode === "plan" &&
    payload.toolName === "Write"
  ) {
    return structuredDecision(
      "deny",
      "Claude's native plan must use a session-bound file in the default plans directory; custom plansDirectory paths are unsupported",
    );
  }

  if (payload.toolName === "ExitPlanMode") {
    if (payload.agentId !== undefined) {
      return structuredDecision(
        "deny",
        "A Claude child agent cannot activate a root TaskFence contract",
      );
    }
    let plan: string;
    let planHash: string;
    try {
      plan = requirePlan(payload.toolInput, "plan");
      const planFilePath = optionalString(
        payload.toolInput,
        "planFilePath",
        MAX_PATH_LENGTH,
      );
      if (planFilePath !== undefined) {
        const boundPlanPath = claudePlanPath(planFilePath);
        if (boundPlanPath === undefined) {
          throw new ClaudeHookInputError(
            "ExitPlanMode returned an invalid Claude plan file path",
          );
        }
        await verifyClaudePlanBinding(payload, boundPlanPath);
        if (await readBoundedPlanFile(boundPlanPath) !== plan) {
          throw new ClaudeHookInputError(
            "ExitPlanMode plan does not match its session-bound plan file",
          );
        }
      }
      if (
        payload.toolInput.allowedPrompts !== undefined &&
        !Array.isArray(payload.toolInput.allowedPrompts)
      ) {
        throw new ClaudeHookInputError("allowedPrompts must be an array when present");
      }
      planHash = compileContract(plan, payload.cwd).planHash;
    } catch (error) {
      return structuredDecision(
        "deny",
        `Invalid TaskFence contract: ${errorMessage(error)}`,
      );
    }
    try {
      const location = await claudeApprovalLocation(payload);
      await stageClaudeApproval(location, payload, planHash);
    } catch (error) {
      return structuredDecision(
        "deny",
        `Could not secure Claude plan approval: ${errorMessage(error)}`,
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
  const planWritePath = await claudePlanWritePath(payload);
  if (planWritePath !== undefined) {
    const expectedPlan = requirePlan(payload.toolInput, "content");
    await verifyClaudePlanBinding(payload, planWritePath);
    const reservation = await claudePlanWriteLocation(payload, planWritePath);
    await verifyClaudeApproval(
      reservation,
      payload,
      createHash("sha256").update(expectedPlan, "utf8").digest("hex"),
      "Claude plan Write does not match its reserved pre-tool input",
    );
    const responsePath = claudePlanPath(
      requireString(payload.toolResponse, "filePath", MAX_PATH_LENGTH),
    );
    if (responsePath !== planWritePath) {
      throw new ClaudeHookInputError(
        "Claude plan Write response path does not match its pre-tool input",
      );
    }
    let observedPlan: string;
    try {
      observedPlan = await readBoundedPlanFile(planWritePath);
    } catch (error) {
      throw new ClaudeHookInputError(
        `Could not verify the written Claude plan file: ${errorMessage(error)}`,
      );
    }
    if (observedPlan !== expectedPlan) {
      throw new ClaudeHookInputError(
        "Written Claude plan file does not match its pre-tool input",
      );
    }
    return silentSuccess();
  }


  if (payload.toolName === "ExitPlanMode") {
    if (payload.agentId !== undefined) {
      throw new ClaudeHookInputError(
        "A Claude child agent cannot activate a root TaskFence contract",
      );
    }
    const responsePath = optionalString(
      payload.toolResponse,
      "filePath",
      MAX_PATH_LENGTH,
    );
    const inputPlan =
      payload.toolInput.plan === undefined
        ? undefined
        : requirePlan(payload.toolInput, "plan");
    let approvedPlan: string;
    if (
      payload.toolResponse.plan !== undefined &&
      payload.toolResponse.plan !== null
    ) {
      approvedPlan = requirePlan(payload.toolResponse, "plan");
    } else {
      const planPath = claudePlanPath(responsePath);
      if (planPath === undefined) {
        if (inputPlan === undefined) {
          throw new ClaudeHookInputError(
            "PostToolUse omitted the approved plan and returned an invalid Claude plan file path",
          );
        }
        approvedPlan = inputPlan;
      } else {
        await verifyClaudePlanBinding(payload, planPath);
        try {
          approvedPlan = await readBoundedPlanFile(planPath);
        } catch (error) {
          throw new ClaudeHookInputError(
            `Could not read the approved Claude plan file: ${errorMessage(error)}`,
          );
        }
      }
    }
    if (inputPlan !== undefined && inputPlan !== approvedPlan) {
      throw new ClaudeHookInputError(
        "PostToolUse plan does not match the approved ExitPlanMode input",
      );
    }
    const planHash = createHash("sha256")
      .update(approvedPlan, "utf8")
      .digest("hex");
    const approval = await claudeApprovalLocation(payload);
    if (await claudeApprovalIsAlreadyActive(payload, planHash)) {
      await removeClaudeCorrelation(approval).catch(() => undefined);
      return silentSuccess();
    }
    await verifyClaudeApproval(
      approval,
      payload,
      planHash,
      "PostToolUse plan does not match the pre-approved ExitPlanMode input",
    );
    await approvePlan(approvedPlan, payload.cwd, {
      runtime: "claude",
      sessionId: payload.sessionId,
    });
    await removeClaudeCorrelation(approval).catch(() => undefined);
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
