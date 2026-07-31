import { createInterface } from "node:readline/promises";

import { canonicalStringify } from "./contract/canonical.js";
import type {
  CommandRule,
  CompiledContract,
  PackageManager,
  PathSelector,
} from "./types.js";

export interface TTYConfirmationOptions {
  yes?: boolean;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface SemanticCollectionDelta<T> {
  added: T[];
  removed: T[];
}

export interface SemanticContractDelta {
  changed: boolean;
  root: { before: string | null; after: string } | null;
  packageManager: {
    before: PackageManager | null;
    after: PackageManager;
  } | null;
  write: SemanticCollectionDelta<PathSelector>;
  create: SemanticCollectionDelta<PathSelector>;
  delete: SemanticCollectionDelta<PathSelector>;
  protected: SemanticCollectionDelta<PathSelector>;
  commands: SemanticCollectionDelta<CommandRule>;
}

function collectionDelta<T>(
  before: readonly T[],
  after: readonly T[],
): SemanticCollectionDelta<T> {
  const beforeByCanonical = new Map(
    before.map((value) => [canonicalStringify(value), value]),
  );
  const afterByCanonical = new Map(
    after.map((value) => [canonicalStringify(value), value]),
  );
  return {
    added: [...afterByCanonical]
      .filter(([key]) => !beforeByCanonical.has(key))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([, value]) => value),
    removed: [...beforeByCanonical]
      .filter(([key]) => !afterByCanonical.has(key))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([, value]) => value),
  };
}

/**
 * Confirms an authority-bearing action. Non-interactive callers must opt in
 * explicitly with `yes`; a redirected stdin/stdout pair never counts as user
 * confirmation.
 */
export async function confirmTTY(
  prompt: string,
  options: TTYConfirmationOptions = {},
): Promise<boolean> {
  if (options.yes === true) return true;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("Confirmation prompt must be a non-empty string");
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error("Interactive TTY confirmation is required; pass --yes to confirm non-interactively");
  }

  const terminal = createInterface({ input, output, terminal: true });
  try {
    const answer = (await terminal.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
}

/** Returns only authority-relevant semantic changes, ignoring plan prose/hash changes. */
export function semanticContractDelta(
  previous: CompiledContract | null,
  next: CompiledContract,
): SemanticContractDelta {

  const write = collectionDelta(previous?.document.write ?? [], next.document.write);
  const create = collectionDelta(previous?.document.create ?? [], next.document.create);
  const deleteDelta = collectionDelta(previous?.document.delete ?? [], next.document.delete);
  const protectedDelta = collectionDelta(previous?.document.protected ?? [], next.document.protected);
  const commands = collectionDelta(previous?.document.commands ?? [], next.document.commands);
  const root = previous?.root === next.root
    ? null
    : { before: previous?.root ?? null, after: next.root };
  const packageManager = previous?.document.packageManager === next.document.packageManager
    ? null
    : {
        before: previous?.document.packageManager ?? null,
        after: next.document.packageManager,
      };
  const changed = root !== null ||
    packageManager !== null ||
    write.added.length !== 0 || write.removed.length !== 0 ||
    create.added.length !== 0 || create.removed.length !== 0 ||
    deleteDelta.added.length !== 0 || deleteDelta.removed.length !== 0 ||
    protectedDelta.added.length !== 0 || protectedDelta.removed.length !== 0 ||
    commands.added.length !== 0 || commands.removed.length !== 0;

  return {
    changed,
    root,
    packageManager,
    write,
    create,
    delete: deleteDelta,
    protected: protectedDelta,
    commands,
  };
}
