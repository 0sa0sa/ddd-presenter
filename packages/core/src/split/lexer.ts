/**
 * Tokenizer shared by the .proto, .domain and .flow sources (docs/10 §12). Newlines are tokens because the
 * .domain / .flow grammar ends statements at the end of a line; the .proto parser skips them.
 *
 * A comment block directly above a declaration (no blank line in between) is its description, as in protobuf:
 * the lexer hands it to the first token of the following line as `doc`.
 */

export type TokKind = "id" | "num" | "str" | "punct" | "nl" | "other" | "eof";

export interface Tok {
  k: TokKind;
  /** Source text (for `str`, the decoded value). */
  v: string;
  /** Offsets [s, e) into the source. */
  s: number;
  e: number;
  line: number;
  col: number;
  /** Description from the comment block attached above this token's line (first token of a line only). */
  doc?: string;
  /** Comment lines above this token's line that are separated from it by a blank line, or every comment line for a statement without a description. */
  comments?: string[];
}

export class SplitSyntaxError extends Error {
  constructor(
    message: string,
    readonly tok: { line: number; col: number },
    readonly hint?: string,
  ) {
    super(message);
  }
}

const PUNCT2 = ["==", "!=", "<=", ">=", "->"];
const PUNCT1 = "{}()[]<>;:,.=+-*/?";

