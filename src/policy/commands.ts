import type { CompiledContract, Decision, PackageManager } from "../types.js";
import { canonicalizeObservedCwd } from "./path.js";
import {
  parseRestrictedCommand,
  rejectUnsafeArgv,
  RestrictedShellError,
} from "./shell.js";

const PACKAGE_MANAGER_BY_EXECUTABLE: Record<string, PackageManager> = {
  bun: "bun",
  bunx: "bun",
  npm: "npm",
  npx: "npm",
  pnpm: "pnpm",
  pnpx: "pnpm",
  yarn: "yarn",
  yarnpkg: "yarn",
};

const JAVASCRIPT_RUNNERS: Record<string, true> = {
  bun: true,
  deno: true,
  node: true,
  nodejs: true,
  tsx: true,
};

const RUNNER_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-C": true,
  "-r": true,
  "--cert": true,
  "--conditions": true,
  "--config": true,
  "--cpu-prof-dir": true,
  "--cpu-prof-name": true,
  "--cwd": true,
  "--define": true,
  "--diagnostic-dir": true,
  "--disable-warning": true,
  "--env-file": true,
  "--experimental-default-type": true,
  "--experimental-loader": true,
  "--external": true,
  "--heap-prof-dir": true,
  "--heap-prof-name": true,
  "--icu-data-dir": true,
  "--import": true,
  "--import-map": true,
  "--input-type": true,
  "--inspect-port": true,
  "--loader": true,
  "--location": true,
  "--lock": true,
  "--log-level": true,
  "--main-fields": true,
  "--max-http-header-size": true,
  "--node-modules-dir": true,
  "--openssl-config": true,
  "--origin": true,
  "--preload": true,
  "--redirect-warnings": true,
  "--report-dir": true,
  "--report-directory": true,
  "--report-filename": true,
  "--report-signal": true,
  "--require": true,
  "--seed": true,
  "--snapshot-blob": true,
  "--test-concurrency": true,
  "--test-name-pattern": true,
  "--test-reporter": true,
  "--test-reporter-destination": true,
  "--test-shard": true,
  "--title": true,
  "--tls-cipher-list": true,
  "--tsconfig": true,
  "--use-largepages": true,
  "--v8-flags": true,
  "--watch-kill-signal": true,
  "--watch-path": true,
};

const PACKAGE_MANAGER_EXECUTABLE_BY_ENTRYPOINT: Record<string, string> = {
  "bun-cli.js": "bun",
  "bun.cjs": "bun",
  "bun.js": "bun",
  "bun.mjs": "bun",
  "npm-cli.js": "npm",
  "npx-cli.js": "npx",
  "pnpm.cjs": "pnpm",
  "pnpm.js": "pnpm",
  "pnpm.mjs": "pnpm",
  "pnpx.cjs": "pnpx",
  "pnpx.js": "pnpx",
  "pnpx.mjs": "pnpx",
  "yarn.cjs": "yarn",
  "yarn.js": "yarn",
  "yarn.mjs": "yarn",
  "yarnpkg.cjs": "yarnpkg",
  "yarnpkg.js": "yarnpkg",
  "yarnpkg.mjs": "yarnpkg",
};

const PACKAGE_MANAGER_ENTRYPOINT_SHAPE =
  /^(?:bun|npm|npx|pnpm|pnpx|yarn|yarnpkg)(?:-cli)?\.(?:[cm]?js|tsx?)$/u;

const TASKFENCE_AUTHORITY_VERBS: Record<string, true> = {
  activate: true,
  amend: true,
  approve: true,
  close: true,
  complete: true,
  install: true,
  revoke: true,
  rollback: true,
  stage: true,
  uninstall: true,
};

export class CommandArgvPolicyError extends Error {
  readonly decisionCode: Decision["code"];

  constructor(decisionCode: Decision["code"], message: string) {
    super(message);
    this.name = "CommandArgvPolicyError";
    this.decisionCode = decisionCode;
  }
}

