import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evaluateToolCall,
  hashNormalizedToolCall,
  hashRawToolCall,
  normalizeToolCall,
} from "../src/index.js";
import type {
  CompiledContract,
  NormalizedToolCall,
  RuntimeName,
} from "../src/index.js";

interface RuntimeCase {
  runtime: RuntimeName;
  readTool: string;
  readInput: Record<string, unknown>;
  shellTool: string;
  mutationTool: string;
  mutationInput: Record<string, unknown>;
  ambiguousMutationInput: Record<string, unknown>;
  patchTool: string;
}

const runtimeCases: RuntimeCase[] = [
  {
    runtime: "claude",
    readTool: "Read",
    readInput: { file_path: "src/allowed.ts" },
    shellTool: "Bash",
    mutationTool: "Edit",
    mutationInput: { file_path: "src/allowed.ts" },
    ambiguousMutationInput: { file_path: "src/allowed.ts", path: "outside.ts" },
    patchTool: "ApplyPatch",
  },
  {
    runtime: "codex",
    readTool: "read_file",
    readInput: { path: "src/allowed.ts" },
    shellTool: "exec_command",
    mutationTool: "edit_file",
    mutationInput: { path: "src/allowed.ts" },
    ambiguousMutationInput: { path: "src/allowed.ts", filePath: "outside.ts" },
    patchTool: "apply_patch",
  },
  {
    runtime: "opencode",
    readTool: "read",
    readInput: { path: "src/allowed.ts" },
    shellTool: "bash",
    mutationTool: "edit",
    mutationInput: { filePath: "src/allowed.ts" },
    ambiguousMutationInput: { path: "src/allowed.ts", filePath: "outside.ts" },
    patchTool: "patch",
  },
  {
    runtime: "omp",
    readTool: "read",
    readInput: { path: "src/allowed.ts" },
    shellTool: "bash",
    mutationTool: "edit_file",
    mutationInput: { path: "src/allowed.ts" },
    ambiguousMutationInput: { path: "src/allowed.ts", filePath: "outside.ts" },
    patchTool: "apply_patch",
  },
  {
    runtime: "pi",
    readTool: "read",
    readInput: { path: "src/allowed.ts" },
    shellTool: "shell",
    mutationTool: "edit",
    mutationInput: { path: "src/allowed.ts" },
    ambiguousMutationInput: { path: "src/allowed.ts", filePath: "outside.ts" },
    patchTool: "apply_patch",
  },
];

let sandbox: string;
let root: string;
let nestedCwd: string;
let contract: CompiledContract;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "taskfence-tool-policy-"));
  root = realpathSync.native(sandbox);
  nestedCwd = join(root, "src");
  mkdirSync(join(root, "src", "protected"), { recursive: true });
  writeFileSync(join(root, "src", "allowed.ts"), "export {};\n");
  writeFileSync(join(root, "src", "protected", "secret.ts"), "secret\n");
  writeFileSync(join(root, "outside.ts"), "outside\n");
  nestedCwd = realpathSync.native(nestedCwd);

  contract = {
    version: 1,
    root,
    rootHash: "root",
    planHash: "plan",
    contractHash: "contract",
    document: {
      version: 1,
      write: [{ kind: "subtree", path: "src" }],
      create: [{ kind: "subtree", path: "src" }],
      delete: [{ kind: "subtree", path: "src" }],
      protected: [{ kind: "subtree", path: "src/protected" }],
      commands: [{ argv: ["git", "status", "--short"], cwd: root }],
      packageManager: "none",
    },
  };
});

afterAll(() => {
  rmSync(sandbox, { force: true, recursive: true });
});

