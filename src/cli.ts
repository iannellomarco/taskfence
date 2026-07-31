#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runClaudeHook } from "./adapters/claude-code.js";
import { runCodexHook } from "./adapters/codex-cli.js";
import {
  doctorAll,
  doctorRuntime,
  recordHostHeartbeat,
} from "./doctor.js";
import type { RuntimeDoctorReport } from "./doctor.js";
import {
  INSTALL_RUNTIMES,
  installRuntime,
  isInstallRuntime,
  uninstallRuntime,
} from "./install/index.js";
import type {
  InstallReport,
  InstallRuntime,
  InstallScope,
} from "./install/index.js";

import { compileContract } from "./contract/compile.js";
import { readBoundedPlanFile } from "./contract/limits.js";
import { confirmTTY } from "./control.js";
import {
  amendPlan,
  approvePlan,
  completePlan,
  getStatus,
  previewRollback,
  revokePlan,
  rollbackPlan,
} from "./engine.js";
import {
  DEFAULT_RECEIPT_PAGE_SIZE,
  listReceipts,
  MAX_RECEIPT_PAGE_SIZE,
  verifyReceiptLedger,
} from "./receipts/verify.js";
import type {
  CompiledContract,
  ProjectState,
  ReceiptRecord,
} from "./types.js";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_CANCELLED = 3;

const USAGE = `Usage:
  taskfence contract validate <plan-file> [--root <path>]
  taskfence approve <plan-file> [--root <path>] [--yes]
  taskfence amend <plan-file> [--root <path>] [--yes]
  taskfence status [--root <path>] [--json]
  taskfence complete [--root <path>] [--yes]
  taskfence revoke [--root <path>] --reason <text> [--yes]
  taskfence rollback [--root <path>] [--dry-run] [--yes]
  taskfence receipts verify [--root <path>] [--json]
  taskfence receipts list [--root <path>] [--json] [--limit <n>] [--cursor <token>]
  taskfence install [claude|codex|opencode|omp|pi|all ...] [--scope user|project] [--root <path>] [--json]
  taskfence uninstall [claude|codex|opencode|omp|pi|all ...] [--scope user|project] [--root <path>] [--json]
  taskfence doctor [claude|codex|opencode|omp|pi|all] [--scope user|project] [--root <path>] [--json]`;

type OptionKind = "boolean" | "value";
type OptionSchema = Readonly<Record<string, OptionKind>>;

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

type ParsedCommand =
  | { command: "contract.validate"; planFile: string; root: string }
  | { command: "approve"; planFile: string; root: string; yes: boolean }
  | { command: "amend"; planFile: string; root: string; yes: boolean }
  | { command: "status"; root: string; json: boolean }
  | { command: "complete"; root: string; yes: boolean }
  | { command: "revoke"; root: string; reason: string; yes: boolean }
  | {
      command: "rollback";
      root: string;
      dryRun: boolean;
      yes: boolean;
    }
  | { command: "receipts.verify"; root: string; json: boolean }
  | {
      command: "receipts.list";
      root: string;
      json: boolean;
      limit: number | null;
      cursor: string | null;
    }
  | {
      command: "install" | "uninstall";
      runtimes: InstallRuntime[];
      scope: InstallScope;
      root: string;
      json: boolean;
    }
  | {
      command: "doctor";
      runtime: InstallRuntime | "all";
      scope: InstallScope;
      root: string;
      json: boolean;
    }
  | { command: "hook"; runtime: "claude" | "codex" };

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function usageError(message: string): never {
  throw new CliError(message, EXIT_USAGE);
}

