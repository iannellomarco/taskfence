import path from "node:path";
import type {
  CompiledContract,
  Decision,
  DecisionCode,
  PathOperation,
  PathSelector,
} from "../types.js";
import { PATH_REASON, pathDecision, type PathReason } from "./reasons.js";
import {
  inspectMutationTarget,
  PathResolutionError,
  parseRootRelativePosix,
  resolveTarget,
  validateCanonicalRoot,
} from "./realpath.js";

export {
  PathResolutionError,
  canonicalizeObservedCwd,
  canonicalizeRoot,
  resolveTarget,
  validateCanonicalRoot,
} from "./realpath.js";

const ALLOW_MUTATION: DecisionCode = "allow_mutation";
const DENY_PATH: DecisionCode = "deny_path";
const DENY_PROTECTED_PATH: DecisionCode = "deny_protected_path";
const DENY_ROOT_MISMATCH: DecisionCode = "deny_root_mismatch";

function invalidPathDecision(error: unknown): Decision {
  if (!(error instanceof PathResolutionError)) {
    return pathDecision(false, DENY_PATH, PATH_REASON.ambiguous);
  }

  let reason: PathReason;
  switch (error.code) {
    case "invalid_nul":
      reason = PATH_REASON.invalidNul;
      break;
    case "invalid_absolute":
      reason = PATH_REASON.invalidAbsolute;
      break;
    case "invalid_traversal":
      reason = PATH_REASON.invalidTraversal;
      break;
    case "invalid_syntax":
      reason = PATH_REASON.invalidSyntax;
      break;
    case "not_found":
      reason = PATH_REASON.notFound;
      break;
    case "dangling_symlink":
      reason = PATH_REASON.dangling;
      break;
    case "ambiguous_path":
      reason = PATH_REASON.ambiguous;
      break;
    case "case_collision":
      reason = PATH_REASON.caseCollision;
      break;
    case "symbolic_link":
    case "hard_link":
      reason = PATH_REASON.ambiguous;
      break;
    case "invalid_root":
      return pathDecision(false, DENY_ROOT_MISMATCH, PATH_REASON.rootInvalid);
    case "root_mismatch":
      return pathDecision(false, DENY_ROOT_MISMATCH, PATH_REASON.rootMismatch);
    case "root_escape":
      return pathDecision(false, DENY_ROOT_MISMATCH, PATH_REASON.rootEscape);
  }
  return pathDecision(false, DENY_PATH, reason);
}

function selectorPath(selector: PathSelector): string {
  if (
    selector.path !== selector.path.normalize("NFC") ||
    /%(?:2e|2f|5c)/i.test(selector.path)
  ) {
    throw new PathResolutionError("invalid_syntax", PATH_REASON.invalidSelector);
  }
  const segments = parseRootRelativePosix(selector.path);
  if (segments.some((segment) => /[*?[\]{}]/.test(segment))) {
    throw new PathResolutionError("invalid_syntax", PATH_REASON.invalidSelector);
  }
  return segments.join("/");
}

export function normalizeSelector(selector: string | PathSelector): PathSelector {
  if (typeof selector === "string") {
    if (selector.endsWith("/**")) {
      const base = selector.slice(0, -3);
      return { kind: "subtree", path: selectorPath({ kind: "subtree", path: base }) };
    }
    return { kind: "exact", path: selectorPath({ kind: "exact", path: selector }) };
  }

  if (
    typeof selector !== "object" ||
    selector === null ||
    typeof selector.path !== "string" ||
    (selector.kind !== "exact" && selector.kind !== "subtree")
  ) {
    throw new PathResolutionError("invalid_syntax", PATH_REASON.invalidSelector);
  }
  return { kind: selector.kind, path: selectorPath(selector) };
}

export function selectorMatches(
  selector: PathSelector,
  relativePath: string,
): boolean {
  const normalizedSelector = normalizeSelector(selector);
  const normalizedPath = parseRootRelativePosix(relativePath).join("/");
  return normalizedSelector.kind === "exact"
    ? normalizedPath === normalizedSelector.path
    : normalizedPath === normalizedSelector.path ||
        normalizedPath.startsWith(`${normalizedSelector.path}/`);
}

interface PreparedTarget {
  readonly relative: string;
  readonly physicalRelative: string;
  readonly exists: boolean;
  readonly hasSymlinkComponent: boolean;
  readonly hasMultipleHardLinks: boolean;
}

function canonicalContractRoot(contract: CompiledContract): string {
  try {
    return validateCanonicalRoot(contract.root);
  } catch (error) {
    throw new PathResolutionError(
      "root_mismatch",
      "contract root does not match the canonical project root",
      { cause: error },
    );
  }
}

function prepareTarget(
  canonicalRoot: string,
  relative: string,
  segments: readonly string[],
  mustExist: boolean,
): PreparedTarget {
  const resolved = resolveTarget(canonicalRoot, relative, { mustExist });
  const facts = inspectMutationTarget(canonicalRoot, relative);
  const physicalRelative = path
    .relative(canonicalRoot, resolved)
    .split(path.sep)
    .join("/");
  return {
    relative,
    physicalRelative,
    exists: facts.exists,
    hasSymlinkComponent: facts.hasSymlinkComponent,
    hasMultipleHardLinks: facts.hasMultipleHardLinks,
  };
}

