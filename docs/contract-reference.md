# Contract Reference

A TaskFence contract is strict JSON inside exactly one top-level Markdown fence. The opening delimiter is the literal line `` ```taskfence-contract `` and the closing delimiter is the literal line `` ``` ``.

The opening line must be exactly `` ```taskfence-contract `` at the top level and the closing line exactly `` ``` ``. A block quote, list-nested fence, tilde fence, extra info text, different casing/spacing, missing close, empty body, or a second fence whose info starts with `taskfence` is rejected. The approved plan may contain other prose and ordinary code fences.

## Strict schema

The JSON object has exactly these fields. Unknown fields and duplicate JSON keys are rejected.

```ts
type Contract = {
  version: 1;
  write: string[];
  create: string[];
  delete: string[];
  protected: string[];
  commands: Array<{
    argv: string[]; // 1–1,024 non-empty strings
    cwd: string;    // existing directory under the project root
  }>;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none";
};
```

All seven top-level fields are required. A contract string must be non-empty, no more than 65,536 JavaScript characters, and no more than 65,536 UTF-8 bytes. Each selector list and `commands` may contain at most 10,000 entries. The entire approved plan is limited to 8 MiB of non-empty, NUL-free UTF-8 text. When read from a file, it must be a regular, current-user-owned, non-symlink file whose metadata remains stable for the read.

## Complete valid example

This is a complete plan fragment, not a shorthand schema illustration:

```taskfence-contract
{
  "version": 1,
  "write": [
    "src/config.ts",
    "src/features/**"
  ],
  "create": [
    "src/new-module/**",
    "test/new-module.test.ts"
  ],
  "delete": [
    "src/obsolete.ts"
  ],
  "protected": [
    "secrets/**"
  ],
  "commands": [
    {
      "argv": ["npm", "test"],
      "cwd": "."
    },
    {
      "argv": ["node", "scripts/check.js", "--mode", "strict"],
      "cwd": "."
    }
  ],
  "packageManager": "npm"
}
```

This authorizes exactly the listed operation/selector combinations and exactly the two argv/cwd pairs. It does not authorize a different npm script, an extra flag, a shell pipeline, or creating a path that is only in `write`.

## Path selectors

A selector is either:

- an **exact** path: `src/config.ts`; or
- a **subtree** path ending in `/**`: `src/features/**`, which matches `src/features` itself and every descendant.

Selectors use relative POSIX spelling and are normalized to Unicode NFC. They must not:

