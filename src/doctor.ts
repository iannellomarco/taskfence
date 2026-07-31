import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeHook } from "./adapters/claude-code.js";
import { runCodexHook } from "./adapters/codex-cli.js";
import TaskFenceOpenCodePlugin from "./adapters/opencode.js";
import TaskFenceOmpExtension from "./adapters/omp.js";
import TaskFencePiExtension from "./adapters/pi.js";

import {
  INSTALL_RUNTIMES,
  isRuntimeConfigured,
} from "./install/index.js";
import type {
  InstallOptions,
  InstallRuntime,
  InstallScope,
} from "./install/index.js";

const DEFAULT_HEARTBEAT_MAX_AGE_MS = 10 * 60 * 1_000;

const ADAPTER_ENTRYPOINTS: Record<InstallRuntime, unknown> = {
  claude: runClaudeHook,
  codex: runCodexHook,
  opencode: TaskFenceOpenCodePlugin,
  omp: TaskFenceOmpExtension,
  pi: TaskFencePiExtension,
};

export interface DoctorOptions extends InstallOptions {
  heartbeatMaxAgeMs?: number;
  now?: Date;
}

export interface AdapterSelfTest {
  passed: boolean;
  detail: string;
}

export interface HostHeartbeatStatus {
  status: "recent" | "stale" | "missing" | "invalid";
  loadingObserved: boolean;
  verified: boolean;
  path: string;
  observedAt?: string;
  ageMs?: number;
  detail: string;
}

export interface RuntimeDoctorReport {
  runtime: InstallRuntime;
  scope: InstallScope;
  binarySelfTest: AdapterSelfTest;
  configured: boolean;
  configurationPath: string;
  configurationDetail: string;
  hostHeartbeat: HostHeartbeatStatus;
}

function stateBaseDirectory(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome !== undefined && xdgStateHome.length > 0) {
    if (!isAbsolute(xdgStateHome)) {
      throw new Error("XDG_STATE_HOME must be an absolute path");
    }
    return join(resolve(xdgStateHome), "taskfence");
  }
  return join(homedir(), ".local", "state", "taskfence");
}

export function hostHeartbeatPath(runtime: InstallRuntime): string {
  return join(stateBaseDirectory(), "host-heartbeats", `${runtime}.json`);
}

export async function recordHostHeartbeat(runtime: InstallRuntime): Promise<void> {
  const path = hostHeartbeatPath(runtime);
  await mkdir(join(stateBaseDirectory(), "host-heartbeats"), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      runtime,
      observedAt: new Date().toISOString(),
      pid: process.pid,
    })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function builtAdapterPath(runtime: InstallRuntime): string {
  const filename = runtime === "claude"
    ? "claude-code.js"
    : runtime === "codex"
      ? "codex-cli.js"
      : `${runtime}.js`;
  return fileURLToPath(new URL(`./adapters/${filename}`, import.meta.url));
}

async function adapterSelfTest(runtime: InstallRuntime, options: DoctorOptions): Promise<AdapterSelfTest> {
  const cliPath = resolve(
    options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
  );
  const nodePath = resolve(options.nodePath ?? process.execPath);
  try {
    const [nodeMetadata, cliMetadata, adapterMetadata] = await Promise.all([
      lstat(nodePath),
      lstat(cliPath),
      lstat(builtAdapterPath(runtime)),
    ]);
    if (!nodeMetadata.isFile()) throw new Error(`Node executable is not a file: ${nodePath}`);
    if (!cliMetadata.isFile()) throw new Error(`CLI artifact is not a file: ${cliPath}`);
    if (!adapterMetadata.isFile()) {
      throw new Error(`Adapter artifact is not a file: ${builtAdapterPath(runtime)}`);
    }
    if (typeof ADAPTER_ENTRYPOINTS[runtime] !== "function") {
      throw new Error(`Adapter does not export a callable entrypoint for ${runtime}`);
    }
    return {
      passed: true,
      detail:
        "Local Node, CLI, and adapter artifacts are present and importable in the doctor process; this does not prove host-process loading or enforcement",
    };
  } catch (error) {
    return {
      passed: false,
      detail: error instanceof Error ? error.message : "Local adapter self-test failed",
    };
  }
}

async function inspectHeartbeat(
  runtime: InstallRuntime,
  options: DoctorOptions,
): Promise<HostHeartbeatStatus> {
  const path = hostHeartbeatPath(runtime);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new Error("heartbeat path is not a regular file");
    const raw = await readFile(path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("heartbeat is not valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("heartbeat must be a JSON object");
    }
    const heartbeat = value as Record<string, unknown>;
    if (
      heartbeat.runtime !== runtime ||
      typeof heartbeat.observedAt !== "string" ||
      typeof heartbeat.pid !== "number" ||
      !Number.isSafeInteger(heartbeat.pid) ||
      heartbeat.pid <= 0
    ) {
      throw new Error("heartbeat fields do not match the host schema");
    }
    const observedTime = Date.parse(heartbeat.observedAt);
    if (!Number.isFinite(observedTime)) throw new Error("heartbeat timestamp is invalid");
    const now = (options.now ?? new Date()).getTime();
    const ageMs = now - observedTime;
    if (ageMs < -60_000) throw new Error("heartbeat timestamp is in the future");
    const maxAge = options.heartbeatMaxAgeMs ?? DEFAULT_HEARTBEAT_MAX_AGE_MS;
    if (!Number.isFinite(maxAge) || maxAge < 0) {
      throw new Error("heartbeatMaxAgeMs must be a non-negative finite number");
    }
    const recent = ageMs <= maxAge;
    return {
      status: recent ? "recent" : "stale",
      loadingObserved: true,
      verified: false,
      path,
      observedAt: heartbeat.observedAt,
      ageMs: Math.max(0, ageMs),
      detail: recent
        ? "Recent adapter loading was observed, but the heartbeat is not bound to this project, host process, or session and does not verify enforcement"
        : "A stale adapter-loading observation exists; it does not prove current host loading or enforcement",
    };
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT"
    ) {
      return {
        status: "missing",
        loadingObserved: false,
        verified: false,
        path,
        detail: "No adapter-loading heartbeat observed; configuration and local artifacts do not prove host loading or enforcement",
      };
    }
    return {
      status: "invalid",
      loadingObserved: false,
      verified: false,
      path,
      detail: `Heartbeat could not establish adapter loading; enforcement remains unverified: ${
        error instanceof Error ? error.message : "unable to inspect heartbeat"
      }`,
    };
  }
}

export async function doctorRuntime(
  runtime: InstallRuntime,
  options: DoctorOptions = {},
): Promise<RuntimeDoctorReport> {
  const scope = options.scope ?? "user";
  const [binarySelfTest, configured, hostHeartbeat] = await Promise.all([
    adapterSelfTest(runtime, options),
    isRuntimeConfigured(runtime, options),
    inspectHeartbeat(runtime, options),
  ]);
  return {
    runtime,
    scope,
    binarySelfTest,
    configured: configured.configured,
    configurationPath: configured.path,
    configurationDetail: configured.detail,
    hostHeartbeat,
  };
}

export async function doctorAll(
  options: DoctorOptions = {},
): Promise<RuntimeDoctorReport[]> {
  return Promise.all(INSTALL_RUNTIMES.map((runtime) => doctorRuntime(runtime, options)));
}
