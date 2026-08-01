import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import TaskFencePlugin, {
  TaskFencePlugin as NamedTaskFencePlugin,
} from "../src/adapters/opencode.js";
import { MAX_PLAN_BYTES } from "../src/contract/limits.js";
import { approvePlan, getStatus, revokePlan } from "../src/engine.js";

const originalTaskFenceStateDirectory = process.env.TASKFENCE_STATE_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
type OpenCodeAfterHook = NonNullable<Hooks["tool.execute.after"]>;
type CompatibleAfterHook = (
  input: Omit<Parameters<OpenCodeAfterHook>[0], "args"> & { args?: unknown },
  output: Parameters<OpenCodeAfterHook>[1],
) => Promise<void>;

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

async function loadPlugin(sessionDirectory: string | null = projectRoot): Promise<Hooks> {
  const client = {
    session: {
      get: async (options: { path: { id: string } }) => ({
        data: {
          id: options.path.id,
          projectID: "test-project",
          ...(sessionDirectory === null ? {} : { directory: sessionDirectory }),
          title: "test session",
          version: "test",
          time: { created: 0, updated: 0 },
        },
      }),
    },
  };
  return TaskFencePlugin({
    directory: projectRoot,
    client,
  } as unknown as PluginInput);
}

function beforeHook(hooks: Hooks): NonNullable<Hooks["tool.execute.before"]> {
  expect(hooks["tool.execute.before"]).toBeTypeOf("function");
  return hooks["tool.execute.before"]!;
}

function afterHook(hooks: Hooks): CompatibleAfterHook {
  expect(hooks["tool.execute.after"]).toBeTypeOf("function");
  return hooks["tool.execute.after"]! as CompatibleAfterHook;
}

const afterOutput = {
  title: "completed",
  output: "ok",
  metadata: {},
};

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "taskfence-opencode-adapter-"));
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

