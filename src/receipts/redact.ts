const REDACTED = "[REDACTED]";

const SECRET_KEYS: Record<string, true> = {
  accesstoken: true,
  apikey: true,
  authtoken: true,
  authorization: true,
  awsecretaccesskey: true,
  clientsecret: true,
  cookie: true,
  credential: true,
  credentials: true,
  idtoken: true,
  password: true,
  passwd: true,
  privatekey: true,
  proxyauthorization: true,
  refreshtoken: true,
  secret: true,
  sessiontoken: true,
  setcookie: true,
  token: true,
};
const RAW_CONTENT_KEYS: Record<string, true> = {
  args: true,
  arguments: true,
  argv: true,
  body: true,
  command: true,
  content: true,
  diff: true,
  filecontent: true,
  filecontents: true,
  filetext: true,
  input: true,
  newstring: true,
  oldstring: true,
  output: true,
  patch: true,
  payload: true,
  prompt: true,
  raw: true,
  request: true,
  response: true,
  stderr: true,
  stdin: true,
  stdout: true,
  text: true,
};
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AUTHORIZATION = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const ASSIGNED_SECRET = /\b(api[-_]?key|auth[-_]?token|access[-_]?token|client[-_]?secret|id[-_]?token|password|passwd|refresh[-_]?token|secret|session[-_]?token|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const KNOWN_TOKEN = /\b(?:AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|gh[oprsu]_[A-Za-z0-9_]+|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]+)\b/g;
export const MAX_RECEIPT_METADATA_BYTES = 64 * 1024;
const MAX_RECEIPT_METADATA_DEPTH = 32;
const MAX_RECEIPT_METADATA_NODES = 4_096;

interface NormalizationBudget {
  nodes: number;
  stringBytes: number;
}

function consumeBudget(
  budget: NormalizationBudget,
  value: unknown,
  depth: number,
  path: string,
): void {
  budget.nodes += 1;
  if (depth > MAX_RECEIPT_METADATA_DEPTH) {
    throw new TypeError(`Receipt metadata at ${path} exceeds maximum nesting depth`);
  }
  if (budget.nodes > MAX_RECEIPT_METADATA_NODES) {
    throw new TypeError("Receipt metadata contains too many values");
  }
  if (typeof value === "string") {
    budget.stringBytes += Buffer.byteLength(value, "utf8");
    if (budget.stringBytes > MAX_RECEIPT_METADATA_BYTES) {
      throw new TypeError("Receipt metadata strings exceed the byte limit");
    }
  }
}

function redactString(value: string): string {
  return value
    .replace(PRIVATE_KEY, REDACTED)
    .replace(AUTHORIZATION, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(ASSIGNED_SECRET, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(URI_CREDENTIALS, `$1${REDACTED}@`)
    .replace(KNOWN_TOKEN, REDACTED);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) {
    return true;
  }
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  return (
    Object.getPrototypeOf(prototype) === null &&
    constructor !== undefined &&
    "value" in constructor &&
    typeof constructor.value === "function" &&
    constructor.value.name === "Object"
  );
}

function normalizeValue(
  value: unknown,
  ancestors: Set<object>,
  path: string,
  budget: NormalizationBudget,
  depth: number,
): unknown {
  consumeBudget(budget, value, depth, path);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? redactString(value) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Receipt metadata at ${path} must contain only finite numbers`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`Receipt metadata at ${path} contains an invalid date`);
    }
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength, value: REDACTED };
  }
  if (typeof value !== "object") {
    throw new TypeError(`Receipt metadata at ${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`Receipt metadata at ${path} contains a cycle`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const normalized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError(`Receipt metadata at ${path}[${index}] must be a dense data array`);
        }
        normalized.push(
          descriptor.value === undefined
            ? null
            : normalizeValue(descriptor.value, ancestors, `${path}[${index}]`, budget, depth + 1),
        );
      }
      return normalized;
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`Receipt metadata at ${path} contains an unsupported object`);
    }

    const normalized: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      budget.stringBytes += Buffer.byteLength(key, "utf8");
      if (budget.stringBytes > MAX_RECEIPT_METADATA_BYTES) {
        throw new TypeError("Receipt metadata keys exceed the byte limit");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`Receipt metadata at ${path}.${key} contains an accessor`);
      }
      const item = descriptor.value;
      if (item === undefined) {
        continue;
      }
      const normalizedKey = key.replace(/[-_\s]/g, "").toLowerCase();
      const secretKey =
        Object.hasOwn(SECRET_KEYS, normalizedKey) ||
        normalizedKey.endsWith("apikey") ||
        normalizedKey.endsWith("password") ||
        normalizedKey.endsWith("privatekey") ||
        normalizedKey.endsWith("secret") ||
        normalizedKey.endsWith("token");
      normalized[key] = secretKey || Object.hasOwn(RAW_CONTENT_KEYS, normalizedKey)
        ? REDACTED
        : normalizeValue(item, ancestors, `${path}.${key}`, budget, depth + 1);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces deterministic JSON-safe metadata while excluding raw tool content and
 * secret-valued fields. The returned object is safe to include in a receipt.
 */
export function normalizeReceiptMetadata(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const normalized = normalizeValue(
    metadata,
    new Set<object>(),
    "metadata",
    { nodes: 0, stringBytes: 0 },
    0,
  ) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_RECEIPT_METADATA_BYTES) {
    throw new TypeError(`Receipt metadata exceeds ${MAX_RECEIPT_METADATA_BYTES} bytes`);
  }
  return normalized;
}
