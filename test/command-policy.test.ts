import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authorizeCommand } from "../src/index.js";
import type { CommandRule, CompiledContract, PackageManager } from "../src/index.js";

let sandbox: string;
let root: string;
let nestedCwd: string;
let contract: CompiledContract;

function makeContract(
  commands: CommandRule[],
  packageManager: PackageManager = "npm",
): CompiledContract {
  return {
    version: 1,
    root,
    rootHash: "root",
    planHash: "plan",
    contractHash: "contract",
    document: {
      version: 1,
      write: [],
      create: [],
      delete: [],
      protected: [],
      commands,
      packageManager,
    },
  };
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "taskfence-command-policy-"));
  root = realpathSync.native(sandbox);
  nestedCwd = join(root, "packages", "app");
  mkdirSync(nestedCwd, { recursive: true });
  nestedCwd = realpathSync.native(nestedCwd);

  contract = makeContract([
    { argv: ["git", "status", "--short"], cwd: root },
    { argv: ["git", "status"], cwd: nestedCwd },
    { argv: ["printf", "%s", "hello world"], cwd: root },
    { argv: ["printf", "%s", "a;b|c"], cwd: root },
    { argv: ["npm", "run", "check", "--", "quoted value"], cwd: root },
    { argv: ["pnpm", "run", "check"], cwd: root },
    { argv: ["bash", "-lc", "printf safe"], cwd: root },
    { argv: ["node", "-e", "process.exit(0)"], cwd: root },
    { argv: ["eval", "printf safe"], cwd: root },
    { argv: ["source", "setup.sh"], cwd: root },
    { argv: ["taskfence", "approve", "plan.md"], cwd: root },
  ]);
});

afterAll(() => {
  rmSync(sandbox, { force: true, recursive: true });
});

