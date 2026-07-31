import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  amendPlan,
  approvePlan,
  completePlan,
  getStatus,
  hashRawToolCall,
  postToolCall,
  preToolCall,
  rollbackPlan,
  revokePlan,
} from "../engine.js";
import { readBoundedPlanFileSync } from "../contract/limits.js";
import type { ProjectState } from "../types.js";

interface OmpUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

interface OmpExtensionContext {
  ui?: OmpUi;
  sessionManager?: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
}

interface OmpToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface OmpToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: unknown[];
  details?: unknown;
  isError: boolean;
}

interface OmpToolCallEventResult {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
}

interface OmpToolResultEventResult {
  content?: unknown[];
  details?: unknown;
  isError?: boolean;
}

interface OmpCommandOptions {
  description?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Array<{ value: string; label?: string; description?: string }> | null;
  handler(args: string, context: OmpExtensionContext): Promise<void>;
}

interface OmpSessionStartEvent {
  type: "session_start";
}

export interface OmpExtensionApi {
  on(
    event: "session_start",
    handler: (
      event: OmpSessionStartEvent,
      context: OmpExtensionContext,
    ) => Promise<void>,
  ): void;
  on(
    event: "tool_call",
    handler: (
      event: OmpToolCallEvent,
      context: OmpExtensionContext,
    ) => Promise<OmpToolCallEventResult | void>,
  ): void;
  on(
    event: "tool_result",
    handler: (
      event: OmpToolResultEvent,
      context: OmpExtensionContext,
    ) => Promise<OmpToolResultEventResult | void>,
  ): void;
  registerCommand(name: string, options: OmpCommandOptions): void;
}

interface PendingCall {
  root: string;
  inputHash: string;
  sessionId: string;
}

const COMMAND_USAGE =
  "Usage: /taskfence approve <plan-file> | amend <plan-file> | status | rollback | complete | revoke <reason>";
let lastHeartbeatAt = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length !== 0
    ? error.message
    : String(error);
}
function hostSessionId(context: OmpExtensionContext): string {
  const sessionId = context.sessionManager?.getSessionId();
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 4_096 ||
    Buffer.byteLength(sessionId, "utf8") > 4_096 ||
    sessionId.includes("\0")
  ) {
    throw new Error(
      "OMP did not expose a valid stable session identity; TaskFence mutations are unavailable",
    );
  }
  return sessionId;
}



function notify(
  context: OmpExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): boolean {
  if (context.ui === undefined) return false;
  try {
    context.ui.notify(message, level);
    return true;
  } catch {
    return false;
  }
}


function splitCommand(args: string): { subcommand: string; operand: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { subcommand: "status", operand: "" };
  const separator = trimmed.search(/\s/);
  if (separator === -1) {
    return { subcommand: trimmed.toLowerCase(), operand: "" };
  }
  return {
    subcommand: trimmed.slice(0, separator).toLowerCase(),
    operand: trimmed.slice(separator).trim(),
  };
}

function readPlanFile(root: string, planFile: string): string {
  if (planFile.length === 0 || planFile.includes("\0")) {
    throw new Error("approve and amend require a plan-file path");
  }
  const path = isAbsolute(planFile) ? planFile : resolve(root, planFile);
  return readBoundedPlanFileSync(path);
}


