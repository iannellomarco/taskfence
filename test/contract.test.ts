import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { canonicalStringify, sha256 } from "../src/contract/canonical.js";
import {
  compileContract,
  PROTECTED_SELECTOR_DEFAULTS,
} from "../src/contract/compile.js";
import {
  extractContractBlock,
  parseContractJson,
} from "../src/contract/extract.js";
import {
  readBoundedPlanFile,
  readBoundedPlanFileSync,
} from "../src/contract/limits.js";
import {
  contractDocumentSchema,
  MAX_COMMAND_ARGUMENTS,
  MAX_CONTRACT_COLLECTION_ENTRIES,
  MAX_CONTRACT_STRING_BYTES,
} from "../src/contract/schema.js";

interface ContractInput {
  version: number;
  write: string[];
  create: string[];
  delete: string[];
  protected: string[];
  commands: Array<{ argv: string[]; cwd: string }>;
  packageManager: string;
  [key: string]: unknown;
}

function contractInput(overrides: Partial<ContractInput> = {}): ContractInput {
  return {
    version: 1,
    write: ["src/z.ts", "src/a.ts"],
    create: ["generated/**", "new.ts"],
    delete: ["obsolete.ts"],
    protected: ["secrets/**"],
    commands: [],
    packageManager: "none",
    ...overrides,
  };
}

function fencedContract(input: unknown): string {
  return [
    "# Approved plan",
    "",
    "```taskfence-contract",
    JSON.stringify(input, null, 2),
    "```",
    "",
  ].join("\n");
}