describe("authorizeCommand", () => {
  it("authorizes only an exact argv and canonical cwd match", () => {
    expect(authorizeCommand(contract, "git status --short", root)).toMatchObject({
      allowed: true,
      code: "allow_command",
    });

    for (const [command, cwd] of [
      ["git status", root],
      ["git status --short --branch", root],
      ["git --short status", root],
      ["git status --short", nestedCwd],
      ["git status", nestedCwd + "/missing"],
    ] as const) {
      expect(authorizeCommand(contract, command, cwd).allowed).toBe(false);
    }
  });

  it("parses quoted and escaped arguments as literal argv", () => {
    for (const command of [
      "printf %s 'hello world'",
      'printf "%s" "hello world"',
      "printf %s hello\\ world",
    ]) {
      expect(authorizeCommand(contract, command, root)).toMatchObject({
        allowed: true,
        code: "allow_command",
      });
    }

    expect(authorizeCommand(contract, 'printf "%s" "a;b|c"', root)).toMatchObject({
      allowed: true,
      code: "allow_command",
    });
    expect(authorizeCommand(contract, "printf %s 'hello  world'", root)).toMatchObject({
      allowed: false,
      code: "deny_command_not_approved",
    });
  });

  it.each([
    "git status && git diff",
    "git status & git diff",
    "git status | cat",
    "git status > status.txt",
    "git status < status.txt",
    "git status; git diff",
    "git status\nrm -rf .",
    "git status\rwhoami",
    "git $(status)",
    "git `status`",
    'git "$(status)"',
    "FOO=1 git status",
    "git FOO=1 status",
  ])("rejects operators, redirects, expansions, and assignments: %s", (command) => {
    expect(authorizeCommand(contract, command, root)).toMatchObject({
      allowed: false,
      code: "deny_command_syntax",
    });
  });

  it.each([
    "git 'status",
    'git "status',
    "git status\\",
    'git "bad\\q"',
  ])("rejects malformed quoting and escapes: %s", (command) => {
    expect(authorizeCommand(contract, command, root)).toMatchObject({
      allowed: false,
      code: "deny_command_syntax",
    });
  });

  it.each([
    "bash -lc 'printf safe'",
    "node -e 'process.exit(0)'",
    "eval 'printf safe'",
    "source setup.sh",
  ])("rejects nested shells, inline evaluation, and source even when listed: %s", (command) => {
    expect(authorizeCommand(contract, command, root)).toMatchObject({
      allowed: false,
      code: "deny_command_syntax",
    });
  });

  it("enforces the declared package manager before exact command matching", () => {
    expect(authorizeCommand(contract, "pnpm run check", root)).toMatchObject({
      allowed: false,
      code: "deny_package_manager",
    });
    expect(authorizeCommand(contract, "corepack npm run check", root)).toMatchObject({
      allowed: false,
      code: "deny_package_manager",
    });
    expect(authorizeCommand(contract, "npm exec pnpm run check", root)).toMatchObject({
      allowed: false,
      code: "deny_package_manager",
    });
  });

  it("requires package-manager scripts and their arguments to match exactly", () => {
    expect(authorizeCommand(contract, "npm run check -- 'quoted value'", root)).toMatchObject({
      allowed: true,
      code: "allow_command",
    });
    for (const command of [
      "npm run test -- 'quoted value'",
      "npm run check",
      "npm run check -- quoted value",
      "npm run check -- 'different value'",
    ]) {
      expect(authorizeCommand(contract, command, root)).toMatchObject({
        allowed: false,
        code: "deny_command_not_approved",
      });
    }
  });

  it("denies unapproved commands and TaskFence authority commands", () => {
    expect(authorizeCommand(contract, "git diff", root)).toMatchObject({
      allowed: false,
      code: "deny_command_not_approved",
    });
    expect(authorizeCommand(contract, "taskfence approve plan.md", root)).toMatchObject({
      allowed: false,
      code: "deny_command_not_approved",
    });
  });

  it.each([
    [
      "none",
      "taskfence complete --yes",
      ["taskfence", "complete", "--yes"],
    ],
    [
      "none",
      "node /plugin/taskfence/dist/cli.js install",
      ["node", "/plugin/taskfence/dist/cli.js", "install"],
    ],
    [
      "npm",
      "npx taskfence approve plan.md --yes",
      ["npx", "taskfence", "approve", "plan.md", "--yes"],
    ],
    [
      "npm",
      "npm exec taskfence -- amend plan.md",
      ["npm", "exec", "taskfence", "--", "amend", "plan.md"],
    ],
    [
      "pnpm",
      "pnpm dlx taskfence@latest rollback",
      ["pnpm", "dlx", "taskfence@latest", "rollback"],
    ],
    [
      "yarn",
      "yarn dlx taskfence uninstall",
      ["yarn", "dlx", "taskfence", "uninstall"],
    ],
    [
      "bun",
      "bunx taskfence install",
      ["bunx", "taskfence", "install"],
    ],
    [
      "bun",
      "bun dist/cli.js approve plan.md --yes",
      ["bun", "dist/cli.js", "approve", "plan.md", "--yes"],
    ],
    [
      "none",
      "/opt/homebrew/bin/bun --smol src/cli.ts rollback",
      ["/opt/homebrew/bin/bun", "--smol", "src/cli.ts", "rollback"],
    ],
    [
      "none",
      "deno --config=deno.json run --allow-read dist/cli.mjs complete",
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
      "tsx --tsconfig tsconfig.json src/cli.ts revoke compromised",
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
      "node /usr/local/lib/node_modules/npm/bin/npx-cli.js taskfence approve plan.md",
      [
        "node",
        "/usr/local/lib/node_modules/npm/bin/npx-cli.js",
        "taskfence",
        "approve",
        "plan.md",
      ],
    ],
  ] as const)(
    "hard-denies wrapped TaskFence authority command %s",
    (packageManager, command, argv) => {
      const authorityContract = makeContract(
        [{ argv: [...argv], cwd: root }],
        packageManager,
      );
      expect(authorizeCommand(authorityContract, command, root)).toMatchObject({
        allowed: false,
        code: "deny_command_not_approved",
      });
    },
  );

  it("rejects env-wrapped TaskFence authority before exact matching", () => {
    const argv = ["/usr/bin/env", "bun", "dist/cli.js", "approve", "plan.md"];
    const envContract = makeContract([{ argv, cwd: root }], "bun");
    expect(
      authorizeCommand(
        envContract,
        "/usr/bin/env bun dist/cli.js approve plan.md",
        root,
      ),
    ).toMatchObject({
      allowed: false,
      code: "deny_command_syntax",
    });
  });

  it.each([
    [
      "node npm override",
      "npm",
      "node /usr/local/lib/node_modules/npm/bin/npm-cli.js --prefix ../outside install",
      [
        "node",
        "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        "--prefix",
        "../outside",
        "install",
      ],
    ],
    [
      "absolute node npm mismatch",
      "none",
      "/usr/local/bin/node --no-warnings /usr/local/lib/node_modules/npm/bin/npm-cli.js install",
      [
        "/usr/local/bin/node",
        "--no-warnings",
        "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        "install",
      ],
    ],
    [
      "node consuming runner option",
      "npm",
      "node --title taskfence /usr/local/lib/node_modules/npm/bin/npm-cli.js --prefix ../outside install",
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
      "bun pnpm mismatch",
      "npm",
      "bun --smol /opt/pnpm/bin/pnpm.cjs install",
      ["bun", "--smol", "/opt/pnpm/bin/pnpm.cjs", "install"],
    ],
    [
      "deno yarn override",
      "yarn",
      "deno run --allow-read /opt/yarn/bin/yarn.js --cwd ../outside install",
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
      "tsx pnpm override",
      "pnpm",
      "tsx --tsconfig tsconfig.json /opt/pnpm/bin/pnpm.cjs -C../outside install",
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
      "node bun override",
      "bun",
      "node /opt/bun/bin/bun-cli.js --cwd ../outside install",
      [
        "node",
        "/opt/bun/bin/bun-cli.js",
        "--cwd",
        "../outside",
        "install",
      ],
    ],
    [
      "unknown npm wrapper",
      "npm",
      "node /opt/npm/bin/npm-cli.cjs install",
      ["node", "/opt/npm/bin/npm-cli.cjs", "install"],
    ],
  ] as const)(
    "denies interpreter-launched package-manager form: %s",
    (_label, packageManager, command, argv) => {
      const wrapperContract = makeContract(
        [{ argv: [...argv], cwd: root }],
        packageManager,
      );
      expect(authorizeCommand(wrapperContract, command, root)).toMatchObject({
        allowed: false,
        code: "deny_package_manager",
      });
    },
  );

  it.each([
    [
      "node --eval='process.exit(0)'",
      ["node", "--eval=process.exit(0)"],
    ],
    [
      "node --title taskfence --eval='process.exit(0)'",
      ["node", "--title", "taskfence", "--eval=process.exit(0)"],
    ],
    [
      "nodejs --print='process.version'",
      ["nodejs", "--print=process.version"],
    ],
    ["bun --eval='process.exit(0)'", ["bun", "--eval=process.exit(0)"]],
    ["tsx --print='process.version'", ["tsx", "--print=process.version"]],
    ["lua '-eos.exit()'", ["lua", "-eos.exit()"]],
    ["python '-cexit()'", ["python", "-cexit()"]],
    ["python2 '-cexit()'", ["python2", "-cexit()"]],
    ["python3 '-cexit()'", ["python3", "-cexit()"]],
    ["ruby --evaluate='exit'", ["ruby", "--evaluate=exit"]],
    ["php --run='exit;'", ["php", "--run=exit;"]],
    ["php '-rexit;'", ["php", "-rexit;"]],
    ["perl '-Eexit'", ["perl", "-Eexit"]],
    ["deno eval 'Deno.exit(0)'", ["deno", "eval", "Deno.exit(0)"]],
  ] as const)(
    "rejects attached or runtime-specific interpreter evaluation: %s",
    (command, argv) => {
      const evalContract = makeContract([{ argv: [...argv], cwd: root }]);
      expect(authorizeCommand(evalContract, command, root)).toMatchObject({
        allowed: false,
        code: "deny_command_syntax",
      });
    },
  );

  it.each([
    [
      "npm",
      "node scripts/npm-client.js --prefix ../outside",
      ["node", "scripts/npm-client.js", "--prefix", "../outside"],
    ],
    [
      "npm",
      "node scripts/tool.js /opt/npm/bin/npm-cli.js --prefix ../outside",
      [
        "node",
        "scripts/tool.js",
        "/opt/npm/bin/npm-cli.js",
        "--prefix",
        "../outside",
      ],
    ],
    [
      "bun",
      "bun scripts/build.ts approve plan.md",
      ["bun", "scripts/build.ts", "approve", "plan.md"],
    ],
    [
      "none",
      "deno run scripts/tool.ts eval",
      ["deno", "run", "scripts/tool.ts", "eval"],
    ],
    [
      "none",
      "tsx scripts/taskfence-helper.ts rollback",
      ["tsx", "scripts/taskfence-helper.ts", "rollback"],
    ],
    [
      "none",
      "node --trace-warnings scripts/check.js",
      ["node", "--trace-warnings", "scripts/check.js"],
    ],
    [
      "none",
      "node scripts/check.js --eval=literal",
      ["node", "scripts/check.js", "--eval=literal"],
    ],
    [
      "bun",
      "bun scripts/check.ts --print=literal",
      ["bun", "scripts/check.ts", "--print=literal"],
    ],
    [
      "none",
      "php scripts/check.php --run=literal",
      ["php", "scripts/check.php", "--run=literal"],
    ],
  ] as const)(
    "allows legitimate runner near miss under %s: %s",
    (packageManager, command, argv) => {
      const ordinaryContract = makeContract(
        [{ argv: [...argv], cwd: root }],
        packageManager,
      );
      expect(authorizeCommand(ordinaryContract, command, root)).toMatchObject({
        allowed: true,
        code: "allow_command",
      });
    },
  );

  it.each([
    ["npm", "npm --prefix ../outside install", ["npm", "--prefix", "../outside", "install"]],
    ["npm", "npm --workspace=other run check", ["npm", "--workspace=other", "run", "check"]],
    ["npm", "npm install --global", ["npm", "install", "--global"]],
    ["pnpm", "pnpm --dir ../outside install", ["pnpm", "--dir", "../outside", "install"]],
    ["pnpm", "pnpm -C../outside install", ["pnpm", "-C../outside", "install"]],
    ["pnpm", "pnpm --workspace-root run check", ["pnpm", "--workspace-root", "run", "check"]],
    ["yarn", "yarn --cwd=../outside install", ["yarn", "--cwd=../outside", "install"]],
    ["yarn", "yarn workspace other run check", ["yarn", "workspace", "other", "run", "check"]],
    ["bun", "bun --cwd ../outside install", ["bun", "--cwd", "../outside", "install"]],
    ["bun", "bun install --global", ["bun", "install", "--global"]],
  ] as const)(
    "denies package-manager root/workspace/global override %s",
    (packageManager, command, argv) => {
      const overrideContract = makeContract(
        [{ argv: [...argv], cwd: root }],
        packageManager,
      );
      expect(authorizeCommand(overrideContract, command, root)).toMatchObject({
        allowed: false,
        code: "deny_package_manager",
      });
    },
  );

  it("preserves literal package script arguments after the argument separator", () => {
    const argv = ["npm", "run", "check", "--", "--prefix", "../outside"];
    const scriptContract = makeContract([{ argv, cwd: root }], "npm");
    expect(
      authorizeCommand(
        scriptContract,
        "npm run check -- --prefix ../outside",
        root,
      ),
    ).toMatchObject({
      allowed: true,
      code: "allow_command",
    });
  });

  it.each([
    ["find . -exec printf x '{}' ';'", ["find", ".", "-exec", "printf", "x", "{}", ";"]],
    ["find . -execdir printf x '{}' ';'", ["find", ".", "-execdir", "printf", "x", "{}", ";"]],
    ["find . -ok printf x '{}' ';'", ["find", ".", "-ok", "printf", "x", "{}", ";"]],
    ["find . -okdir printf x '{}' ';'", ["find", ".", "-okdir", "printf", "x", "{}", ";"]],
    ["script -cprintf", ["script", "-cprintf"]],
    ["git '-calias.pwn=!printf x' pwn", ["git", "-calias.pwn=!printf x", "pwn"]],
    ["git rebase '--exec=printf x'", ["git", "rebase", "--exec=printf x"]],
    ["git untrusted-alias", ["git", "untrusted-alias"]],
    ["make check", ["make", "check"]],
    ["tar '--checkpoint-action=exec=printf x'", ["tar", "--checkpoint-action=exec=printf x"]],
    ["rsync --rsh=sh from to", ["rsync", "--rsh=sh", "from", "to"]],
    ["timeout 5 printf x", ["timeout", "5", "printf", "x"]],
  ] as const)(
    "rejects explicit subprocess indirection even when exactly listed: %s",
    (command, argv) => {
      const indirectionContract = makeContract([{ argv: [...argv], cwd: root }]);
      expect(authorizeCommand(indirectionContract, command, root)).toMatchObject({
        allowed: false,
        code: "deny_command_syntax",
      });
    },
  );
});