function matchesAny(selectors: readonly PathSelector[], relative: string): boolean {
  return selectors.some((selector) => selectorMatches(selector, relative));
}

function matchesProtected(
  selectors: readonly PathSelector[],
  prepared: PreparedTarget,
): boolean {
  return (
    matchesAny(selectors, prepared.relative) ||
    (prepared.physicalRelative !== prepared.relative &&
      prepared.physicalRelative !== "" &&
      matchesAny(selectors, prepared.physicalRelative))
  );
}


function operationSelectors(
  contract: CompiledContract,
  operation: PathOperation,
): readonly PathSelector[] {
  switch (operation) {
    case "write":
      return contract.document.write;
    case "create":
      return contract.document.create;
    case "delete":
      return contract.document.delete;
  }
}

function authorizePrepared(
  contract: CompiledContract,
  operation: PathOperation,
  prepared: PreparedTarget,
): Decision {
  if (matchesProtected(contract.document.protected, prepared)) {
    return pathDecision(false, DENY_PROTECTED_PATH, PATH_REASON.protected);
  }
  if (
    prepared.hasSymlinkComponent ||
    prepared.physicalRelative !== prepared.relative
  ) {
    return pathDecision(false, DENY_PATH, PATH_REASON.ambiguous);
  }
  if (prepared.hasMultipleHardLinks) {
    return pathDecision(false, DENY_PATH, PATH_REASON.ambiguous);
  }
  if (operation === "create" && prepared.exists) {
    return pathDecision(false, DENY_PATH, PATH_REASON.alreadyExists);
  }
  if (!matchesAny(operationSelectors(contract, operation), prepared.relative)) {
    return pathDecision(false, DENY_PATH, PATH_REASON.notAuthorized);
  }
  return pathDecision(true, ALLOW_MUTATION, PATH_REASON.authorized);
}

export function authorizePath(
  contract: CompiledContract,
  operation: PathOperation,
  target: string,
): Decision {
  try {
    const canonicalRoot = canonicalContractRoot(contract);
    const segments = parseRootRelativePosix(target);
    const relative = segments.join("/");
    if (matchesAny(contract.document.protected, relative)) {
      return pathDecision(false, DENY_PROTECTED_PATH, PATH_REASON.protected);
    }
    const prepared = prepareTarget(
      canonicalRoot,
      relative,
      segments,
      operation !== "create",
    );
    return authorizePrepared(contract, operation, prepared);
  } catch (error) {
    return invalidPathDecision(error);
  }
}

export function authorizeWrite(
  contract: CompiledContract,
  target: string,
): Decision {
  return authorizePath(contract, "write", target);
}

export function authorizeCreate(
  contract: CompiledContract,
  target: string,
): Decision {
  return authorizePath(contract, "create", target);
}

export function authorizeDelete(
  contract: CompiledContract,
  target: string,
): Decision {
  return authorizePath(contract, "delete", target);
}

export function authorizeRename(
  contract: CompiledContract,
  source: string,
  destination: string,
): Decision {
  try {
    const canonicalRoot = canonicalContractRoot(contract);
    const sourceSegments = parseRootRelativePosix(source);
    const sourceRelative = sourceSegments.join("/");
    if (matchesAny(contract.document.protected, sourceRelative)) {
      return pathDecision(false, DENY_PROTECTED_PATH, PATH_REASON.protected);
    }

    const destinationSegments = parseRootRelativePosix(destination);
    const destinationRelative = destinationSegments.join("/");
    if (matchesAny(contract.document.protected, destinationRelative)) {
      return pathDecision(false, DENY_PROTECTED_PATH, PATH_REASON.protected);
    }

    const preparedSource = prepareTarget(
      canonicalRoot,
      sourceRelative,
      sourceSegments,
      true,
    );
    const preparedDestination = prepareTarget(
      canonicalRoot,
      destinationRelative,
      destinationSegments,
      false,
    );

    if (
      matchesProtected(contract.document.protected, preparedSource) ||
      matchesProtected(contract.document.protected, preparedDestination)
    ) {
      return pathDecision(false, DENY_PROTECTED_PATH, PATH_REASON.protected);
    }
    if (
      preparedSource.hasSymlinkComponent ||
      preparedDestination.hasSymlinkComponent ||
      preparedSource.physicalRelative !== preparedSource.relative ||
      preparedDestination.physicalRelative !== preparedDestination.relative ||
      preparedSource.hasMultipleHardLinks ||
      preparedDestination.hasMultipleHardLinks
    ) {
      return pathDecision(false, DENY_PATH, PATH_REASON.ambiguous);
    }
    if (preparedDestination.exists) {
      return pathDecision(false, DENY_PATH, PATH_REASON.alreadyExists);
    }
    if (!matchesAny(contract.document.delete, preparedSource.relative)) {
      return pathDecision(false, DENY_PATH, PATH_REASON.notAuthorized);
    }
    if (!matchesAny(contract.document.create, preparedDestination.relative)) {
      return pathDecision(false, DENY_PATH, PATH_REASON.notAuthorized);
    }
    return pathDecision(true, ALLOW_MUTATION, PATH_REASON.renameAuthorized);
  } catch (error) {
    return invalidPathDecision(error);
  }
}
