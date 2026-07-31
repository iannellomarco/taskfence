import { execFile } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import {
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

const lockRenameRace = vi.hoisted(() => ({
  intercept: undefined as LockRenameRace | undefined,
}));

const lockOpenInspection = vi.hoisted(() => ({
  intercept: undefined as LockOpenInspection | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof FsPromises;
  return {
    ...actual,
    open: (...arguments_: unknown[]) => {
      lockOpenInspection.intercept?.(arguments_[0], arguments_[1]);
      return Reflect.apply(actual.open, actual, arguments_);
    },
    rename: async (source: string, destination: string) => {
      const intercept = lockRenameRace.intercept;
      lockRenameRace.intercept = undefined;
      if (intercept !== undefined) {
        await intercept(source, destination);
      }
      return actual.rename(source, destination);
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
  lockOpenInspection.intercept = undefined;
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
    // Regression for the stale-lock quarantine gap: with three legitimate
    // contenders, A could inspect a stale inode, B recover it and create a
    // fresh lock, A rename B's fresh lock into its quarantine (inode mismatch
    // with the stale candidate), and C acquire state.lock via O_EXCL while it
    // was absent — leaving B and C as concurrent protected owners. The durable
    // recovery marker must block C's acquisition for the entire quarantine
    // window and never let protected holders exceed one.
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
    const contenderEntered = once(signals, "contender-window");
    let holders = 0;
    let maximumHolders = 0;
    let contenderAcquired = false;
    let contenderRan = false;
    let contenderError: unknown = undefined;

    // Intercept A's quarantine rename: at the instant state.lock is moved into
    // the stale-lock quarantine (the gap), launch C as a concurrent acquirer.
    // Under the old protocol C would O_EXCL-create state.lock here; under the
    // marker protocol C must observe A's recovery marker and stay blocked.
    const contenderPromise = { current: Promise.resolve() as Promise<unknown> };
    lockRenameRace.intercept = async (source, destination) => {
      if (source !== layout.lockFile || !destination.includes(".stale-lock-")) {
        return;
      }
      // Move the candidate aside so the subsequent actual.rename(source,...)
      // hits ENOENT and A aborts this recovery attempt cleanly (matching the
      // two-contender race). state.lock is now absent — the vulnerability window.
      const competingQuarantine = join(layout.projectDir, ".competing-stale-lock");
      await rename(source, competingQuarantine);
      await unlink(competingQuarantine);
      // Signal and launch C during the window while A still holds its marker.
      signals.emit("contender-window");
      contenderPromise.current = withProjectLock(
        projectRoot,
        () => {
          contenderRan = true;
          holders += 1;
          maximumHolders = Math.max(maximumHolders, holders);
          holders -= 1;
        },
        {
          acquireTimeoutMs: 2_000,
          retryDelayMs: 5,
          staleLockMs: 1,
        },
      ).catch((error) => {
        contenderError = error;
      });
      // C must not acquire while A holds the marker. Give it a bounded chance.
      await sleep(50);
      contenderAcquired = contenderRan;
    };

    let ownerRan = false;
    await withProjectLock(
      projectRoot,
      async () => {
        // A's protected operation. If C acquired concurrently, holders would
        // reach 2 here.
        holders += 1;
        maximumHolders = Math.max(maximumHolders, holders);
        ownerRan = true;
        await sleep(20);
        holders -= 1;
      },
      {
        acquireTimeoutMs: 2_000,
        retryDelayMs: 5,
        staleLockMs: 1,
      },
    );

    await contenderEntered;
    expect(ownerRan).toBe(true);
    // C must NOT have entered its protected section while A held the lock.
    expect(contenderAcquired).toBe(false);
    // Wait for C to finish (it acquires only after A releases the lock).
    await contenderPromise.current;
    if (!contenderRan) {
      throw new Error(
        `Contender C did not run. contenderError=${JSON.stringify(
          contenderError instanceof Error
            ? { name: contenderError.name, message: contenderError.message, code: (contenderError as { code?: string }).code }
            : contenderError,
        )}`,
      );
    }
    // Maximum concurrent protected holders never exceeded one.
    expect(maximumHolders).toBe(1);
    // No quarantine detritus remains.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-") ||
        name.startsWith(".competing-stale-lock"),
      ),
    ).toEqual([]);
    // No recovery marker is stranded.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.endsWith(".lock.recover"),
      ),
    ).toEqual([]);
  });

  it("does not remove a lock that becomes valid while recovery acquires its marker", async () => {
    // Delayed-marker interleaving: A publishes an empty inode (createLockFile
    // opens the file before writing payload). B inspects it as payload=null /
    // stale. A then finishes writing+syncing a valid payload. B acquires the
    // recovery marker and must re-inspect the candidate's CURRENT payload,
    // mtime, and owner liveness under the marker — aborting recovery if the
    // lock is now valid/live, instead of removing A's lock based on stale
    // inode identity alone.
    const layout = await stateLayout(projectRoot);
    const markerPath = join(layout.projectDir, "state.lock.recover");

    // Simulate A's published-but-unwritten inode: empty file, stale mtime.
    await writeFile(layout.lockFile, "", { flag: "wx", mode: 0o600 });
    await utimes(layout.lockFile, new Date(0), new Date(0));

    // When B's recoverStaleLock acquires the marker (opens state.lock.recover
    // with O_EXCL), write A's valid payload with a fresh mtime — simulating A
    // finishing its write between B's initial inspection and B's marker
    // acquisition. Use process.pid so the owner appears live to B.
    const validPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "valid-owner",
      createdAt: new Date().toISOString(),
    };
    let recoveryAttemptedRename = false;
    let interceptFired = false;
    let interceptError: unknown = undefined;
    lockOpenInspection.intercept = (target, flags) => {
      // Fire only when acquireRecoveryMarker creates the marker (O_CREAT),
      // not when inspectRecoveryMarker reads it (O_RDONLY).
      if (target !== markerPath || typeof flags !== "number") return;
      if ((flags & fsConstants.O_CREAT) === 0) return;
      interceptFired = true;
      try {
        // A finishes writing its payload right as B acquires the marker.
        writeFileSync(layout.lockFile, `${JSON.stringify(validPayload)}\n`);
        const now = new Date();
        utimesSync(layout.lockFile, now, now);
      } catch (error) {
        interceptError = error;
      }
    };
    // If recovery incorrectly removes the lock, this rename fires.
    lockRenameRace.intercept = async (source, _destination) => {
      if (source === layout.lockFile) {
        recoveryAttemptedRename = true;
      }
    };

    // B attempts acquisition. It inspects the empty lock as stale and tries
    // recovery. Under the marker, it must re-inspect and find a valid, live
    // lock — aborting recovery rather than removing it. Since the lock owner
    // is the same live PID (B cannot distinguish its own process), B times
    // out waiting. The critical assertion is that B never removed A's lock.
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

    // B never entered its protected section.
    expect(bRan).toBe(false);
    // The intercept fired during marker acquisition (proving B reached recovery).
    expect(interceptFired).toBe(true);
    expect(interceptError).toBeUndefined();
    // Recovery did NOT rename/remove the now-valid lock.
    expect(recoveryAttemptedRename).toBe(false);
    expect(JSON.parse(await readFile(layout.lockFile, "utf8"))).toEqual(
      validPayload,
    );
    // No quarantine detritus from an incorrect removal.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
    // No recovery marker is stranded.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.endsWith(".lock.recover"),
      ),
    ).toEqual([]);
  });

  it("rejects a dead foreign-root lock discovered under the marker as corrupt", async () => {
    // The initial inspection may see an empty file (null payload) that passes
    // the root-binding check trivially. Under the marker, the re-inspection
    // reads a non-null payload bound to a DIFFERENT canonical root with a dead
    // owner. This must fail closed as LOCK_CORRUPT, not be treated as a
    // recoverable stale lock.
    const layout = await stateLayout(projectRoot);
    const markerPath = join(layout.projectDir, "state.lock.recover");

    // Simulate a published-but-unwritten inode: empty file, stale mtime.
    await writeFile(layout.lockFile, "", { flag: "wx", mode: 0o600 });
    await utimes(layout.lockFile, new Date(0), new Date(0));

    // A foreign-root payload with a dead owner, written at marker acquisition.
    const foreignRootHash = "f".repeat(64);
    const foreignPayload = {
      schemaVersion: 1,
      rootHash: foreignRootHash,
      pid: 999_999_999,
      nonce: "foreign-dead-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let recoveryAttemptedRename = false;
    lockOpenInspection.intercept = (target, flags) => {
      if (target !== markerPath || typeof flags !== "number") return;
      if ((flags & fsConstants.O_CREAT) === 0) return;
      writeFileSync(layout.lockFile, `${JSON.stringify(foreignPayload)}\n`);
      utimesSync(layout.lockFile, new Date(0), new Date(0));
    };
    lockRenameRace.intercept = async (source, _destination) => {
      if (source === layout.lockFile) {
        recoveryAttemptedRename = true;
      }
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

    // Recovery did NOT rename/remove the foreign-root lock.
    expect(recoveryAttemptedRename).toBe(false);
    // No recovery marker is stranded.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.endsWith(".lock.recover"),
      ),
    ).toEqual([]);
  });

  it("retries instead of entering when the just-created lock inode is replaced post-creation", async () => {
    // Creator-side identity recheck: after createLockFile succeeds and the
    // post-creation marker check returns absent, a contender may have unlinked
    // our just-created lock and written a valid live replacement at the same
    // path. lockInodeMatches must detect this and retry rather than entering
    // the critical section as a second owner.
    //
    // Harness: count O_RDONLY opens of markerPath. The first is the pre-create
    // waitForRecoveryMarkerCleared; the second is the post-create
    // reclaimMarkerIfStale. On the second, synchronously unlink state.lock and
    // write a valid live replacement inode. The marker open returns ENOENT, so
    // the fixed code's identity check must retry/time out without running and
    // preserve the replacement.
    const layout = await stateLayout(projectRoot);
    const markerPath = join(layout.projectDir, "state.lock.recover");

    const replacementPayload = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "replacement-owner",
      createdAt: new Date().toISOString(),
    };

    let markerReadOpens = 0;
    let interceptFired = false;
    lockOpenInspection.intercept = (target, flags) => {
      if (target !== markerPath || typeof flags !== "number") return;
      // Only count O_RDONLY opens (inspectRecoveryMarker), not O_CREAT.
      if ((flags & fsConstants.O_CREAT) !== 0) return;
      markerReadOpens += 1;
      // Fire on the second O_RDONLY open: the post-create reclaimMarkerIfStale.
      if (markerReadOpens !== 2) return;
      interceptFired = true;
      // Contender unlinks our just-created lock inode and creates a fresh
      // replacement inode at the same path.
      try {
        unlinkSync(layout.lockFile);
      } catch {
        // Already gone.
      }
      writeFileSync(layout.lockFile, `${JSON.stringify(replacementPayload)}\n`, {
        mode: 0o600,
      });
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

    // The post-creation intercept fired (proving we reached the identity check).
    expect(interceptFired).toBe(true);
    // The creator never entered its critical section.
    expect(operationRan).toBe(false);
    // The replacement lock is intact and unchanged.
    expect(JSON.parse(await readFile(layout.lockFile, "utf8"))).toEqual(
      replacementPayload,
    );
    // No quarantine detritus.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.startsWith(".stale-lock-"),
      ),
    ).toEqual([]);
    // No recovery marker is stranded.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.endsWith(".lock.recover"),
      ),
    ).toEqual([]);
  });

  it("reclaims a crash-stale recovery marker and proceeds with the next acquisition", async () => {
    // If a recoverer crashes after creating its recovery marker but before
    // clearing it, the marker is crash-stale (dead owner). The next normal
    // withProjectLock must reclaim it by inode identity and proceed, not time
    // out forever.
    const layout = await stateLayout(projectRoot);
    const markerPath = join(layout.projectDir, "state.lock.recover");
    const crashStaleMarker = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: 999_999_999,
      nonce: "crashed-recoverer",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(markerPath, `${JSON.stringify(crashStaleMarker)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

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
    // The crash-stale marker was reclaimed.
    expect(
      (await readdir(layout.projectDir)).filter((name) =>
        name.endsWith(".lock.recover"),
      ),
    ).toEqual([]);
  });

  it("blocks acquisition while a live recovery marker is held and never removes it", async () => {
    // A live recovery marker (owner process alive) must block all acquisitions
    // until timeout. The wait path must never remove a live owner's marker.
    const layout = await stateLayout(projectRoot);
    const markerPath = join(layout.projectDir, "state.lock.recover");
    const liveMarker = {
      schemaVersion: 1,
      rootHash: layout.rootHash,
      pid: process.pid,
      nonce: "live-recoverer",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(markerPath, `${JSON.stringify(liveMarker)}\n`, {
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
    // The live marker was NOT removed — its owner is still alive.
    const remaining = (await readdir(layout.projectDir)).filter((name) =>
      name.endsWith(".lock.recover"),
    );
    expect(remaining).toEqual(["state.lock.recover"]);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(liveMarker);
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
