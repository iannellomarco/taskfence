import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  NormalizedOperation,
  NormalizedToolCall,
  PathOperation,
  RuntimeName,
} from "../types.js";

interface ToolCatalog {
  read: Record<string, true>;
  shell: Record<string, true>;
  write: Record<string, true>;
  create: Record<string, true>;
  edit: Record<string, true>;
  delete: Record<string, true>;
  rename: Record<string, true>;
  patch: Record<string, true>;
}

const TOOL_CATALOGS: Record<RuntimeName, ToolCatalog> = {
  claude: {
    read: {
      EnterPlanMode: true,
      Glob: true,
      Grep: true,
      Read: true,
      ToolSearch: true,
      WebFetch: true,
      WebSearch: true,
    },
    shell: { Bash: true },
    write: { Write: true },
    create: { Create: true },
    edit: { Edit: true, NotebookEdit: true },
    delete: { Delete: true },
    rename: { Move: true, Rename: true },
    patch: { ApplyPatch: true, apply_patch: true },
  },
  codex: {
    read: {
      grep_files: true,
      list_dir: true,
      read_file: true,
      view_image: true,
      web_search: true,
    },
    shell: { bash: true, exec_command: true, local_shell: true, shell: true, shell_command: true },
    write: { write_file: true },
    create: { create_file: true },
    edit: { edit_file: true },
    delete: { delete_file: true },
    rename: { move_file: true, rename_file: true },
    patch: { apply_patch: true },
  },
  opencode: {
    read: { glob: true, grep: true, read: true, webfetch: true, websearch: true },
    shell: { bash: true, shell: true },
    write: { write: true, write_file: true },
    create: { create: true, create_file: true },
    edit: { edit: true, edit_file: true },
    delete: { delete: true, delete_file: true },
    rename: { move: true, move_file: true, rename: true, rename_file: true },
    patch: { apply_patch: true, patch: true },
  },
  omp: {
    read: { find: true, glob: true, grep: true, ls: true, read: true, web_search: true },
    shell: { bash: true, shell: true },
    write: { write: true, write_file: true },
    create: { create: true, create_file: true },
    edit: { edit: true, edit_file: true },
    delete: { delete: true, delete_file: true },
    rename: { move: true, move_file: true, rename: true, rename_file: true },
    patch: { apply_patch: true },
  },
  pi: {
    read: { find: true, glob: true, grep: true, ls: true, read: true, web_search: true },
    shell: { bash: true, shell: true },
    write: { write: true, write_file: true },
    create: { create: true, create_file: true },
    edit: { edit: true, edit_file: true },
    delete: { delete: true, delete_file: true },
    rename: { move: true, move_file: true, rename: true, rename_file: true },
    patch: { apply_patch: true },
  },
};

const READ_REQUIRED_STRING_FIELDS: Record<RuntimeName, Record<string, readonly string[]>> = {
  claude: {
    Glob: ["pattern"],
    Grep: ["pattern"],
    Read: ["file_path", "path"],
    WebFetch: ["url"],
    WebSearch: ["query"],
  },
  codex: {
    grep_files: ["pattern", "query"],
    list_dir: ["path"],
    read_file: ["path", "filePath"],
    view_image: ["path"],
    web_search: ["query"],
  },
  opencode: {
    glob: ["pattern"],
    grep: ["pattern"],
    read: ["filePath", "path"],
    webfetch: ["url"],
    websearch: ["query"],
  },
  omp: {
    find: ["pattern"],
    glob: ["pattern"],
    grep: ["pattern"],
    ls: ["path"],
    read: ["path"],
    web_search: ["query"],
  },
  pi: {
    find: ["pattern"],
    glob: ["pattern"],
    grep: ["pattern"],
    ls: ["path"],
    read: ["path"],
    web_search: ["query"],
  },
};

interface StringFieldResult {
  value?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneRequiredString(
  input: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): StringFieldResult {
  const present = fields.filter((field) => Object.hasOwn(input, field));
  if (present.length !== 1) {
    return { error: `${label} must be supplied in exactly one supported field` };
  }
  const value = input[present[0]];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return { error: `${label} must be a non-empty NUL-free string` };
  }
  return { value };
}

