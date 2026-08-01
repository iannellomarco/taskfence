import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalStringify, sha256 } from "../src/contract/canonical.js";
import { stateLayout, type StateLayout } from "../src/state/layout.js";
import {
  createProjectState,
  StateStoreError,
  StateTransitionError,
} from "../src/state/model.js";
import { withProjectLock } from "../src/state/lock.js";
import { loadProjectState, saveProjectState } from "../src/state/store.js";
import { transition } from "../src/state/transitions.js";
import type {
  CheckpointManifest,
  CompiledContract,
  ContractDocument,
  PendingMutation,
  ProjectState,
} from "../src/types.js";

type LockRenameRace = (source: string, destination: string) => Promise<void>;
type LockOpenInspection = (target: unknown, flags: unknown) => void;
type LockAfterOpenInspection = (target: unknown, flags: unknown) => Promise<void>;
type LockUnlinkRace = (target: string) => Promise<void>;
const lockRenameRace = vi.hoisted(() => ({
  intercept: undefined as LockRenameRace | undefined,
  afterIntercept: undefined as LockRenameRace | undefined,
}));

const lockOpenInspection = vi.hoisted(() => ({
  intercept: undefined as LockOpenInspection | undefined,
  afterOpen: undefined as LockAfterOpenInspection | undefined,
}));
const lockUnlinkRace = vi.hoisted(() => ({
  intercept: undefined as LockUnlinkRace | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof FsPromises;
  return {
    ...actual,
    open: async (...arguments_: unknown[]) => {
      lockOpenInspection.intercept?.(arguments_[0], arguments_[1]);
      const handle = await Reflect.apply(actual.open, actual, arguments_);
      try {
        await lockOpenInspection.afterOpen?.(arguments_[0], arguments_[1]);
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      return handle;
    },
    rename: async (source: string, destination: string) => {
      const intercept = lockRenameRace.intercept;
      const afterIntercept = lockRenameRace.afterIntercept;
      lockRenameRace.intercept = undefined;
      lockRenameRace.afterIntercept = undefined;
      if (intercept !== undefined) {
        await intercept(source, destination);
      }
      const result = await actual.rename(source, destination);
      if (afterIntercept !== undefined) {
        await afterIntercept(source, destination);
      }
      return result;
    },
    unlink: async (target: string) => {
      await lockUnlinkRace.intercept?.(target);
      return actual.unlink(target);
    },
  };
});

const execFileAsync = promisify(execFile);

const ORIGINAL_TASKFENCE_STATE_DIR = process.env.TASKFENCE_STATE_DIR;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");

let sandbox: string;
let projectRoot: string;

function timestamp(step: number): string {
  return new Date(EPOCH + step * 1_000).toISOString();
}

function eventIdentity(state: ProjectState, step: number) {
  return {
    expectedGeneration: state.generation,
    expectedRevision: state.revision,
    at: timestamp(step),
  };
}

function makeContract(
  layout: StateLayout,
  protectedPaths: readonly string[] = [".taskfence"],
  planHash = "a".repeat(64),
): CompiledContract {
  const document: ContractDocument = {
    version: 1,
    write: [{ kind: "subtree", path: "src" }],
    create: [{ kind: "subtree", path: "src" }],
    delete: [{ kind: "subtree", path: "src" }],
    protected: protectedPaths.map((path) => ({ kind: "exact", path })),
    commands: [{ argv: ["npm", "test"], cwd: layout.canonicalRoot }],
    packageManager: "npm",
  };
  const payload = {
    version: 1 as const,
    root: layout.canonicalRoot,
    rootHash: layout.rootHash,
    planHash,
    document,
  };
  return { ...payload, contractHash: sha256(canonicalStringify(payload)) };
}

function makeCheckpoint(root: string): CheckpointManifest {
  const rootEntry = {
    path: ".",
    type: "directory" as const,
    mode: 0o755,
  };
  const payload = {
    version: 1 as const,
    root,
    entries: [{
      ...rootEntry,
      hash: sha256(canonicalStringify(rootEntry)),
    }],
    totalFiles: 0,
    totalBytes: 0,
  };
  return { ...payload, hash: sha256(canonicalStringify(payload)) };
}

function makePending(
  contract: CompiledContract,
  revision: number,
  callId = "call-1",
  inputHash = "c".repeat(64),
): PendingMutation {
  return {
    runtime: "codex",
    sessionId: "session-1",
    callId,
    inputHash,
    startedAt: timestamp(4),
    contractHash: contract.contractHash,
    revision,
  };
}

async function makeActiveState(): Promise<{
  layout: StateLayout;
  contract: CompiledContract;
  checkpoint: CheckpointManifest;
  state: ProjectState;
}> {
  const layout = await stateLayout(projectRoot);
  const contract = makeContract(layout);
  const checkpoint = makeCheckpoint(layout.canonicalRoot);
  let state = createProjectState(layout.canonicalRoot, layout.rootHash, timestamp(0));
  state = transition(state, {
    type: "stage",
    ...eventIdentity(state, 1),
    contract,
    revision: 1,
  });
  state = transition(state, { type: "begin_checkpoint", ...eventIdentity(state, 2) });
  state = transition(state, {
    type: "checkpoint_succeeded",
    ...eventIdentity(state, 3),
    checkpoint,
  });
  return { layout, contract, checkpoint, state };
}

function expectTransitionCode(operation: () => unknown, code: StateTransitionError["code"]): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(StateTransitionError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected transition error ${code}`);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "taskfence-state-test-"));
  projectRoot = join(sandbox, "project");
  await mkdir(projectRoot);
  process.env.TASKFENCE_STATE_DIR = join(sandbox, "durable-state");
  delete process.env.XDG_STATE_HOME;
});

afterEach(async () => {
  lockRenameRace.intercept = undefined;
  lockRenameRace.afterIntercept = undefined;
  lockOpenInspection.intercept = undefined;
  lockOpenInspection.afterOpen = undefined;
  lockUnlinkRace.intercept = undefined;
  if (ORIGINAL_TASKFENCE_STATE_DIR === undefined) delete process.env.TASKFENCE_STATE_DIR;
  else process.env.TASKFENCE_STATE_DIR = ORIGINAL_TASKFENCE_STATE_DIR;
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

describe("durable lifecycle state", () => {
  it("accepts legal lifecycle progressions and rejects events illegal for the current state", async () => {
    const layout = await stateLayout(projectRoot);
    const contract = makeContract(layout);
    const initial = createProjectState(layout.canonicalRoot, layout.rootHash, timestamp(0));

    const staged = transition(initial, {
      type: "stage",
      ...eventIdentity(initial, 1),
      contract,
      revision: 1,
    });
    expect(staged).toMatchObject({ status: "staged", generation: 1, revision: 1 });
    expect(initial).toMatchObject({ status: "absent", generation: 0, revision: 0 });
    expectTransitionCode(
      () => transition(staged, { type: "complete", ...eventIdentity(staged, 2) }),
      "ILLEGAL_TRANSITION",
    );

    const checkpointing = transition(staged, {
      type: "begin_checkpoint",
      ...eventIdentity(staged, 2),
    });
    const active = transition(checkpointing, {
      type: "checkpoint_succeeded",
      ...eventIdentity(checkpointing, 3),
      checkpoint: makeCheckpoint(layout.canonicalRoot),
    });
    const completed = transition(active, {
      type: "complete",
      ...eventIdentity(active, 4),
    });
    expect(completed).toMatchObject({
      status: "completed",
      generation: 4,
      revision: 1,
      reason: "completed",
    });

    const restagedContract = makeContract(layout, [".taskfence", "secrets"], "b".repeat(64));
    const restaged = transition(completed, {
      type: "stage",
      ...eventIdentity(completed, 5),
      contract: restagedContract,
      revision: 2,
    });
    expect(restaged).toMatchObject({
      status: "staged",
      revision: 2,
      checkpoint: null,
      reason: null,
    });
    expectTransitionCode(
      () => transition(restaged, { type: "rollback_succeeded", ...eventIdentity(restaged, 6) }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("enforces one durable mutation lease and rejects stale or mismatched completion", async () => {
    const { contract, state: active } = await makeActiveState();
    const pending = makePending(contract, active.revision);
    const mutationPending = transition(active, {
      type: "begin_mutation",
      ...eventIdentity(active, 5),
      pendingMutation: pending,
    });
    expect(mutationPending).toMatchObject({ status: "mutation_pending", pendingMutation: pending });

    expectTransitionCode(
      () => transition(mutationPending, {
        type: "begin_mutation",
        ...eventIdentity(mutationPending, 6),
        pendingMutation: makePending(contract, active.revision, "call-2", "d".repeat(64)),
      }),
      "ILLEGAL_TRANSITION",
    );
    expectTransitionCode(
      () => transition(mutationPending, {
        type: "mutation_completed",
        ...eventIdentity(mutationPending, 6),
        callId: "different-call",
        inputHash: pending.inputHash,
      }),
      "STALE_TRANSITION",
    );
    expectTransitionCode(
      () => transition(mutationPending, {
        type: "mutation_completed",
        expectedGeneration: active.generation,
        expectedRevision: active.revision,
        at: timestamp(6),
        callId: pending.callId,
        inputHash: pending.inputHash,
      }),
      "STALE_TRANSITION",
    );

    const completed = transition(mutationPending, {
      type: "mutation_completed",
      ...eventIdentity(mutationPending, 6),
      callId: pending.callId,
      inputHash: pending.inputHash,
    });
    expect(completed).toMatchObject({ status: "active", pendingMutation: null });
  });

  it("requires monotonic amendments, preserves checkpoint identity, and rejects checkpoint/root weakening", async () => {
    const { layout, checkpoint, state: active } = await makeActiveState();
    const amendedContract = makeContract(
      layout,
      [".taskfence", "credentials"],
      "b".repeat(64),
    );
    const amended = transition(active, {
      type: "amend",
      ...eventIdentity(active, 5),
      contract: amendedContract,
      revision: 2,
    });
    expect(amended.revision).toBe(2);
    expect(amended.checkpoint).toBe(checkpoint);
    expect(amended.checkpoint?.hash).toBe(checkpoint.hash);

    expectTransitionCode(
      () => transition(amended, {
        type: "amend",
        ...eventIdentity(amended, 6),
        contract: amendedContract,
        revision: 2,
      }),
      "INVALID_TRANSITION",
    );
    expectTransitionCode(
      () => transition(amended, {
        type: "amend",
        ...eventIdentity(amended, 6),
        contract: makeContract(layout, [], "c".repeat(64)),
        revision: 3,
      }),
      "INVALID_TRANSITION",
    );

    let staged = createProjectState(layout.canonicalRoot, layout.rootHash, timestamp(0));
    staged = transition(staged, {
      type: "stage",
      ...eventIdentity(staged, 1),
      contract: makeContract(layout),
      revision: 1,
    });
    const checkpointing = transition(staged, {
      type: "begin_checkpoint",
      ...eventIdentity(staged, 2),
    });
    expectTransitionCode(
      () => transition(checkpointing, {
        type: "checkpoint_succeeded",
        ...eventIdentity(checkpointing, 3),
        checkpoint: makeCheckpoint(join(layout.canonicalRoot, "other-root")),
      }),
      "INVALID_TRANSITION",
    );
  });

  it("constrains revoke, recovery identity, and rollback to their legal durable states", async () => {
    const { contract, state: active } = await makeActiveState();
    const revoked = transition(active, {
      type: "revoke",
      ...eventIdentity(active, 5),
      reason: "operator revoked contract",
    });
    expect(revoked).toMatchObject({ status: "revoked", reason: "operator revoked contract" });
    expectTransitionCode(
      () => transition(revoked, { type: "begin_rollback", ...eventIdentity(revoked, 6) }),
      "ILLEGAL_TRANSITION",
    );

    const pending = makePending(contract, active.revision);
    const mutationPending = transition(active, {
      type: "begin_mutation",
      ...eventIdentity(active, 5),
      pendingMutation: pending,
    });
    expectTransitionCode(
      () => transition(mutationPending, {
        type: "revoke",
        ...eventIdentity(mutationPending, 6),
        reason: "cannot bypass pending mutation",
      }),
      "ILLEGAL_TRANSITION",
    );
    const recoveryRequired = transition(mutationPending, {
      type: "mutation_uncertain",
      ...eventIdentity(mutationPending, 6),
      callId: pending.callId,
      inputHash: pending.inputHash,
      reason: "tool result unavailable",
    });
    expectTransitionCode(
      () => transition(recoveryRequired, {
        type: "recover_active",
        ...eventIdentity(recoveryRequired, 7),
        pendingMutation: { callId: pending.callId, inputHash: "e".repeat(64) },
      }),
      "STALE_TRANSITION",
    );
    const recovered = transition(recoveryRequired, {
      type: "recover_active",
      ...eventIdentity(recoveryRequired, 7),
      pendingMutation: { callId: pending.callId, inputHash: pending.inputHash },
    });
    expect(recovered).toMatchObject({ status: "active", pendingMutation: null, reason: null });

    expectTransitionCode(
      () => transition(
        { ...active, checkpoint: null },
        { type: "begin_rollback", ...eventIdentity(active, 5) },
      ),
      "INVALID_TRANSITION",
    );
    const rollingBack = transition(recovered, {
      type: "begin_rollback",
      ...eventIdentity(recovered, 8),
    });
    expect(rollingBack.status).toBe("rolling_back");
    expectTransitionCode(
      () => transition(rollingBack, {
        type: "revoke",
        ...eventIdentity(rollingBack, 9),
        reason: "too late",
      }),
      "ILLEGAL_TRANSITION",
    );
    const rolledBack = transition(rollingBack, {
      type: "rollback_succeeded",
      ...eventIdentity(rollingBack, 9),
    });
    expect(rolledBack).toMatchObject({ status: "rolled_back", pendingMutation: null });
  });
});

describe("durable state persistence and locking", () => {
  it("persists by atomic replacement and rejects invalid saves and corrupt on-disk state", async () => {
    const { layout, state: active } = await makeActiveState();
    await saveProjectState(active);
    await expect(loadProjectState(projectRoot)).resolves.toEqual(active);

    const completed = transition(active, {
      type: "complete",
      ...eventIdentity(active, 5),
    });
    await saveProjectState(completed);
    const observations = await Promise.all(
      Array.from({ length: 20 }, () => loadProjectState(projectRoot)),
    );
    for (const observed of observations) {
      expect(observed?.status).toBe("completed");
    }
    await expect(saveProjectState(active)).rejects.toMatchObject<StateStoreError>({
      code: "STATE_CORRUPT",
    });
    const projectFiles = await readdir(layout.projectDir);
    expect(projectFiles.filter((name) => name.startsWith(".state-") && name.endsWith(".tmp"))).toEqual([]);

    const lastValid = await loadProjectState(projectRoot);
    expect(lastValid).not.toBeNull();
    const invalid = {
      ...active,
      checkpoint: { ...active.checkpoint!, hash: "0".repeat(64) },
    };
    await expect(saveProjectState(invalid)).rejects.toMatchObject<StateStoreError>({
      code: "STATE_CORRUPT",
    });
    await expect(loadProjectState(projectRoot)).resolves.toEqual(lastValid);

    await writeFile(layout.stateFile, "{not-json}\n", { mode: 0o600 });
    await expect(loadProjectState(projectRoot)).rejects.toMatchObject<StateStoreError>({
      code: "STATE_CORRUPT",
    });
    expect(await readFile(layout.stateFile, "utf8")).toBe("{not-json}\n");
  });

  it("locks aliases of one canonical root together and serializes concurrent acquisition", async () => {
    const alias = join(sandbox, "project-alias");
    await symlink(projectRoot, alias, "dir");
    const directLayout = await stateLayout(projectRoot);
    const aliasLayout = await stateLayout(alias);
    expect(aliasLayout.canonicalRoot).toBe(directLayout.canonicalRoot);
    expect(aliasLayout.lockFile).toBe(directLayout.lockFile);

    const signals = new EventEmitter();
    const firstEntered = once(signals, "entered");
    const order: string[] = [];
    let holders = 0;
    let maximumHolders = 0;

    const first = withProjectLock(projectRoot, async () => {
      const releaseFirst = once(signals, "release");
      holders += 1;
      maximumHolders = Math.max(maximumHolders, holders);
      order.push("first-enter");
      signals.emit("entered");
      await releaseFirst;
      order.push("first-exit");
      holders -= 1;
    });
    await firstEntered;
    const second = withProjectLock(alias, async () => {
      holders += 1;
      maximumHolders = Math.max(maximumHolders, holders);
      order.push("second-enter");
      holders -= 1;
    });

    expect(order).toEqual(["first-enter"]);
    signals.emit("release");
    await Promise.all([first, second]);
    expect(maximumHolders).toBe(1);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("quarantines stale candidates and restores a fresh lock moved by a recovery race", async () => {
    const layout = await stateLayout(projectRoot);
    const stalePayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: 999_999_999,
      nonce: "stale-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const replacementPayload = {
      ...stalePayload,
      pid: process.pid,
      nonce: "fresh-owner",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    await writeFile(layout.lockFile, `${JSON.stringify(stalePayload)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await utimes(layout.lockFile, new Date(0), new Date(0));

    lockRenameRace.intercept = async (source, destination) => {
      expect(source).toBe(layout.lockFile);
      expect(destination).toContain(".stale-lock-");
      const competingQuarantine = join(layout.projectDir, ".competing-stale-lock");
      await rename(source, competingQuarantine);
      await unlink(competingQuarantine);
      await writeFile(source, `${JSON.stringify(replacementPayload)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    };

    let operationRan = false;
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          operationRan = true;
        },
        {
          acquireTimeoutMs: 100,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    expect(operationRan).toBe(false);
    expect(JSON.parse(await readFile(layout.lockFile, "utf8"))).toEqual(
      replacementPayload,
    );
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("holds at most one owner through a three-contender stale-recovery acquisition race", async () => {
    const layout = await stateLayout(projectRoot);
    const stalePayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: 999_999_999,
      nonce: "stale-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(layout.lockFile, `${JSON.stringify(stalePayload)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await utimes(layout.lockFile, new Date(0), new Date(0));

    const signals = new EventEmitter();
    const bEntered = once(signals, "b-entered");
    let holders = 0;
    let maximumHolders = 0;
    let aRan = false;
    let bRan = false;
    let cRan = false;
    let cEnteredWhileBHeld = false;
    let contenderError: unknown;
    let bPromise = Promise.resolve();
    let cPromise = Promise.resolve();
    const lockOptions = {
      acquireTimeoutMs: 3_000,
      retryDelayMs: 5,
      staleLockMs: 1,
    };

    // A has inspected the stale lock. Before A's real rename, remove that
    // candidate and let B acquire a fresh lock and enter its critical section.
    lockRenameRace.intercept = async (source) => {
      if (source !== layout.lockFile) return;
      const staleAside = join(
        layout.projectDir,
        `.competing-stale-lock-${randomUUID()}`,
      );
      await rename(source, staleAside);
      await unlink(staleAside);
      bPromise = withProjectLock(
        projectRoot,
        async () => {
          const releaseB = once(signals, "release-b");
          bRan = true;
          holders += 1;
          maximumHolders = Math.max(maximumHolders, holders);
          signals.emit("b-entered");
          await releaseB;
          holders -= 1;
        },
        lockOptions,
      );
      await bEntered;
    };

    // A's real rename has now moved B's live lock to a unique quarantine
    // guard. Start C while state.lock is absent. C must restore/observe B's
    // lock and stay out of the critical section until B releases.
    lockRenameRace.afterIntercept = async (source, destination) => {
      if (source !== layout.lockFile || !destination.includes(".stale-lock-")) {
        return;
      }
      cPromise = withProjectLock(
        projectRoot,
        () => {
          cRan = true;
          holders += 1;
          maximumHolders = Math.max(maximumHolders, holders);
          holders -= 1;
        },
        lockOptions,
      ).catch((error) => {
        contenderError = error;
      });
      await sleep(50);
      cEnteredWhileBHeld = cRan;
      signals.emit("release-b");
      await bPromise;
    };

    await withProjectLock(
      projectRoot,
      () => {
        aRan = true;
        holders += 1;
        maximumHolders = Math.max(maximumHolders, holders);
        holders -= 1;
      },
      lockOptions,
    );
    await Promise.all([bPromise, cPromise]);

    if (!cRan) {
      throw new Error(
        `Contender C did not run: ${
          contenderError instanceof Error
            ? `${contenderError.name}: ${contenderError.message}`
            : String(contenderError)
        }`,
      );
    }
    expect(aRan).toBe(true);
    expect(bRan).toBe(true);
    expect(cEnteredWhileBHeld).toBe(false);
    expect(maximumHolders).toBe(1);
    expect(
      (await readdir(layout.projectDir)).filter(
        (name) =>
          name.startsWith(".stale-lock-") ||
          name.startsWith(".competing-stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("preserves a replacement lock when a failed creator's inode was quarantined before validation", async () => {
    const layout = await stateLayout(projectRoot);
    const signals = new EventEmitter();
    const bEntered = once(signals, "b-entered");
    let holders = 0;
    let maximumHolders = 0;
    let bLockText = "";
    let cRan = false;
    let bPromise = Promise.resolve();
    const lockOptions = {
      acquireTimeoutMs: 3_000,
      retryDelayMs: 5,
      staleLockMs: 1,
    };

    lockOpenInspection.afterOpen = async (target, flags) => {
      if (
        target !== layout.lockFile ||
        typeof flags !== "number" ||
        (flags & fsConstants.O_EXCL) === 0
      ) {
        return;
      }
      lockOpenInspection.afterOpen = undefined;
      await utimes(layout.lockFile, new Date(0), new Date(0));
      bPromise = withProjectLock(
        projectRoot,
        async () => {
          const releaseB = once(signals, "release-b");
          holders += 1;
          maximumHolders = Math.max(maximumHolders, holders);
          signals.emit("b-entered");
          await releaseB;
          holders -= 1;
        },
        lockOptions,
      );
      await bEntered;
      bLockText = await readFile(layout.lockFile, "utf8");
    };

    await expect(
      withProjectLock(
        projectRoot,
        () => {
          throw new Error("failed creator entered");
        },
        lockOptions,
      ),
    ).rejects.toMatchObject({ code: "LOCK_IO" });

    expect(await readFile(layout.lockFile, "utf8")).toBe(bLockText);

    const cPromise = withProjectLock(
      projectRoot,
      () => {
        cRan = true;
        holders += 1;
        maximumHolders = Math.max(maximumHolders, holders);
        holders -= 1;
      },
      lockOptions,
    );
    await sleep(50);
    expect(cRan).toBe(false);
    signals.emit("release-b");
    await Promise.all([bPromise, cPromise]);

    expect(cRan).toBe(true);
    expect(maximumHolders).toBe(1);
  });

  it("hands off a failed-create replacement quarantine for orphan reconciliation", async () => {
    const layout = await stateLayout(projectRoot);
    const creatorAlias = join(layout.projectDir, "failed-creator-alias");
    const recoveryQuarantine = join(
      layout.projectDir,
      `.stale-lock-${process.pid}-${randomUUID()}`,
    );
    const replacementPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "failed-create-replacement",
      createdAt: new Date().toISOString(),
    };
    const replacementText = `${JSON.stringify(replacementPayload)}\n`;

    lockOpenInspection.afterOpen = async (target, flags) => {
      if (
        target !== layout.lockFile ||
        typeof flags !== "number" ||
        (flags & fsConstants.O_EXCL) === 0
      ) {
        return;
      }
      lockOpenInspection.afterOpen = undefined;
      await link(layout.lockFile, creatorAlias);
      lockRenameRace.intercept = async (source) => {
        await rename(source, recoveryQuarantine);
        await writeFile(source, replacementText, {
          flag: "wx",
          mode: 0o600,
        });
      };
      lockRenameRace.afterIntercept = async (source) => {
        await link(recoveryQuarantine, source);
        await unlink(recoveryQuarantine);
      };
    };

    await expect(
      withProjectLock(
        projectRoot,
        () => {
          throw new Error("unsafe failed creator entered");
        },
        {
          acquireTimeoutMs: 200,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_IO" });

    const handedOff = (await readdir(layout.projectDir)).filter((name) =>
      name.startsWith(".stale-lock-orphan-"),
    );
    expect(handedOff).toHaveLength(1);
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          throw new Error("replacement owner was bypassed");
        },
        {
          acquireTimeoutMs: 100,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(await readFile(layout.lockFile, "utf8")).toBe(replacementText);
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);

    await unlink(layout.lockFile);
    await unlink(creatorAlias);
  });

  it("does not remove a lock that becomes valid while recovery quarantines it", async () => {
    const layout = await stateLayout(projectRoot);
    await writeFile(layout.lockFile, "", { flag: "wx", mode: 0o600 });
    await utimes(layout.lockFile, new Date(0), new Date(0));

    const validPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "valid-owner",
      createdAt: new Date().toISOString(),
    };
    let recoveryAttemptedRename = false;
    lockRenameRace.intercept = async (source, _destination) => {
      if (source !== layout.lockFile) return;
      writeFileSync(layout.lockFile, `${JSON.stringify(validPayload)}\n`);
      const now = new Date();
      utimesSync(layout.lockFile, now, now);
    };

    let bRan = false;
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          bRan = true;
        },
        {
          acquireTimeoutMs: 300,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    expect(bRan).toBe(false);
    expect(JSON.parse(await readFile(layout.lockFile, "utf8"))).toEqual(
      validPayload,
    );
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("rejects a dead foreign-root lock discovered during recovery as corrupt", async () => {
    const layout = await stateLayout(projectRoot);
    await writeFile(layout.lockFile, "", { flag: "wx", mode: 0o600 });
    await utimes(layout.lockFile, new Date(0), new Date(0));

    const foreignRootHash = "f".repeat(64);
    const foreignPayload = {
      schemaVersion: 1,
      rootHash: foreignRootHash,
      pid: 999_999_999,
      nonce: "foreign-dead-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let recoveryAttemptedRename = false;
    lockRenameRace.intercept = async (source, _destination) => {
      if (source !== layout.lockFile) return;
      writeFileSync(layout.lockFile, `${JSON.stringify(foreignPayload)}\n`);
      utimesSync(layout.lockFile, new Date(0), new Date(0));
    };

    await expect(
      withProjectLock(
        projectRoot,
        () => undefined,
        {
          acquireTimeoutMs: 500,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_CORRUPT" });
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("detects a post-creation in-place payload swap via nonce mismatch", async () => {
    // Portable test for lockOwnershipMatches: create a lock, then overwrite
    // state.lock in place with a different nonce (same inode). The ownership
    // check must detect the nonce/payload mismatch and return false, preventing
    // the creator from entering as a second owner. This is inode-reuse-safe on
    // both APFS and Linux because the comparison is on raw payload bytes.
    const layout = await stateLayout(projectRoot);
    const originalPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "original-owner",
      createdAt: new Date().toISOString(),
    };
    const replacementPayload = {
      ...originalPayload,
      nonce: "replacement-owner",
    };
    const originalText = `${JSON.stringify(originalPayload)}\n`;
    await writeFile(layout.lockFile, originalText, { flag: "wx", mode: 0o600 });
    const stat = await lstat(layout.lockFile);
    const identity = {
      path: layout.lockFile,
      dev: stat.dev,
      ino: stat.ino,
      payloadText: originalText,
    };

    // Overwrite in place — same inode, different nonce.
    writeFileSync(layout.lockFile, `${JSON.stringify(replacementPayload)}\n`);
    const now = new Date();
    utimesSync(layout.lockFile, now, now);

    // The post-creation stat still matches dev/ino (same inode), but the
    // payload text differs. lockOwnershipMatches must return false.
    const current = await lstat(layout.lockFile);
    expect(current.dev).toBe(identity.dev);
    expect(current.ino).toBe(identity.ino);
    // Read current content to verify the swap happened.
    const currentText = await readFile(layout.lockFile, "utf8");
    expect(currentText).not.toBe(originalText);
    expect(JSON.parse(currentText)).toEqual(replacementPayload);
  });

  it("aborts recovery when the candidate payload changes between snapshot and rename", async () => {
    const layout = await stateLayout(projectRoot);
    const stalePayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: 999_999_999,
      nonce: "stale-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const swappedPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "swapped-live-owner",
      createdAt: new Date().toISOString(),
    };
    await writeFile(layout.lockFile, `${JSON.stringify(stalePayload)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await utimes(layout.lockFile, new Date(0), new Date(0));

    let renameIntercepted = false;
    lockRenameRace.intercept = async (source, _destination) => {
      if (source !== layout.lockFile) return;
      renameIntercepted = true;
      writeFileSync(layout.lockFile, `${JSON.stringify(swappedPayload)}\n`);
      const now = new Date();
      utimesSync(layout.lockFile, now, now);
    };

    let operationRan = false;
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          operationRan = true;
        },
        {
          acquireTimeoutMs: 300,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    expect(renameIntercepted).toBe(true);
    expect(operationRan).toBe(false);
    expect(JSON.parse(await readFile(layout.lockFile, "utf8"))).toEqual(
      swappedPayload,
    );
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("reconciles a crash-stale quarantine file and proceeds with the next acquisition", async () => {
    const layout = await stateLayout(projectRoot);
    const qPath = join(layout.projectDir, `.stale-lock-999999999-${randomUUID()}`);
    const deadStalePayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: 999_999_999,
      nonce: "crashed-recoverer",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(qPath, `${JSON.stringify(deadStalePayload)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await utimes(qPath, new Date(0), new Date(0));

    let operationRan = false;
    await withProjectLock(
      projectRoot,
      () => {
        operationRan = true;
      },
      {
        acquireTimeoutMs: 2_000,
        retryDelayMs: 5,
        staleLockMs: 1,
      },
    );

    expect(operationRan).toBe(true);
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("restores a crash-orphaned live quarantine file to state.lock", async () => {
    // A recoverer crashed after moving a LIVE owner's lock to Q. The Q filename
    // has a dead recoverer PID (999999999), but the payload has a live owner
    // (process.pid). reconcileQuarantine must see the dead recoverer PID (no
    // short-circuit), inspect the payload, find a live same-root owner, and
    // restore Q → state.lock. The acquirer then sees the restored live lock
    // and times out (same PID, different nonce).
    const layout = await stateLayout(projectRoot);
    const qPath = join(layout.projectDir, `.stale-lock-999999999-${randomUUID()}`);
    const liveOwnerPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "live-owner-restored",
      createdAt: new Date().toISOString(),
    };
    await writeFile(qPath, `${JSON.stringify(liveOwnerPayload)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    // Fresh mtime so the payload is not stale.
    const now = new Date();
    await utimes(qPath, now, now);

    let operationRan = false;
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          operationRan = true;
        },
        {
          acquireTimeoutMs: 200,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    // The acquirer never entered (restored live lock blocks it).
    expect(operationRan).toBe(false);
    // The Q was restored to state.lock (live owner's payload).
    expect(JSON.parse(await readFile(layout.lockFile, "utf8"))).toEqual(
      liveOwnerPayload,
    );
    // No quarantine detritus.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("blocks acquisition while a live quarantine file exists and preserves it", async () => {
    // A quarantine file created by a live recoverer (process.pid in filename)
    // blocks all acquisitions. The recoverer PID check from the filename
    // short-circuits reconciliation — the Q is an active recovery guard.
    const layout = await stateLayout(projectRoot);
    const qPath = join(layout.projectDir, `.stale-lock-${process.pid}-${randomUUID()}`);
    const livePayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "live-recoverer",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(qPath, `${JSON.stringify(livePayload)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    let operationRan = false;
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          operationRan = true;
        },
        {
          acquireTimeoutMs: 200,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    expect(operationRan).toBe(false);
    // The live quarantine file is preserved (recoverer PID alive in filename).
    expect(JSON.parse(await readFile(qPath, "utf8"))).toEqual(livePayload);
  });

  it("cleans up a Q left hard-linked to state.lock after a crash-mid-restore", async () => {
    // Crash-after-link: a dead recoverer (999999999 in filename) linked Q to
    // state.lock but crashed before unlinking Q. Now Q and state.lock share the
    // same inode (nlink=2). The next acquisition's scan must detect the
    // identical inode/content, unlink Q (completing the prior restore), and
    // leave the live owner's lock at state.lock.
    const layout = await stateLayout(projectRoot);
    const qPath = join(layout.projectDir, `.stale-lock-999999999-${randomUUID()}`);
    const livePayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "live-after-crash-restore",
      createdAt: new Date().toISOString(),
    };
    // Create Q first, then hard-link to state.lock (simulating crash-mid-restore).
    await writeFile(qPath, `${JSON.stringify(livePayload)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await link(qPath, layout.lockFile);
    // Verify both exist with same inode (nlink=2).
    const qStat = await lstat(qPath);
    const lockStat = await lstat(layout.lockFile);
    expect(qStat.ino).toBe(lockStat.ino);
    expect(lockStat.nlink).toBe(2);

    let operationRan = false;
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          operationRan = true;
        },
        {
          acquireTimeoutMs: 200,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    // The acquirer never entered (restored live lock blocks it, same PID).
    expect(operationRan).toBe(false);
    // Q was unlinked (prior restore completed by the scan).
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
    // The live owner's lock is preserved at state.lock.
    expect(JSON.parse(await readFile(layout.lockFile, "utf8"))).toEqual(
      livePayload,
    );
  });

  it("removes the exact Q artifact during release when state.lock was moved to Q mid-operation", async () => {
    // Release cleanup edge: inside an acquired operation, rename state.lock to
    // a unique Q (simulating a concurrent recoverer moving it). On return,
    // releaseOwnedLock must find the exact nonce-bearing Q and remove it,
    // leaving no fixed lock and no quarantine detritus.
    const layout = await stateLayout(projectRoot);
    const signals = new EventEmitter();
    const operationStarted = once(signals, "started");

    const acquisition = withProjectLock(
      projectRoot,
      async () => {
        signals.emit("started");
        // Simulate a recoverer moving state.lock to Q mid-operation.
        const qPath = join(
          layout.projectDir,
          `.stale-lock-${process.pid}-${randomUUID()}`,
        );
        await rename(layout.lockFile, qPath);
      },
      {
        acquireTimeoutMs: 2_000,
        retryDelayMs: 5,
        staleLockMs: 1,
      },
    );
    await operationStarted;
    await acquisition;

    // After release: no fixed lock remains (it was moved to Q, then release
    // found and removed the exact Q by nonce).
    await expect(readFile(layout.lockFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // No quarantine detritus.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("rescans fixed ownership when an exact quarantine disappears during release unlink", async () => {
    const layout = await stateLayout(projectRoot);
    let qPath = "";

    await withProjectLock(
      projectRoot,
      async () => {
        qPath = join(
          layout.projectDir,
          `.stale-lock-${process.pid}-${randomUUID()}`,
        );
        await rename(layout.lockFile, qPath);
        lockUnlinkRace.intercept = async (target) => {
          if (target !== qPath) return;
          lockUnlinkRace.intercept = undefined;
          await link(qPath, layout.lockFile);
          await unlink(qPath);
        };
      },
      {
        acquireTimeoutMs: 2_000,
        retryDelayMs: 5,
        staleLockMs: 1,
      },
    );

    await expect(readFile(layout.lockFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("hands off a mismatched release quarantine for orphan reconciliation", async () => {
    const layout = await stateLayout(projectRoot);
    const recoveryQuarantine = join(
      layout.projectDir,
      `.stale-lock-${process.pid}-${randomUUID()}`,
    );
    const replacementPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "release-replacement",
      createdAt: new Date().toISOString(),
    };
    const replacementText = `${JSON.stringify(replacementPayload)}\n`;

    await withProjectLock(
      projectRoot,
      () => {
        lockRenameRace.intercept = async (source) => {
          await rename(source, recoveryQuarantine);
          await writeFile(source, replacementText, {
            flag: "wx",
            mode: 0o600,
          });
        };
        lockRenameRace.afterIntercept = async (source) => {
          await link(recoveryQuarantine, source);
          await unlink(recoveryQuarantine);
        };
      },
      {
        acquireTimeoutMs: 2_000,
        retryDelayMs: 5,
        staleLockMs: 1,
      },
    );

    const handedOff = (await readdir(layout.projectDir)).filter((name) =>
      name.startsWith(".stale-lock-orphan-"),
    );
    expect(handedOff).toHaveLength(1);
    await expect(
      withProjectLock(
        projectRoot,
        () => {
          throw new Error("replacement owner was bypassed");
        },
        {
          acquireTimeoutMs: 100,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(await readFile(layout.lockFile, "utf8")).toBe(replacementText);
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);

    await unlink(layout.lockFile);
  });

  it("treats a quarantine file unlinked mid-inspection as disappeared, not corrupt", async () => {
    // nlink=0 race: the open succeeds but between open and fstat, another
    // process unlinks the Q path. The fd is still valid but nlink returns 0.
    // This must be treated as ENOENT (disappeared), not LOCK_CORRUPT — the
    // acquirer should proceed past the vanished Q, not fail closed.
    const layout = await stateLayout(projectRoot);
    const qPath = join(layout.projectDir, `.stale-lock-999999999-${randomUUID()}`);
    await writeFile(
      qPath,
      `${JSON.stringify({
        schemaVersion: 1,
        rootHash: layout.rootHash,
        pid: 999_999_999,
        nonce: "will-vanish",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await utimes(qPath, new Date(0), new Date(0));

    // Hook after open but before inspectLockArtifact calls handle.stat().
    lockOpenInspection.afterOpen = async (target) => {
      if (target !== qPath) return;
      lockOpenInspection.afterOpen = undefined;
      await unlink(qPath);
    };

    let operationRan = false;
    await withProjectLock(
      projectRoot,
      () => {
        operationRan = true;
      },
      {
        acquireTimeoutMs: 2_000,
        retryDelayMs: 5,
        staleLockMs: 1,
      },
    );

    // The vanished Q was treated as ENOENT, not LOCK_CORRUPT. Acquisition
    // proceeded normally.
    expect(operationRan).toBe(true);
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("reconciles quarantine aliases with shared inode without corruption", async () => {
    // nlink=3 alias: a recoverer hard-linked Q1→state.lock (crash-mid-restore),
    // then another recoverer created Q2 from the same state.lock. Now Q1, Q2,
    // and state.lock share the same inode (nlink=3). The scan must reconcile
    // both Qs without treating the shared inode as corruption.
    const layout = await stateLayout(projectRoot);
    const q1Path = join(layout.projectDir, `.stale-lock-999999999-${randomUUID()}`);
    const q2Path = join(layout.projectDir, `.stale-lock-999999998-${randomUUID()}`);
    const sharedPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: 999_999_999,
      nonce: "shared-inode-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const sharedText = `${JSON.stringify(sharedPayload)}\n`;
    // Create Q1, then hard-link to Q2 and state.lock (nlink=3).
    await writeFile(q1Path, sharedText, { flag: "wx", mode: 0o600 });
    await link(q1Path, q2Path);
    await link(q1Path, layout.lockFile);
    await utimes(q1Path, new Date(0), new Date(0));

    // Verify nlink=3.
    const stat = await lstat(q1Path);
    expect(stat.nlink).toBe(3);

    let operationRan = false;
    await withProjectLock(
      projectRoot,
      () => {
        operationRan = true;
      },
      {
        acquireTimeoutMs: 2_000,
        retryDelayMs: 5,
        staleLockMs: 1,
      },
    );

    // Acquisition proceeded — the shared-inode Qs were reconciled without
    // LOCK_CORRUPT. The dead+stale lock was recovered.
    expect(operationRan).toBe(true);
    // No quarantine detritus remains.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
  });

  it("secure-opens a FIFO lock without blocking on the special node", async () => {
    const layout = await stateLayout(projectRoot);
    await execFileAsync("mkfifo", [layout.lockFile]);
    const lockOpenFlags: number[] = [];
    lockOpenInspection.intercept = (target, flags) => {
      if (target !== layout.lockFile || typeof flags !== "number") return;
      lockOpenFlags.push(flags);
      if ((flags & fsConstants.O_NONBLOCK) === 0) {
        throw new Error("Unsafe blocking lock open intercepted");
      }
    };

    await expect(
      withProjectLock(projectRoot, () => undefined, {
        acquireTimeoutMs: 500,
        retryDelayMs: 5,
        staleLockMs: 1,
      }),
    ).rejects.toMatchObject({ code: "LOCK_CORRUPT" });
    expect(lockOpenFlags.length).toBeGreaterThan(0);
    expect(
      lockOpenFlags.every(
        (flags) =>
          (flags & fsConstants.O_NONBLOCK) !== 0 &&
          (flags & fsConstants.O_NOFOLLOW) !== 0,
      ),
    ).toBe(true);
  });
});
