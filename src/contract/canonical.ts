import { createHash } from "node:crypto";

function canonicalize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON does not support non-finite numbers");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not support cyclic values");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON does not support sparse arrays");
        }
        entries.push(canonicalize(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON supports only plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("Canonical JSON does not support symbol keys");
    }

    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Canonical JSON does not support accessor properties");
      }
      entries.push(
        `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