function effectiveCwd(input: Record<string, unknown>, cwd: string): StringFieldResult {
  const present = ["cwd", "workdir", "working_directory"].filter((field) => Object.hasOwn(input, field));
  if (present.length > 1) {
    return { error: "Tool input contains conflicting working directories" };
  }
  if (present.length === 0) {
    return { value: cwd };
  }
  const declared = input[present[0]];
  if (typeof declared !== "string" || declared.length === 0 || declared.includes("\0")) {
    return { error: "Tool working directory must be a non-empty NUL-free string" };
  }
  return { value: isAbsolute(declared) ? declared : resolve(cwd, declared) };
}

function classifyWrite(cwd: string, target: string): PathOperation {
  const candidate = isAbsolute(target) ? target : resolve(cwd, target);
  try {
    lstatSync(candidate);
    return "write";
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    return code === "ENOENT" || code === "ENOTDIR" ? "create" : "write";
  }
}

function normalizeObservedTarget(cwd: string, target: string): string {
  if (!isAbsolute(target)) return target;
  return relative(cwd, target).split(sep).join("/");
}

function parsePatch(patch: string): StringFieldResult & { operations?: NormalizedOperation[] } {
  if (patch.includes("\0")) {
    return { error: "Patch contains a NUL byte" };
  }
  const lines = patch.split(/\r?\n/u);
  if (lines[0] !== "*** Begin Patch") {
    return { error: "Patch must start with the apply_patch begin marker" };
  }
  let endIndex = lines.length - 1;
  while (endIndex > 0 && lines[endIndex] === "") {
    endIndex -= 1;
  }
  if (lines[endIndex] !== "*** End Patch") {
    return { error: "Patch must end with the apply_patch end marker" };
  }

  type PendingFile = { kind: "Add" | "Update" | "Delete"; target: string; moveTarget?: string };
  let pending: PendingFile | null = null;
  const operations: NormalizedOperation[] = [];

  const flush = (): void => {
    if (pending === null) return;
    if (pending.kind === "Add") {
      operations.push({ operation: "create", target: pending.target });
    } else if (pending.kind === "Delete") {
      operations.push({ operation: "delete", target: pending.target });
    } else if (pending.moveTarget !== undefined) {
      operations.push({ operation: "delete", target: pending.target });
      operations.push({ operation: "create", target: pending.moveTarget });
    } else {
      operations.push({ operation: "write", target: pending.target });
    }
    pending = null;
  };

  for (let index = 1; index < endIndex; index += 1) {
    const line = lines[index];
    const fileDirective = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    if (fileDirective !== null) {
      flush();
      pending = {
        kind: fileDirective[1] as PendingFile["kind"],
        target: fileDirective[2],
      };
      continue;
    }
    const moveDirective = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (moveDirective !== null) {
      if (pending?.kind !== "Update" || pending.moveTarget !== undefined) {
        return { error: "Patch move directive is not attached to one update" };
      }
      pending.moveTarget = moveDirective[1];
      continue;
    }
    if (line.startsWith("*** ")) {
      return { error: "Patch contains an unsupported structural directive" };
    }
  }
  flush();

  if (operations.length === 0) {
    return { error: "Patch contains no file operations" };
  }
  const seen = new Set<string>();
  return {
    operations: operations.filter((operation) => {
      const key = `${operation.operation}\0${operation.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

function malformed(
  runtime: RuntimeName,
  toolName: string,
  cwd: string,
  reason: string,
  sessionId?: string,
  callId?: string,
): NormalizedToolCall {
  return { runtime, toolName, cwd, sessionId, callId, kind: "malformed", reason };
}

export function normalizeToolCall(
  runtime: RuntimeName,
  toolName: string,
  input: unknown,
  cwd: string,
  sessionId?: string,
  callId?: string,
): NormalizedToolCall {
  const catalog = TOOL_CATALOGS[runtime];
  if (catalog === undefined) {
    return malformed(runtime, String(toolName), String(cwd), "Unsupported runtime", sessionId, callId);
  }
  if (typeof toolName !== "string" || toolName.length === 0) {
    return malformed(runtime, String(toolName), cwd, "Tool name must be a non-empty string", sessionId, callId);
  }
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    return malformed(runtime, toolName, String(cwd), "Tool cwd must be a non-empty NUL-free string", sessionId, callId);
  }
  if ((sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) ||
      (callId !== undefined && (typeof callId !== "string" || callId.length === 0))) {
    return malformed(runtime, toolName, cwd, "Session and call identifiers must be non-empty strings", sessionId, callId);
  }
  if (!isRecord(input)) {
    return malformed(runtime, toolName, cwd, "Tool input must be an object", sessionId, callId);
  }

  const base = { runtime, toolName, cwd, sessionId, callId };
  if (catalog.read[toolName] === true) {
    const requiredFields = READ_REQUIRED_STRING_FIELDS[runtime][toolName];
    if (requiredFields !== undefined) {
      const required = oneRequiredString(input, requiredFields, "Read-only tool argument");
      if (required.error !== undefined) {
        return malformed(runtime, toolName, cwd, required.error, sessionId, callId);
      }
    }
    return { ...base, kind: "read" };
  }

  if (catalog.shell[toolName] === true) {
    for (const flag of ["run_in_background", "background", "interactive", "pty"] as const) {
      if (Object.hasOwn(input, flag) && typeof input[flag] !== "boolean") {
        return malformed(runtime, toolName, cwd, `${flag} must be boolean`, sessionId, callId);
      }
      if (input[flag] === true) {
        return malformed(runtime, toolName, cwd, "Background and interactive shell sessions are not allowed", sessionId, callId);
      }
    }
    const command = oneRequiredString(input, ["command", "cmd"], "Shell command");
    const shellCwd = effectiveCwd(input, cwd);
    if (command.error !== undefined || command.value === undefined) {
      return malformed(runtime, toolName, cwd, command.error ?? "Shell command is malformed", sessionId, callId);
    }
    if (shellCwd.error !== undefined || shellCwd.value === undefined) {
      return malformed(runtime, toolName, cwd, shellCwd.error ?? "Shell cwd is malformed", sessionId, callId);
    }
    return { ...base, cwd: shellCwd.value, kind: "command", command: command.value };
  }

  const pathFields = runtime === "claude"
    ? ["file_path", "notebook_path", "path"] as const
    : ["path", "filePath", "file_path"] as const;

  if (catalog.write[toolName] === true || catalog.create[toolName] === true || catalog.edit[toolName] === true || catalog.delete[toolName] === true) {
    const target = oneRequiredString(input, pathFields, "Target path");
    if (target.error !== undefined || target.value === undefined) {
      return malformed(runtime, toolName, cwd, target.error ?? "Target path is malformed", sessionId, callId);
    }
    const normalizedTarget = normalizeObservedTarget(cwd, target.value);
    let operation: PathOperation;
    if (catalog.delete[toolName] === true) operation = "delete";
    else if (catalog.create[toolName] === true) operation = "create";
    else if (catalog.edit[toolName] === true) operation = "write";
    else operation = classifyWrite(cwd, target.value);
    return { ...base, kind: "mutation", operations: [{ operation, target: normalizedTarget }] };
  }

  if (catalog.rename[toolName] === true) {
    const source = oneRequiredString(input, ["source", "from", "oldPath", "old_path", "file_path"], "Rename source");
    const destination = oneRequiredString(input, ["destination", "to", "newPath", "new_path"], "Rename destination");
    if (source.error !== undefined || source.value === undefined) {
      return malformed(runtime, toolName, cwd, source.error ?? "Rename source is malformed", sessionId, callId);
    }
    if (destination.error !== undefined || destination.value === undefined) {
      return malformed(runtime, toolName, cwd, destination.error ?? "Rename destination is malformed", sessionId, callId);
    }
    const normalizedSource = normalizeObservedTarget(cwd, source.value);
    const normalizedDestination = normalizeObservedTarget(cwd, destination.value);
    return {
      ...base,
      kind: "mutation",
      operations: [
        { operation: "delete", target: normalizedSource },
        { operation: "create", target: normalizedDestination },
      ],
    };
  }

  if (catalog.patch[toolName] === true) {
    const patchText = oneRequiredString(input, ["command", "patch", "patchText", "input"], "Patch text");
    if (patchText.error !== undefined || patchText.value === undefined) {
      return malformed(runtime, toolName, cwd, patchText.error ?? "Patch text is malformed", sessionId, callId);
    }
    const parsed = parsePatch(patchText.value);
    if (parsed.error !== undefined || parsed.operations === undefined) {
      return malformed(runtime, toolName, cwd, parsed.error ?? "Patch is malformed", sessionId, callId);
    }
    return { ...base, kind: "mutation", operations: parsed.operations };
  }

  return {
    ...base,
    kind: "unknown",
    reason: "Tool is not present in the runtime's explicit read-only or mutation catalog",
  };
}
