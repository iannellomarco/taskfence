import type { Decision, DecisionCode } from "../types.js";

export const PATH_REASON = Object.freeze({
  authorized: "Path operation authorized",
  renameAuthorized: "Path rename authorized",
  invalidNul: "Path contains a NUL byte",
  invalidAbsolute: "Path must be root-relative POSIX syntax",
  invalidTraversal: "Path traversal is not allowed",
  invalidSyntax: "Path is not a canonical root-relative POSIX path",
  invalidSelector: "Path selector must be an exact path or end in /**",
  notFound: "Path does not exist",
  alreadyExists: "Create target already exists",
  dangling: "Path contains a dangling symbolic link",
  ambiguous: "Path cannot be resolved unambiguously",
  caseCollision: "Path casing collides with an existing entry",
  rootInvalid: "Project root is not a canonical existing directory",
  rootMismatch: "Contract root does not match the canonical project root",
  rootEscape: "Resolved path escapes the canonical project root",
  protected: "Path is protected from mutation",
  notAuthorized: "Path is not authorized for this operation",
} as const);

export type PathReason = (typeof PATH_REASON)[keyof typeof PATH_REASON];

export function pathDecision(
  allowed: boolean,
  code: DecisionCode,
  reason: PathReason,
): Decision {
  return { allowed, code, reason };
}
