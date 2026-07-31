import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import path from "node:path";

export type PathResolutionCode =
  | "invalid_nul"
  | "invalid_absolute"
  | "invalid_traversal"
  | "invalid_syntax"
  | "not_found"
  | "dangling_symlink"
  | "ambiguous_path"
  | "case_collision"
  | "symbolic_link"
  | "hard_link"
  | "invalid_root"
  | "root_mismatch"
  | "root_escape";

export class PathResolutionError extends Error {
  readonly code: PathResolutionCode;

  constructor(code: PathResolutionCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathResolutionError";
    this.code = code;
  }
}

export interface ResolveTargetOptions {
  mustExist: boolean;
}

export interface MutationTargetFacts {
  readonly exists: boolean;
  readonly hasSymlinkComponent: boolean;
  readonly hasMultipleHardLinks: boolean;
}

function fail(
  code: PathResolutionCode,
  message: string,
  cause?: unknown,
): never {
  throw new PathResolutionError(code, message, cause === undefined ? undefined : { cause });
}

function hasNodeCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function assertString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_syntax", `${label} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    fail("invalid_nul", `${label} contains a NUL byte`);
  }
}

export function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function assertContained(root: string, candidate: string): void {
  if (!isContainedPath(root, candidate)) {
    fail("root_escape", "resolved path escapes the canonical project root");
  }
}

function realpathExisting(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch (error) {
    if (hasNodeCode(error, "ENOENT")) {
      try {
        lstatSync(candidate);
      } catch (inspectionError) {
        if (hasNodeCode(inspectionError, "ENOENT")) {
          fail("not_found", "path does not exist", error);
        }
        fail("ambiguous_path", "path cannot be inspected", inspectionError);
      }
      fail("dangling_symlink", "path contains a dangling symbolic link", error);
    }
    if (hasNodeCode(error, "ELOOP")) {
      fail("ambiguous_path", "path contains a symbolic-link loop", error);
    }
    if (hasNodeCode(error, "ENOTDIR")) {
      fail("ambiguous_path", "a path ancestor is not a directory", error);
    }
    fail("ambiguous_path", "path cannot be resolved unambiguously", error);
  }
}

export function canonicalizeRoot(root: string): string {
  assertString(root, "project root");
  if (!path.isAbsolute(root)) {
    fail("invalid_root", "project root must be absolute");
  }

  let canonical: string;
  try {
    canonical = realpathExisting(root);
  } catch (error) {
    if (error instanceof PathResolutionError) {
      fail("invalid_root", "project root must be an existing directory", error);
    }
    throw error;
  }

  try {
    if (!statSync(canonical).isDirectory()) {
      fail("invalid_root", "project root must be a directory");
    }
  } catch (error) {
    if (error instanceof PathResolutionError) throw error;
    fail("invalid_root", "project root must be an existing directory", error);
  }
  return canonical;
}

export function validateCanonicalRoot(root: string): string {
  const canonical = canonicalizeRoot(root);
  if (canonical !== root) {
    fail("root_mismatch", "project root is not canonical");
  }
  return canonical;
}

export function canonicalizeObservedCwd(root: string, cwd: string): string {
  const canonicalRoot = validateCanonicalRoot(root);
  assertString(cwd, "observed cwd");
  if (!path.isAbsolute(cwd)) {
    fail("invalid_absolute", "observed cwd must be absolute");
  }

  const canonicalCwd = realpathExisting(cwd);
  let isDirectory = false;
  try {
    isDirectory = statSync(canonicalCwd).isDirectory();
  } catch (error) {
    fail("ambiguous_path", "observed cwd cannot be inspected", error);
  }
  if (!isDirectory) {
    fail("ambiguous_path", "observed cwd is not a directory");
  }
  assertContained(canonicalRoot, canonicalCwd);
  const lexicalRelative = path.relative(canonicalRoot, cwd);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRelative)
  ) {
    fail("root_escape", "observed cwd is not rooted in the project");
  }
  if (lexicalRelative !== "") {
    assertExactCaseAndContainment(canonicalRoot, lexicalRelative.split(path.sep));
  }
  return canonicalCwd;
}

