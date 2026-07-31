const EXACT_OPENING = "```taskfence-contract";

interface MarkdownFence {
  readonly body: string;
  readonly canonical: boolean;
}

interface MarkdownLine {
  readonly content: string;
  readonly nested: boolean;
}

function markdownLineContent(line: string): MarkdownLine {
  let content = line;
  let nested = false;

  while (true) {
    const blockQuote = /^ {0,3}>[ \t]?(.*)$/u.exec(content);
    if (blockQuote !== null) {
      content = blockQuote[1]!;
      nested = true;
      continue;
    }
    const listItem =
      /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+(.*)$/u.exec(content);
    if (listItem !== null) {
      content = listItem[1]!;
      nested = true;
      continue;
    }
    return { content, nested };
  }
}

function scanTaskFenceFences(planText: string): MarkdownFence[] {
  const lines = planText.split(/\r?\n/u);
  const fences: MarkdownFence[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const sourceOpeningLine = lines[index]!;
    const openingLine = markdownLineContent(sourceOpeningLine);
    const opening =
      /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(openingLine.content);
    if (opening === null) continue;

    const marker = opening[2]!;
    const info = opening[3]!;
    if (marker[0] === "`" && info.includes("`")) continue;

    let closingIndex = lines.length;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const closingLine = markdownLineContent(lines[candidate]!);
      const closing =
        /^( {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(closingLine.content);
      if (
        closing !== null &&
        closing[2]![0] === marker[0] &&
        closing[2]!.length >= marker.length
      ) {
        closingIndex = candidate;
        break;
      }
    }

    if (info.trimStart().toLowerCase().startsWith("taskfence")) {
      fences.push({
        body: lines.slice(index + 1, closingIndex).join("\n"),
        canonical:
          !openingLine.nested &&
          sourceOpeningLine === EXACT_OPENING &&
          closingIndex < lines.length &&
          lines[closingIndex] === "```",
      });
    }

    index = closingIndex;
  }

  return fences;
}

export function extractContractBlock(planText: string): string {
  const fences = scanTaskFenceFences(planText);
  if (fences.length !== 1 || fences[0]?.canonical !== true) {
    throw new Error(
      "Approved plan must contain exactly one exact ```taskfence-contract JSON block",
    );
  }

  const body = fences[0].body;
  if (body.trim().length === 0) {
    throw new Error("TaskFence contract block must contain one JSON object");
  }

  return body;
}

class JsonDuplicateKeyScanner {
  private offset = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) {
      this.fail("Unexpected content after JSON value");
    }
  }

  private scanValue(): void {
    this.skipWhitespace();
    const token = this.source[this.offset];
    if (token === "{") {
      this.scanObject();
      return;
    }
    if (token === "[") {
      this.scanArray();
      return;
    }
    if (token === '"') {
      this.scanString();
      return;
    }
    if (token === "t") {
      this.scanLiteral("true");
      return;
    }
    if (token === "f") {
      this.scanLiteral("false");
      return;
    }
    if (token === "n") {
      this.scanLiteral("null");
      return;
    }
    this.scanNumber();
  }

  private scanObject(): void {
    this.offset += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.consume("}")) return;

    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') this.fail("Expected object key");
      const key = this.scanString();
      if (keys.has(key)) this.fail(`Duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.fail("Expected colon after object key");
      this.scanValue();
      this.skipWhitespace();
      if (this.consume("}")) return;
      if (!this.consume(",")) this.fail("Expected comma between object entries");
    }
  }

  private scanArray(): void {
    this.offset += 1;
    this.skipWhitespace();
    if (this.consume("]")) return;

    while (true) {
      this.scanValue();
      this.skipWhitespace();
      if (this.consume("]")) return;
      if (!this.consume(",")) this.fail("Expected comma between array entries");
    }
  }

  private scanString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      this.offset += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        const raw = this.source.slice(start, this.offset);
        return JSON.parse(raw) as string;
      }
    }
    this.fail("Unterminated JSON string");
  }

  private scanNumber(): void {
    const match = this.source.slice(this.offset).match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
    );
    if (!match) this.fail("Expected JSON value");
    this.offset += match[0].length;
  }

  private scanLiteral(literal: string): void {
    if (!this.source.startsWith(literal, this.offset)) {
      this.fail(`Expected ${literal}`);
    }
    this.offset += literal.length;
  }

  private skipWhitespace(): void {
    while (
      this.offset < this.source.length &&
      /[\u0009\u000a\u000d\u0020]/.test(this.source[this.offset] ?? "")
    ) {
      this.offset += 1;
    }
  }

  private consume(token: string): boolean {
    if (this.source[this.offset] !== token) return false;
    this.offset += 1;
    return true;
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} at byte ${this.offset}`);
  }
}

export function parseContractJson(source: string): unknown {
  const parsed: unknown = JSON.parse(source);
  new JsonDuplicateKeyScanner(source).scan();
  return parsed;
}
