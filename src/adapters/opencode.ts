import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";
import { compileContract } from "../contract/compile.js";
import { requireBoundedPlanText } from "../contract/limits.js";

import {
  getStatus,
  claimSessionAuthority,
  hashRawToolCall,
  postToolCall,
  preToolCall,
  type PreToolCallInput,
} from "../engine.js";

interface ArgumentCarrier {
  readonly args: unknown;
}

interface PendingCorrelation {
  readonly inputHash: string;
  readonly argumentCarrier: ArgumentCarrier;
  readonly root: string;
  readonly toolName: string;
}

interface PendingPlanCorrelation {
  readonly contractHash: string;
  readonly argumentCarrier: ArgumentCarrier;
  readonly generation: number;
  readonly planHash: string;
  readonly revision: number;
  readonly root: string;
}


function requirePlan(args: Record<string, unknown>): string {
  return requireBoundedPlanText(args.plan, "TaskFence plan_exit args.plan");
}

export const TaskFencePlugin: Plugin = async ({ directory, client }) => {
  // OpenCode supplies its canonical project directory at plugin initialization.
  // Resolve it once so session metadata can only authorize this immutable root.
  const projectRoot = await realpath(directory);
  const pendingCalls = new Map<string, PendingCorrelation>();
  const pendingPlans = new Map<string, PendingPlanCorrelation>();
  const verifiedParentSessionId = async (
    sessionId: string,
  ): Promise<string | null | undefined> => {
    if (typeof client?.session?.get !== "function") return undefined;
    try {
      const result = await client.session.get({
        path: { id: sessionId },
        query: { directory: projectRoot },
      });
      const data: unknown = result.data;
      if (
        result.error !== undefined ||
        typeof data !== "object" ||
        data === null
      ) {
        return undefined;
      }
      const session = data as {
        id?: unknown;
        parentID?: unknown;
        directory?: unknown;
      };
      if (
        session.id !== sessionId ||
        typeof session.directory !== "string" ||
        session.directory.length === 0 ||
        session.directory.includes("\0") ||
        (
          session.parentID !== undefined &&
          typeof session.parentID !== "string"
        )
      ) {
        return undefined;
      }
      const canonicalSessionDirectory = await realpath(session.directory);
      if (
        session.directory !== canonicalSessionDirectory ||
        canonicalSessionDirectory !== projectRoot
      ) {
        return undefined;
      }
      return session.parentID ?? null;
    } catch {
      return undefined;
    }
  };


  const configuredStateHome = process.env.XDG_STATE_HOME;
  const stateHome = configuredStateHome !== undefined && configuredStateHome.length > 0
    ? configuredStateHome
    : join(homedir(), ".local", "state");
  const heartbeatDirectory = join(stateHome, "taskfence", "host-heartbeats");
  try {
    await mkdir(heartbeatDirectory, { recursive: true });
    await writeFile(
      join(heartbeatDirectory, "opencode.json"),
      `${JSON.stringify({
        runtime: "opencode",
        observedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Heartbeats are diagnostic only and never participate in authorization.
  }

  return {
    "tool.execute.before": async (input, output): Promise<void> => {
      if (input.tool === "plan_exit") {
        const key = JSON.stringify([input.sessionID, input.callID]);
        if (pendingPlans.has(key)) {
          throw new Error("TaskFence duplicate pending plan_exit");
        }
        const compiled = compileContract(requirePlan(output.args), projectRoot);
        const approved = await getStatus(projectRoot);
        if (
          approved.status !== "active" ||
          approved.contract === null ||
          approved.root !== compiled.root ||
          approved.contract.root !== compiled.root ||
          approved.contract.planHash !== compiled.planHash ||
          approved.contract.contractHash !== compiled.contractHash
        ) {
          throw new Error(
            "TaskFence plan_exit requires an externally user-approved active contract with the exact plan hash and root",
          );
        }
        const parentSessionId = await verifiedParentSessionId(input.sessionID);
        const state = await claimSessionAuthority({
          root: compiled.root,
          runtime: "opencode",
          sessionId: input.sessionID,
          parentSessionId,
          expectedContractHash: compiled.contractHash,
          expectedPlanHash: compiled.planHash,
        });
        if (
          state.contract === null ||
          state.contract.root !== compiled.root ||
          state.contract.planHash !== compiled.planHash
        ) {
          throw new Error(
            "TaskFence plan_exit requires an externally user-approved active contract with the exact plan hash and root",
          );
        }
        pendingPlans.set(key, {
          argumentCarrier: output,
          contractHash: state.contract.contractHash,
          generation: state.generation,
          planHash: compiled.planHash,
          revision: state.revision,
          root: compiled.root,
        });
        return;
      }
      const parentSessionId = await verifiedParentSessionId(input.sessionID);
      const call: PreToolCallInput = {
        runtime: "opencode",
        toolName: input.tool,
        input: output.args,
        cwd: projectRoot,
        sessionId: input.sessionID,
        parentSessionId,
        callId: input.callID,
      };
      const result = await preToolCall(call);
      if (!result.decision.allowed) {
        throw new Error(result.decision.reason);
      }

      if (result.inputHash !== null) {
        pendingCalls.set(JSON.stringify([input.sessionID, input.callID]), {
          argumentCarrier: output,
          inputHash: result.inputHash,
          root: result.root,
          toolName: input.tool,
        });
      }
    },

    "tool.execute.after": async (input, _output): Promise<void> => {
      const key = JSON.stringify([input.sessionID, input.callID]);
      if (input.tool === "plan_exit") {
        const expected = pendingPlans.get(key);
        if (expected === undefined) {
          throw new Error("TaskFence plan_exit completion has no matching preflight");
        }
        pendingPlans.delete(key);
        const observedArgs =
          "args" in input ? input.args : expected.argumentCarrier.args;
        if (
          typeof observedArgs !== "object" ||
          observedArgs === null ||
          Array.isArray(observedArgs)
        ) {
          throw new Error("TaskFence plan_exit completion has invalid arguments");
        }
        const observed = compileContract(
          requirePlan(observedArgs as Record<string, unknown>),
          projectRoot,
        );
        if (
          observed.planHash !== expected.planHash ||
          observed.root !== expected.root
        ) {
          throw new Error("TaskFence plan_exit correlation mismatch");
        }
        const state = await getStatus(projectRoot);
        if (
          state.status !== "active" ||
          state.contract === null ||
          state.root !== expected.root ||
          state.contract.root !== expected.root ||
          state.contract.planHash !== expected.planHash ||
          state.contract.contractHash !== expected.contractHash ||
          state.generation !== expected.generation ||
          state.revision !== expected.revision
        ) {
          throw new Error(
            "TaskFence plan_exit authority changed after preflight",
          );
        }
        return;
      }
      const pending = pendingCalls.get(key);
      if (pending === undefined) return;
      pendingCalls.delete(key);

      // Older supported after-hooks identify the call without repeating its
      // arguments. Retain the mutable before-hook carrier so later plugins
      // cannot substitute arguments without changing the post hash.
      const observedArgs =
        "args" in input ? input.args : pending.argumentCarrier.args;
      const inputHash = hashRawToolCall({
        runtime: "opencode",
        toolName: input.tool,
        input: observedArgs,
        cwd: projectRoot,
        sessionId: input.sessionID,
        callId: input.callID,
      });
      if (pending.toolName !== input.tool || pending.inputHash !== inputHash) {
        throw new Error("TaskFence post-tool correlation mismatch");
      }

      await postToolCall({
        root: pending.root,
        runtime: "opencode",
        sessionId: input.sessionID,
        callId: input.callID,
        inputHash,
        success: true,
      });
    },
  };
};

export default TaskFencePlugin;