describe("contract extraction and schema", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "taskfence-contract-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts exactly one exact taskfence-contract fence containing one JSON object", () => {
    const source = fencedContract(contractInput());

    expect(JSON.parse(extractContractBlock(source))).toMatchObject({ version: 1 });
    expect(() => compileContract(source, root)).not.toThrow();

    const secondFence = `${source}\n${fencedContract(contractInput())}`;
    expect(() => extractContractBlock(secondFence)).toThrow(/exactly one exact/);
  });

  test.each([
    ["no contract fence", "# Plan without a contract"],
    [
      "near-match language tag",
      "```taskfence-contract json\n{}\n```\n",
    ],
    ["legacy tag", "```taskfence\n{}\n```\n"],
    ["empty body", "```taskfence-contract\n   \n```\n"],
  ])("rejects %s", (_label, source) => {
    expect(() => extractContractBlock(source)).toThrow();
  });

  test.each([
    "   ```taskfence-contract\n{}\n   ```",
    "````taskfence-contract\n{}\n````",
    "~~~taskfence-contract\n{}\n~~~",
    "```taskfence\n{}\n```",
    "```TaskFence-contract\n{}\n```",
    "```taskfence-contract json\n{}\n```",
    "> ```taskfence-contract\n> {}\n> ```",
    "- ```taskfence-contract\n  {}\n  ```",
  ])("rejects a second Markdown-valid alternate authority fence: %j", (alternate) => {
    expect(() =>
      extractContractBlock(`${fencedContract(contractInput())}\n${alternate}\n`),
    ).toThrow(/exactly one exact/);
  });

  test("does not treat fence-looking text inside another fenced block as authority", () => {
    const quoted = [
      "````text",
      "```taskfence-contract",
      "{}",
      "```",
      "````",
      fencedContract(contractInput()),
    ].join("\n");
    expect(() => extractContractBlock(quoted)).not.toThrow();
  });

  test.each([
    ["none", ["taskfence", "complete"]],
    ["none", ["tf", "uninstall"]],
    ["none", ["node", "/plugin/taskfence/dist/cli.js", "install"]],
    ["npm", ["npx", "taskfence", "approve", "plan.md"]],
    ["npm", ["npm", "exec", "taskfence", "--", "amend", "plan.md"]],
    ["pnpm", ["pnpm", "dlx", "taskfence@latest", "rollback"]],
    ["yarn", ["yarn", "dlx", "taskfence", "complete"]],
    ["bun", ["bunx", "taskfence", "install"]],
    ["bun", ["bun", "dist/cli.js", "approve", "plan.md", "--yes"]],
    [
      "none",
      ["/opt/homebrew/bin/bun", "--smol", "src/cli.ts", "rollback"],
    ],
    [
      "none",
      [
        "deno",
        "--config=deno.json",
        "run",
        "--allow-read",
        "dist/cli.mjs",
        "complete",
      ],
    ],
    [
      "none",
      [
        "tsx",
        "--tsconfig",
        "tsconfig.json",
        "src/cli.ts",
        "revoke",
        "compromised",
      ],
    ],
    [
      "npm",
      [
        "node",
        "/usr/local/lib/node_modules/npm/bin/npx-cli.js",
        "taskfence",
        "approve",
        "plan.md",
      ],
    ],
  ] as const)(
    "rejects TaskFence authority argv at compilation for package manager %s",
    (packageManager, argv) => {
      expect(() =>
        compileContract(
          fencedContract(
            contractInput({
              commands: [{ argv: [...argv], cwd: "." }],
              packageManager,
            }),
          ),
          root,
        ),
      ).toThrow(/TaskFence authority/);
    },
  );

  test("rejects env-wrapped TaskFence authority argv at compilation", () => {
    expect(() =>
      compileContract(
        fencedContract(
          contractInput({
            commands: [
              {
                argv: [
                  "/usr/bin/env",
                  "bun",
                  "dist/cli.js",
                  "approve",
                  "plan.md",
                ],
                cwd: ".",
              },
            ],
            packageManager: "bun",
          }),
        ),
        root,
      ),
    ).toThrow(/indirection/);
  });

  test.each([
    [
      "npm",
      [
        "node",
        "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        "--prefix",
        "../outside",
        "install",
      ],
    ],
    [
      "none",
      [
        "/usr/local/bin/node",
        "--no-warnings",
        "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        "install",
      ],
    ],
    [
      "npm",
      [
        "node",
        "--title",
        "taskfence",
        "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        "--prefix",
        "../outside",
        "install",
      ],
    ],
    [
      "npm",
      ["bun", "--smol", "/opt/pnpm/bin/pnpm.cjs", "install"],
    ],
    [
      "yarn",
      [
        "deno",
        "run",
        "--allow-read",
        "/opt/yarn/bin/yarn.js",
        "--cwd",
        "../outside",
        "install",
      ],
    ],
    [
      "pnpm",
      [
        "tsx",
        "--tsconfig",
        "tsconfig.json",
        "/opt/pnpm/bin/pnpm.cjs",
        "-C../outside",
        "install",
      ],
    ],
    [
      "bun",
      [
        "node",
        "/opt/bun/bin/bun-cli.js",
        "--cwd",
        "../outside",
        "install",
      ],
    ],
    ["npm", ["node", "/opt/npm/bin/npm-cli.cjs", "install"]],
  ] as const)(
    "rejects interpreter-launched package manager at compilation for %s",
    (packageManager, argv) => {
      expect(() =>
        compileContract(
          fencedContract(
            contractInput({
              commands: [{ argv: [...argv], cwd: "." }],
              packageManager,
            }),
          ),
          root,
        ),
      ).toThrow(
        /package-manager|package manager|contract (?:does not authorize|authorizes)/i,
      );
    },
  );

  test.each([
    ["node", "--eval=process.exit(0)"],
    ["node", "--title", "taskfence", "--eval=process.exit(0)"],
    ["nodejs", "--print=process.version"],
    ["bun", "--eval=process.exit(0)"],
    ["tsx", "--print=process.version"],
    ["lua", "-eos.exit()"],
    ["python", "-cexit()"],
    ["python2", "-cexit()"],
    ["python3", "-cexit()"],
    ["ruby", "--evaluate=exit"],
    ["php", "--run=exit;"],
    ["php", "-rexit;"],
    ["perl", "-Eexit"],
    ["deno", "eval", "Deno.exit(0)"],
  ])("rejects interpreter evaluation argv at compilation: %j", (...argv) => {
    expect(() =>
      compileContract(
        fencedContract(
          contractInput({ commands: [{ argv, cwd: "." }] }),
        ),
        root,
      ),
    ).toThrow(/Inline interpreter/);
  });

  test.each([
    ["none", ["node", "scripts/check.js", "--eval=literal"]],
    ["bun", ["bun", "scripts/check.ts", "--print=literal"]],
    ["none", ["php", "scripts/check.php", "--run=literal"]],
    ["none", ["deno", "run", "scripts/tool.ts", "eval"]],
  ] as const)(
    "accepts ordinary interpreter arguments after the script for %s",
    (packageManager, argv) => {
      expect(() =>
        compileContract(
          fencedContract(
            contractInput({
              commands: [{ argv: [...argv], cwd: "." }],
              packageManager,
            }),
          ),
          root,
        ),
      ).not.toThrow();
    },
  );

  test.each([
    ["npm", ["npm", "--prefix", "../outside", "install"]],
    ["npm", ["npm", "--workspace=outside", "run", "check"]],
    ["npm", ["npm", "install", "--global"]],
    ["pnpm", ["pnpm", "--dir", "../outside", "install"]],
    ["pnpm", ["pnpm", "-C../outside", "install"]],
    ["pnpm", ["pnpm", "--workspace-root", "run", "check"]],
    ["yarn", ["yarn", "--cwd=../outside", "install"]],
    ["yarn", ["yarn", "workspace", "outside", "run", "check"]],
    ["bun", ["bun", "--cwd", "../outside", "install"]],
    ["bun", ["bun", "install", "--global"]],
  ] as const)(
    "rejects package-manager root/workspace/global override for %s",
    (packageManager, argv) => {
      expect(() =>
        compileContract(
          fencedContract(
            contractInput({
              commands: [{ argv: [...argv], cwd: "." }],
              packageManager,
            }),
          ),
          root,
        ),
      ).toThrow(/override/);
    },
  );

  test.each([
    ["find", ".", "-exec", "printf", "x", "{}", ";"],
    ["find", ".", "-execdir", "printf", "x", "{}", ";"],
    ["find", ".", "-ok", "printf", "x", "{}", ";"],
    ["script", "-cprintf x"],
    ["git", "rebase", "--exec=printf x"],
    ["git", "-calias.pwn=!printf x", "pwn"],
    ["git", "untrusted-alias"],
    ["make", "check"],
    ["tar", "--checkpoint-action=exec=printf x"],
    ["rsync", "--rsh=sh", "from", "to"],
    ["timeout", "5", "printf", "x"],
  ])("rejects option-driven subprocess argv at compilation: %j", (...argv) => {
    expect(() =>
      compileContract(
        fencedContract(
          contractInput({ commands: [{ argv, cwd: "." }] }),
        ),
        root,
      ),
    ).toThrow();
  });
  test("rejects a fenced JSON value that is not a contract object", () => {
    expect(() => compileContract(fencedContract([]), root)).toThrow();
    expect(() => compileContract(fencedContract(null), root)).toThrow();
  });

  test("enforces the complete strict top-level and nested schemas", () => {
    const withUnknownTopLevel = contractInput({ unexpected: true });
    const withUnknownCommandField = contractInput({
      commands: [{ argv: ["echo", "ok"], cwd: ".", timeout: 1 } as never],
    });
    const { delete: _omitted, ...missingRequiredField } = contractInput();

    expect(() => compileContract(fencedContract(withUnknownTopLevel), root)).toThrow();
    expect(() => compileContract(fencedContract(withUnknownCommandField), root)).toThrow();
    expect(() => compileContract(fencedContract(missingRequiredField), root)).toThrow();
  });

  test("rejects duplicate object keys at every nesting level, including escaped aliases", () => {
    expect(() => parseContractJson('{"write":[],"write":[]}')).toThrow(
      /Duplicate object key "write"/,
    );
    expect(() =>
      parseContractJson('{"command":{"cwd":".","cwd":"src"}}'),
    ).toThrow(/Duplicate object key "cwd"/);
    expect(() => parseContractJson('{"a":1,"\\u0061":2}')).toThrow(
      /Duplicate object key "a"/,
    );
  });

  test.each([
    "/absolute.ts",
    "C:/absolute.ts",
    "../escape.ts",
    "safe/../escape.ts",
    "safe\\file.ts",
    "safe/%2e%2e/escape.ts",
    "safe/%2Fescape.ts",
    "safe/./file.ts",
    "safe//file.ts",
    "safe/*.ts",
    "cafe\u0301.ts",
  ])("rejects selector aliases and non-canonical selector %j", (selector) => {
    expect(() =>
      compileContract(
        fencedContract(contractInput({ create: [selector] })),
        root,
      ),
    ).toThrow();
  });

  test("reads valid plan files through both bounded reader variants", async () => {
    const source = fencedContract(contractInput());
    const planFile = join(root, "plan.md");
    writeFileSync(planFile, source);

    expect(readBoundedPlanFileSync(planFile)).toBe(source);
    await expect(readBoundedPlanFile(planFile)).resolves.toBe(source);
  });

  test("bounds contract strings and collections", () => {
    expect(
      contractDocumentSchema.safeParse(
        contractInput({
          create: ["é".repeat(Math.floor(MAX_CONTRACT_STRING_BYTES / 2) + 1)],
        }),
      ).success,
    ).toBe(false);
    expect(
      contractDocumentSchema.safeParse(
        contractInput({
          write: Array.from(
            { length: MAX_CONTRACT_COLLECTION_ENTRIES + 1 },
            (_, index) => `src/${index}.ts`,
          ),
        }),
      ).success,
    ).toBe(false);
    expect(
      contractDocumentSchema.safeParse(
        contractInput({
          commands: [{
            argv: Array.from(
              { length: MAX_COMMAND_ARGUMENTS + 1 },
              () => "argument",
            ),
            cwd: ".",
          }],
        }),
      ).success,
    ).toBe(false);
  });
});

describe("compiled contract normalization", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "taskfence-normalize-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("adds every default protected path without replacing caller protection", () => {
    const compiled = compileContract(fencedContract(contractInput()), root);
    const protectedSelectors = compiled.document.protected.map(
      ({ kind, path }) => `${path}${kind === "subtree" ? "/**" : ""}`,
    );

    expect(protectedSelectors).toEqual(
      [...PROTECTED_SELECTOR_DEFAULTS, "secrets/**"].sort(),
    );
  });

  test("produces a deterministic hash from the canonical root and normalized contract payload", () => {
    const plan = fencedContract(contractInput());
    const first = compileContract(plan, root);
    const second = compileContract(plan, join(root, "."));
    const { contractHash: _contractHash, ...payload } = first;

    expect(first.document.write).toEqual([
      { kind: "exact", path: "src/a.ts" },
      { kind: "exact", path: "src/z.ts" },
    ]);
    expect(second).toEqual(first);
    expect(first.contractHash).toBe(sha256(canonicalStringify(payload)));
    expect(first.contractHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
