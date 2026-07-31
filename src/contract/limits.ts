import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export const MAX_PLAN_BYTES = 8 * 1024 * 1024;

const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

function validatePlanFileMetadata(metadata: BigIntStats, path: string): void {
  if (!metadata.isFile()) {
    throw new Error(`TaskFence plan file is not a regular file: ${path}`);
  }
  if (metadata.size < 0n || metadata.size > BigInt(MAX_PLAN_BYTES)) {
    throw new Error(`TaskFence plan file exceeds ${MAX_PLAN_BYTES} bytes`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) {
    throw new Error(`TaskFence plan file is not owned by the current user: ${path}`);
  }
}

function metadataChanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs;
}

function decodePlan(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("TaskFence plan file is not valid UTF-8 text");
  }
  return requireBoundedPlanText(text);
}

export function requireBoundedPlanText(
  value: unknown,
  label = "TaskFence plan",
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text`);
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_PLAN_BYTES) {
    throw new Error(`${label} exceeds ${MAX_PLAN_BYTES} bytes`);
  }
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be non-empty, NUL-free text`);
  }
  return value;
}

async function readFromHandle(handle: FileHandle, path: string): Promise<string> {
  const before = await handle.stat({ bigint: true });
  validatePlanFileMetadata(before, path);
  const expectedBytes = Number(before.size);
  const bytes = Buffer.allocUnsafe(expectedBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_PLAN_BYTES) {
    throw new Error(`TaskFence plan file exceeds ${MAX_PLAN_BYTES} bytes`);
  }
  const after = await handle.stat({ bigint: true });
  if (metadataChanged(before, after) || offset !== expectedBytes) {
    throw new Error("TaskFence plan file changed while it was being read");
  }
  return decodePlan(bytes.subarray(0, offset));
}

export async function readBoundedPlanFile(path: string): Promise<string> {
  const handle = await open(path, READ_FLAGS);
  try {
    return await readFromHandle(handle, path);
  } finally {
    await handle.close();
  }
}

export function readBoundedPlanFileSync(path: string): string {
  const descriptor = openSync(path, READ_FLAGS);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    validatePlanFileMetadata(before, path);
    const expectedBytes = Number(before.size);
    const bytes = Buffer.allocUnsafe(expectedBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PLAN_BYTES) {
      throw new Error(`TaskFence plan file exceeds ${MAX_PLAN_BYTES} bytes`);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (metadataChanged(before, after) || offset !== expectedBytes) {
      throw new Error("TaskFence plan file changed while it was being read");
    }
    return decodePlan(bytes.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}
