const SHELLS: Record<string, true> = {
  ash: true,
  bash: true,
  csh: true,
  dash: true,
  fish: true,
  ksh: true,
  nu: true,
  powershell: true,
  pwsh: true,
  sh: true,
  tcsh: true,
  zsh: true,
};

const INTERPRETERS: Record<string, true> = {
  bun: true,
  deno: true,
  lua: true,
  node: true,
  nodejs: true,
  perl: true,
  php: true,
  python: true,
  python2: true,
  python3: true,
  ruby: true,
  tsx: true,
};

const INTERPRETER_EVAL_FLAGS: Record<string, true> = {
  "--eval": true,
  "--evaluate": true,
  "--print": true,
  "-c": true,
  "-e": true,
  "-p": true,
};

const LONG_LIVED_COMMANDS: Record<string, true> = {
  emacs: true,
  ftp: true,
  htop: true,
  less: true,
  man: true,
  more: true,
  mosh: true,
  nano: true,
  nvim: true,
  screen: true,
  sftp: true,
  ssh: true,
  telnet: true,
  tmux: true,
  top: true,
  vi: true,
  vim: true,
  watch: true,
  script: true,
};

const INDIRECTION_COMMANDS: Record<string, true> = {
  ".": true,
  busybox: true,
  chroot: true,
  command: true,
  daemonize: true,
  doas: true,
  env: true,
  eval: true,
  exec: true,
  gmake: true,
  ionice: true,
  make: true,
  nice: true,
  ninja: true,
  parallel: true,
  runuser: true,
  nohup: true,
  setsid: true,
  stdbuf: true,
  source: true,
  su: true,
  sudo: true,
  timeout: true,
  xargs: true,
};
const GIT_BUILTINS: Record<string, true> = {
  add: true,
  am: true,
  annotate: true,
  apply: true,
  archive: true,
  bisect: true,
  blame: true,
  branch: true,
  bundle: true,
  checkout: true,
  cherry: true,
  "cherry-pick": true,
  clean: true,
  clone: true,
  commit: true,
  config: true,
  describe: true,
  diff: true,
  difftool: true,
  fetch: true,
  "format-patch": true,
  fsck: true,
  gc: true,
  grep: true,
  init: true,
  log: true,
  maintenance: true,
  merge: true,
  mergetool: true,
  mv: true,
  notes: true,
  pull: true,
  push: true,
  "range-diff": true,
  rebase: true,
  reflog: true,
  remote: true,
  reset: true,
  restore: true,
  revert: true,
  rm: true,
  shortlog: true,
  show: true,
  "show-branch": true,
  "sparse-checkout": true,
  stash: true,
  status: true,
  submodule: true,
  switch: true,
  tag: true,
  worktree: true,
};

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const UNSAFE_UNQUOTED: Record<string, true> = {
  "&": true,
  "(": true,
  ")": true,
  ";": true,
  "<": true,
  ">": true,
  "|": true,
};
const EXPANSION_UNQUOTED: Record<string, true> = {
  "*": true,
  "?": true,
  "[": true,
  "]": true,
  "{": true,
  "}": true,
};

export class RestrictedShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictedShellError";
  }
}

function executableName(argv0: string): string {
  const normalized = argv0.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

const INTERPRETER_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-C": true,
  "-E": true,
  "-F": true,
  "-I": true,
  "-S": true,
  "-W": true,
  "-X": true,
  "-d": true,
  "-r": true,
  "-z": true,
  "--cert": true,
  "--conditions": true,
  "--config": true,
  "--cwd": true,
  "--env-file": true,
  "--import": true,
  "--loader": true,
  "--location": true,
  "--log-level": true,
  "--preload": true,
  "--require": true,
  "--seed": true,
  "--title": true,
  "--tsconfig": true,
  "--v8-flags": true,
};