function executableName(argv0: string): string {
  const normalized = argv0.replaceAll("\\", "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return name.replace(/\.(?:bat|cmd|exe)$/u, "");
}

function isTaskFenceToken(argument: string): boolean {
  const name = executableName(argument);
  return (
    name === "taskfence" ||
    name === "tf" ||
    name.startsWith("taskfence@")
  );
}

function isTaskFenceScriptEntrypoint(argument: string): boolean {
  const normalized = argument.replaceAll("\\", "/").toLowerCase();
  return (
    /(?:^|\/)(?:dist\/cli\.[cm]?js|src\/cli\.(?:[cm]?ts|tsx))$/u.test(
      normalized,
    ) ||
    /(?:^|\/)taskfence(?:\.[cm]?[jt]s)?$/u.test(normalized)
  );
}

function nextAuthorityVerb(
  argv: readonly string[],
  start: number,
): string | undefined {
  for (let index = start; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") continue;
    return TASKFENCE_AUTHORITY_VERBS[argument.toLowerCase()] === true
      ? argument
      : undefined;
  }
  return undefined;
}

function containsTaskFenceAuthority(argv: readonly string[]): boolean {
  const executable = executableName(argv[0] ?? "");
  if (
    (executable === "taskfence" || executable === "tf") &&
    nextAuthorityVerb(argv, 1) !== undefined
  ) {
    return true;
  }

  if (JAVASCRIPT_RUNNERS[executable] === true) {
    const entrypointIndex = argv.findIndex(
      (argument, index) => index > 0 && isTaskFenceScriptEntrypoint(argument),
    );
    if (
      entrypointIndex >= 0 &&
      nextAuthorityVerb(argv, entrypointIndex + 1) !== undefined
    ) {
      return true;
    }
  }

  const isDirectRunner = ["bunx", "npx", "pnpx"].includes(executable);
  const managerRunner =
    (executable === "npm" &&
      argv.slice(1).some((argument) => argument === "exec" || argument === "x")) ||
    (executable === "pnpm" &&
      argv.slice(1).some((argument) => argument === "dlx" || argument === "exec")) ||
    ((executable === "yarn" || executable === "yarnpkg") &&
      argv.slice(1).some((argument) => argument === "dlx" || argument === "exec")) ||
    (executable === "bun" && argv.slice(1).some((argument) => argument === "x"));
  if (!isDirectRunner && !managerRunner) return false;

  return argv.some(
    (argument, index) =>
      index > 0 &&
      isTaskFenceToken(argument) &&
      nextAuthorityVerb(argv, index + 1) !== undefined,
  );
}

function runnerEntrypointIndex(
  argv: readonly string[],
  runner: string,
): number | null {
  if (JAVASCRIPT_RUNNERS[runner] !== true) return null;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") return index + 1 < argv.length ? index + 1 : null;
    if (argument.startsWith("-")) {
      if (
        !argument.includes("=") &&
        RUNNER_OPTIONS_WITH_VALUE[argument] === true
      ) {
        index += 1;
      }
      continue;
    }
    if (
      ((runner === "bun" || runner === "deno") && argument === "run") ||
      (runner === "tsx" && argument === "watch")
    ) {
      continue;
    }
    return index;
  }
  return null;
}

function wrappedPackageManagerArgv(
  argv: readonly string[],
  runner: string,
): string[] | null {
  let entrypointIndex = runnerEntrypointIndex(argv, runner);
  if (entrypointIndex === null) return null;

  let entrypointName = executableName(argv[entrypointIndex] ?? "");
  let managerExecutable =
    PACKAGE_MANAGER_EXECUTABLE_BY_ENTRYPOINT[entrypointName];
  if (
    managerExecutable === undefined &&
    !PACKAGE_MANAGER_ENTRYPOINT_SHAPE.test(entrypointName)
  ) {
    if (/\.(?:[cm]?[jt]s|tsx)$/u.test(entrypointName)) return null;
    const priorEntrypointIndex = entrypointIndex;
    entrypointIndex = argv.findIndex(
      (argument, index) =>
        index > priorEntrypointIndex &&
        (PACKAGE_MANAGER_EXECUTABLE_BY_ENTRYPOINT[executableName(argument)] !==
          undefined ||
          PACKAGE_MANAGER_ENTRYPOINT_SHAPE.test(executableName(argument))),
    );
    if (entrypointIndex < 0) return null;
    entrypointName = executableName(argv[entrypointIndex] ?? "");
    managerExecutable =
      PACKAGE_MANAGER_EXECUTABLE_BY_ENTRYPOINT[entrypointName];
  }

  if (managerExecutable !== undefined) {
    return [managerExecutable, ...argv.slice(entrypointIndex + 1)];
  }
  throw new CommandArgvPolicyError(
    "deny_package_manager",
    "Unknown or malformed package-manager interpreter entrypoint",
  );
}

function matchesPackageOverride(
  argument: string,
  exact: readonly string[],
  valuePrefixes: readonly string[],
): boolean {
  return (
    exact.includes(argument) ||
    valuePrefixes.some((prefix) => argument.startsWith(prefix))
  );
}

