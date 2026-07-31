import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TestContext } from "vitest";

import { compileContract } from "../src/contract/compile.js";
import {
  authorizeCreate,
  authorizeDelete,
  authorizeRename,
  authorizeWrite,
  normalizeSelector,
  resolveTarget,
  selectorMatches,
} from "../src/policy/path.js";
import type { CompiledContract } from "../src/types.js";

interface PolicyInput {
  write: string[];
  create: string[];
  delete: string[];
  protected: string[];
}

function plan(input: Partial<PolicyInput> = {}): string {
  const document = {
    version: 1,
    write: [],
    create: [],
    delete: [],
    protected: [],
    commands: [],
    packageManager: "none",
    ...input,
  };
  return `\`\`\`taskfence-contract\n${JSON.stringify(document)}\n\`\`\`\n`;
}

function symlinkOrSkip(
  target: string,
  link: string,
  skip: TestContext["skip"],
): void {
  try {
    symlinkSync(target, link, "junction");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(code)) {
      skip(`symbolic links unavailable (${code})`);
    }
    throw error;
  }
}

describe("path policy", () => {
  let sandbox: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    sandbox = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "taskfence-path-")),
    );
    root = path.join(sandbox, "root");
    outside = path.join(sandbox, "outside");
    mkdirSync(root);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function compile(input: Partial<PolicyInput>): CompiledContract {
    return compileContract(plan(input), root);
  }

  test("denies a non-canonical contract root even when it aliases the canonical root", ({
    skip,
  }) => {
    const rootAlias = path.join(sandbox, "root-alias");
    symlinkOrSkip(root, rootAlias, skip);
    const canonical = compile({ create: ["new.txt"] });
    const aliasedContract: CompiledContract = { ...canonical, root: rootAlias };

    expect(authorizeCreate(aliasedContract, "new.txt")).toMatchObject({
      allowed: false,
      code: "deny_root_mismatch",
    });
  });

  test.each([
    "../outside.txt",
    "safe/../../outside.txt",
    "/tmp/absolute.txt",
    "C:/absolute.txt",
    "\\\\server\\share\\file.txt",
  ])("denies traversal or absolute target %j", (target) => {
    const contract = compile({ create: ["safe/**"] });

    expect(authorizeCreate(contract, target)).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });

  test.each([
    "./safe/file.txt",
    "safe//file.txt",
    "safe/file.txt/",
    "safe\\file.txt",
    "safe\0file.txt",
  ])("denies non-canonical path alias %j", (target) => {
    const contract = compile({ create: ["safe/**"] });

    expect(authorizeCreate(contract, target)).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });

  test("denies case-folded and Unicode-normalization aliases of existing entries", () => {
    mkdirSync(path.join(root, "CaseSensitive"));
    mkdirSync(path.join(root, "Café"));
    const contract = compile({ create: ["CaseSensitive/**", "Café/**"] });

    expect(authorizeCreate(contract, "casesensitive/new.txt")).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
    expect(authorizeCreate(contract, "Cafe\u0301/new.txt")).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });

  test("denies an existing symlink that escapes the canonical root", ({ skip }) => {
    writeFileSync(path.join(outside, "existing.txt"), "outside");
    symlinkOrSkip(outside, path.join(root, "escape"), skip);
    const contract = compile({
      write: ["escape/**"],
      create: ["escape/**"],
      delete: ["escape/**"],
    });

    for (const decision of [
      authorizeWrite(contract, "escape/existing.txt"),
      authorizeCreate(contract, "escape/deep/new.txt"),
      authorizeDelete(contract, "escape/existing.txt"),
    ]) {
      expect(decision).toMatchObject({
        allowed: false,
        code: "deny_root_mismatch",
      });
    }
  });

  test("resolves in-root aliases for inspection but denies mutation through them", ({
    skip,
  }) => {
    const actual = path.join(root, "actual");
    mkdirSync(actual);
    symlinkOrSkip(actual, path.join(root, "alias"), skip);
    const contract = compile({ create: ["alias/**"] });
    const target = "alias/missing/deep/file.txt";

    expect(resolveTarget(root, target, { mustExist: false })).toBe(
      path.join(actual, "missing", "deep", "file.txt"),
    );
    expect(authorizeCreate(contract, target)).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });
  test("denies final symlinks and multiply-linked regular mutation targets", ({
    skip,
  }) => {
    mkdirSync(path.join(root, "allowed"));
    writeFileSync(path.join(root, "allowed", "original.txt"), "shared");
    symlinkOrSkip(
      path.join(root, "allowed", "original.txt"),
      path.join(root, "allowed", "alias.txt"),
      skip,
    );
    linkSync(
      path.join(root, "allowed", "original.txt"),
      path.join(root, "allowed", "hardlink.txt"),
    );
    const contract = compile({
      write: ["allowed/**"],
      create: ["allowed/**"],
      delete: ["allowed/**"],
    });

    for (const decision of [
      authorizeWrite(contract, "allowed/alias.txt"),
      authorizeDelete(contract, "allowed/alias.txt"),
      authorizeWrite(contract, "allowed/original.txt"),
      authorizeWrite(contract, "allowed/hardlink.txt"),
      authorizeDelete(contract, "allowed/hardlink.txt"),
      authorizeRename(contract, "allowed/alias.txt", "allowed/renamed-alias.txt"),
      authorizeRename(contract, "allowed/hardlink.txt", "allowed/renamed-hardlink.txt"),
    ]) {
      expect(decision).toMatchObject({
        allowed: false,
        code: "deny_path",
      });
    }
  });


  test("allows a deeply nonexistent create target but requires write and delete targets to exist", () => {
    mkdirSync(path.join(root, "generated"));
    const contract = compile({
      write: ["generated/**"],
      create: ["generated/**"],
      delete: ["generated/**"],
    });
    const target = "generated/a/b/c/new.txt";

    expect(authorizeCreate(contract, target)).toMatchObject({
      allowed: true,
      code: "allow_mutation",
    });
    expect(authorizeWrite(contract, target)).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
    expect(authorizeDelete(contract, target)).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });

  test("rejects create when the nearest existing ancestor is a file", () => {
    writeFileSync(path.join(root, "parent-file"), "not a directory");
    const contract = compile({ create: ["parent-file/**"] });

    expect(authorizeCreate(contract, "parent-file/child.txt")).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });

  test("applies protected selectors before overlapping operation selectors", () => {
    mkdirSync(path.join(root, "locked"));
    writeFileSync(path.join(root, "locked", "existing.txt"), "locked");
    const contract = compile({
      write: ["locked/**"],
      create: ["locked/**"],
      delete: ["locked/**"],
      protected: ["locked/**"],
    });

    for (const decision of [
      authorizeWrite(contract, "locked/existing.txt"),
      authorizeCreate(contract, "locked/new.txt"),
      authorizeDelete(contract, "locked/existing.txt"),
    ]) {
      expect(decision).toMatchObject({
        allowed: false,
        code: "deny_protected_path",
      });
    }
  });

  test("protects a physical default-protected path reached through an allowed alias", ({
    skip,
  }) => {
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".git", "config"), "protected");
    symlinkOrSkip(path.join(root, ".git"), path.join(root, "git-alias"), skip);
    const contract = compile({ write: ["git-alias/**"] });

    expect(authorizeWrite(contract, "git-alias/config")).toMatchObject({
      allowed: false,
      code: "deny_protected_path",
    });
  });

  test("implements exact and subtree selector semantics without prefix confusion", () => {
    const exact = normalizeSelector("dir");
    const subtree = normalizeSelector("tree/**");

    expect(selectorMatches(exact, "dir")).toBe(true);
    expect(selectorMatches(exact, "dir/file.txt")).toBe(false);
    expect(selectorMatches(subtree, "tree")).toBe(true);
    expect(selectorMatches(subtree, "tree/file.txt")).toBe(true);
    expect(selectorMatches(subtree, "treehouse/file.txt")).toBe(false);
  });

  test("keeps selector semantics path-based while filesystem ancestry remains unambiguous", () => {
    mkdirSync(path.join(root, "exact-dir"));
    writeFileSync(path.join(root, "exact-dir", "child.txt"), "child");
    mkdirSync(path.join(root, "tree"));
    writeFileSync(path.join(root, "tree", "child.txt"), "child");
    writeFileSync(path.join(root, "file.txt"), "file");
    const contract = compile({
      write: ["exact-dir", "tree/**"],
      create: ["file.txt/**"],
    });

    expect(authorizeWrite(contract, "exact-dir")).toMatchObject({
      allowed: true,
      code: "allow_mutation",
    });
    expect(authorizeWrite(contract, "exact-dir/child.txt")).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
    expect(authorizeWrite(contract, "tree")).toMatchObject({
      allowed: true,
      code: "allow_mutation",
    });
    expect(authorizeWrite(contract, "tree/child.txt")).toMatchObject({
      allowed: true,
      code: "allow_mutation",
    });
    expect(authorizeCreate(contract, "file.txt/child.txt")).toMatchObject({
      allowed: false,
      code: "deny_path",
    });
  });
});
