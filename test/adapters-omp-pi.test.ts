import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import createOmpTaskFenceExtension, {
  type OmpExtensionApi,
} from "../src/adapters/omp.js";
import createPiTaskFenceExtension, {
  type PiExtensionApi,
} from "../src/adapters/pi.js";
import { MAX_PLAN_BYTES } from "../src/contract/limits.js";
import { getStatus } from "../src/engine.js";

type Runtime = "omp" | "pi";
type ExtensionApi = OmpExtensionApi | PiExtensionApi;
type ExtensionFactory = (api: never) => void;
type Context = {
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
  sessionManager?: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
};
type ToolEvent = {
  type: "tool_call" | "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content?: unknown[];
  isError?: boolean;
};
type SessionStartEvent = {
  type: "session_start";
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
};
type ExtensionEvent = ToolEvent | SessionStartEvent;
type HandlerResult = {
  block?: boolean;
  reason?: string;
} | void;
type Handler = (event: ExtensionEvent, context: Context) => Promise<HandlerResult>;
type Command = {
  description?: string;
  handler(args: string, context: Context): Promise<void>;
};

interface CapturedExtension {
  handlers: Map<string, Handler>;
  commands: Map<string, Command>;
}

interface AdapterSummary {
  registeredEvents: string[];
  registeredCommands: string[];
  description: string | undefined;
  readResult: HandlerResult;
  unrelatedResult: HandlerResult;
  denied: HandlerResult;
  missingIdentity: HandlerResult;
  allowed: HandlerResult;
  completedStatus: string;
  uncertainStatus: string;
  rolledBackStatus: string;
  completedPlanStatus: string;
  revokedStatus: string;
  revokeReason: string | null;
  commandStatuses: string[];
}

const factories: Record<Runtime, ExtensionFactory> = {
  omp: createOmpTaskFenceExtension as ExtensionFactory,
  pi: createPiTaskFenceExtension as ExtensionFactory,
};

const sandboxes: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function plan(create: string[] = ["created.txt"]): string {
  return [
    "Adapter test plan.",
    "```taskfence-contract",
    JSON.stringify({
      version: 1,
      write: ["allowed.txt"],
      create,
      delete: ["deletable.txt"],
      protected: [],
      commands: [{ argv: ["node", "--version"], cwd: "." }],
      packageManager: "none",
    }),
    "```",
  ].join("\n");
}
function sessionStartEvent(
  runtime: Runtime,
  reason: "startup" | "reload" | "new" | "resume" | "fork",
): SessionStartEvent {
  if (runtime === "omp") return { type: "session_start" };
  return reason === "startup" || reason === "reload"
    ? { type: "session_start", reason }
    : {
        type: "session_start",
        reason,
        previousSessionFile: "/tmp/taskfence-previous-session.jsonl",
      };
}


