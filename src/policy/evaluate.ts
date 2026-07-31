import type { CompiledContract, Decision, NormalizedToolCall, PathOperation } from "../types.js";
import { authorizeCommand } from "./commands.js";
import { authorizePath, canonicalizeObservedCwd } from "./path.js";

const PATH_OPERATIONS: Record<PathOperation, true> = {
  create: true,
  delete: true,
  write: true,
};

function deny(code: Decision["code"], reason: string): Decision {
  return { allowed: false, code, reason };
}

/**
 * Compose a deterministic decision from an already-normalized tool call. This
 * function has no side effects; filesystem access is limited to canonical path
 * resolution performed by the shared path policy.
 */
export function evaluateToolCall(
  contractOrNull: CompiledContract | null,
  call: NormalizedToolCall,
): Decision {
  if (
    typeof call !== "object" ||
    call === null ||
    typeof call.toolName !== "string" ||
    call.toolName.length === 0 ||
    typeof call.cwd !== "string" ||
    call.cwd.length === 0
  ) {
    return deny("deny_malformed_tool", "Normalized tool call is malformed");
  }

  switch (call.kind) {
    case "read":
      return { allowed: true, code: "allow_read_only", reason: "Tool is in the explicit read-only catalog" };

    case "unknown":
      return deny("deny_unknown_tool", call.reason || "Tool is not in an explicit catalog");

    case "malformed":
      return deny("deny_malformed_tool", call.reason || "Tool input is malformed");

    case "command":
      if (typeof call.command !== "string" || call.command.length === 0) {
        return deny("deny_malformed_tool", "Normalized command is missing its command string");
      }
      if (contractOrNull === null) {
        return deny("deny_contract_required", "An active contract is required for command execution");
      }
      return authorizeCommand(contractOrNull, call.command, call.cwd);

    case "mutation": {
      if (!Array.isArray(call.operations) || call.operations.length === 0) {
        return deny("deny_malformed_tool", "Normalized mutation contains no path operations");
      }
      if (contractOrNull === null) {
        return deny("deny_contract_required", "An active contract is required for mutation");
      }

      let canonicalCwd: string;
      try {
        canonicalCwd = canonicalizeObservedCwd(contractOrNull.root, call.cwd);
      } catch {
        return deny("deny_root_mismatch", "Tool working directory is not a canonical existing directory");
      }
      if (canonicalCwd !== contractOrNull.root) {
        return deny("deny_root_mismatch", "Tool working directory does not match the immutable contract root");
      }

      for (const operation of call.operations) {
        if (
          typeof operation !== "object" ||
          operation === null ||
          PATH_OPERATIONS[operation.operation] !== true ||
          typeof operation.target !== "string" ||
          operation.target.length === 0
        ) {
          return deny("deny_malformed_tool", "Normalized mutation contains a malformed path operation");
        }
        try {
          const decision = authorizePath(contractOrNull, operation.operation, operation.target);
          if (!decision.allowed) return decision;
        } catch {
          return deny("deny_internal_error", "Path authorization failed closed");
        }
      }

      return {
        allowed: true,
        code: "allow_mutation",
        reason: "Every normalized path operation is authorized",
      };
    }
  }

  const exhaustive: never = call;
  void exhaustive;
  return deny("deny_malformed_tool", "Normalized tool call kind is unsupported");
}
