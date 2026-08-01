import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { checkArtifactDrift, EXPECTED_ARTIFACTS } from "../scripts/check-artifact-drift.mjs";

const execFile = promisify(execFileCallback);

// Node >= 20.0 compatible path resolution (import.meta.dirname arrived in 20.11).
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED_DIST = join(REPOSITORY_ROOT, "dist");
const COMMITTED_CLI = join(COMMITTED_DIST, "cli.js");
const PACKAGE_JSON_PATH = join(REPOSITORY_ROOT, "package.json");
const PLUGIN_MANIFEST_PATH = join(REPOSITORY_ROOT, ".claude-plugin", "plugin.json");
const MARKETPLACE_MANIFEST_PATH = join(REPOSITORY_ROOT, ".claude-plugin", "marketplace.json");
const HOOKS_MANIFEST_PATH = join(REPOSITORY_ROOT, "hooks", "hooks.json");

interface PackageManifest {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  engines?: { node?: string };
}

async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as PackageManifest;
}

/** Files expected in the published npm tarball (from package.json `files` + metadata). */
const EXPECTED_PACK_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "package.json",
  ...EXPECTED_ARTIFACTS.map((artifact) => `dist/${artifact}`),
]);

let temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  }
});

async function makeTemporary(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `taskfence-package-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}
function makeTemporarySync(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `taskfence-package-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

describe("committed dist is not gitignored", () => {
  it("treats the marketplace CLI entrypoint as a tracked release artifact", () => {
    const ignored = spawnSync(
      "git",
      ["check-ignore", "--no-index", "dist/cli.js"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    expect(ignored.status, ignored.stdout || ignored.stderr).toBe(1);
  });
});

describe("committed distribution artifacts match a clean build", () => {
  // Builds source into a temporary directory and compares the full expected
  // generated tree/content against committed `dist` in a normalization-safe way
  // (sourcemap source paths are canonicalized). This is the gate that fails on
  // stale committed dist but never rewrites it.
  it("reports every stale or inconsistent committed artifact", async () => {
    const failures = await checkArtifactDrift();
    expect(failures, failures.join("\n")).toEqual([]);
  }, 90_000);
});

describe("marketplace plugin entrypoint (committed artifacts)", () => {
  it("exposes the committed CLI and existing plugin component paths", async () => {
    await stat(COMMITTED_CLI);

    const pluginManifest = JSON.parse(
      await readFile(PLUGIN_MANIFEST_PATH, "utf8"),
    ) as {
      version?: string;
      skills?: string;
      hooks?: string;
    };
    const marketplaceManifest = JSON.parse(
      await readFile(MARKETPLACE_MANIFEST_PATH, "utf8"),
    ) as { plugins?: Array<{ version?: string }> };
    const packageManifest = await readPackageManifest();

    expect(pluginManifest.version).toBe(packageManifest.version);
    expect(marketplaceManifest.plugins?.[0]?.version).toBe(packageManifest.version);

    for (const componentPath of [pluginManifest.skills, pluginManifest.hooks]) {
      expect(typeof componentPath).toBe("string");
      await stat(resolve(REPOSITORY_ROOT, componentPath as string));
    }

    const hookManifest = JSON.parse(
      await readFile(HOOKS_MANIFEST_PATH, "utf8"),
    ) as {
      hooks?: Record<
        string,
        Array<{
          hooks?: Array<{ command?: string; args?: string[] }>;
        }>
      >;
    };
    const hookInvocations = Object.values(hookManifest.hooks ?? {}).flatMap(
      (matchers) =>
        matchers.flatMap((matcher) =>
          (matcher.hooks ?? []).map((hook) => ({
            command: hook.command,
            args: hook.args,
          })),
        ),
    );
    expect(hookInvocations).toEqual([
      {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/cli.js", "hook", "claude"],
      },
      {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/cli.js", "hook", "claude"],
      },
    ]);
  });

  it("processes a pre-tool-use hook payload through the plugin entrypoint", () => {
    const projectRoot = makeTemporarySync("hook");

    const payload = {
      session_id: "smoke-session",
      prompt_id: "smoke-prompt",
      transcript_path: join(projectRoot, "transcript.jsonl"),
      cwd: projectRoot,
      permission_mode: "default",
      effort: { level: "high" },
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(projectRoot, "readme.md") },
      tool_use_id: "smoke-call",
    };

    const result = spawnSync(
      process.execPath,
      [COMMITTED_CLI, "hook", "claude"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        input: JSON.stringify(payload),
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    // With no active contract a non-ExitPlanMode pre-tool call is allowed silently.
    expect(result.stdout).toBe("");
  }, 30_000);
});

describe("npm pack inventory and package entrypoints", () => {
  it("publishes exactly the declared file set with no stale or missing entries", async () => {
    const manifest = await readPackageManifest();
    const tarballDir = await makeTemporary("pack");

    // --ignore-scripts avoids the prepack rebuild so we inspect the committed
    // artifacts exactly as a registry consumer would receive them.
    const packed = await execFile(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 },
    );

    const summary = JSON.parse(packed.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    expect(summary.length).toBe(1);
    const packedPaths = summary[0].files
      .map((entry) => entry.path)
      .sort();

    expect(packedPaths).toEqual([...EXPECTED_PACK_FILES].sort());

    // `files` must include `dist` so the built artifacts ship.
    expect(manifest.files).toContain("dist");
  }, 60_000);

  it("declares bin entrypoints that resolve to committed artifacts", async () => {
    const manifest = await readPackageManifest();
    expect(manifest.bin).toMatchObject({
      taskfence: "dist/cli.js",
      tf: "dist/cli.js",
    });

    for (const target of Object.values(manifest.bin ?? {})) {
      const resolved = join(REPOSITORY_ROOT, target);
      // Throws (fails the test) if a declared bin target is missing from dist.
      await stat(resolved);
    }
  });

  it("declares export subpaths whose types/import targets exist in committed dist", async () => {
    const manifest = await readPackageManifest();
    expect(manifest.exports).toBeDefined();

    for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
      const conditionMap = conditions as Record<string, string>;
      const conditionEntries = Object.entries(conditionMap);

      for (const [condition, target] of conditionEntries) {
        expect(typeof target).toBe("string");
        const resolved = join(REPOSITORY_ROOT, target);
        // Throws (fails the test) if a declared export target is missing.
        await stat(resolved);

        if (condition === "import") {
          expect(target.endsWith(".js")).toBe(true);
        }
        if (condition === "types") {
          expect(target.endsWith(".d.ts")).toBe(true);
        }
      }

      // The main entry subpath is always ".".
      if (subpath === ".") {
        expect(conditionMap.import).toBeDefined();
        expect(conditionMap.types).toBeDefined();
      }
    }
  });

  it("includes the declared node engine floor", async () => {
    const manifest = await readPackageManifest();
    expect(manifest.engines?.node).toMatch(/^>=20/);
  });
});