function capture(factory: ExtensionFactory): CapturedExtension {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
  };
  factory(api as unknown as ExtensionApi as never);
  return { handlers, commands };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing captured ${label}`);
  return value;
}

async function runAdapter(runtime: Runtime): Promise<AdapterSummary> {
  const sandbox = await mkdtemp(join(tmpdir(), `taskfence-${runtime}-adapter-`));
  sandboxes.push(sandbox);
  const root = join(sandbox, "project");
  await mkdir(root);
  await writeFile(join(root, "allowed.txt"), "checkpoint\n");
  await writeFile(join(root, "deletable.txt"), "delete me\n");
  await writeFile(join(root, "plan.md"), plan());
  await writeFile(join(root, "amended.md"), plan(["created.txt", "extra.txt"]));

  vi.stubEnv("TASKFENCE_STATE_DIR", join(sandbox, "state"));
  vi.stubEnv("XDG_STATE_HOME", join(sandbox, "xdg-state"));

  const previousCwd = process.cwd();
  let captured: CapturedExtension;
  try {
    process.chdir(root);
    captured = capture(factories[runtime]);
  } finally {
    process.chdir(previousCwd);
  }

  const sessionStart = required(captured.handlers.get("session_start"), "session_start handler");
  const toolCall = required(captured.handlers.get("tool_call"), "tool_call handler");
  const toolResult = required(captured.handlers.get("tool_result"), "tool_result handler");
  const command = required(captured.commands.get("taskfence"), "taskfence command");
  const notifications: Array<{ message: string; level: string }> = [];
  let hostSessionId = `${runtime}-session-root`;
  const context: Context = {
    ui: {
      notify(message, level = "info") {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionId: () => hostSessionId,
      getSessionFile: () => join(root, ".sessions", `${hostSessionId}.jsonl`),
    },
  };
  await sessionStart(sessionStartEvent(runtime, "startup"), context);

  // The registered command handler is the adapter's plan-approval callback.
  await command.handler("approve plan.md", context);
  expect((await getStatus(root)).status).toBe("active");
  await command.handler("status", context);
  await command.handler("amend amended.md", context);
  expect((await getStatus(root)).revision).toBe(2);

  const readResult = await toolCall({
    type: "tool_call",
    toolCallId: "read-1",
    toolName: "read",
    input: { path: "allowed.txt" },
  }, context);
  const unrelatedResult = await toolResult({
    type: "tool_result",
    toolCallId: "not-pending",
    toolName: "read",
    input: { path: "allowed.txt" },
    content: [],
    isError: false,
  }, context);

  const denied = await toolCall({
    type: "tool_call",
    toolCallId: "denied-1",
    toolName: "write",
    input: { path: "outside.txt", content: "no" },
  }, context);
  const missingIdentity = await toolCall({
    type: "tool_call",
    toolCallId: "",
    toolName: "write",
    input: { path: "allowed.txt", content: "no identity" },
  }, context);

  const successfulInput = { path: "allowed.txt", content: "success" };
  const allowed = await toolCall({
    type: "tool_call",
    toolCallId: "write-success",
    toolName: "write",
    input: successfulInput,
  }, context);
  expect((await getStatus(root)).status).toBe("mutation_pending");
  await toolResult({
    type: "tool_result",
    toolCallId: "write-success",
    toolName: "write",
    input: successfulInput,
    content: [],
    isError: false,
  }, context);
  const completedStatus = (await getStatus(root)).status;

  const failedInput = { path: "allowed.txt", content: "uncertain" };
  await toolCall({
    type: "tool_call",
    toolCallId: "write-failure",
    toolName: "write",
    input: failedInput,
  }, context);
  await toolResult({
    type: "tool_result",
    toolCallId: "write-failure",
    toolName: "write",
    input: failedInput,
    content: [],
    isError: true,
  }, context);
  const uncertainStatus = (await getStatus(root)).status;

  await command.handler("rollback", context);
  const rolledBackStatus = (await getStatus(root)).status;
  await command.handler("approve plan.md", context);
  await command.handler("complete", context);
  const completedPlanStatus = (await getStatus(root)).status;
  await command.handler("approve plan.md", context);
  await command.handler("revoke adapter parity", context);
  const revoked = await getStatus(root);

  const commandStatuses = notifications
    .filter(({ level, message }) => level === "info" && message.startsWith("TaskFence status="))
    .map(({ message }) => required(/status=([^;]+)/.exec(message)?.[1], "command status"));

  return {
    registeredEvents: [...captured.handlers.keys()].sort(),
    registeredCommands: [...captured.commands.keys()].sort(),
    description: command.description,
    readResult,
    unrelatedResult,
    denied,
    missingIdentity,
    allowed,
    completedStatus,
    uncertainStatus,
    rolledBackStatus,
    completedPlanStatus,
    revokedStatus: revoked.status,
    revokeReason: revoked.reason,
    commandStatuses,
  };
}

describe.each(["omp", "pi"] as const)("%s adapter", (runtime) => {
  it("registers the full surface and enforces calls, results, identity, and commands", async () => {
    const summary = await runAdapter(runtime);

    expect(summary.registeredEvents).toEqual(["session_start", "tool_call", "tool_result"]);
    expect(summary.registeredCommands).toEqual(["taskfence"]);
    expect(summary.description).toMatch(/Approve, amend, inspect, rollback, complete, or revoke/);
    expect(summary.readResult).toBeUndefined();
    expect(summary.unrelatedResult).toBeUndefined();
    expect(summary.denied).toMatchObject({ block: true });
    expect(summary.denied?.reason).toMatch(/not authorized/i);
    expect(summary.missingIdentity).toMatchObject({ block: true });
    expect(summary.missingIdentity?.reason).toMatch(
      /identifiers must be non-empty|sessionId and callId|invalid_call_id/i,
    );
    expect(summary.allowed).toBeUndefined();
    expect(summary.completedStatus).toBe("active");
    expect(summary.uncertainStatus).toBe("recovery_required");
    expect(summary.rolledBackStatus).toBe("rolled_back");
    expect(summary.completedPlanStatus).toBe("completed");
    expect(summary.revokedStatus).toBe("revoked");
    expect(summary.revokeReason).toBe("adapter parity");
    expect(summary.commandStatuses).toEqual([
      "active",
      "active",
      "active",

      "rolled_back",
      "active",
      "completed",
      "active",
      "revoked",
    ]);
  });

  it("uses the host session lifecycle for root, resume, new, and fork authority", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), `taskfence-${runtime}-sessions-`));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    await mkdir(root);
    await writeFile(join(root, "allowed.txt"), "checkpoint\n");
    await writeFile(join(root, "plan.md"), plan());
    vi.stubEnv("TASKFENCE_STATE_DIR", join(sandbox, "state"));
    vi.stubEnv("XDG_STATE_HOME", join(sandbox, "xdg-state"));

    const previousCwd = process.cwd();
    let captured: CapturedExtension;
    try {
      process.chdir(root);
      captured = capture(factories[runtime]);
    } finally {
      process.chdir(previousCwd);
    }

    const sessionStart = required(captured.handlers.get("session_start"), "session_start handler");
    const toolCall = required(captured.handlers.get("tool_call"), "tool_call handler");
    const toolResult = required(captured.handlers.get("tool_result"), "tool_result handler");
    const command = required(captured.commands.get("taskfence"), "taskfence command");
    let sessionId = `${runtime}-durable-root`;
    const context: Context = {
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, ".sessions", `${sessionId}.jsonl`),
      },
    };

    await sessionStart(sessionStartEvent(runtime, "startup"), context);
    await command.handler("approve plan.md", context);
    expect((await getStatus(root)).authority).toMatchObject({
      runtime,
      rootSessionId: `${runtime}-durable-root`,
      sessions: [{ sessionId: `${runtime}-durable-root`, parentSessionId: null }],
    });

    const resumedInput = { path: "allowed.txt", content: "resumed" };
    await sessionStart(sessionStartEvent(runtime, "resume"), context);
    await expect(toolCall({
      type: "tool_call",
      toolCallId: "resumed-write",
      toolName: "write",
      input: resumedInput,
    }, context)).resolves.toBeUndefined();
    await toolResult({
      type: "tool_result",
      toolCallId: "resumed-write",
      toolName: "write",
      input: resumedInput,
      content: [],
      isError: false,
    }, context);
    expect((await getStatus(root)).status).toBe("active");

    sessionId = `${runtime}-new-session`;
    await sessionStart(sessionStartEvent(runtime, "new"), context);
    const newDenied = await toolCall({
      type: "tool_call",
      toolCallId: "new-write",
      toolName: "write",
      input: { path: "allowed.txt", content: "new" },
    }, context);
    expect(newDenied).toMatchObject({ block: true });
    expect(newDenied?.reason).toMatch(/not authorized/iu);

    sessionId = `${runtime}-durable-root`;
    await sessionStart(sessionStartEvent(runtime, "resume"), context);
    sessionId = `${runtime}-fork-session`;
    await sessionStart(sessionStartEvent(runtime, "fork"), context);
    const forkDenied = await toolCall({
      type: "tool_call",
      toolCallId: "fork-write",
      toolName: "write",
      input: { path: "allowed.txt", content: "fork" },
    }, context);
    expect(forkDenied).toMatchObject({ block: true });
    expect(forkDenied?.reason).toMatch(/not authorized/iu);
  });

  it("rejects oversized and malformed plan files before contract parsing", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), `taskfence-${runtime}-plan-limits-`));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    await mkdir(root);
    await writeFile(join(root, "oversized.md"), Buffer.alloc(MAX_PLAN_BYTES + 1, 0x61));
    await writeFile(join(root, "malformed.md"), Buffer.from([0xff]));
    vi.stubEnv("TASKFENCE_STATE_DIR", join(sandbox, "state"));
    vi.stubEnv("XDG_STATE_HOME", join(sandbox, "xdg-state"));

    const previousCwd = process.cwd();
    let captured: CapturedExtension;
    try {
      process.chdir(root);
      captured = capture(factories[runtime]);
    } finally {
      process.chdir(previousCwd);
    }
    const sessionStart = required(captured.handlers.get("session_start"), "session_start handler");
    const toolCall = required(captured.handlers.get("tool_call"), "tool_call handler");
    const command = required(captured.commands.get("taskfence"), "taskfence command");
    const missingContext: Context = {};
    await sessionStart(sessionStartEvent(runtime, "startup"), missingContext);
    const capabilityDenied = await toolCall({
      type: "tool_call",
      toolCallId: "missing-host-session",
      toolName: "write",
      input: { path: "allowed.txt", content: "blocked" },
    }, missingContext);
    expect(capabilityDenied).toMatchObject({ block: true });
    expect(capabilityDenied?.reason).toMatch(/stable session identity/iu);

    const context: Context = {
      sessionManager: {
        getSessionId: () => `${runtime}-plan-session`,
        getSessionFile: () => join(root, ".sessions", "plan-session.jsonl"),
      },
    };
    await sessionStart(sessionStartEvent(runtime, "startup"), context);

    await expect(command.handler("approve oversized.md", context)).rejects.toThrow(
      new RegExp(`exceeds ${MAX_PLAN_BYTES} bytes`, "u"),
    );
    await expect(command.handler("approve malformed.md", context)).rejects.toThrow(
      /valid UTF-8/iu,
    );
    expect((await getStatus(root)).status).toBe("absent");
  });
});

describe("OMP/Pi adapter parity", () => {
  it("produces the same observable behavior for the shared extension contract", async () => {
    const omp = await runAdapter("omp");
    const pi = await runAdapter("pi");

    expect(pi).toEqual(omp);
  }, 15_000);
});
