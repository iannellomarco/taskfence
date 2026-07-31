#!/usr/bin/env node
/**
 * Deterministic clean-artifact drift check.
 *
 * Builds the source tree into a temporary directory and compares the expected
 * generated artifact tree (and content) against the committed `dist/`, using a
 * normalization-safe comparison. Exits non-zero on drift but never rewrites
 * committed artifacts — the fix is always to rebuild and commit `dist`.
 *
 * Node >= 20 compatible (no import.meta.dirname).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED_DIST = join(REPOSITORY_ROOT, "dist");
const TSUP_BIN = join(REPOSITORY_ROOT, "node_modules", "tsup", "dist", "cli-default.js");
const TSUP_CONFIG = join(REPOSITORY_ROOT, "tsup.config.ts");

/** All paths a clean build must produce, relative to the dist root. */
const EXPECTED_ARTIFACTS = Object.freeze([
  "cli.js",
  "cli.js.map",
  "cli.d.ts",
  "index.js",
  "index.js.map",
  "index.d.ts",
  "adapters/claude-code.js",
  "adapters/claude-code.js.map",
  "adapters/claude-code.d.ts",
  "adapters/codex-cli.js",
  "adapters/codex-cli.js.map",
  "adapters/codex-cli.d.ts",
  "adapters/opencode.js",
  "adapters/opencode.js.map",
  "adapters/opencode.d.ts",
  "adapters/omp.js",
  "adapters/omp.js.map",
  "adapters/omp.d.ts",
  "adapters/pi.js",
  "adapters/pi.js.map",
  "adapters/pi.d.ts",
]);

/**
 * Normalize artifact bytes so builds from different output directories compare
 * equal. Only sourcemaps carry build-location-dependent data: their
 * `sources` array holds paths whose prefix depends on the checkout and output
 * directory. Strip everything before the first stable source-tree segment
 * (`src/` or `node_modules/`) so committed artifacts compare across clones.
 * The embedded `sourcesContent`, `file`, `version`, and `mappings` are already
 * deterministic.
 */
async function normalizeArtifact(artifactPath, bytes) {
  if (!artifactPath.endsWith(".map")) return bytes;
  const decoded = JSON.parse(bytes);
  if (Array.isArray(decoded.sources)) {
    decoded.sources = decoded.sources.map((source) => {
      if (typeof source !== "string") return source;
      const normalized = source.replace(/\\/gu, "/");
      const match = /(?:^|\/)(src|node_modules)\//u.exec(normalized);
      return match === null
        ? normalized
        : normalized.slice(match.index + (match[0].startsWith("/") ? 1 : 0));
    });
  }
  return JSON.stringify(decoded);
}

async function sha256Hex(normalizedBytes) {
  return createHash("sha256").update(normalizedBytes).digest("hex");
}

/** Recursively collect files under a directory as posix-relative paths. */
async function collectFiles(root) {
  const out = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}

export async function checkArtifactDrift() {
  const temporary = await mkdtemp(join(tmpdir(), "taskfence-drift-"));
  const outputDirectory = join(temporary, "dist");
  const failures = [];

  try {
    try {
      await execFileAsync(
        process.execPath,
        [TSUP_BIN, "--config", TSUP_CONFIG, "--out-dir", outputDirectory],
        { cwd: REPOSITORY_ROOT, maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (error) {
      const detail =
        error instanceof Error && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr.trim()
          : String(error);
      failures.push(
        `clean build failed; cannot verify committed dist until source compiles: ${detail}`,
      );
      return failures;
    }

    const builtFiles = (await collectFiles(outputDirectory)).map((f) => f);
    const committedFiles = await collectFiles(COMMITTED_DIST).catch(() => []);

    // 1. Expected file inventory: every required artifact must be produced.
    for (const expected of EXPECTED_ARTIFACTS) {
      if (!builtFiles.includes(expected)) {
        failures.push(`missing expected artifact: ${expected}`);
      }
      try {
        await stat(join(COMMITTED_DIST, expected));
      } catch {
        failures.push(`missing committed artifact: ${expected}`);
      }
    }

    // 2. No stray artifacts: a clean build must not emit unexpected files.
    for (const built of builtFiles) {
      if (!EXPECTED_ARTIFACTS.includes(built)) {
        failures.push(`unexpected build artifact: ${built}`);
      }
    }
    for (const committed of committedFiles) {
      if (!EXPECTED_ARTIFACTS.includes(committed)) {
        failures.push(`unexpected committed artifact: ${committed}`);
      }
    }

    // 3. Content comparison with normalization for each expected artifact.
    for (const rel of EXPECTED_ARTIFACTS) {
      const builtPath = join(outputDirectory, rel);
      const committedPath = join(COMMITTED_DIST, rel);

      let builtBytes;
      let committedBytes;
      try {
        builtBytes = await readFile(builtPath, "utf8");
      } catch {
        continue; // already reported as missing above
      }
      try {
        committedBytes = await readFile(committedPath, "utf8");
      } catch {
        continue; // already reported as missing above
      }

      const builtNormalized = await normalizeArtifact(rel, builtBytes);
      const committedNormalized = await normalizeArtifact(rel, committedBytes);

      if (builtNormalized !== committedNormalized) {
        const builtHash = await sha256Hex(builtNormalized);
        const committedHash = await sha256Hex(committedNormalized);
        failures.push(
          `artifact drift in ${rel}: rebuilt sha256=${builtHash} != committed sha256=${committedHash}`,
        );
      }
    }

    return failures;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function main() {
  const failures = await checkArtifactDrift();
  if (failures.length === 0) {
    process.stdout.write("taskfence: committed dist matches a clean build\n");
    return 0;
  }
  process.stderr.write(
    `taskfence: committed dist is stale or inconsistent (${failures.length} difference(s))\n`,
  );
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.stderr.write(
    "Fix: rebuild and commit dist (`npm run build`) so committed artifacts match current source.\n",
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

export { REPOSITORY_ROOT, COMMITTED_DIST, EXPECTED_ARTIFACTS };