function rejectPackageManagerOverrides(
  argv: readonly string[],
  manager: PackageManager,
): void {
  const separator = argv.indexOf("--");
  const managerArguments = argv.slice(
    1,
    separator === -1 ? argv.length : separator,
  );
  let unsafe = false;

  switch (manager) {
    case "npm":
      unsafe = managerArguments.some((argument) =>
        matchesPackageOverride(
          argument,
          [
            "-g",
            "-w",
            "--global",
            "--include-workspace-root",
            "--location",
            "--prefix",
            "--workspace",
            "--workspaces",
            "--ws",
          ],
          [
            "--global=",
            "--include-workspace-root=",
            "--location=",
            "--prefix=",
            "--workspace=",
            "--workspaces=",
            "--ws=",
            "-w",
          ],
        )
      );
      if (
        managerArguments.some(
          (argument) => argument === "--call" || argument.startsWith("--call="),
        )
      ) {
        throw new CommandArgvPolicyError(
          "deny_command_syntax",
          "npm inline subprocess execution is not allowed",
        );
      }
      break;
    case "pnpm":
      unsafe = managerArguments.some((argument) =>
        matchesPackageOverride(
          argument,
          [
            "-C",
            "-F",
            "-g",
            "-r",
            "-w",
            "--dir",
            "--filter",
            "--global",
            "--recursive",
            "--workspace-root",
          ],
          [
            "-C",
            "-F",
            "--dir=",
            "--filter=",
            "--global=",
            "--recursive=",
            "--workspace-root=",
          ],
        )
      );
      break;
    case "yarn":
      unsafe =
        managerArguments.some((argument) =>
          matchesPackageOverride(
            argument,
            [
              "-C",
              "-T",
              "-g",
              "--all",
              "--cwd",
              "--global",
              "--recursive",
              "--since",
              "--top-level",
            ],
            ["-C", "--cwd=", "--global=", "--since=", "--top-level="],
          )
        ) ||
        managerArguments.some((argument) =>
          ["global", "workspace", "workspaces"].includes(argument)
        );
      break;
    case "bun":
      unsafe = managerArguments.some((argument) =>
        matchesPackageOverride(
          argument,
          [
            "-C",
            "-g",
            "--all",
            "--cwd",
            "--filter",
            "--global",
            "--workspace",
            "--workspaces",
          ],
          [
            "-C",
            "--all=",
            "--cwd=",
            "--filter=",
            "--global=",
            "--workspace=",
            "--workspaces=",
          ],
        )
      );
      break;
    case "none":
      break;
  }

  if (unsafe) {
    throw new CommandArgvPolicyError(
      "deny_package_manager",
      "Package-manager CWD, root, workspace, and global overrides are not allowed",
    );
  }
}

export function validateCommandArgv(
  argv: readonly string[],
  packageManager: PackageManager,
): PackageManager | null {
  rejectUnsafeArgv(argv);
  if (containsTaskFenceAuthority(argv)) {
    throw new CommandArgvPolicyError(
      "deny_command_not_approved",
      "TaskFence authority commands cannot be invoked through a tool call",
    );
  }

  const runner = executableName(argv[0] ?? "");
  const wrappedManagerArgv = wrappedPackageManagerArgv(argv, runner);
  if (wrappedManagerArgv !== null) {
    return validateCommandArgv(wrappedManagerArgv, packageManager);
  }

  const executable = runner;
  if (executable === "corepack") {
    throw new CommandArgvPolicyError(
      "deny_package_manager",
      "Package-manager indirection through corepack is not allowed",
    );
  }

  const invokedManager = PACKAGE_MANAGER_BY_EXECUTABLE[executable] ?? null;
  if (invokedManager !== null && invokedManager !== packageManager) {
    throw new CommandArgvPolicyError(
      "deny_package_manager",
      packageManager === "none"
        ? "The contract does not authorize a package manager"
        : `The contract authorizes ${packageManager}, not ${invokedManager}`,
    );
  }
  if (invokedManager === null) return null;

  rejectPackageManagerOverrides(argv, invokedManager);
  const conflictingManager = argv
    .slice(1)
    .map((argument) => PACKAGE_MANAGER_BY_EXECUTABLE[executableName(argument)] ?? null)
    .find((manager) => manager !== null && manager !== invokedManager);
  if (conflictingManager !== undefined) {
    throw new CommandArgvPolicyError(
      "deny_package_manager",
      `A ${invokedManager} command cannot invoke the conflicting ${conflictingManager} package manager`,
    );
  }
  return invokedManager;
}

function deny(code: Decision["code"], reason: string): Decision {
  return { allowed: false, code, reason };
}

export function authorizeCommand(
  contract: CompiledContract,
  command: string,
  cwd: string,
): Decision {
  let argv: string[];
  try {
    argv = parseRestrictedCommand(command);
  } catch (error) {
    const reason = error instanceof RestrictedShellError
      ? error.message
      : "Command could not be parsed safely";
    return deny("deny_command_syntax", reason);
  }

  try {
    validateCommandArgv(argv, contract.document.packageManager);
  } catch (error) {
    if (error instanceof CommandArgvPolicyError) {
      return deny(error.decisionCode, error.message);
    }
    const reason = error instanceof RestrictedShellError
      ? error.message
      : "Command argv could not be validated safely";
    return deny("deny_command_syntax", reason);
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = canonicalizeObservedCwd(contract.root, cwd);
  } catch {
    return deny(
      "deny_root_mismatch",
      "Command working directory is not a canonical existing directory",
    );
  }

  const approved = contract.document.commands.some(
    (rule) =>
      rule.cwd === canonicalCwd &&
      rule.argv.length === argv.length &&
      rule.argv.every((value, index) => value === argv[index]),
  );
  if (!approved) {
    return deny(
      "deny_command_not_approved",
      "Command argv and working directory do not exactly match an approved rule",
    );
  }

  return {
    allowed: true,
    code: "allow_command",
    reason: "Command exactly matches an approved argv and working directory",
  };
}