describe("normalizeToolCall runtime catalogs", () => {
  it.each(runtimeCases)("normalizes $runtime read-only tools and allows them without a contract", (entry) => {
    const call = normalizeToolCall(
      entry.runtime,
      entry.readTool,
      entry.readInput,
      root,
      "session-1",
      "call-1",
    );

    expect(call).toMatchObject({
      runtime: entry.runtime,
      toolName: entry.readTool,
      cwd: root,
      sessionId: "session-1",
      callId: "call-1",
      kind: "read",
    });
    expect(evaluateToolCall(null, call)).toMatchObject({
      allowed: true,
      code: "allow_read_only",
    });
  });

  it.each(runtimeCases)("normalizes $runtime mutation tools to concrete path operations", (entry) => {
    const call = normalizeToolCall(
      entry.runtime,
      entry.mutationTool,
      entry.mutationInput,
      root,
      "session-1",
      "call-1",
    );

    expect(call).toMatchObject({
      runtime: entry.runtime,
      toolName: entry.mutationTool,
      cwd: root,
      sessionId: "session-1",
      callId: "call-1",
      kind: "mutation",
      operations: [{ operation: "write", target: "src/allowed.ts" }],
    });
    expect(evaluateToolCall(contract, call)).toMatchObject({
      allowed: true,
      code: "allow_mutation",
    });
  });

  it.each(runtimeCases)("normalizes $runtime shell tools without executing or rewriting the raw command", (entry) => {
    const command = 'git status --short';
    const call = normalizeToolCall(
      entry.runtime,
      entry.shellTool,
      { command, workdir: "." },
      root,
      "session-1",
      "call-1",
    );

    expect(call).toMatchObject({
      runtime: entry.runtime,
      toolName: entry.shellTool,
      cwd: root,
      kind: "command",
      command,
    });
    expect(evaluateToolCall(contract, call)).toMatchObject({
      allowed: true,
      code: "allow_command",
    });
  });

  it.each(runtimeCases)("classifies unknown $runtime tools as unknown rather than read-only", (entry) => {
    const call = normalizeToolCall(
      entry.runtime,
      `${entry.readTool}_untrusted`,
      entry.readInput,
      root,
      "session-1",
      "call-1",
    );

    expect(call.kind).toBe("unknown");
    expect(evaluateToolCall(contract, call)).toMatchObject({
      allowed: false,
      code: "deny_unknown_tool",
    });
  });

  it.each(runtimeCases)("fails closed on adversarial $runtime raw inputs", (entry) => {
    const calls = [
      normalizeToolCall(entry.runtime, entry.readTool, null, root, "session-1", "call-1"),
      normalizeToolCall(entry.runtime, entry.readTool, {}, root, "session-1", "call-1"),
      normalizeToolCall(
        entry.runtime,
        entry.shellTool,
        { command: "git status", cmd: "rm -rf ." },
        root,
        "session-1",
        "call-1",
      ),
      normalizeToolCall(
        entry.runtime,
        entry.shellTool,
        { command: ["git", "status"] },
        root,
        "session-1",
        "call-1",
      ),
      normalizeToolCall(
        entry.runtime,
        entry.shellTool,
        { command: "git status", cwd: root, workdir: root },
        root,
        "session-1",
        "call-1",
      ),
      normalizeToolCall(
        entry.runtime,
        entry.shellTool,
        { command: "git status", background: true },
        root,
        "session-1",
        "call-1",
      ),
      normalizeToolCall(
        entry.runtime,
        entry.mutationTool,
        entry.ambiguousMutationInput,
        root,
        "session-1",
        "call-1",
      ),
      normalizeToolCall(
        entry.runtime,
        entry.patchTool,
        { patch: "*** Begin Patch\n*** Run File: src/allowed.ts\n*** End Patch" },
        root,
        "session-1",
        "call-1",
      ),
    ];

    for (const call of calls) {
      expect(call.kind).toBe("malformed");
      expect(evaluateToolCall(contract, call)).toMatchObject({
        allowed: false,
        code: "deny_malformed_tool",
      });
    }
  });

  it.each(runtimeCases)("rejects empty $runtime session and call identities", (entry) => {
    expect(
      normalizeToolCall(entry.runtime, entry.mutationTool, entry.mutationInput, root, "", "call-1").kind,
    ).toBe("malformed");
    expect(
      normalizeToolCall(entry.runtime, entry.shellTool, { command: "git status" }, root, "session-1", "").kind,
    ).toBe("malformed");
  });
});