function recordHeartbeat(runtime: "omp"): void {
  const now = Date.now();
  if (now - lastHeartbeatAt < 60_000) return;
  lastHeartbeatAt = now;
  try {
    const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
    const path = join(stateHome, "taskfence", "host-heartbeats", `${runtime}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ runtime, observedAt: new Date().toISOString(), pid: process.pid })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    // Heartbeats are diagnostic only and never weaken or interrupt enforcement.
  }
}

async function executeControlCommand(
  args: string,
  context: OmpExtensionContext,
  root: string,
  sessionId: string,
): Promise<void> {
  const { subcommand, operand } = splitCommand(args);
  let state: ProjectState;

  switch (subcommand) {
    case "approve":
      state = await approvePlan(readPlanFile(root, operand), root, {
        runtime: "omp",
        sessionId,
      });
      break;
    case "amend":
      state = await amendPlan(readPlanFile(root, operand), root);
      break;
    case "status":
      if (operand.length !== 0) throw new Error(COMMAND_USAGE);
      state = await getStatus(root);
      break;
    case "rollback":
      if (operand.length !== 0) throw new Error(COMMAND_USAGE);
      state = await rollbackPlan(root);
      break;
    case "complete":
      if (operand.length !== 0) throw new Error(COMMAND_USAGE);
      state = await completePlan(root);
      break;
    case "revoke":
      if (operand.length === 0) throw new Error("revoke requires a reason");
      state = await revokePlan(root, operand);
      break;
    default:
      throw new Error(COMMAND_USAGE);
  }

  const reason = state.reason === null ? "" : `; reason=${state.reason}`;
  notify(
    context,
    `TaskFence status=${state.status}; root=${state.root}; revision=${state.revision}; generation=${state.generation}${reason}`,
  );
}

export default function createOmpTaskFenceExtension(api: OmpExtensionApi): void {
  const cwd = realpathSync.native(resolve(process.cwd()));
  let activeSessionId: string | undefined;
  const pendingCalls = new Map<string, PendingCall>();
  api.on("session_start", async (_event, context) => {
    pendingCalls.clear();
    try {
      activeSessionId = hostSessionId(context);
    } catch (error) {
      activeSessionId = undefined;
      notify(context, `TaskFence session binding failed: ${errorMessage(error)}`, "error");
    }
  });

  api.on("tool_call", async (event, context) => {
    recordHeartbeat("omp");
    try {
      const sessionId = hostSessionId(context);
      if (sessionId !== activeSessionId) {
        throw new Error("OMP session identity changed without a session_start event");
      }
      const result = await preToolCall({
        runtime: "omp",
        toolName: event.toolName,
        input: event.input,
        cwd,
        sessionId,
        callId: event.toolCallId,
      });
      if (!result.decision.allowed) {
        return { block: true, reason: result.decision.reason };
      }
      if (result.inputHash !== null) {
        pendingCalls.set(event.toolCallId, {
          root: result.root,
          inputHash: result.inputHash,
          sessionId,
        });
      }
      return undefined;
    } catch (error) {
      const reason = `TaskFence internal error: ${errorMessage(error)}`;
      notify(context, reason, "error");
      return { block: true, reason };
    }
  });

  api.on("tool_result", async (event, context) => {
    recordHeartbeat("omp");
    const pending = pendingCalls.get(event.toolCallId);
    if (pending === undefined) return;
    pendingCalls.delete(event.toolCallId);

    try {
      const sessionId = hostSessionId(context);
      if (sessionId !== activeSessionId || sessionId !== pending.sessionId) {
        throw new Error("OMP tool result belongs to a different host session");
      }
      const inputHash = hashRawToolCall({
        runtime: "omp",
        toolName: event.toolName,
        input: event.input,
        cwd,
        sessionId,
        callId: event.toolCallId,
      });
      if (inputHash !== pending.inputHash) {
        notify(
          context,
          "TaskFence could not reconcile the executed tool input; mutation remains fail-closed",
          "error",
        );
        return;
      }
      await postToolCall({
        root: pending.root,
        runtime: "omp",
        sessionId,
        callId: event.toolCallId,
        inputHash,
        success: !event.isError,
      });
    } catch (error) {
      notify(
        context,
        `TaskFence post-tool reconciliation failed: ${errorMessage(error)}`,
        "error",
      );
    }
  });

  api.registerCommand("taskfence", {
    description: "Approve, amend, inspect, rollback, complete, or revoke a TaskFence contract",
    handler: async (args, context) => {
      recordHeartbeat("omp");
      try {
        const sessionId = hostSessionId(context);
        if (sessionId !== activeSessionId) {
          throw new Error("OMP session identity is not initialized by session_start");
        }
        await executeControlCommand(args, context, cwd, sessionId);
      } catch (error) {
        const message = `TaskFence command failed: ${errorMessage(error)}`;
        if (!notify(context, message, "error")) throw new Error(message);
      }
    },
  });

  recordHeartbeat("omp");
}