describe("OpenCode adapter", () => {
  it("exports one plugin and registers both observable tool lifecycle hooks", async () => {
    expect(NamedTaskFencePlugin).toBe(TaskFencePlugin);

    const hooks = await loadPlugin();
    expect(hooks).toEqual(
      expect.objectContaining({
        "tool.execute.before": expect.any(Function),
        "tool.execute.after": expect.any(Function),
      }),
    );

    const heartbeatPath = join(
      process.env.XDG_STATE_HOME!,
      "taskfence",
      "host-heartbeats",
      "opencode.json",
    );
    const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
    expect(heartbeat).toEqual({
      runtime: "opencode",
      observedAt: expect.any(String),
      pid: process.pid,
    });
  });

  it("requires exact external approval for plan_exit and never activates the contract itself", async () => {
    const hooks = await loadPlugin();
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const plan = contractPlan();
    const identity = {
      tool: "plan_exit",
      sessionID: "opencode-session-plan",
      callID: "opencode-plan-1",
    };
    const args = { plan };

    await expect(
      before(
        { ...identity, callID: "opencode-plan-invalid" },
        { args: { plan: "# Missing TaskFence contract" } },
      ),
    ).rejects.toThrow(/contract/iu);
    expect((await getStatus(projectRoot)).status).toBe("absent");

    await expect(before(identity, { args })).rejects.toThrow(
      /externally user-approved active contract/iu,
    );
    expect((await getStatus(projectRoot)).status).toBe("absent");

    const approved = await approvePlan(plan, projectRoot);
    await expect(
      before(
        { ...identity, callID: "opencode-plan-wrong-hash" },
        { args: { plan: `${plan}\n` } },
      ),
    ).rejects.toThrow(/exact plan hash and root/iu);

    await expect(before(identity, { args })).resolves.toBeUndefined();
    await expect(after(identity, afterOutput)).resolves.toBeUndefined();
    expect(await getStatus(projectRoot)).toMatchObject({
      status: "active",
      contract: { contractHash: approved.contract?.contractHash },
      generation: approved.generation + 1,
      revision: approved.revision,
    });
  });

  it("correlates plan_exit authority before and after without amending it", async () => {
    const plan = contractPlan();
    await approvePlan(plan, projectRoot);
    const hooks = await loadPlugin();
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const identity = {
      tool: "plan_exit",
      sessionID: "opencode-session-plan-change",
      callID: "opencode-plan-change-1",
    };
    const args = { plan };

    await before(identity, { args });
    await revokePlan(projectRoot, "External user revoked approval");
    await expect(after({ ...identity, args }, afterOutput)).rejects.toThrow(
      /authority changed after preflight/iu,
    );
    expect(await getStatus(projectRoot)).toMatchObject({
      status: "revoked",
      reason: "External user revoked approval",
    });
  });

  it("detects plan argument mutation when a legacy after hook omits args", async () => {
    const plan = contractPlan();
    await approvePlan(plan, projectRoot);
    const hooks = await loadPlugin();
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const identity = {
      tool: "plan_exit",
      sessionID: "opencode-session-plan-carrier-change",
      callID: "opencode-plan-carrier-change-1",
    };
    const carrier = { args: { plan } };

    await before(identity, carrier);
    carrier.args = { plan: `${plan}\n` };
    await expect(after(identity, afterOutput)).rejects.toThrow(
      /plan_exit correlation mismatch/iu,
    );
  });

  it("throws on denial and remains silent for an allowed read", async () => {
    const hooks = await loadPlugin();
    const before = beforeHook(hooks);

    await expect(
      before(
        {
          tool: "write",
          sessionID: "opencode-session-1",
          callID: "opencode-write-denied",
        },
        { args: { path: "tracked.txt", content: "blocked\n" } },
      ),
    ).rejects.toThrow(/active contract is required for mutation/iu);

    await expect(
      before(
        {
          tool: "read",
          sessionID: "opencode-session-1",
          callID: "opencode-read-allowed",
        },
        { args: { path: "tracked.txt" } },
      ),
    ).resolves.toBeUndefined();
  });

  it("correlates matching before and after inputs and closes the pending mutation", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const hooks = await loadPlugin();
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const identity = {
      tool: "write",
      sessionID: "opencode-session-2",
      callID: "opencode-write-1",
    };
    const args = { path: "tracked.txt", content: "after\n" };

    await expect(before(identity, { args })).resolves.toBeUndefined();
    expect((await getStatus(projectRoot)).status).toBe("mutation_pending");

    await expect(after(identity, afterOutput)).resolves.toBeUndefined();
    expect((await getStatus(projectRoot)).status).toBe("active");
  });

  it("rejects after-hook argument substitution instead of closing the pending call", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const hooks = await loadPlugin();
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const identity = {
      tool: "write",
      sessionID: "opencode-session-3",
      callID: "opencode-write-mismatch",
    };

    await before(identity, {
      args: { path: "tracked.txt", content: "approved\n" },
    });
    await expect(
      after(
        {
          ...identity,
          args: { path: "tracked.txt", content: "substituted\n" },
        },
        afterOutput,
      ),
    ).rejects.toThrow("TaskFence post-tool correlation mismatch");
    expect((await getStatus(projectRoot)).status).toBe("mutation_pending");
  });

  it("detects later plugin mutation when a legacy after hook omits args", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const hooks = await loadPlugin();
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const identity = {
      tool: "write",
      sessionID: "opencode-session-carrier-change",
      callID: "opencode-write-carrier-change",
    };
    const carrier = {
      args: { path: "tracked.txt", content: "approved\n" },
    };

    await before(identity, carrier);
    carrier.args = { path: "outside.txt", content: "substituted\n" };
    await expect(after(identity, afterOutput)).rejects.toThrow(
      "TaskFence post-tool correlation mismatch",
    );
    expect((await getStatus(projectRoot)).status).toBe("mutation_pending");
  });

  it("loads approved policy from the configured external TaskFence state directory", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const configuredStateDirectory = process.env.TASKFENCE_STATE_DIR!;
    expect(configuredStateDirectory.startsWith(projectRoot)).toBe(false);

    const hooks = await loadPlugin();
    const before = beforeHook(hooks);
    const after = afterHook(hooks);
    const identity = {
      tool: "write",
      sessionID: "opencode-session-config",
      callID: "opencode-configured-state",
    };
    const args = { path: "tracked.txt", content: "configured\n" };

    await expect(before(identity, { args })).resolves.toBeUndefined();
    await expect(after({ ...identity, args }, afterOutput)).resolves.toBeUndefined();
    expect((await getStatus(projectRoot)).status).toBe("active");
  });

  it("fails closed when the host session directory is missing or mismatches the immutable project", async () => {
    await approvePlan(contractPlan(), projectRoot);
    const otherRoot = join(temporaryDirectory, "other-project");
    await mkdir(otherRoot);

    for (const [label, sessionDirectory] of [
      ["missing", null],
      ["mismatched", await realpath(otherRoot)],
    ] as const) {
      const hooks = await loadPlugin(sessionDirectory);
      await expect(
        beforeHook(hooks)(
          {
            tool: "write",
            sessionID: `opencode-${label}-directory`,
            callID: `opencode-${label}-call`,
          },
          { args: { path: "tracked.txt", content: "blocked\n" } },
        ),
      ).rejects.toThrow(/ancestry could not be verified/iu);
    }
    expect((await getStatus(projectRoot)).authority).toBeNull();
  });

  it("bounds OpenCode plans by UTF-8 bytes before contract parsing", async () => {
    const hooks = await loadPlugin();
    const oversized = "é".repeat(Math.floor(MAX_PLAN_BYTES / 2) + 1);
    await expect(
      beforeHook(hooks)(
        {
          tool: "plan_exit",
          sessionID: "opencode-oversized-plan",
          callID: "opencode-oversized-plan-call",
        },
        { args: { plan: oversized } },
      ),
    ).rejects.toThrow(/exceeds.+bytes/iu);
    expect((await getStatus(projectRoot)).status).toBe("absent");
  });
});