describe("evaluateToolCall", () => {
  it("requires an active contract for commands and mutations", () => {
    const command = normalizeToolCall(
      "claude",
      "Bash",
      { command: "git status --short" },
      root,
      "session-1",
      "call-1",
    );
    const mutation = normalizeToolCall(
      "claude",
      "Edit",
      { file_path: "src/allowed.ts" },
      root,
      "session-1",
      "call-2",
    );

    expect(evaluateToolCall(null, command)).toMatchObject({
      allowed: false,
      code: "deny_contract_required",
    });
    expect(evaluateToolCall(null, mutation)).toMatchObject({
      allowed: false,
      code: "deny_contract_required",
    });
  });

  it("denies protected and out-of-scope mutations after normalization", () => {
    const protectedCall = normalizeToolCall(
      "claude",
      "Edit",
      { file_path: "src/protected/secret.ts" },
      root,
      "session-1",
      "call-protected",
    );
    const outOfScopeCall = normalizeToolCall(
      "codex",
      "edit_file",
      { path: "outside.ts" },
      root,
      "session-1",
      "call-outside",
    );

    expect(evaluateToolCall(contract, protectedCall)).toMatchObject({
      allowed: false,
      code: "deny_protected_path",
    });
    expect(evaluateToolCall(contract, outOfScopeCall)).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });

  it("rejects mutations observed from a cwd other than the immutable root", () => {
    const call = normalizeToolCall(
      "omp",
      "edit",
      { path: "allowed.ts" },
      nestedCwd,
      "session-1",
      "call-1",
    );

    expect(evaluateToolCall(contract, call)).toMatchObject({
      allowed: false,
      code: "deny_root_mismatch",
    });
  });

  it("requires every operation in a normalized patch to be authorized", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/allowed.ts",
      "@@",
      "-export {};",
      "+export const allowed = true;",
      "*** Update File: src/protected/secret.ts",
      "@@",
      "-secret",
      "+changed",
      "*** End Patch",
    ].join("\n");
    const call = normalizeToolCall(
      "pi",
      "apply_patch",
      { patch },
      root,
      "session-1",
      "call-1",
    );

    expect(call).toMatchObject({
      kind: "mutation",
      operations: [
        { operation: "write", target: "src/allowed.ts" },
        { operation: "write", target: "src/protected/secret.ts" },
      ],
    });
    expect(evaluateToolCall(contract, call)).toMatchObject({
      allowed: false,
      code: "deny_protected_path",
    });
  });

  it("applies command policy from normalized kind, independent of tool labels", () => {
    const approved: NormalizedToolCall = {
      runtime: "claude",
      toolName: "Read",
      cwd: root,
      sessionId: "session-1",
      callId: "call-1",
      kind: "command",
      command: "git status --short",
    };
    const denied: NormalizedToolCall = {
      ...approved,
      runtime: "codex",
      toolName: "totally_unknown_tool",
      command: "git diff",
    };

    expect(evaluateToolCall(contract, approved)).toMatchObject({
      allowed: true,
      code: "allow_command",
    });
    expect(evaluateToolCall(contract, denied)).toMatchObject({
      allowed: false,
      code: "deny_command_not_approved",
    });
  });

  it("fails closed when normalized tool identity or cwd is missing", () => {
    const calls = [
      {
        runtime: "claude",
        toolName: "",
        cwd: root,
        kind: "read",
      },
      {
        runtime: "codex",
        toolName: "read_file",
        cwd: "",
        kind: "read",
      },
    ] as NormalizedToolCall[];

    for (const call of calls) {
      expect(evaluateToolCall(contract, call)).toMatchObject({
        allowed: false,
        code: "deny_malformed_tool",
      });
    }
  });

  it("rejects malformed normalized commands and mutations", () => {
    const missingCommand = {
      runtime: "claude",
      toolName: "Bash",
      cwd: root,
      kind: "command",
    } as NormalizedToolCall;
    const emptyMutation: NormalizedToolCall = {
      runtime: "codex",
      toolName: "edit_file",
      cwd: root,
      kind: "mutation",
      operations: [],
    };

    expect(evaluateToolCall(contract, missingCommand)).toMatchObject({
      allowed: false,
      code: "deny_malformed_tool",
    });
    expect(evaluateToolCall(contract, emptyMutation)).toMatchObject({
      allowed: false,
      code: "deny_malformed_tool",
    });
  });
  it("hashes normalized calls deterministically and distinctly from raw host input", () => {
    const first: NormalizedToolCall = {
      runtime: "claude",
      toolName: "Edit",
      cwd: root,
      sessionId: "session-1",
      callId: "call-1",
      kind: "mutation",
      operations: [{ operation: "write", target: "src/allowed.ts" }],
    };
    const equivalent: NormalizedToolCall = {
      ...first,
      operations: [{ operation: "write", target: "src/allowed.ts" }],
    };
    const different: NormalizedToolCall = {
      ...first,
      operations: [{ operation: "delete", target: "src/allowed.ts" }],
    };

    expect(hashNormalizedToolCall(equivalent)).toBe(hashNormalizedToolCall(first));
    expect(hashNormalizedToolCall(different)).not.toBe(hashNormalizedToolCall(first));
    expect(hashNormalizedToolCall(first)).not.toBe(hashRawToolCall({
      runtime: "claude",
      toolName: "Edit",
      input: { file_path: "src/allowed.ts" },
      cwd: root,
      sessionId: "session-1",
      callId: "call-1",
    }));
    expect(hashNormalizedToolCall(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

});
