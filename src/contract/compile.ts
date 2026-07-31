import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  CommandRule,
  CompiledContract,
  ContractDocument,
  PackageManager,
  PathSelector,
} from "../types.js";
import { canonicalStringify, sha256 } from "./canonical.js";
import { extractContractBlock, parseContractJson } from "./extract.js";
import {
  contractDocumentSchema,
  type RawContractDocument,
} from "./schema.js";
import { validateCommandArgv } from "../policy/commands.js";

export const PROTECTED_SELECTOR_DEFAULTS = Object.freeze([
  ".git/**",
  ".taskfence/**",
  ".claude/**",
  ".codex/**",
  ".opencode/**",
  ".omp/**",
  ".pi/**",
] as const);


function canonicalizeRoot(root: string): string {
  if (root.length === 0 || root.includes("\0")) {
    throw new Error("Contract root must be a non-empty filesystem path");
  }
  const canonicalRoot = realpathSync.native(resolve(root));
  if (!statSync(canonicalRoot).isDirectory()) {
    throw new Error("Contract root must be an existing directory");
  }
  return canonicalRoot;
}

function normalizeSelector(source: string): PathSelector {
  if (source.includes("\0") || source.includes("\\")) {
    throw new Error(`Invalid path selector ${JSON.stringify(source)}`);
  }
  if (
    source.length === 0 ||
    source.startsWith("/") ||
    /^[A-Za-z]:/.test(source) ||
    /%(?:2e|2f|5c)/i.test(source)
  ) {
    throw new Error(`Path selector must be an unencoded relative POSIX path: ${source}`);
  }

  const kind = source.endsWith("/**") ? "subtree" : "exact";
  const rawPath = kind === "subtree" ? source.slice(0, -3) : source;
  const normalizedPath = rawPath.normalize("NFC");
  const segments = normalizedPath.split("/");
  if (
    rawPath !== normalizedPath ||
    normalizedPath.length === 0 ||
    normalizedPath.endsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[*?\[\]{}]/.test(normalizedPath)
  ) {
    throw new Error(`Invalid exact/subtree path selector: ${source}`);
  }

  return { kind, path: normalizedPath };
}

function normalizeSelectorList(
  sources: string[],
  label: string,
): PathSelector[] {
  const selectors = sources.map(normalizeSelector);
  const seen = new Set<string>();
  for (const selector of selectors) {
    const key = `${selector.kind}:${selector.path}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate ${label} selector: ${selector.path}`);
    }
    seen.add(key);
  }
  return selectors.sort((left, right) => {
    const leftKey = `${left.path}\u0000${left.kind}`;
    const rightKey = `${right.path}\u0000${right.kind}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function canonicalizeCommandCwd(root: string, declaredCwd: string): string {
  if (declaredCwd.includes("\0") || declaredCwd.includes("\\")) {
    throw new Error(`Invalid command cwd ${JSON.stringify(declaredCwd)}`);
  }

  let target: string;
  if (declaredCwd === ".") {
    target = root;
  } else {
    const cwdSelector = normalizeSelector(declaredCwd);
    if (cwdSelector.kind !== "exact") {
      throw new Error("Command cwd cannot be a subtree selector");
    }
    target = join(root, ...cwdSelector.path.split("/"));
  }

  const canonicalCwd = realpathSync.native(target);
  if (!statSync(canonicalCwd).isDirectory() || !isWithinRoot(root, canonicalCwd)) {
    throw new Error(`Command cwd is not a directory inside the contract root: ${declaredCwd}`);
  }
  return canonicalCwd;
}


function normalizeCommands(
  commands: RawContractDocument["commands"],
  packageManager: PackageManager,
  root: string,
): CommandRule[] {
  const normalized = commands.map((command) => {
    if (command.argv.some((argument) => argument.includes("\0"))) {
      throw new Error("Command argv cannot contain NUL bytes");
    }
    const validatedPackageManager = validateCommandArgv(
      command.argv,
      packageManager,
    );
    const cwd = canonicalizeCommandCwd(root, command.cwd);
    if (validatedPackageManager !== null && cwd !== root) {
      throw new Error("Package-manager commands must use the canonical contract root");
    }
    return { argv: [...command.argv], cwd };
  });

  const commandKeys = new Set<string>();
  for (const command of normalized) {
    const key = canonicalStringify(command);
    if (commandKeys.has(key)) {
      throw new Error(`Duplicate command rule: ${key}`);
    }
    commandKeys.add(key);
  }

  return normalized.sort((left, right) => {
    const leftKey = canonicalStringify(left);
    const rightKey = canonicalStringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function freezeCompiledContract(contract: CompiledContract): CompiledContract {
  const selectorLists = [
    contract.document.write,
    contract.document.create,
    contract.document.delete,
    contract.document.protected,
  ];
  for (const selectors of selectorLists) {
    for (const selector of selectors) Object.freeze(selector);
    Object.freeze(selectors);
  }
  for (const command of contract.document.commands) {
    Object.freeze(command.argv);
    Object.freeze(command);
  }
  Object.freeze(contract.document.commands);
  Object.freeze(contract.document);
  return Object.freeze(contract);
}

export function compileContract(planText: string, root: string): CompiledContract {
  const canonicalRoot = canonicalizeRoot(root);
  const block = extractContractBlock(planText);
  const rawDocument = contractDocumentSchema.parse(parseContractJson(block));

  const suppliedProtected = normalizeSelectorList(
    rawDocument.protected,
    "protected",
  );
  const protectedByKey = new Map<string, PathSelector>();
  for (const source of PROTECTED_SELECTOR_DEFAULTS) {
    const selector = normalizeSelector(source);
    protectedByKey.set(`${selector.kind}:${selector.path}`, selector);
  }
  for (const selector of suppliedProtected) {
    protectedByKey.set(`${selector.kind}:${selector.path}`, selector);
  }

  const document: ContractDocument = {
    version: 1,
    write: normalizeSelectorList(rawDocument.write, "write"),
    create: normalizeSelectorList(rawDocument.create, "create"),
    delete: normalizeSelectorList(rawDocument.delete, "delete"),
    protected: Array.from(protectedByKey.values()).sort((left, right) => {
      const leftKey = `${left.path}\u0000${left.kind}`;
      const rightKey = `${right.path}\u0000${right.kind}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
    commands: normalizeCommands(
      rawDocument.commands,
      rawDocument.packageManager,
      canonicalRoot,
    ),
    packageManager: rawDocument.packageManager,
  };

  const rootHash = sha256(canonicalRoot);
  const planHash = sha256(planText);
  const contractPayload = {
    version: 1 as const,
    root: canonicalRoot,
    rootHash,
    planHash,
    document,
  };
  const compiled: CompiledContract = {
    ...contractPayload,
    contractHash: sha256(canonicalStringify(contractPayload)),
  };
  return freezeCompiledContract(compiled);
}