function parseOptions(args: readonly string[], schema: OptionSchema): ParsedOptions {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.length === 0) usageError("Arguments cannot be empty");
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }

    if (!argument.startsWith("--") || argument === "--" || argument.includes("=")) {
      usageError(`Unknown option: ${argument}`);
    }

    const name = argument.slice(2);
    if (!Object.hasOwn(schema, name)) usageError(`Unknown option: ${argument}`);
    const kind = schema[name];
    if (flags.has(name) || values.has(name)) {
      usageError(`Duplicate option: ${argument}`);
    }

    if (kind === "boolean") {
      flags.add(name);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      usageError(`Option ${argument} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }

  return { positionals, values, flags };
}

function requirePositionals(
  parsed: ParsedOptions,
  count: number,
  commandName: string,
): void {
  if (parsed.positionals.length !== count) {
    usageError(`${commandName} requires exactly ${count} positional argument${count === 1 ? "" : "s"}`);
  }
}

function commandRoot(parsed: ParsedOptions): string {
  return parsed.values.get("root") ?? process.cwd();
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const primary = argv[0];
  if (primary === undefined) usageError("A command is required");

  if (primary === "hook") {
    if (
      argv.length !== 2 ||
      (argv[1] !== "claude" && argv[1] !== "codex")
    ) {
      usageError("hook requires exactly one of claude or codex");
    }
    return { command: "hook", runtime: argv[1] };
  }

  if (primary === "install" || primary === "uninstall") {
    const parsed = parseOptions(argv.slice(1), {
      scope: "value",
      root: "value",
      json: "boolean",
    });
    const scopeValue = parsed.values.get("scope") ?? "user";
    if (scopeValue !== "user" && scopeValue !== "project") {
      usageError(`${primary} --scope must be user or project`);
    }
    if (parsed.positionals.includes("all") && parsed.positionals.length !== 1) {
      usageError(`${primary} all cannot be combined with individual runtimes`);
    }
    const requested = parsed.positionals.length === 0 ||
      parsed.positionals[0] === "all"
      ? [...INSTALL_RUNTIMES]
      : parsed.positionals;
    const invalidRuntime = requested.find((runtime) => !isInstallRuntime(runtime));
    if (invalidRuntime !== undefined) {
      usageError(`Unknown runtime: ${invalidRuntime}`);
    }
    const runtimes = requested as InstallRuntime[];
    if (new Set(runtimes).size !== runtimes.length) {
      usageError(`${primary} runtimes cannot be repeated`);
    }
    return {
      command: primary,
      runtimes,
      scope: scopeValue,
      root: commandRoot(parsed),
      json: parsed.flags.has("json"),
    };
  }

  if (primary === "doctor") {
    const parsed = parseOptions(argv.slice(1), {
      scope: "value",
      root: "value",
      json: "boolean",
    });
    if (parsed.positionals.length > 1) {
      usageError("doctor accepts at most one runtime");
    }
    const scopeValue = parsed.values.get("scope") ?? "user";
    if (scopeValue !== "user" && scopeValue !== "project") {
      usageError("doctor --scope must be user or project");
    }
    const runtime = parsed.positionals[0] ?? "all";
    if (runtime !== "all" && !isInstallRuntime(runtime)) {
      usageError(`Unknown runtime: ${runtime}`);
    }
    return {
      command: "doctor",
      runtime,
      scope: scopeValue,
      root: commandRoot(parsed),
      json: parsed.flags.has("json"),
    };
  }

  if (primary === "contract") {
    if (argv[1] !== "validate") {
      usageError("contract requires the validate subcommand");
    }
    const parsed = parseOptions(argv.slice(2), { root: "value" });
    requirePositionals(parsed, 1, "contract validate");
    return {
      command: "contract.validate",
      planFile: parsed.positionals[0],
      root: commandRoot(parsed),
    };
  }

  if (primary === "receipts") {
    const subcommand = argv[1];
    if (subcommand !== "verify" && subcommand !== "list") {
      usageError("receipts requires the verify or list subcommand");
    }
    if (subcommand === "list") {
      const parsed = parseOptions(argv.slice(2), {
        root: "value",
        json: "boolean",
        limit: "value",
        cursor: "value",
      });
      requirePositionals(parsed, 0, "receipts list");
      let limit: number | null = null;
      const limitValue = parsed.values.get("limit");
      if (limitValue !== undefined) {
        limit = Number(limitValue);
        if (!Number.isSafeInteger(limit) || limit < 1) {
          usageError("--limit must be a positive integer");
        }
        if (limit > MAX_RECEIPT_PAGE_SIZE) {
          usageError(`--limit must not exceed ${MAX_RECEIPT_PAGE_SIZE}`);
        }
      }
      return {
        command: "receipts.list",
        root: commandRoot(parsed),
        json: parsed.flags.has("json"),
        limit,
        cursor: parsed.values.get("cursor") ?? null,
      };
    }
    const parsed = parseOptions(argv.slice(2), {
      root: "value",
      json: "boolean",
    });
    requirePositionals(parsed, 0, "receipts verify");
    return {
      command: "receipts.verify",
      root: commandRoot(parsed),
      json: parsed.flags.has("json"),
    };
  }

  if (primary === "approve" || primary === "amend") {
    const parsed = parseOptions(argv.slice(1), {
      root: "value",
      yes: "boolean",
    });
    requirePositionals(parsed, 1, primary);
    return {
      command: primary,
      planFile: parsed.positionals[0],
      root: commandRoot(parsed),
      yes: parsed.flags.has("yes"),
    };
  }

  if (primary === "status") {
    const parsed = parseOptions(argv.slice(1), {
      root: "value",
      json: "boolean",
    });
    requirePositionals(parsed, 0, primary);
    return {
      command: "status",
      root: commandRoot(parsed),
      json: parsed.flags.has("json"),
    };
  }

  if (primary === "complete") {
    const parsed = parseOptions(argv.slice(1), {
      root: "value",
      yes: "boolean",
    });
    requirePositionals(parsed, 0, primary);
    return {
      command: "complete",
      root: commandRoot(parsed),
      yes: parsed.flags.has("yes"),
    };
  }

  if (primary === "revoke") {
    const parsed = parseOptions(argv.slice(1), {
      root: "value",
      reason: "value",
      yes: "boolean",
    });
    requirePositionals(parsed, 0, primary);
    const reason = parsed.values.get("reason");
    if (reason === undefined || reason.trim().length === 0) {
      usageError("revoke requires a non-empty --reason value");
    }
    return {
      command: "revoke",
      root: commandRoot(parsed),
      reason,
      yes: parsed.flags.has("yes"),
    };
  }

  if (primary === "rollback") {
    const parsed = parseOptions(argv.slice(1), {
      root: "value",
      "dry-run": "boolean",
      yes: "boolean",
    });
    requirePositionals(parsed, 0, primary);
    return {
      command: "rollback",
      root: commandRoot(parsed),
      dryRun: parsed.flags.has("dry-run"),
      yes: parsed.flags.has("yes"),
    };
  }

  usageError(`Unknown command: ${primary}`);
}

async function readPlan(planFile: string): Promise<string> {
  if (planFile.includes("\0")) usageError("Plan file path cannot contain a NUL byte");
  try {
    return await readBoundedPlanFile(planFile);
  } catch (error) {
    const detail = error instanceof Error && error.message.length > 0
      ? error.message
      : "plan file could not be read";
    usageError(detail);
  }
}

function selectorText(selector: { kind: "exact" | "subtree"; path: string }): string {
  return selector.kind === "subtree" ? `${selector.path}/**` : selector.path;
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function writeJson(value: unknown): void {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new Error("Command result is not JSON-serializable");
  }
  writeLine(serialized);
}

function writeContract(contract: CompiledContract): void {
  const lines = [
    "Contract valid",
    `root: ${contract.root}`,
    `plan hash: ${contract.planHash}`,
    `contract hash: ${contract.contractHash}`,
    `package manager: ${contract.document.packageManager}`,
    `write: ${contract.document.write.map(selectorText).join(", ") || "none"}`,
    `create: ${contract.document.create.map(selectorText).join(", ") || "none"}`,
    `delete: ${contract.document.delete.map(selectorText).join(", ") || "none"}`,
    `protected: ${contract.document.protected.map(selectorText).join(", ") || "none"}`,
    "commands:",
    ...contract.document.commands.map(
      (command) => `  ${JSON.stringify(command.argv)} (cwd: ${command.cwd})`,
    ),
  ];
  writeLine(lines.join("\n"));
}

function stateLines(state: ProjectState): string[] {
  return [
    `status: ${state.status}`,
    `root: ${state.root}`,
    `revision: ${state.revision}`,
    `generation: ${state.generation}`,
    `contract hash: ${state.contract?.contractHash ?? "none"}`,
    `checkpoint hash: ${state.checkpoint?.hash ?? "none"}`,
    `pending call: ${state.pendingMutation?.callId ?? "none"}`,
    `reason: ${state.reason ?? "none"}`,
    `updated: ${state.updatedAt}`,
  ];
}

function writeState(state: ProjectState, heading?: string): void {
  const lines = heading === undefined
    ? stateLines(state)
    : [heading, ...stateLines(state)];
  writeLine(lines.join("\n"));
}

function receiptLine(receipt: ReceiptRecord): string {
  return [
    String(receipt.sequence),
    receipt.timestamp,
    receipt.event,
    `revision=${receipt.revision}`,
    receipt.recordHash,
  ].join("\t");
}

async function requireConfirmation(prompt: string, yes: boolean): Promise<void> {
  const confirmed = await confirmTTY(prompt, { yes });
  if (!confirmed) {
    throw new CliError("Confirmation declined", EXIT_CANCELLED);
  }
}

const MAX_HOOK_STDIN_BYTES = 1_048_576;

async function readHookPayload(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_HOOK_STDIN_BYTES) {
      throw new Error(`hook input exceeds ${MAX_HOOK_STDIN_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("hook input is empty");
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`hook input is not valid JSON: ${detail}`);
  }
}

async function executeHook(runtime: "claude" | "codex"): Promise<number> {
  try {
    const payload = await readHookPayload();
    const result = runtime === "claude"
      ? await runClaudeHook(payload)
      : await runCodexHook(payload);
    if (
      !Number.isInteger(result.exitCode) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      throw new Error("adapter returned an invalid hook result");
    }
    await recordHostHeartbeat(runtime).catch(() => undefined);
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    return result.exitCode;
  } catch (error) {
    const detail = error instanceof Error && error.message.length > 0
      ? error.message
      : "unexpected internal error";
    process.stderr.write(`TaskFence ${runtime} hook failed closed: ${detail}\n`);
    return EXIT_USAGE;
  }
}

function writeInstallReports(reports: readonly InstallReport[], json: boolean): void {
  if (json) {
    writeJson(reports);
    return;
  }
  writeLine(reports.map((report) => {
    const backup = report.backupPath === undefined ? "" : `; backup ${report.backupPath}`;
    return `${report.runtime}: ${report.action} at ${report.path}${backup}`;
  }).join("\n"));
}

function doctorLines(report: RuntimeDoctorReport): string[] {
  return [
    `${report.runtime}:`,
    `  local adapter self-test: ${report.binarySelfTest.passed ? "pass" : "fail"} (${report.binarySelfTest.detail})`,
    `  configured: ${report.configured ? "yes" : "no"} (${report.configurationDetail})`,
    `  configuration path: ${report.configurationPath}`,
    `  verified recent host heartbeat: ${report.hostHeartbeat.verified ? "yes" : "no"} (${report.hostHeartbeat.detail})`,
    `  heartbeat path: ${report.hostHeartbeat.path}`,
  ];
}

async function execute(command: ParsedCommand): Promise<number> {
  switch (command.command) {
    case "hook":
      return executeHook(command.runtime);

    case "install":
    case "uninstall": {
      const reports: InstallReport[] = [];
      for (const runtime of command.runtimes) {
        reports.push(command.command === "install"
          ? await installRuntime(runtime, {
              scope: command.scope,
              root: command.root,
            })
          : await uninstallRuntime(runtime, {
              scope: command.scope,
              root: command.root,
            }));
      }
      writeInstallReports(reports, command.json);
      return EXIT_SUCCESS;
    }

    case "doctor": {
      const options = { scope: command.scope, root: command.root };
      const reports = command.runtime === "all"
        ? await doctorAll(options)
        : [await doctorRuntime(command.runtime, options)];
      if (command.json) writeJson(reports);
      else writeLine(reports.flatMap(doctorLines).join("\n"));
      return reports.every((report) =>
        report.binarySelfTest.passed &&
        report.configured &&
        report.hostHeartbeat.verified
      ) ? EXIT_SUCCESS : EXIT_FAILURE;
    }

    case "contract.validate": {
      const planText = await readPlan(command.planFile);
      writeContract(compileContract(planText, command.root));
      return EXIT_SUCCESS;
    }

    case "approve": {
      const planText = await readPlan(command.planFile);
      await requireConfirmation(
        `Approve ${command.planFile} for root ${command.root}?`,
        command.yes,
      );
      writeState(await approvePlan(planText, command.root), "Contract approved");
      return EXIT_SUCCESS;
    }

    case "amend": {
      const planText = await readPlan(command.planFile);
      await requireConfirmation(
        `Amend the active contract from ${command.planFile} for root ${command.root}?`,
        command.yes,
      );
      writeState(await amendPlan(planText, command.root), "Contract amended");
      return EXIT_SUCCESS;
    }

    case "status": {
      const state = await getStatus(command.root);
      if (command.json) writeJson(state);
      else writeState(state);
      return EXIT_SUCCESS;
    }

    case "complete": {
      await requireConfirmation(
        `Complete the active contract for root ${command.root}?`,
        command.yes,
      );
      writeState(await completePlan(command.root), "Contract completed");
      return EXIT_SUCCESS;
    }

    case "revoke": {
      await requireConfirmation(
        `Revoke the active contract for root ${command.root}?`,
        command.yes,
      );
      writeState(
        await revokePlan(command.root, command.reason),
        "Contract revoked",
      );
      return EXIT_SUCCESS;
    }

    case "rollback": {
      await requireConfirmation(
        `${command.dryRun ? "Inspect rollback" : "Rollback the active contract"} for root ${command.root}?`,
        command.yes,
      );
      if (command.dryRun) {
        const comparison = await previewRollback(command.root);
        const lines = [
          "Rollback dry run; no changes made",
          `checkpoint matches current tree: ${comparison.matches ? "yes" : "no"}`,
          `differences: ${comparison.differences.length}`,
          ...comparison.differences.map(
            (difference) => `  ${difference.reason}\t${difference.path}`,
          ),
        ];
        writeLine(lines.join("\n"));
        return EXIT_SUCCESS;
      }
      writeState(await rollbackPlan(command.root), "Rollback complete");
      return EXIT_SUCCESS;
    }

    case "receipts.verify": {
      const verification = await verifyReceiptLedger(command.root);
      if (command.json) {
        writeJson(verification);
      } else if (verification.valid) {
        writeLine(
          `Receipt ledger valid: ${verification.count} record${verification.count === 1 ? "" : "s"}; head ${verification.lastHash ?? "none"}`,
        );
      } else {
        writeLine(
          `Receipt ledger invalid at index ${verification.index}: ${verification.reason}`,
        );
      }
      return verification.valid ? EXIT_SUCCESS : EXIT_FAILURE;
    }

    case "receipts.list": {
      const page = await listReceipts(command.root, {
        limit: command.limit ?? DEFAULT_RECEIPT_PAGE_SIZE,
        cursor: command.cursor,
      });
      if (command.json) {
        // Only this bounded page is in memory; the full ledger is never
        // collected regardless of its size (up to 64 GiB).
        writeJson({ records: page.records, cursor: page.cursor });
      } else if (page.records.length === 0) {
        writeLine("No receipts.");
      } else {
        for (const receipt of page.records) writeLine(receiptLine(receipt));
        if (page.cursor !== null) {
          writeLine(`-- next page: --cursor ${page.cursor}`);
        }
      }
      return EXIT_SUCCESS;
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Unexpected error";
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await execute(parseCommand(argv));
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : EXIT_FAILURE;
    process.stderr.write(`taskfence: ${errorMessage(error)}\n`);
    if (exitCode === EXIT_USAGE) process.stderr.write(`${USAGE}\n`);
    return exitCode;
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))
) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