export function parseRootRelativePosix(target: string): readonly string[] {
  assertString(target, "path");
  if (
    target.startsWith("/") ||
    target.startsWith("\\") ||
    /^[A-Za-z]:/.test(target) ||
    path.posix.isAbsolute(target)
  ) {
    fail("invalid_absolute", "path must be root-relative");
  }
  if (target.includes("\\")) {
    fail("invalid_syntax", "path must use POSIX separators");
  }

  const segments = target.split("/");
  if (segments.some((segment) => segment === "" || segment === ".")) {
    fail("invalid_syntax", "path is not in canonical root-relative POSIX form");
  }
  if (segments.some((segment) => segment === "..")) {
    fail("invalid_traversal", "path traversal is not allowed");
  }
  return segments;
}

function foldedName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function readEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasNodeCode(error, "ENOTDIR")) {
      fail("ambiguous_path", "a path ancestor is not a directory", error);
    }
    fail("ambiguous_path", "a path ancestor cannot be inspected", error);
  }
}

function assertExactCaseAndContainment(
  root: string,
  segments: readonly string[],
): void {
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const canonicalCurrent = realpathExisting(current);
    assertContained(root, canonicalCurrent);
    const entries = readEntries(current);
    const requested = segments[index]!;
    const exact = entries.find((entry) => entry.name === requested);

    if (!exact) {
      const folded = foldedName(requested);
      if (entries.some((entry) => foldedName(entry.name) === folded)) {
        fail("case_collision", "path casing collides with an existing entry");
      }
      return;
    }

    current = path.join(current, exact.name);
    if (index < segments.length - 1 && !exact.isDirectory() && !exact.isSymbolicLink()) {
      fail("ambiguous_path", "a path ancestor is not a directory");
    }
  }
}

function lstatOrMissing(candidate: string): "exists" | "missing" {
  try {
    lstatSync(candidate);
    return "exists";
  } catch (error) {
    if (hasNodeCode(error, "ENOENT")) return "missing";
    if (hasNodeCode(error, "ENOTDIR")) {
      fail("ambiguous_path", "a path ancestor is not a directory", error);
    }
    fail("ambiguous_path", "path cannot be inspected", error);
  }
}

export function targetExists(target: string): boolean {
  return lstatOrMissing(target) === "exists";
}

export function inspectMutationTarget(
  root: string,
  target: string,
): MutationTargetFacts {
  const canonicalRoot = validateCanonicalRoot(root);
  const segments = parseRootRelativePosix(target);
  let current = canonicalRoot;
  let hasSymlinkComponent = false;
  let metadata: Stats | undefined;

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (hasNodeCode(error, "ENOENT")) {
        return {
          exists: false,
          hasSymlinkComponent,
          hasMultipleHardLinks: false,
        };
      }
      if (hasNodeCode(error, "ENOTDIR")) {
        fail("ambiguous_path", "a path ancestor is not a directory", error);
      }
      fail("ambiguous_path", "path cannot be inspected", error);
    }
    if (metadata.isSymbolicLink()) hasSymlinkComponent = true;
  }

  return {
    exists: true,
    hasSymlinkComponent,
    hasMultipleHardLinks:
      metadata !== undefined && metadata.isFile() && metadata.nlink > 1,
  };
}

export function resolveTarget(
  root: string,
  target: string,
  options: ResolveTargetOptions,
): string {
  const canonicalRoot = validateCanonicalRoot(root);
  const segments = parseRootRelativePosix(target);
  assertExactCaseAndContainment(canonicalRoot, segments);

  const lexicalTarget = path.join(canonicalRoot, ...segments);
  const existence = lstatOrMissing(lexicalTarget);
  if (existence === "exists") {
    const canonicalTarget = realpathExisting(lexicalTarget);
    assertContained(canonicalRoot, canonicalTarget);
    return canonicalTarget;
  }
  if (options.mustExist) {
    fail("not_found", "path does not exist");
  }

  let ancestor = lexicalTarget;
  const missing: string[] = [];
  while (lstatOrMissing(ancestor) === "missing") {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      fail("root_escape", "cannot find an existing ancestor inside the project root");
    }
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }

  const canonicalAncestor = realpathExisting(ancestor);
  assertContained(canonicalRoot, canonicalAncestor);
  let ancestorIsDirectory = false;
  try {
    ancestorIsDirectory = statSync(canonicalAncestor).isDirectory();
  } catch (error) {
    fail("ambiguous_path", "nearest existing ancestor cannot be inspected", error);
  }
  if (!ancestorIsDirectory) {
    fail("ambiguous_path", "nearest existing ancestor is not a directory");
  }

  const resolved = path.join(canonicalAncestor, ...missing);
  assertContained(canonicalRoot, resolved);
  return resolved;
}
