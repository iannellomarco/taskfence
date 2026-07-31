import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

export type JsonObject = Record<string, unknown>;

export interface JsonUpdateResult {
  changed: boolean;
  backupPath?: string;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Refusing to modify ${path}: invalid JSON (${reason})`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`Refusing to modify ${path}: expected a JSON object at the top level`);
  }
  return value;
}

async function readExisting(path: string): Promise<{
  value: JsonObject;
  text: string | null;
  mode: number;
}> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new Error(`Refusing to modify ${path}: path is not a regular file`);
    }
    const text = await readFile(path, "utf8");
    return { value: parseJsonObject(text, path), text, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { value: {}, text: null, mode: 0o600 };
    }
    throw error;
  }
}

function backupName(path: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.taskfence-backup-${timestamp}-${process.pid}`;
}

async function atomicWrite(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.taskfence-tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Updates a JSON object without touching the file unless its structure changes.
 * Existing files are parsed before mutation and backed up immediately before
 * the atomic replacement. Malformed or non-object JSON is never overwritten.
 */
export async function updateJsonObject(
  path: string,
  update: (value: JsonObject) => JsonObject,
): Promise<JsonUpdateResult> {
  const existing = await readExisting(path);
  const working = structuredClone(existing.value);
  const updated = update(working);
  if (!isJsonObject(updated)) {
    throw new Error(`Refusing to modify ${path}: updater returned a non-object value`);
  }

  const before = JSON.stringify(existing.value);
  const after = JSON.stringify(updated);
  if (after === undefined) {
    throw new Error(`Refusing to modify ${path}: result is not JSON-serializable`);
  }
  if (before === after) return { changed: false };

  if (existing.text === null) {
    try {
      await lstat(path);
      throw new Error(`Refusing to modify ${path}: file appeared during update`);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )) throw error;
    }
  } else if (await readFile(path, "utf8") !== existing.text) {
    throw new Error(`Refusing to modify ${path}: file changed during update`);
  }

  let backupPath: string | undefined;
  if (existing.text !== null) {
    backupPath = backupName(path);
    await copyFile(path, backupPath, fsConstants.COPYFILE_EXCL);
  }
  await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`, existing.mode);
  return backupPath === undefined
    ? { changed: true }
    : { changed: true, backupPath };
}

export async function readJsonObject(path: string): Promise<JsonObject | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new Error(`Cannot inspect ${path}: path is not a regular file`);
    }
    return parseJsonObject(await readFile(path, "utf8"), path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