function decodeString(src: string, start: number, quote: string, at: { line: number; col: number }): { value: string; end: number } {
  let i = start + 1;
  let out = "";
  while (i < src.length && src[i] !== quote) {
    const c = src[i]!;
    if (c === "\n") break;
    if (c === "\\" && i + 1 < src.length) {
      const n = src[i + 1]!;
      i += 2;
      switch (n) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "v":
          out += "\v";
          break;
        case "a":
          out += "\x07";
          break;
        case "0":
          out += "\0";
          break;
        case "u": {
          const hex = src.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SplitSyntaxError("Invalid \\u escape in a string", at);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        case "x": {
          const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i))?.[0];
          if (!hex) throw new SplitSyntaxError("Invalid \\x escape in a string", at);
          out += String.fromCharCode(parseInt(hex, 16));
          i += hex.length;
          break;
        }
        default:
          out += n;
      }
      continue;
    }
    out += c;
    i++;
  }
  if (src[i] !== quote) throw new SplitSyntaxError("Unterminated string", at, "Close the string on the same line");
  return { value: out, end: i + 1 };
}

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  /** Comment lines seen since the last token: [line, text]. */
  let pending: { line: number; text: string }[] = [];
  let lastTokLine = 0;
  const pos = (at: number) => ({ line, col: at - lineStart + 1 });
  const push = (t: Omit<Tok, "line" | "col">) => {
    const p = pos(t.s);
    const tok: Tok = { ...t, ...p };
    if (t.k !== "nl" && p.line !== lastTokLine) {
      // First token of its line: the contiguous comment block ending on the line above is its description.
      let j = pending.length;
      let expect = p.line - 1;
      while (j > 0 && pending[j - 1]!.line === expect) {
        j--;
        expect--;
      }
      const attached = pending.slice(j);
      const detached = pending.slice(0, j);
      if (attached.length) tok.doc = attached.map((c) => c.text).join("\n");
      if (detached.length) tok.comments = detached.map((c) => c.text);
      pending = [];
    }
    if (t.k !== "nl") lastTokLine = p.line;
    toks.push(tok);
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      push({ k: "nl", v: "\n", s: i, e: i + 1 });
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = i + 2;
      while (j < src.length && src[j] !== "\n") j++;
      const raw = src.slice(i + 2, j).replace(/\r$/, "");
      // A trailing comment (code before it on the same line) is not part of any description.
      if (lastTokLine !== line) pending.push({ line, text: raw.startsWith(" ") ? raw.slice(1) : raw });
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new SplitSyntaxError("Unterminated /* comment", pos(i));
      for (let j = i; j < end; j++) {
        if (src[j] === "\n") {
          line++;
          lineStart = j + 1;
        }
      }
      i = end + 2;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c)) {
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      if (src[i] === "." && /[0-9]/.test(src[i + 1] ?? "")) {
        i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      if ((src[i] === "e" || src[i] === "E") && /[-+0-9]/.test(src[i + 1] ?? "")) {
        i++;
        if (src[i] === "-" || src[i] === "+") i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      push({ k: "num", v: src.slice(start, i), s: start, e: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      push({ k: "id", v: src.slice(start, i), s: start, e: i });
      continue;
    }
    if (c === '"' || c === "'") {
      const { value, end } = decodeString(src, i, c, pos(i));
      i = end;
      push({ k: "str", v: value, s: start, e: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      i += 2;
      push({ k: "punct", v: two, s: start, e: i });
      continue;
    }
    if (PUNCT1.includes(c)) {
      i++;
      push({ k: "punct", v: c, s: start, e: i });
      continue;
    }
    // Anything else is kept as a token so that the grammar (or the expression checker) can report it in context.
    i += c.length;
    push({ k: "other", v: c, s: start, e: i });
  }
  push({ k: "eof", v: "", s: src.length, e: src.length });
  return toks;
}

/** Deepest nesting of blocks / option messages (hostile input becomes a diagnostic, not a stack overflow). */
export const MAX_NESTING = 64;

/** Cursor over tokens with the helpers both parsers use. */
export class Cursor {
  p = 0;
  private depth = 0;

  /** Runs `parse` one nesting level deeper. */
  nested<T>(at: Tok, parse: () => T): T {
    if (++this.depth > MAX_NESTING) throw new SplitSyntaxError(`Nested too deeply (more than ${MAX_NESTING} levels)`, at);
    try {
      return parse();
    } finally {
      this.depth--;
    }
  }

  constructor(
    readonly toks: Tok[],
    readonly src: string,
    /** Skip newline tokens transparently (.proto). */
    readonly skipNewlines: boolean,
  ) {}

  private skip(): void {
    if (this.skipNewlines) while (this.toks[this.p]!.k === "nl") this.p++;
  }

  peek(offset = 0): Tok {
    this.skip();
    let p = this.p;
    for (let n = 0; ; p++) {
      const t = this.toks[p]!;
      if (t.k === "eof") return t;
      if (this.skipNewlines && t.k === "nl") continue;
      if (n === offset) return t;
      n++;
    }
  }

  next(): Tok {
    this.skip();
    const t = this.toks[this.p]!;
    if (t.k !== "eof") this.p++;
    return t;
  }

  /** Skips newline tokens (in newline-sensitive mode). */
  newlines(): void {
    while (this.toks[this.p]!.k === "nl") this.p++;
  }

  is(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return (t.k === "punct" || t.k === "id") && t.v === v;
  }

  accept(v: string): Tok | undefined {
    if (this.is(v)) return this.next();
    return undefined;
  }

  expect(v: string, what?: string): Tok {
    const t = this.peek();
    if ((t.k === "punct" || t.k === "id") && t.v === v) return this.next();
    throw new SplitSyntaxError(`Expected "${v}"${what ? ` ${what}` : ""} but found ${describe(t)}`, t);
  }

  ident(what: string): Tok {
    const t = this.peek();
    if (t.k === "id") return this.next();
    throw new SplitSyntaxError(`Expected ${what} but found ${describe(t)}`, t);
  }

  /** Dotted name `a.b.c`. */
  dotted(what: string): { v: string; tok: Tok } {
    const first = this.ident(what);
    let v = first.v;
    while (this.is(".") && this.peek(1).k === "id") {
      this.next();
      v += "." + this.next().v;
    }
    return { v, tok: first };
  }

  /** Source text of tokens [from, to] (inclusive). */
  text(from: Tok, to: Tok): string {
    return this.src.slice(from.s, to.e);
  }
}

export function describe(t: Tok): string {
  if (t.k === "eof") return "the end of the file";
  if (t.k === "nl") return "the end of the line";
  if (t.k === "str") return `the string ${JSON.stringify(t.v)}`;
  return `"${t.v}"`;
}