function isInlineInterpreterExecution(
  argv: readonly string[],
  executable: string,
): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (
      INTERPRETER_EVAL_FLAGS[argument] === true ||
      /^--(?:eval|evaluate|print)=/u.test(argument) ||
      /^-(?:c|e|p).+/u.test(argument) ||
      /^-i(?:c|e|p)/u.test(argument) ||
      (executable === "perl" && /^-E(?:.*)$/u.test(argument)) ||
      (executable === "php" &&
        (/^-(?:B|E|F|R|r)(?:.*)$/u.test(argument) ||
          /^(?:--process-begin|--process-code|--process-end|--process-file|--run)(?:=.*)?$/u.test(
            argument,
          )))
    ) {
      return true;
    }
    if (argument === "--") {
      return executable === "deno" && argv[index + 1] === "eval";
    }
    if (argument.startsWith("-")) {
      if (
        !argument.includes("=") &&
        INTERPRETER_OPTIONS_WITH_VALUE[argument] === true
      ) {
        index += 1;
      }
      continue;
    }
    return executable === "deno" && argument === "eval";
  }
  return false;
}

function rejectOptionDrivenSubprocess(argv: readonly string[], executable: string): void {
  const argumentsAfterExecutable = argv.slice(1);
  if (
    (executable === "find" || executable === "gfind") &&
    argumentsAfterExecutable.some((argument) =>
      ["-exec", "-execdir", "-ok", "-okdir"].includes(argument.toLowerCase())
    )
  ) {
    throw new RestrictedShellError("find subprocess execution is not allowed");
  }
  if (
    executable === "script" &&
    argumentsAfterExecutable.some((argument) =>
      argument === "-c" ||
      argument.startsWith("-c") ||
      argument === "--command" ||
      argument.startsWith("--command=")
    )
  ) {
    throw new RestrictedShellError("script subprocess execution is not allowed");
  }
  if (
    (executable === "tar" || executable === "bsdtar") &&
    argumentsAfterExecutable.some((argument) =>
      argument === "--to-command" ||
      argument.startsWith("--to-command=") ||
      argument.startsWith("--checkpoint-action=exec") ||
      argument === "-I" ||
      /^-I.+/u.test(argument) ||
      argument === "--use-compress-program" ||
      argument.startsWith("--use-compress-program=")
    )
  ) {
    throw new RestrictedShellError("Archive subprocess execution is not allowed");
  }
  if (
    executable === "rsync" &&
    argumentsAfterExecutable.some((argument) =>
      argument === "-e" ||
      /^-e.+/u.test(argument) ||
      argument === "--rsh" ||
      argument.startsWith("--rsh=") ||
      argument === "--rsync-path" ||
      argument.startsWith("--rsync-path=")
    )
  ) {
    throw new RestrictedShellError("rsync subprocess execution is not allowed");
  }
  if (executable !== "git") return;

  if (
    argumentsAfterExecutable.some((argument, index) =>
      /^-calias\./iu.test(argument) ||
      /^--config-env=alias\./iu.test(argument) ||
      (argument === "--config-env" &&
        /^alias\./iu.test(argumentsAfterExecutable[index + 1] ?? "")) ||
      argument === "-C" ||
      /^-C.+/u.test(argument) ||
      argument === "--git-dir" ||
      argument.startsWith("--git-dir=") ||
      argument === "--work-tree" ||
      argument.startsWith("--work-tree=") ||
      argument === "--exec-path" ||
      argument.startsWith("--exec-path=") ||
      argument === "--exec" ||
      argument.startsWith("--exec=") ||
      argument === "-x" ||
      /^-x.+/u.test(argument) ||
      argument === "--extcmd" ||
      argument.startsWith("--extcmd=") ||
      argument === "--tool" ||
      argument.startsWith("--tool=") ||
      argument === "--open-files-in-pager" ||
      argument.startsWith("--open-files-in-pager=")
    )
  ) {
    throw new RestrictedShellError("Git alias and root override execution is not allowed");
  }

  const subcommand = argumentsAfterExecutable.find(
    (argument) => argument !== "--" && !argument.startsWith("-"),
  );
  if (subcommand !== undefined && GIT_BUILTINS[subcommand.toLowerCase()] !== true) {
    throw new RestrictedShellError("Git aliases and external subcommands are not allowed");
  }

  const subcommandIndex = argumentsAfterExecutable.indexOf(subcommand ?? "");
  const subcommandArguments = subcommandIndex < 0
    ? []
    : argumentsAfterExecutable.slice(subcommandIndex + 1);
  if (
    (subcommand === "submodule" && subcommandArguments.includes("foreach")) ||
    (subcommand === "bisect" && subcommandArguments.includes("run"))
  ) {
    throw new RestrictedShellError("Git subprocess execution modes are not allowed");
  }
}