- be empty, absolute, drive-letter-prefixed, or contain `\` or NUL;
- contain empty, `.` or `..` segments, or end in `/`;
- contain `*`, `?`, `[`, `]`, `{`, or `}` except for the single final `/**` subtree marker;
- contain percent-encoded dot, slash, or backslash forms (`%2e`, `%2f`, `%5c`, case-insensitive); or
- change when normalized to NFC.

Duplicate selectors within the same list are rejected. Exact and subtree forms for the same base are distinct. Lists are sorted in the compiled document, but the operation lists remain independent:

| Requested operation | Required selector list |
| --- | --- |
| overwrite/edit an existing target | `write` |
| create a target that does not exist | `create` |
| delete an existing target | `delete` |
| rename | source in `delete` **and** nonexistent destination in `create` |

At enforcement time the target must remain under the canonical root. TaskFence rejects traversal, absolute/root escape, wrong case or case collisions, dangling or traversed symlinks, physical/logical path mismatches, and existing targets with multiple hard links. `create` rejects an already-existing destination; write and delete require an existing target.

### Protected precedence

TaskFence always adds these subtree selectors, even when `protected` is empty:

```text
.git/**
.taskfence/**
.claude/**
.codex/**
.opencode/**
.omp/**
.pi/**
```

User-supplied protected selectors are unioned with those defaults. Protection is checked against both the requested relative path and any resolved physical relative path **before** operation allowlists. A protected match always denies; adding the same target to `write`, `create`, or `delete` cannot override it. An active amendment cannot remove or weaken any already-compiled protected selector.

## Command rules

A rule is an exact literal `argv` plus an exact canonical working directory. TaskFence does not run the declared array; it parses the host's one-line command string into literal argv, validates it, canonicalizes the observed cwd, and permits only when:

```text
parsed argv length == declared argv length
and every argv[i] is exactly string-equal
and canonical observed cwd == canonical declared cwd
```

Quoting syntax is not authority. For example, `node 'scripts/check.js'` and `node scripts/check.js` parse to the same argv, but `node ./scripts/check.js` does not.

### Restricted POSIX command grammar

The accepted command language produces one argv and deliberately has no shell program structure:

- Unicode whitespace separates arguments outside quotes.
- Single quotes preserve every character until the next single quote.
- Double quotes preserve characters; backslash may escape only `"`, `\`, `$`, or a backtick. Unescaped `$` and backticks are rejected.
- Outside quotes, backslash quotes the next non-newline character.
- Empty quoted strings are valid empty argv entries at runtime, but cannot appear in a declared rule because schema strings are non-empty; therefore such a command cannot match a contract.
- Newline/CR, NUL, shell comments (`#`), operators/redirections (`&`, `(`, `)`, `;`, `<`, `>`, `|`), `$` expansion, backticks, unquoted glob/brace characters (`* ? [ ] { }`), and a token-initial `~` are rejected.
- A malformed quote or trailing backslash is rejected.

After parsing, global argv policy still applies. A matching rule cannot override these denials:

- environment assignments in any argv position;
- any argument exactly `-c`, `--command`, or `--interactive`;
- direct nested shells (`ash`, `bash`, `csh`, `dash`, `fish`, `ksh`, `nu`, `powershell`, `pwsh`, `sh`, `tcsh`, `zsh`, or `cmd`) or a shell executable named in a later argument;
- command indirection through `.`, `busybox`, `chroot`, `command`, `daemonize`, `doas`, `env`, `eval`, `exec`, `gmake`, `ionice`, `make`, `nice`, `ninja`, `parallel`, `runuser`, `nohup`, `setsid`, `stdbuf`, `source`, `su`, `sudo`, `timeout`, or `xargs`;
- interactive/long-lived commands `emacs`, `ftp`, `htop`, `less`, `man`, `more`, `mosh`, `nano`, `nvim`, `screen`, `sftp`, `ssh`, `telnet`, `tmux`, `top`, `vi`, `vim`, `watch`, or `script`, plus `tail -f`, `tail -F`, or `tail --follow`;
- interactive interpreters or inline eval/print modes for Bun, Deno, Lua, Node, Perl, PHP, Python, Ruby, or tsx;
- subprocess modes for `find`/`gfind` (`-exec`, `-execdir`, `-ok`, `-okdir`), `script --command`, tar command/compressor hooks, and rsync remote-shell/path hooks;
- Git alias/root/executable/tool overrides, external Git subcommands, `git submodule foreach`, and `git bisect run`; and
- TaskFence authority operations invoked directly, through its JS entrypoint, or through a recognized package runner: `activate`, `amend`, `approve`, `close`, `complete`, `install`, `revoke`, `rollback`, `stage`, and `uninstall`.

Git is limited to the built-in subcommand names compiled into the policy. A custom alias or external `git-…` executable is denied even if the command rule is otherwise exact.

### Working directories

A declared `cwd` is either `"."` for the canonical contract root or an exact selector-like relative POSIX path. It may not be a subtree selector. The directory must already exist, resolve canonically inside the root, and remain an existing canonical directory when the tool executes.

Package-manager commands have an additional rule: their declared and observed cwd must be the canonical contract root. A package-manager rule in a subdirectory is invalid at compilation.

### Package-manager policy

The `packageManager` field authorizes exactly one manager family:

| Value | Recognized executables |
| --- | --- |
| `npm` | `npm`, `npx` |
| `pnpm` | `pnpm`, `pnpx` |
| `yarn` | `yarn`, `yarnpkg` |
| `bun` | `bun`, `bunx` |
| `none` | none of the above |

TaskFence recognizes executable basenames case-insensitively after removing common Windows executable suffixes. It also detects those managers when launched through known Bun/Node/Deno/tsx package-manager entrypoints. Unknown or malformed package-manager-shaped interpreter entrypoints are denied. `corepack` indirection is denied. A command from one manager may not invoke a conflicting manager token.

Root/workspace/global overrides are always denied before exact-rule matching:

| Manager | Denied override forms before `--` |
| --- | --- |
| npm | `-g`, `-w…`, `--global`, `--include-workspace-root`, `--location`, `--prefix`, `--workspace`, `--workspaces`, `--ws`, including `=value` forms; also `--call` inline execution |
| pnpm | `-C…`, `-F…`, `-g`, `-r`, `-w`, `--dir`, `--filter`, `--global`, `--recursive`, `--workspace-root`, including supported `=value` forms |
| yarn | `-C…`, `-T`, `-g`, `--all`, `--cwd`, `--global`, `--recursive`, `--since`, `--top-level`, and `global`, `workspace`, or `workspaces` modes |
| bun | `-C…`, `-g`, `--all`, `--cwd`, `--filter`, `--global`, `--workspace`, `--workspaces`, including supported `=value` forms |

Package-manager authorization is not transitive containment. If an exactly approved `npm test` script starts subprocesses or writes other files, those child effects do not generate separate application tool hooks. Approve such commands only when their complete transitive behavior is trusted.

## Canonicalization and hashes

Compilation performs the following deterministic transformation:

1. Resolve the project root with native `realpath`; it must be an existing directory.
2. Parse the one exact contract block with `JSON.parse` plus an independent duplicate-key scan and the strict schema.
3. Normalize selectors to NFC, convert them to `{kind, path}`, reject duplicates, and sort by path then kind.
4. Union and sort protected defaults.
5. Canonicalize every command cwd with native `realpath`, validate argv/package-manager policy, reject duplicate rules, and sort rules by canonical JSON.
6. Freeze the compiled contract and nested arrays/objects.

Hashes are lowercase hexadecimal SHA-256:

```text
rootHash     = SHA-256(canonicalRoot UTF-8)
planHash     = SHA-256(exact complete approved plan text UTF-8)
contractHash = SHA-256(canonicalJSON({
  version: 1,
  root: canonicalRoot,
  rootHash,
  planHash,
  document: normalizedDocument
}))
```

Canonical JSON has no insignificant whitespace, sorts object keys lexicographically, preserves array order, uses JSON string escaping, and serializes negative zero as `0`. It rejects non-finite numbers, cycles, sparse arrays, symbol keys, accessors, and non-plain objects. The same canonicalizer underlies state/receipt transaction hashes and receipt record hashes.

## Lifecycle and adapter denials that a contract cannot override

Even a valid exact rule or selector cannot authorize:

- a command or mutation while state is absent, staged, checkpointing, pending, violated, recovery-required, rolling back, rolled back, completed, revoked, or error;
- a second command/mutation while one raw host input is pending post-tool reconciliation;
- a runtime/session outside durable authority or a child with missing/unverified ancestry;
- an allowed command/mutation with a missing session ID or call ID;
- an unknown tool name or malformed/oversized tool payload;
- a shell request marked background, interactive, or PTY;
- a protected, escaping, symlinked, hard-linked, case-ambiguous, or wrong-operation path;
- a wrapper command rejected by the restricted argv policy; or
- a TaskFence control/authority command launched by an agent tool call.

The Codex CLI 0.146.0 adapter additionally denies every command/shell tool, even if listed in `commands`, because subsequent `write_stdin` operations do not receive a fresh `PreToolUse` event. Current Codex mutation support is limited to a pre/post-correlated `apply_patch` shape. This adapter-specific denial is intentional and non-overridable.

## Rejection examples

Each example below is invalid independently.

### Unknown field

```json
{
  "version": 1,
  "write": [],
  "create": [],
  "delete": [],
  "protected": [],
  "commands": [],
  "packageManager": "none",
  "allowEverythingElse": true
}
```

Reason: the top-level schema is strict.

### Duplicate key

```json
{
  "version": 1,
  "write": [],
  "write": ["src/**"],
  "create": [],
  "delete": [],
  "protected": [],
  "commands": [],
  "packageManager": "none"
}
```

Reason: duplicate JSON keys are rejected rather than last-value-wins.

### Invalid selectors

```json
{
  "version": 1,
  "write": ["../outside", "/absolute", "src/*.ts", "src/%2e%2e/escape"],
  "create": [],
  "delete": [],
  "protected": [],
  "commands": [],
  "packageManager": "none"
}
```

Reason: traversal, absolute paths, general globbing, and encoded dot/slash/backslash forms are forbidden.

### Package-manager mismatch

```json
{
  "version": 1,
  "write": [],
  "create": [],
  "delete": [],
  "protected": [],
  "commands": [{"argv": ["pnpm", "test"], "cwd": "."}],
  "packageManager": "npm"
}
```

Reason: the rule invokes pnpm while only npm is authorized.

### Shell structure disguised as a rule

```json
{
  "version": 1,
  "write": [],
  "create": [],
  "delete": [],
  "protected": [],
  "commands": [{"argv": ["sh", "-c", "npm test && rm -rf /"], "cwd": "."}],
  "packageManager": "npm"
}
```

Reason: nested shells, `-c`, and shell program structure are non-overridable denials. The contract is rejected during compilation.
