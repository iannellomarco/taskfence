import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface RawContractDocument {
  version: 1;
  write: string[];
  create: string[];
  delete: string[];
  protected: string[];
  commands: Array<{ argv: string[]; cwd: string }>;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none";
}

export async function makeTempProject(prefix = "taskfence-test-"): Promise<{
  root: string;
  stateDir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  return {
    root,
    stateDir,
    cleanup: async () => {
      await rm(base, { force: true, recursive: true });
    },
  };
}

export async function withStateDir<T>(
  stateDir: string,
  fn: () => T | Promise<T>,
): Promise<Awaited<T>> {
  const previousTaskFenceStateDir = process.env.TASKFENCE_STATE_DIR;
  const previousXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.TASKFENCE_STATE_DIR = resolve(stateDir);
  process.env.XDG_STATE_HOME = resolve(stateDir);

  try {
    return await fn();
  } finally {
    if (previousTaskFenceStateDir === undefined) {
      delete process.env.TASKFENCE_STATE_DIR;
    } else {
      process.env.TASKFENCE_STATE_DIR = previousTaskFenceStateDir;
    }
    if (previousXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
  }
}

export function minimalPlan(
  root: string,
  overrides: Partial<RawContractDocument> = {},
): string {
  void resolve(root);
  const contract: RawContractDocument = {
    version: 1,
    write: [],
    create: [],
    delete: [],
    protected: [],
    commands: [],
    packageManager: "none",
    ...overrides,
  };
  return `\`\`\`taskfence-contract\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}