export function rejectUnsafeArgv(argv: readonly string[]): void {
  if (argv.length === 0 || argv[0].length === 0) {
    throw new RestrictedShellError("Command must contain an executable");
  }

  if (ENVIRONMENT_ASSIGNMENT.test(argv[0])) {
    throw new RestrictedShellError("Environment assignments are not allowed");
  }

  for (const argument of argv) {
    if (ENVIRONMENT_ASSIGNMENT.test(argument)) {
      throw new RestrictedShellError("Environment assignments are not allowed");
    }
    if (argument === "-c" || argument === "--command") {
      throw new RestrictedShellError("Interpreter -c execution is not allowed");
    }
    if (argument === "--interactive") {
      throw new RestrictedShellError("Interactive sessions are not allowed");
    }
  }

  const executable = executableName(argv[0]);
  rejectOptionDrivenSubprocess(argv, executable);
  if (SHELLS[executable] === true || executable === "cmd" || executable === "cmd.exe") {
    throw new RestrictedShellError("Nested shell execution is not allowed");
  }
  if (INDIRECTION_COMMANDS[executable] === true) {
    throw new RestrictedShellError("Command indirection is not allowed");
  }
  if (
    argv
      .slice(1)
      .some((argument) => SHELLS[executableName(argument)] === true)
  ) {
    throw new RestrictedShellError("Nested shell execution is not allowed");
  }
  if (LONG_LIVED_COMMANDS[executable] === true) {
    throw new RestrictedShellError("Interactive or long-lived sessions are not allowed");
  }
  if (
    executable === "tail" &&
    argv.slice(1).some((argument) => argument === "-f" || argument === "-F" || argument === "--follow")
  ) {
    throw new RestrictedShellError("Long-lived follow sessions are not allowed");
  }
  if (INTERPRETERS[executable] === true) {
    if (argv.length === 1) {
      throw new RestrictedShellError("Interactive interpreter sessions are not allowed");
    }
    if (isInlineInterpreterExecution(argv, executable)) {
      throw new RestrictedShellError("Inline interpreter execution is not allowed");
    }
  }
}

/**
 * Parse the deliberately small shell subset used by command rules. The result is
 * literal argv; no expansion, operator, redirect, or secondary parse is accepted.
 */
export function parseRestrictedCommand(command: string): string[] {
  if (typeof command !== "string" || command.length === 0) {
    throw new RestrictedShellError("Command must be a non-empty string");
  }
  if (command.includes("\0")) {
    throw new RestrictedShellError("Command contains a NUL byte");
  }

  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  const finishToken = (): void => {
    if (tokenStarted) {
      argv.push(token);
      token = "";
      tokenStarted = false;
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (character === "\n" || character === "\r") {
      throw new RestrictedShellError("Command must be a single line");
    }

    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (character === "\\") {
        const next = command[index + 1];
        if (next === undefined || !['"', "\\", "$", "`"].includes(next)) {
          throw new RestrictedShellError("Unsafe escape in double-quoted argument");
        }
        token += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
      if (character === "$" || character === "`") {
        throw new RestrictedShellError("Command substitution and expansion are not allowed");
      }
      token += character;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined || next === "\n" || next === "\r") {
        throw new RestrictedShellError("Malformed backslash escape");
      }
      token += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (UNSAFE_UNQUOTED[character] === true) {
      throw new RestrictedShellError("Shell operators and redirects are not allowed");
    }
    if (character === "$" || character === "`") {
      throw new RestrictedShellError("Command substitution and expansion are not allowed");
    }
    if (character === "#") {
      throw new RestrictedShellError("Shell comments are not allowed");
    }
    if (EXPANSION_UNQUOTED[character] === true || (character === "~" && !tokenStarted)) {
      throw new RestrictedShellError("Shell pathname and brace expansion are not allowed");
    }

    token += character;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw new RestrictedShellError("Malformed shell quoting");
  }
  finishToken();
  rejectUnsafeArgv(argv);
  return argv;
}
