/**
 * A small, Prettier-compatible formatter for the statements the TypeScript generator emits.
 *
 * Generated code must be "prettier-clean": running Prettier (printWidth 100, the defaults otherwise) over it changes
 * nothing. The generator cannot call Prettier (it is asynchronous, and generation must stay a pure, synchronous,
 * dependency-free function), so this module re-implements the part of Prettier the generated code needs:
 *
 * - the document printer (groups, indentation, soft and hard lines, conditional groups, `ifBreak`, measuring with
 *   the rest of the line) — a port of Prettier's `printDocToString` / `fits` / `propagateBreaks`;
 * - the printing rules of the expression subset the generator emits: calls (last-argument expansion), member chains,
 *   binary and logical chains, arrow functions, ternaries, object and array literals, `as` casts, `await`, unary
 *   operators; assignments (`chooseLayout`), `return` / `throw`, `if (…)` heads, object properties, import lists;
 * - Prettier's parenthesization (`needsParens`): redundant parentheses are dropped, clarifying ones are added
 *   (`(a && b) || c`, `(a * b) % c`).
 *
 * The emitters write each statement on one line (objects and type literals they want expanded are written expanded,
 * which Prettier preserves); `formatSource` re-prints every line that is wider than the print width. The run suite
 * checks the result with the real Prettier over every test model.
 *
 * Ported from Prettier 3 (MIT, https://github.com/prettier/prettier): src/document/printer.js,
 * src/language-js/print/{call-arguments,member-chain,binaryish,arrow-function,assignment}.js.
 */

export const PRINT_WIDTH = 100;
const TAB = "  ";

// ---------------------------------------------------------------------------
// String width (East Asian wide characters count twice, like Prettier's getStringWidth)
// ---------------------------------------------------------------------------

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Display width of `text` as Prettier measures it. */
export function strWidth(text: string): number {
  if (!/[^\x20-\x7e]/.test(text)) return text.length;
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
    if (cp >= 0x300 && cp <= 0x36f) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type Doc = string | Doc[] | Group | Indent | Line | IfBreak | IndentIfBreak | BreakParent;
interface Group {
  t: "group";
  c: Doc;
  brk: boolean;
  states?: Doc[];
  id?: symbol;
}
interface Indent {
  t: "indent";
  c: Doc;
}
interface Line {
  t: "line";
  soft?: boolean;
  hard?: boolean;
}
interface IfBreak {
  t: "if";
  b: Doc;
  f: Doc;
  id?: symbol;
}
interface IndentIfBreak {
  t: "iib";
  c: Doc;
  id: symbol;
}
interface BreakParent {
  t: "bp";
}

const line: Line = { t: "line" };
const softline: Line = { t: "line", soft: true };
const breakParent: BreakParent = { t: "bp" };
const hardline: Doc = [{ t: "line", hard: true }, breakParent];

function group(c: Doc, opts: { shouldBreak?: boolean; id?: symbol } = {}): Group {
  return { t: "group", c, brk: !!opts.shouldBreak, id: opts.id };
}
function conditionalGroup(states: Doc[], shouldBreak = false): Group {
  return { t: "group", c: states[0]!, brk: shouldBreak, states };
}
function indent(c: Doc): Indent {
  return { t: "indent", c };
}
function ifBreak(b: Doc, f: Doc = "", id?: symbol): IfBreak {
  return { t: "if", b, f, id };
}
function indentIfBreak(c: Doc, id: symbol): IndentIfBreak {
  return { t: "iib", c, id };
}
function join(sep: Doc, docs: Doc[]): Doc[] {
  const out: Doc[] = [];
  docs.forEach((d, i) => {
    if (i) out.push(sep);
    out.push(d);
  });
  return out;
}

/** Visits every doc once; conditional groups expose all their states when `allStates`. */
function walk(doc: Doc, enter: (d: Doc) => boolean | void, exit?: (d: Doc) => void, allStates = false): void {
  const seen = new Set<object>();
  const rec = (d: Doc) => {
    if (typeof d === "object" && !Array.isArray(d)) {
      if (d.t === "group") {
        if (enter(d) === false) return;
        if (seen.has(d)) {
          exit?.(d);
          return;
        }
        seen.add(d);
        if (d.states && allStates) for (const s of d.states) rec(s);
        else rec(d.c);
        exit?.(d);
        return;
      }
    }
    if (enter(d) === false) return;
    if (Array.isArray(d)) for (const x of d) rec(x);
    else if (typeof d === "object") {
      if (d.t === "indent" || d.t === "iib") rec(d.c);
      else if (d.t === "if") {
        rec(d.b);
        rec(d.f);
      }
    }
    exit?.(d);
  };
  rec(doc);
}

function willBreak(doc: Doc): boolean {
  let found = false;
  walk(doc, (d) => {
    if (found) return false;
    if (typeof d === "object" && !Array.isArray(d)) {
      if ((d.t === "group" && d.brk) || (d.t === "line" && d.hard) || d.t === "bp") found = true;
    }
  });
  return found;
}

function canBreak(doc: Doc): boolean {
  let found = false;
  walk(doc, (d) => {
    if (typeof d === "object" && !Array.isArray(d) && d.t === "line") found = true;
  });
  return found;
}

/** Prettier's propagateBreaks: a hard break breaks every enclosing group (conditional groups stop it). */
function propagateBreaks(doc: Doc): void {
  const stack: Group[] = [];
  const breakParentGroup = () => {
    const parent = stack.at(-1);
    if (parent && !parent.states && !parent.brk) parent.brk = true;
  };
  walk(
    doc,
    (d) => {
      if (typeof d === "object" && !Array.isArray(d) && d.t === "group") stack.push(d);
    },
    (d) => {
      if (typeof d !== "object" || Array.isArray(d)) return;
      if (d.t === "bp") breakParentGroup();
      if (d.t === "group") {
        const child = stack.pop()!;
        if (child.brk) breakParentGroup();
      }
    },
    true,
  );
}

const BREAK = 1;
const FLAT = 2;
interface Cmd {
  ind: string;
  mode: number;
  doc: Doc;
}

function fits(next: Cmd, rest: Cmd[], width: number, modes: Map<symbol, number>, mustBeFlat = false): boolean {
  let restIdx = rest.length;
  const cmds: { mode: number; doc: Doc }[] = [next];
  while (width >= 0) {
    if (!cmds.length) {
      if (restIdx === 0) return true;
      cmds.push(rest[--restIdx]!);
      continue;
    }
    const { mode, doc } = cmds.pop()!;
    if (typeof doc === "string") {
      width -= strWidth(doc);
    } else if (Array.isArray(doc)) {
      for (let i = doc.length - 1; i >= 0; i--) cmds.push({ mode, doc: doc[i]! });
    } else {
      switch (doc.t) {
        case "indent":
        case "iib":
          cmds.push({ mode, doc: doc.c });
          break;
        case "group": {
          if (mustBeFlat && doc.brk) return false;
          const groupMode = doc.brk ? BREAK : mode;
          const contents = doc.states && groupMode === BREAK ? doc.states.at(-1)! : doc.c;
          cmds.push({ mode: groupMode, doc: contents });
          break;
        }
        case "if": {
          const groupMode = doc.id ? (modes.get(doc.id) ?? FLAT) : mode;
          const contents = groupMode === BREAK ? doc.b : doc.f;
          if (contents) cmds.push({ mode, doc: contents });
          break;
        }
        case "line":
          if (mode === BREAK || doc.hard) return true;
          if (!doc.soft) width -= 1;
          break;
        case "bp":
          break;
      }
    }
  }
  return false;
}

/** Prints `doc` at indentation `ind` (the caller writes `ind` before the first line). */
export function printDoc(doc: Doc, ind: string, width = PRINT_WIDTH): string {
  propagateBreaks(doc);
  const modes = new Map<symbol, number>();
  let pos = ind.length;
  const out: string[] = [];
  const cmds: Cmd[] = [{ ind, mode: BREAK, doc }];
  let shouldRemeasure = false;
  while (cmds.length) {
    const cmd = cmds.pop()!;
    const { ind: i, mode, doc: d } = cmd;
    if (typeof d === "string") {
      out.push(d);
      pos += strWidth(d);
      continue;
    }
    if (Array.isArray(d)) {
      for (let k = d.length - 1; k >= 0; k--) cmds.push({ ind: i, mode, doc: d[k]! });
      continue;
    }
    switch (d.t) {
      case "indent":
        cmds.push({ ind: i + TAB, mode, doc: d.c });
        break;
      case "iib":
        cmds.push({ ind: i, mode, doc: modes.get(d.id) === BREAK ? indent(d.c) : d.c });
        break;
      case "group": {
        let pushed: Cmd | undefined;
        if (mode === FLAT && !shouldRemeasure) {
          pushed = { ind: i, mode: d.brk ? BREAK : FLAT, doc: d.c };
        } else {
          shouldRemeasure = false;
          const next: Cmd = { ind: i, mode: FLAT, doc: d.c };
          const rem = width - pos;
          if (!d.brk && fits(next, cmds, rem, modes)) {
            pushed = next;
          } else if (d.states) {
            const mostExpanded = d.states.at(-1)!;
            if (d.brk) {
              pushed = { ind: i, mode: BREAK, doc: mostExpanded };
            } else {
              for (let k = 1; k < d.states.length + 1; k++) {
                if (k >= d.states.length) {
                  pushed = { ind: i, mode: BREAK, doc: mostExpanded };
                  break;
                }
                const state: Cmd = { ind: i, mode: FLAT, doc: d.states[k]! };
                if (fits(state, cmds, rem, modes)) {
                  pushed = state;
                  break;
                }
              }
            }
          } else {
            pushed = { ind: i, mode: BREAK, doc: d.c };
          }
        }
        cmds.push(pushed!);
        if (d.id) modes.set(d.id, pushed!.mode);
        break;
      }
      case "if": {
        const groupMode = d.id ? modes.get(d.id) : mode;
        const contents = groupMode === BREAK ? d.b : d.f;
        if (contents) cmds.push({ ind: i, mode, doc: contents });
        break;
      }
      case "line":
        if (mode === FLAT && !d.hard) {
          if (!d.soft) {
            out.push(" ");
            pos += 1;
          }
          break;
        }
        if (mode === FLAT) shouldRemeasure = true;
        while (out.length && /^[ \t]*$/.test(out.at(-1)!)) out.pop();
        if (out.length) out[out.length - 1] = out.at(-1)!.replace(/[ \t]+$/, "");
        out.push("\n" + i);
        pos = i.length;
        break;
      case "bp":
        break;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Tokens and expressions
// ---------------------------------------------------------------------------

interface Token {
  k: "id" | "num" | "str" | "punc" | "eof";
  v: string;
  /** Whitespace (or the line start) before the token. */
  sp: boolean;
  /** A newline before the token (the statement was written over several lines). */
  nl: boolean;
}

const PUNCT = [
  "...", "===", "!==", "**=", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "**",
  "(", ")", "[", "]", "{", "}", ",", ";", ":", "?", ".", "<", ">", "+", "-", "*", "/", "%", "!", "=", "&", "|", "^", "~", "@",
];

class SyntaxErr extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let sp = true;
  let nl = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      sp = true;
      if (ch === "\n") nl = true;
      i++;
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) throw new SyntaxErr("comment");
    const push = (k: Token["k"], v: string) => {
      out.push({ k, v, sp, nl });
      sp = false;
      nl = false;
    };
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) throw new SyntaxErr("string");
      push("str", src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === "`") throw new SyntaxErr("template");
    if (/[0-9]/.test(ch)) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?n?)/.exec(src.slice(i))!;
      push("num", m[0]);
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$#]/.test(ch) || ch.charCodeAt(0) > 127) {
      const m = /^#?[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/.exec(src.slice(i));
      if (!m) throw new SyntaxErr(`unexpected ${ch}`);
      push("id", m[0]);
      i += m[0].length;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new SyntaxErr(`unexpected ${ch}`);
    push("punc", p);
    i += p.length;
  }
  out.push({ k: "eof", v: "", sp, nl });
  return out;
}

type Node =
  | { k: "id"; name: string }
  | { k: "this" }
  | { k: "lit"; raw: string; str?: boolean; num?: boolean }
  | { k: "member"; obj: Node; prop: string; optional?: boolean }
  | { k: "index"; obj: Node; index: Node }
  | { k: "call"; callee: Node; args: Node[]; typeArgs?: string; optional?: boolean }
  | { k: "new"; callee: Node; args: Node[]; typeArgs?: string }
  | { k: "nonnull"; expr: Node }
  | { k: "unary"; op: string; arg: Node }
  | { k: "await"; arg: Node }
  | { k: "spread"; arg: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "cond"; test: Node; cons: Node; alt: Node }
  | { k: "arrow"; params: string; async: boolean; body: Node | "block" }
  | { k: "obj"; props: Prop[]; brk: boolean }
  | { k: "arr"; items: Node[] }
  | { k: "as"; expr: Node; type: string; op: "as" | "satisfies" };

type Prop = { key: string; value: Node; shorthand: boolean } | { spread: Node };

const BINARY_PREC: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "|": 4,
  "^": 5,
  "&": 6,
  "==": 7,
  "!=": 7,
  "===": 7,
  "!==": 7,
  "<": 8,
  ">": 8,
  "<=": 8,
  ">=": 8,
  instanceof: 8,
  in: 8,
  "+": 10,
  "-": 10,
  "*": 11,
  "/": 11,
  "%": 11,
  "**": 12,
};
const LOGICAL = new Set(["&&", "||", "??"]);
/** `as` / `satisfies` bind like relational operators. */
const AS_PREC = 8;

class Parser {
  i = 0;
  constructor(readonly toks: Token[]) {}

  peek(o = 0): Token {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!;
  }
  next(): Token {
    return this.toks[this.i++]!;
  }
  is(v: string, o = 0): boolean {
    const t = this.peek(o);
    return (t.k === "punc" || t.k === "id") && t.v === v;
  }
  eat(v: string): Token {
    if (!this.is(v)) throw new SyntaxErr(`expected ${v}, got ${this.peek().v || "end"}`);
    return this.next();
  }
  done(): boolean {
    return this.peek().k === "eof";
  }

  /** Index of the token closing the bracket at `from`. */
  matching(from: number): number {
    let depth = 0;
    for (let j = from; j < this.toks.length; j++) {
      const t = this.toks[j]!;
      if (t.k !== "punc") continue;
      if ("([{".includes(t.v)) depth++;
      else if (")]}".includes(t.v)) {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  }

  /** Raw text of a type starting here (until a token that cannot continue a type at depth 0). */
  type(): string {
    // Type predicate: `event is InvitationAccepted`.
    if (this.peek().k === "id" && this.peek(1).k === "id" && this.peek(1).v === "is") {
      const subject = this.next().v;
      this.next();
      return `${subject} is ${this.type()}`;
    }
    let out = "";
    let depth = 0;
    while (!this.done()) {
      const t = this.peek();
      if (t.k === "punc") {
        if ("(<[{".includes(t.v)) depth++;
        else if (")>]}".includes(t.v)) {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && t.v !== "." && t.v !== "|" && t.v !== "&") break;
      } else if (depth === 0 && out && t.sp && !/[|&]\s*$/.test(out)) break;
      this.next();
      const space = t.v === "|" || t.v === "&" ? " " : "";
      out += (space || (t.sp && out && /[,:]$/.test(out)) ? " " : "") + t.v + space;
      out = out.replace(/ {2,}/g, " ");
    }
    return out.trim();
  }

  expr(): Node {
    return this.conditional();
  }

  conditional(): Node {
    const test = this.binary(0);
    if (this.is("?")) {
      this.next();
      const cons = this.conditional();
      this.eat(":");
      const alt = this.conditional();
      return { k: "cond", test, cons, alt };
    }
    return test;
  }

  binary(min: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if ((t.k === "id" && (t.v === "as" || t.v === "satisfies")) && AS_PREC > min) {
        this.next();
        left = { k: "as", expr: left, type: this.type(), op: t.v as "as" | "satisfies" };
        continue;
      }
      const prec = (t.k === "punc" || (t.k === "id" && (t.v === "instanceof" || t.v === "in"))) ? BINARY_PREC[t.v] : undefined;
      if (prec === undefined || prec <= min) break;
      this.next();
      const right = t.v === "**" ? this.binary(prec - 1) : this.binary(prec);
      left = { k: "bin", op: t.v, l: left, r: right };
    }
    return left;
  }

  unary(): Node {
    const t = this.peek();
    if (t.k === "punc" && (t.v === "!" || t.v === "-" || t.v === "+" || t.v === "~")) {
      this.next();
      return { k: "unary", op: t.v, arg: this.unary() };
    }
    if (t.k === "id" && (t.v === "typeof" || t.v === "void") && this.peek(1).k !== "punc") {
      this.next();
      return { k: "unary", op: t.v, arg: this.unary() };
    }
    if (t.k === "id" && t.v === "await") {
      this.next();
      return { k: "await", arg: this.unary() };
    }
    return this.postfix(this.primary());
  }

  args(): Node[] {
    this.eat("(");
    const out: Node[] = [];
    while (!this.is(")")) {
      out.push(this.element());
      if (!this.is(")")) this.eat(",");
    }
    this.eat(")");
    return out;
  }

  element(): Node {
    if (this.is("...")) {
      this.next();
      return { k: "spread", arg: this.expr() };
    }
    return this.expr();
  }

  /** `<T>` directly before `(`: type arguments of a call. */
  typeArgs(): string | undefined {
    const t = this.peek();
    if (!(t.k === "punc" && t.v === "<" && !t.sp)) return undefined;
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const x = this.toks[j]!;
      if (x.k === "punc" && x.v === "<") depth++;
      else if (x.k === "punc" && x.v === ">") {
        depth--;
        if (depth === 0) {
          const after = this.toks[j + 1];
          if (!after || after.k !== "punc" || after.v !== "(") return undefined;
          this.next();
          let raw = "";
          while (this.i < j) {
            const y = this.next();
            raw += (y.sp && raw && /[,]$/.test(raw) ? " " : y.v === "|" || raw.endsWith("|") ? " " : "") + y.v;
          }
          this.next();
          return raw;
        }
      } else if (x.k === "punc" && (x.v === ";" || x.v === "=>" || x.v === "&&" || x.v === "||")) return undefined;
    }
    return undefined;
  }

  postfix(node: Node): Node {
    for (;;) {
      const t = this.peek();
      if (t.k !== "punc") return node;
      if (t.v === "." || t.v === "?.") {
        this.next();
        if (t.v === "?." && this.is("(")) {
          node = { k: "call", callee: node, args: this.args(), optional: true };
          continue;
        }
        const name = this.next();
        if (name.k !== "id") throw new SyntaxErr("member name");
        node = { k: "member", obj: node, prop: name.v, optional: t.v === "?." };
      } else if (t.v === "[" && !t.sp) {
        this.next();
        const index = this.expr();
        this.eat("]");
        node = { k: "index", obj: node, index };
      } else if (t.v === "(" && !t.sp) {
        node = { k: "call", callee: node, args: this.args() };
      } else if (t.v === "<" && !t.sp) {
        const typeArgs = this.typeArgs();
        if (typeArgs === undefined) return node;
        node = { k: "call", callee: node, args: this.args(), typeArgs };
      } else if (t.v === "!" && !t.sp && !this.is("=", 1)) {
        this.next();
        node = { k: "nonnull", expr: node };
      } else {
        return node;
      }
    }
  }

  primary(): Node {
    const t = this.peek();
    if (t.k === "str") {
      this.next();
      return { k: "lit", raw: t.v, str: true };
    }
    if (t.k === "num") {
      this.next();
      return { k: "lit", raw: t.v, num: true };
    }
    if (t.k === "id") {
      if (t.v === "new") {
        this.next();
        let callee: Node = this.primary();
        while (this.is(".")) {
          this.next();
          callee = { k: "member", obj: callee, prop: this.next().v };
        }
        const typeArgs = this.typeArgs();
        const args = this.is("(") ? this.args() : [];
        return { k: "new", callee, args, typeArgs };
      }
      if (t.v === "async" && (this.is("(", 1) || (this.peek(1).k === "id" && this.is("=>", 2)))) {
        this.next();
        return this.arrow(true);
      }
      if (this.is("=>", 1)) return this.arrow(false);
      this.next();
      if (t.v === "this") return { k: "this" };
      if (t.v === "true" || t.v === "false" || t.v === "null" || t.v === "undefined") return { k: "lit", raw: t.v };
      return { k: "id", name: t.v };
    }
    if (t.k === "punc") {
      if (t.v === "(") {
        const close = this.matching(this.i);
        const after = this.toks[close + 1];
        if (after && after.k === "punc" && (after.v === "=>" || after.v === ":")) return this.arrow(false);
        this.next();
        const inner = this.expr();
        this.eat(")");
        return inner;
      }
      if (t.v === "[") {
        this.next();
        const items: Node[] = [];
        while (!this.is("]")) {
          items.push(this.element());
          if (!this.is("]")) this.eat(",");
        }
        this.eat("]");
        return { k: "arr", items };
      }
      if (t.v === "{") return this.object();
    }
    throw new SyntaxErr(`unexpected ${t.v || "end"}`);
  }

  object(): Node {
    this.eat("{");
    const brk = this.peek().nl && !this.is("}");
    const props: Prop[] = [];
    while (!this.is("}")) {
      if (this.is("...")) {
        this.next();
        props.push({ spread: this.expr() });
      } else {
        const keyTok = this.next();
        if (keyTok.k !== "id" && keyTok.k !== "str" && keyTok.k !== "num") throw new SyntaxErr("object key");
        if (this.is(":")) {
          this.next();
          props.push({ key: keyTok.v, value: this.expr(), shorthand: false });
        } else {
          props.push({ key: keyTok.v, value: { k: "id", name: keyTok.v }, shorthand: true });
        }
      }
      if (!this.is("}")) this.eat(",");
    }
    this.eat("}");
    return { k: "obj", props, brk };
  }

  arrow(isAsync: boolean): Node {
    let params: string;
    if (this.is("(")) {
      const close = this.matching(this.i);
      params = "";
      this.next();
      while (this.i < close) {
        const t = this.next();
        // The emitters write parameters as Prettier prints them: keep their spacing (`{ signal }`, `A | B`).
        params += (t.sp && params ? " " : "") + t.v;
      }
      this.next();
      params = `(${params})`;
    } else {
      params = `(${this.next().v})`;
    }
    if (this.is(":")) {
      this.next();
      params += `: ${this.type()}`;
    }
    this.eat("=>");
    if (this.is("{") && this.peek(1).k === "eof") {
      this.next();
      return { k: "arrow", params, async: isAsync, body: "block" };
    }
    return { k: "arrow", params, async: isAsync, body: this.expr() };
  }
}

// ---------------------------------------------------------------------------
// Printing expressions (Prettier's printer-estree subset)
// ---------------------------------------------------------------------------

/** What the node is a part of: the parent node (or a statement kind) and the key under it. */
interface Path {
  parent?: Node | Stmt;
  key?: string;
  /** Prettier's `args.expandLastArg` / `expandFirstArg`. */
  expandLastArg?: boolean;
  assignmentLayout?: string;
}

type Stmt =
  | { k: "ExpressionStatement" }
  | { k: "ReturnStatement" }
  | { k: "ThrowStatement" }
  | { k: "IfStatement" }
  | { k: "VariableDeclarator" }
  | { k: "AssignmentExpression" }
  | { k: "PropertyDefinition" }
  | { k: "Property" }
  | { k: "Element" };

const isNode = (x: Node | Stmt | undefined): x is Node => !!x && x.k.length <= 7 && x.k === x.k.toLowerCase();
const isBinaryish = (n: Node | Stmt | undefined): n is Extract<Node, { k: "bin" }> => !!n && isNode(n) && n.k === "bin";
const isCall = (n: Node | Stmt | undefined): n is Extract<Node, { k: "call" }> => !!n && isNode(n) && n.k === "call";
const isMemberish = (n: Node): boolean => n.k === "member" || n.k === "index";
const binType = (n: Node | Stmt | undefined): string | undefined =>
  isBinaryish(n) ? (LOGICAL.has(n.op) ? "Logical" : "Binary") : undefined;

function shouldFlatten(parentOp: string, nodeOp: string): boolean {
  if (BINARY_PREC[nodeOp] !== BINARY_PREC[parentOp]) return false;
  if (parentOp === "**") return false;
  const eq = (o: string) => ["==", "!=", "===", "!=="].includes(o);
  if (eq(parentOp) && eq(nodeOp)) return false;
  const mul = (o: string) => o === "*" || o === "/" || o === "%";
  if ((nodeOp === "%" && mul(parentOp)) || (parentOp === "%" && mul(nodeOp))) return false;
  if (nodeOp !== parentOp && mul(nodeOp) && mul(parentOp)) return false;
  return true;
}

/** Prettier's needsParens for the node kinds the generator emits. */
function needsParens(node: Node, path: Path): boolean {
  const parent = path.parent;
  if (!parent || !isNode(parent)) return false;
  const key = path.key;
  const isObjectOfMember = (parent.k === "member" || parent.k === "index" || parent.k === "nonnull") && (key === "obj" || key === "expr");
  const isCallee = (parent.k === "call" || parent.k === "new") && key === "callee";
  switch (node.k) {
    case "bin": {
      if (isObjectOfMember || isCallee) return true;
      if (parent.k === "unary" || parent.k === "await" || parent.k === "as") return true;
      if (parent.k === "bin") {
        const po = parent.op;
        const no = node.op;
        const pp = BINARY_PREC[po]!;
        const np = BINARY_PREC[no]!;
        if (LOGICAL.has(po) && LOGICAL.has(no) && po !== no) return true;
        if (pp > np) return true;
        if (pp === np && key === "r") return true;
        if (pp === np && !shouldFlatten(po, no)) return true;
        if (pp < np && no === "%") return po === "+" || po === "-";
      }
      return false;
    }
    case "cond":
      return isObjectOfMember || isCallee || ["unary", "await", "as", "bin", "spread"].includes(parent.k) || (parent.k === "cond" && key === "test");
    case "arrow":
      return isObjectOfMember || isCallee || ["unary", "await", "as", "bin"].includes(parent.k) || (parent.k === "cond" && key === "test");
    case "as":
      return isObjectOfMember || isCallee || ["unary", "await", "bin", "nonnull"].includes(parent.k);
    case "await":
      return isObjectOfMember || isCallee || ["unary", "bin", "as", "nonnull", "spread"].includes(parent.k) || (parent.k === "cond" && key === "test");
    case "unary":
      if (isObjectOfMember || isCallee) return true;
      if (parent.k === "unary" && node.op === parent.op && (node.op === "+" || node.op === "-")) return true;
      return parent.k === "bin" && parent.op === "**" && key === "l";
    case "obj":
      return parent.k === "arrow" && key === "body";
    case "lit":
      return !!node.num && isObjectOfMember;
    default:
      return false;
  }
}

function print(node: Node, path: Path = {}): Doc {
  const doc = printInner(node, path);
  return needsParens(node, path) ? ["(", doc, ")"] : doc;
}

function printInner(node: Node, path: Path): Doc {
  switch (node.k) {
    case "id":
      return node.name;
    case "this":
      return "this";
    case "lit":
      return node.raw;
    case "member":
    case "index":
      return printMember(node, path);
    case "nonnull":
      return [print(node.expr, { parent: node, key: "expr" }), "!"];
    case "call":
      return printCall(node, path);
    case "new":
      return ["new ", print(node.callee, { parent: node, key: "callee" }), node.typeArgs ? `<${node.typeArgs}>` : "", printCallArguments(node)];
    case "unary":
      return [node.op, /[a-z]$/.test(node.op) ? " " : "", print(node.arg, { parent: node, key: "arg" })];
    case "await":
      return ["await ", print(node.arg, { parent: node, key: "arg" })];
    case "spread":
      return ["...", print(node.arg, { parent: node, key: "arg" })];
    case "bin":
      return printBinaryish(node, path);
    case "cond":
      return printTernary(node, path);
    case "arrow":
      return printArrow(node, path);
    case "obj":
      return printObject(node);
    case "arr":
      return printArray(node);
    case "as":
      return [print(node.expr, { parent: node, key: "expr" }), ` ${node.op} `, node.type];
  }
}

function printMemberLookup(node: Extract<Node, { k: "member" | "index" }>): Doc {
  if (node.k === "index") return ["[", print(node.index, { parent: node, key: "index" }), "]"];
  return [node.optional ? "?." : ".", node.prop];
}

function printMember(node: Extract<Node, { k: "member" | "index" }>, path: Path): Doc {
  const lookup = printMemberLookup(node);
  const objectDoc = print(node.obj, { parent: node, key: "obj" });
  const parent = path.parent;
  const parentIsMember = !!parent && isNode(parent) && (parent.k === "member" || parent.k === "index");
  const shouldInline =
    node.k === "index" ||
    (parent && isNode(parent) && parent.k === "new") ||
    ((node.obj.k === "id" || node.obj.k === "this") && !parentIsMember);
  return [objectDoc, shouldInline ? lookup : group(indent([softline, lookup]))];
}

const TEST_CALLEES = new Set(["it", "test", "describe", "xit", "xtest", "xdescribe", "fit", "fdescribe", "ftest", "beforeEach", "afterEach", "beforeAll", "afterAll"]);

function isTestCall(node: Extract<Node, { k: "call" }>): boolean {
  if (node.callee.k !== "id" && !(node.callee.k === "member" && node.callee.obj.k === "id")) return false;
  const name = node.callee.k === "id" ? node.callee.name : (node.callee.obj as { name: string }).name;
  if (!TEST_CALLEES.has(name)) return false;
  if (node.args.length === 1) return name.startsWith("before") || name.startsWith("after");
  if (node.args.length !== 2 && node.args.length !== 3) return false;
  const [a, b] = node.args;
  return !!a && a.k === "lit" && !!a.str && !!b && b.k === "arrow";
}

function printCall(node: Extract<Node, { k: "call" }>, path: Path): Doc {
  if (node.args.length > 0 && isTestCall(node)) {
    return [print(node.callee, { parent: node, key: "callee" }), "(", join(", ", node.args.map((a, i) => print(a, { parent: node, key: `arg${i}` }))), ")"];
  }
  if (isMemberish(node.callee)) return printMemberChain(node, path);
  const contents: Doc = [print(node.callee, { parent: node, key: "callee" }), node.optional ? "?." : "", node.typeArgs ? `<${node.typeArgs}>` : "", printCallArguments(node)];
  return isCall(node.callee) ? group(contents) : contents;
}

// --- call arguments ---------------------------------------------------------

function couldExpandArg(arg: Node, arrowChainRecursion = false): boolean {
  if (arg.k === "obj" && arg.props.length > 0) return true;
  if (arg.k === "arr" && arg.items.length > 0) return true;
  if (arg.k === "as" && couldExpandArg(arg.expr)) return true;
  if (arg.k === "arrow") {
    const body = arg.body;
    if (body === "block" || body.k === "obj" || body.k === "arr") return true;
    if (body.k === "arrow" && couldExpandArg(body, true)) return true;
    if (!arrowChainRecursion && (body.k === "cond" || body.k === "call")) return true;
  }
  return false;
}

function isSimpleCallArgument(node: Node, depth = 2): boolean {
  if (depth <= 0) return false;
  const child = (c: Node) => isSimpleCallArgument(c, depth - 1);
  switch (node.k) {
    case "lit":
    case "id":
    case "this":
      return true;
    case "obj":
      return node.props.every((p) => !("spread" in p) && (p.shorthand || child(p.value)));
    case "arr":
      return node.items.every(child);
    case "call":
    case "new":
      return isSimpleCallArgument(node.callee, depth) && node.args.length <= depth && node.args.every(child);
    case "member":
      return isSimpleCallArgument(node.obj, depth);
    case "index":
      return isSimpleCallArgument(node.obj, depth) && isSimpleCallArgument(node.index, depth);
    case "nonnull":
      return isSimpleCallArgument(node.expr, depth);
    case "unary":
      return ["!", "-", "+", "~"].includes(node.op) && isSimpleCallArgument(node.arg, depth);
    default:
      return false;
  }
}

function isConciselyPrintedArray(node: Node): boolean {
  return node.k === "arr" && node.items.length > 1 && node.items.every((x) => (x.k === "lit" && !!x.num) || (x.k === "unary" && (x.op === "-" || x.op === "+") && x.arg.k === "lit" && !!x.arg.num));
}

function shouldExpandLastArg(args: Node[]): boolean {
  const last = args.at(-1)!;
  const penultimate = args.at(-2);
  return (
    couldExpandArg(last) &&
    (!penultimate || penultimate.k !== last.k) &&
    (args.length !== 2 || penultimate!.k !== "arrow" || last.k !== "arr") &&
    !(args.length > 1 && isConciselyPrintedArray(last))
  );
}

function isHopefullyShortCallArgument(node: Node): boolean {
  if (node.k === "as") return isSimpleCallArgument(node.expr, 1);
  if ((node.k === "call" || node.k === "new") && node.args.length > 1) return false;
  if (node.k === "bin") return isSimpleCallArgument(node.l, 1) && isSimpleCallArgument(node.r, 1);
  return isSimpleCallArgument(node);
}

function shouldExpandFirstArg(args: Node[]): boolean {
  if (args.length !== 2) return false;
  const [first, second] = args as [Node, Node];
  return (
    first.k === "arrow" &&
    first.body === "block" &&
    second.k !== "arrow" &&
    second.k !== "cond" &&
    isHopefullyShortCallArgument(second) &&
    !couldExpandArg(second)
  );
}

function printCallArguments(node: Extract<Node, { k: "call" | "new" }>): Doc {
  const args = node.args;
  if (!args.length) return "()";
  const printArg = (a: Node, i: number, extra: Partial<Path> = {}) => print(a, { parent: node, key: `arg${i}`, ...extra });
  const printed = args.map((a, i) => (i === args.length - 1 ? printArg(a, i) : [printArg(a, i), ",", line]));
  const trailingComma = ifBreak(",");
  const allArgsBrokenOut = () => group(["(", indent([line, ...printed]), trailingComma, line, ")"], { shouldBreak: true });

  if (shouldExpandFirstArg(args)) {
    const tail = printed.slice(1);
    if (tail.some(willBreak)) return allArgsBrokenOut();
    const first = printArg(args[0]!, 0);
    if (willBreak(first)) return [breakParent, conditionalGroup([["(", group(first, { shouldBreak: true }), ", ", ...tail, ")"], allArgsBrokenOut()])];
    return conditionalGroup([["(", first, ", ", ...tail, ")"], ["(", group(first, { shouldBreak: true }), ", ", ...tail, ")"], allArgsBrokenOut()]);
  }

  if (shouldExpandLastArg(args)) {
    const head = printed.slice(0, -1);
    if (head.some(willBreak)) return allArgsBrokenOut();
    const last = printArg(args.at(-1)!, args.length - 1, { expandLastArg: true });
    if (willBreak(last)) return [breakParent, conditionalGroup([["(", ...head, group(last, { shouldBreak: true }), ")"], allArgsBrokenOut()])];
    return conditionalGroup([["(", ...head, last, ")"], ["(", ...head, group(last, { shouldBreak: true }), ")"], allArgsBrokenOut()]);
  }

  return group(["(", indent([softline, ...printed]), trailingComma, softline, ")"], { shouldBreak: printed.some(willBreak) });
}

// --- member chains ------------------------------------------------------------

interface ChainNode {
  node: Node;
  printed: Doc;
}

function printMemberChain(node: Extract<Node, { k: "call" }>, path: Path): Doc {
  return memberChain(node, path).doc;
}

function memberChain(node: Extract<Node, { k: "call" }>, path: Path): { doc: Doc; labelled: boolean } {
  const parent = path.parent;
  const isExpressionStatement = !!parent && parent.k === "ExpressionStatement";
  const printedNodes: ChainNode[] = [];

  const rec = (n: Node, p: Path) => {
    if (n.k === "call" && (isMemberish(n.callee) || isCall(n.callee)) && !needsParens(n, p)) {
      printedNodes.unshift({ node: n, printed: [n.optional ? "?." : "", n.typeArgs ? `<${n.typeArgs}>` : "", printCallArguments(n)] });
      rec(n.callee, { parent: n, key: "callee" });
    } else if (isMemberish(n) && !needsParens(n, p)) {
      const m = n as Extract<Node, { k: "member" | "index" }>;
      printedNodes.unshift({ node: n, printed: printMemberLookup(m) });
      rec(m.obj, { parent: n, key: "obj" });
    } else if (n.k === "nonnull" && !needsParens(n, p)) {
      printedNodes.unshift({ node: n, printed: "!" });
      rec(n.expr, { parent: n, key: "expr" });
    } else {
      printedNodes.unshift({ node: n, printed: print(n, p) });
    }
  };
  printedNodes.unshift({ node, printed: [node.optional ? "?." : "", node.typeArgs ? `<${node.typeArgs}>` : "", printCallArguments(node)] });
  rec(node.callee, { parent: node, key: "callee" });

  const groups: ChainNode[][] = [];
  let current: ChainNode[] = [printedNodes[0]!];
  let i = 1;
  for (; i < printedNodes.length; ++i) {
    const n = printedNodes[i]!.node;
    if (n.k === "nonnull" || isCall(n) || (n.k === "index" && n.index.k === "lit" && !!n.index.num)) current.push(printedNodes[i]!);
    else break;
  }
  if (!isCall(printedNodes[0]!.node)) {
    for (; i + 1 < printedNodes.length; ++i) {
      if (isMemberish(printedNodes[i]!.node) && isMemberish(printedNodes[i + 1]!.node)) current.push(printedNodes[i]!);
      else break;
    }
  }
  groups.push(current);
  current = [];
  let hasSeenCall = false;
  for (; i < printedNodes.length; ++i) {
    const pn = printedNodes[i]!;
    if (hasSeenCall && isMemberish(pn.node)) {
      if (pn.node.k === "index" && pn.node.index.k === "lit" && pn.node.index.num) {
        current.push(pn);
        continue;
      }
      groups.push(current);
      current = [];
      hasSeenCall = false;
    }
    if (isCall(pn.node)) hasSeenCall = true;
    current.push(pn);
  }
  if (current.length) groups.push(current);

  const isFactory = (name: string) => /^[A-Z]|^[$_]+$/.test(name);
  const isShort = (name: string) => name.length <= TAB.length;
  const shouldNotWrap = (gs: ChainNode[][]) => {
    const hasComputed = gs[1]![0]?.node.k === "index";
    if (gs[0]!.length === 1) {
      const first = gs[0]![0]!.node;
      return first.k === "this" || (first.k === "id" && (isFactory(first.name) || (isExpressionStatement && isShort(first.name)) || hasComputed));
    }
    const last = gs[0]!.at(-1)!.node;
    return last.k === "member" && (isFactory(last.prop) || hasComputed);
  };
  const shouldMerge = groups.length >= 2 && groups[1]!.length > 0 && shouldNotWrap(groups);

  const printGroup = (g: ChainNode[]) => g.map((t) => t.printed);
  const printIndentedGroup = (gs: ChainNode[][]) => (gs.length ? indent([hardline, join(hardline, gs.map(printGroup))]) : "");
  const printedGroups = groups.map(printGroup);
  const oneLine: Doc = printedGroups;
  const cutoff = shouldMerge ? 3 : 2;
  if (groups.length <= cutoff) return { doc: group(oneLine), labelled: false };

  const expanded: Doc = [printGroup(groups[0]!), shouldMerge ? groups.slice(1, 2).map(printGroup) : "", printIndentedGroup(groups.slice(shouldMerge ? 2 : 1))];
  const callExpressions = printedNodes.map((t) => t.node).filter(isCall);
  const lastGroupWillBreakAndOtherCallsHaveFunctionArguments = () => {
    const lastNode = groups.at(-1)!.at(-1)!.node;
    return isCall(lastNode) && willBreak(printedGroups.at(-1)!) && callExpressions.slice(0, -1).some((c) => c.args.some((a) => a.k === "arrow"));
  };
  if (
    (callExpressions.length > 2 && callExpressions.some((c) => c.args.some((a) => !isSimpleCallArgument(a)))) ||
    printedGroups.slice(0, -1).some(willBreak) ||
    lastGroupWillBreakAndOtherCallsHaveFunctionArguments()
  ) {
    return { doc: group(expanded), labelled: true };
  }
  return { doc: [willBreak(oneLine) ? breakParent : "", conditionalGroup([oneLine, expanded])], labelled: true };
}

// --- binary / logical -------------------------------------------------------

function printBinaryishExpressions(node: Node, path: Path, isNested: boolean, isInsideParenthesis: boolean): Doc[] {
  if (node.k !== "bin") return [group(print(node, path))];
  let parts: Doc[];
  if (isBinaryish(node.l) && shouldFlatten(node.op, node.l.op)) {
    parts = printBinaryishExpressions(node.l, { parent: node, key: "l" }, true, isInsideParenthesis);
  } else {
    parts = [group(print(node.l, { parent: node, key: "l" }))];
  }
  let right: Doc = [node.op, line, print(node.r, { parent: node, key: "r" })];
  const parent = path.parent;
  const shouldGroup =
    !(isInsideParenthesis && LOGICAL.has(node.op)) &&
    binType(parent) !== binType(node) &&
    binType(node.l) !== binType(node) &&
    binType(node.r) !== binType(node);
  if (shouldGroup) right = group(right);
  parts.push(" ", right);
  return parts;
}

function printBinaryish(node: Extract<Node, { k: "bin" }>, path: Path): Doc {
  const parent = path.parent;
  const isInsideParenthesis = !!parent && parent.k === "IfStatement";
  const parts = printBinaryishExpressions(node, path, false, isInsideParenthesis);
  if (isInsideParenthesis) return parts;
  if (parent && isNode(parent)) {
    if (
      (path.key === "callee" && (parent.k === "call" || parent.k === "new")) ||
      parent.k === "unary" ||
      (parent.k === "member" && path.key === "obj")
    ) {
      return group([indent([softline, ...parts]), softline]);
    }
  }
  const shouldNotIndent =
    (!!parent && (parent.k === "ReturnStatement" || parent.k === "ThrowStatement")) ||
    (!!parent && isNode(parent) && parent.k === "arrow" && path.key === "body");
  const shouldIndentIfInlining =
    !!parent && (parent.k === "AssignmentExpression" || parent.k === "VariableDeclarator" || parent.k === "PropertyDefinition" || parent.k === "Property");
  if (shouldNotIndent || shouldIndentIfInlining) return group(parts);
  const firstGroupIndex = parts.findIndex((p) => typeof p === "object" && !Array.isArray(p) && p.t === "group");
  const headParts = parts.slice(0, firstGroupIndex === -1 ? 1 : firstGroupIndex + 1);
  const rest = parts.slice(headParts.length);
  return group([...headParts, indent(rest)]);
}

// --- ternary ------------------------------------------------------------------

function printTernary(node: Extract<Node, { k: "cond" }>, path: Path): Doc {
  const parent = path.parent;
  const isParentTest = !!parent && isNode(parent) && parent.k === "cond" && path.key === "test";
  const consAlt = [line, "? ", print(node.cons, { parent: node, key: "cons" }), line, ": ", print(node.alt, { parent: node, key: "alt" })];
  const shouldNotIndent = !!parent && isNode(parent) && parent.k === "cond" && path.key === "alt";
  const result = group([print(node.test, { parent: node, key: "test" }), shouldNotIndent ? consAlt : indent(consAlt)]);
  return isParentTest ? group([indent([line, result]), softline]) : result;
}

// --- arrows -------------------------------------------------------------------

function printArrow(node: Extract<Node, { k: "arrow" }>, path: Path): Doc {
  const signature: Doc = [node.async ? "async " : "", node.params];
  if (node.body === "block") return group([group(signature), " =>", " {"]);
  const body = node.body;
  const bodyDoc = print(body, { parent: node, key: "body" });
  const shouldPutBodyOnSameLine = body.k === "arr" || body.k === "obj" || body.k === "arrow" || body.k === "cond";
  const trailingComma = path.expandLastArg ? ifBreak(",") : "";
  const trailingSpace = path.expandLastArg ? softline : "";
  let bodyParts: Doc;
  if (shouldPutBodyOnSameLine && body.k === "cond") {
    bodyParts = [" ", group([ifBreak("", "("), indent([softline, bodyDoc]), ifBreak("", ")"), trailingComma, trailingSpace])];
  } else if (shouldPutBodyOnSameLine) {
    bodyParts = [" ", bodyDoc];
  } else {
    bodyParts = [indent([line, bodyDoc]), trailingComma, trailingSpace];
  }
  return group([group(signature), " =>", group(bodyParts)]);
}

// --- objects and arrays ----------------------------------------------------------

function printObject(node: Extract<Node, { k: "obj" }>): Doc {
  if (!node.props.length) return "{}";
  const props = node.props.map((p) => {
    if ("spread" in p) return ["...", print(p.spread, { parent: node, key: "spread" })];
    if (p.shorthand) return p.key;
    return printAssignment(p.key, ":", p.value, { k: "Property" });
  });
  return group(["{", indent([line, join([",", line], props)]), ifBreak(","), line, "}"], { shouldBreak: node.brk });
}

function printArray(node: Extract<Node, { k: "arr" }>): Doc {
  if (!node.items.length) return "[]";
  const items = node.items;
  const shouldBreak =
    items.length > 1 &&
    items.every((el, i) => {
      if (el.k !== "obj" && el.k !== "arr") return false;
      const next = items[i + 1];
      if (next && next.k !== el.k) return false;
      return (el.k === "arr" ? el.items.length : el.props.length) > 1;
    });
  const printed = items.map((x, i) => print(x, { parent: node, key: `item${i}` }));
  return group(["[", indent([softline, join([",", line], printed), ifBreak(",")]), softline, "]"], { shouldBreak });
}

// --- assignments ------------------------------------------------------------------

function isLoneShortArgument(node: Node): boolean {
  const threshold = PRINT_WIDTH * 0.25;
  if (node.k === "this" || (node.k === "id" && node.name.length <= threshold)) return true;
  if (node.k === "unary" && (node.op === "-" || node.op === "+") && node.arg.k === "lit" && node.arg.num) return true;
  if (node.k === "lit" && node.str) return node.raw.length <= threshold;
  if (node.k === "unary") return isLoneShortArgument(node.arg);
  if (node.k === "call" && node.args.length === 0 && node.callee.k === "id") return node.callee.name.length <= threshold - 2;
  return node.k === "lit";
}

/** Whether printCallExpression would return a labelled member chain (more groups than the cutoff). */
function isMemberChainDoc(node: Extract<Node, { k: "call" }>): boolean {
  if (!isMemberish(node.callee) || (node.args.length > 0 && isTestCall(node))) return false;
  return memberChain(node, {}).labelled;
}

function isPoorlyBreakableMemberOrCallChain(node: Node, deep = false): boolean {
  if (node.k === "call") {
    if (isMemberChainDoc(node)) return false;
    const poorly = node.args.length === 0 || (node.args.length === 1 && isLoneShortArgument(node.args[0]!));
    if (!poorly) return false;
    if (node.typeArgs && (node.typeArgs.includes(",") || /[|&{]/.test(node.typeArgs))) return false;
    return isPoorlyBreakableMemberOrCallChain(node.callee, true);
  }
  if (node.k === "member" || node.k === "index") return isPoorlyBreakableMemberOrCallChain(node.obj, true);
  if (node.k === "nonnull") return isPoorlyBreakableMemberOrCallChain(node.expr, true);
  return deep && (node.k === "id" || node.k === "this");
}

function shouldBreakAfterOperator(right: Node, hasShortKey: boolean): boolean {
  if (right.k === "bin") return true;
  if (right.k === "cond") return right.test.k === "bin";
  if (hasShortKey) return false;
  let node: Node = right;
  for (;;) {
    if (node.k === "unary" || node.k === "await") node = node.arg;
    else if (node.k === "nonnull") node = node.expr;
    else break;
  }
  return (node.k === "lit" && !!node.str) || isPoorlyBreakableMemberOrCallChain(node);
}

function printAssignment(left: Doc, operator: string, right: Node, parent: Stmt, leftCanBreak = false): Doc {
  const hasShortKey = parent.k === "Property" && typeof left === "string" && strWidth(left) < TAB.length + 3;
  let layout: string;
  if (shouldBreakAfterOperator(right, hasShortKey)) layout = "break-after-operator";
  else if (!leftCanBreak && (hasShortKey || (right.k === "lit" && !right.str && (right.raw === "true" || right.raw === "false" || !!right.num)))) layout = "never-break-after-operator";
  else layout = "fluid";
  const rightDoc = print(right, { parent, key: "value", assignmentLayout: layout });
  switch (layout) {
    case "break-after-operator":
      return group([group(left), operator, group(indent([line, rightDoc]))]);
    case "never-break-after-operator":
      return group([group(left), operator, " ", rightDoc]);
    default: {
      const id = Symbol("assignment");
      return group([group(left), operator, group(indent(line), { id }), indentIfBreak(rightDoc, id)]);
    }
  }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function parseExpr(src: string): Node {
  const p = new Parser(tokenize(src));
  const e = p.expr();
  if (!p.done()) throw new SyntaxErr(`unexpected ${p.peek().v}`);
  return e;
}

function printReturnArgument(keyword: string, arg: Node): Doc {
  const parent: Stmt = { k: keyword === "return" ? "ReturnStatement" : "ThrowStatement" };
  if (arg.k === "bin") return [keyword, " ", group([ifBreak("("), indent([softline, print(arg, { parent, key: "argument" })]), softline, ifBreak(")")])];
  return [keyword, " ", print(arg, { parent, key: "argument" })];
}

/** `if (test)` — the `!(…)` of a binary test hugs the parentheses like Prettier does. */
function printIfHead(prefix: string, test: Node): Doc {
  const parent: Stmt = { k: "IfStatement" };
  if (test.k === "unary" && test.op === "!" && test.arg.k === "bin") {
    const inner = printBinaryishExpressions(test.arg, { parent: test, key: "arg" }, false, false);
    return group([prefix, "if (!(", indent([softline, ...inner]), softline, "))"]);
  }
  return group([prefix, "if (", group([indent([softline, print(test, { parent, key: "test" })]), softline]), ")"]);
}

/** Top-level parts of `s` separated by `sep` (outside brackets and strings). */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch) && !(ch === ">" && s[i - 1] === "=")) depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

/** A type as a doc: object type literals can break (members end with `;`), type arguments too. */
function typeDoc(raw: string): Doc {
  const t = raw.trim();
  if (t.startsWith("{") && t.endsWith("}") && splitTop(t, " & ").length === 1) {
    const members = splitTop(t.slice(1, -1), ";");
    if (!members.length) return "{}";
    return group(["{", indent([line, join([";", line], members.map(memberDoc))]), ifBreak(";"), line, "}"]);
  }
  const union = splitTop(t, " | ");
  if (union.length > 1) return join(" | ", union.map(typeDoc));
  const inter = splitTop(t, " & ");
  if (inter.length > 1) return join(" & ", inter.map(typeDoc));
  const m = /^([\w$.]+)<(.*)>$/.exec(t);
  if (m) {
    const params = splitTop(m[2]!, ",");
    // A single simple or object type argument hugs the brackets (Prettier's shouldHugType).
    if (params.length === 1 && (/^[\w$.]+$/.test(params[0]!) || (params[0]!.startsWith("{") && splitTop(params[0]!, " & ").length === 1))) {
      return [m[1]!, "<", typeDoc(params[0]!), ">"];
    }
    return group([m[1]!, "<", indent([softline, join([",", line], params.map(typeDoc))]), softline, ">"]);
  }
  return t;
}

function memberDoc(member: string): Doc {
  const m = /^((?:readonly )?[\w$]+\??): (.*)$/.exec(member.trim());
  return m ? [m[1]!, ": ", typeDoc(m[2]!)] : member.trim();
}

/** A parameter: `name: Type`, `name = default`, `name: Type = default`. */
function paramDoc(param: string): { doc: Doc; hug: boolean } {
  const parts = splitTop(param, " = ");
  const head = parts[0]!;
  const def = parts.length > 1 ? parts.slice(1).join(" = ") : undefined;
  const m = /^([\w$]+\??): (.*)$/.exec(head);
  const type = m ? m[2]!.trim() : undefined;
  const isObjectType = !!type && type.startsWith("{") && type.endsWith("}") && splitTop(type, " | ").length === 1 && splitTop(type, " & ").length === 1;
  const doc: Doc = m ? [m[1]!, ": ", typeDoc(type!)] : head;
  return { doc: def === undefined ? doc : [doc, " = ", def], hug: isObjectType && def === undefined };
}

/** `name(params): Ret {` / `name(params): Ret;` — Prettier's function parameter printing (a sole object type hugs). */
function signatureDoc(head: string, paramsSrc: string, ret: string, tail: string): Doc {
  const params = splitTop(paramsSrc, ",").map(paramDoc);
  const retDoc: Doc = ret ? [": ", typeDoc(ret)] : "";
  if (params.length === 1 && params[0]!.hug) return group([head, "(", params[0]!.doc, ")", retDoc, tail]);
  if (!params.length) return [head, "()", retDoc, tail];
  return [group([head, "(", indent([softline, join([",", line], params.map((p) => p.doc))]), ifBreak(","), softline, ")"]), retDoc, tail];
}

/** A statement (or element line) re-printed by Prettier's rules, or undefined when it is not one we understand. */
function formatStatement(text: string, ind: string): string | undefined {
  const t = text.trim();
  let m: RegExpExecArray | null;
  const out = (doc: Doc) => ind + printDoc(doc, ind);

  // import / export lists
  if ((m = /^((?:import|export)(?: type)? )\{ (.*) \}( from "[^"]*";)$/.exec(t))) {
    const names = m[2]!.split(", ");
    if (names.length < 2) return undefined;
    return out(group([m[1]!, "{", indent([line, join([",", line], names)]), ifBreak(","), line, "}", m[3]!]));
  }
  // if (…) {   /   } else if (…) {   /   if (…) statement;
  if ((m = /^(\} else )?if \((.*)\) \{$/.exec(t))) {
    const test = parseCondition(m[2]!);
    if (!test) return undefined;
    return out([printIfHead(m[1] ?? "", test), " {"]);
  }
  if ((m = /^if \((.*?)\) ((?:return|throw)\b.*;)$/.exec(t))) {
    for (let cut = t.indexOf(") "); cut !== -1; cut = t.indexOf(") ", cut + 1)) {
      const testSrc = t.slice(4, cut);
      const stmtSrc = t.slice(cut + 2);
      const test = parseCondition(testSrc);
      if (!test || !/^(?:return|throw)\b/.test(stmtSrc)) continue;
      const stmt = statementDoc(stmtSrc);
      if (!stmt) continue;
      return out(group([printIfHead("", test), indent([line, stmt])]));
    }
    return undefined;
  }
  // type aliases: unions break after `=`, one member per line if needed; generic types break their arguments
  if ((m = /^((?:export )?type [\w$]+(?:<[^=]*>)?) = (.*);$/.exec(t))) {
    const members = splitTop(m[2]!, " | ");
    if (members.length > 1) {
      const union = group([ifBreak("| "), join([line, "| "], members.map(typeDoc))]);
      return out([group([m[1]!, " =", group(indent([line, union]))]), ";"]);
    }
    const id = Symbol("assignment");
    return out([group([m[1]!, " =", group(indent(line), { id }), indentIfBreak(typeDoc(m[2]!), id)]), ";"]);
  }
  // function / method / constructor signatures
  if (
    (m = /^((?:(?:export|async|static|private|protected|public|override|function|get|set|abstract) )*#?[A-Za-z_$][\w$]*)\((.*)\)(?:: (.+?))?( \{|;)$/.exec(t)) &&
    !/^(if|for|while|switch|return|catch)$/.test(m[1]!.split(" ").at(-1)!) &&
    (m[3] !== undefined || m[4] === " {") &&
    splitTop(m[2]!, ",").every((p) => /^[A-Za-z_$][\w$]*\??(?:: .+)?(?: = .+)?$/.test(p))
  ) {
    return out(signatureDoc(m[1]!, m[2]!, m[3] ?? "", m[4]!));
  }
  // element lines of an expanded object / array / argument list
  if ((m = /^([A-Za-z_$#][\w$]*|"(?:[^"\\]|\\.)*"): (.*),$/.exec(t)) && !/^(case|default)$/.test(m[1]!)) {
    const value = tryParse(m[2]!);
    if (value) return out([printAssignment(m[1]!, ":", value, { k: "Property" }), ","]);
  }
  const doc = statementDoc(t);
  if (doc) return out(doc);
  if (t.endsWith(",")) {
    const value = tryParse(t.slice(0, -1));
    if (value) return out([print(value, { parent: { k: "Element" } }), ","]);
  }
  return undefined;
}

function tryParse(src: string): Node | undefined {
  try {
    return parseExpr(src);
  } catch (e) {
    if (e instanceof SyntaxErr) return undefined;
    throw e;
  }
}

function parseCondition(src: string): Node | undefined {
  // The test must be balanced: `if (a) (b)` is not a condition.
  return tryParse(src);
}

/** Doc of a complete statement ending in `;`. */
function statementDoc(t: string): Doc | undefined {
  let m: RegExpExecArray | null;
  if (!t.endsWith(";")) return undefined;
  const body = t.slice(0, -1);
  if ((m = /^(return|throw) (.*)$/.exec(body))) {
    const arg = tryParse(m[2]!);
    return arg ? [printReturnArgument(m[1]!, arg), ";"] : undefined;
  }
  // declarations and class properties: `[export ]const|let x[: T] = …`, `[static ][readonly ]x = …`
  if ((m = /^((?:export )?(?:const|let) [A-Za-z_$][\w$]*(?:: [^=]+?)?|(?:(?:static|readonly|private|protected|public|override) )+#?[A-Za-z_$][\w$]*(?:: [^=]+?)?) = (.*)$/.exec(body))) {
    const right = tryParse(m[2]!);
    if (!right) return undefined;
    const kind: Stmt = /^(?:export )?(?:const|let) /.test(m[1]!) ? { k: "VariableDeclarator" } : { k: "PropertyDefinition" };
    return [printAssignment(m[1]!, " =", right, kind), ";"];
  }
  // assignments to a variable or member: `x = …`, `this.#x = …`
  if ((m = /^([A-Za-z_$#][\w$#.]*) = (.*)$/.exec(body))) {
    const right = tryParse(m[2]!);
    return right ? [printAssignment(m[1]!, " =", right, { k: "AssignmentExpression" }), ";"] : undefined;
  }
  const e = tryParse(body);
  return e ? [print(e, { parent: { k: "ExpressionStatement" } }), ";"] : undefined;
}

/**
 * Re-prints every line wider than the print width with Prettier's rules (doc comments and `//` comments are left
 * alone; Prettier does not reflow them either). Lines that fit are kept: the emitters write canonical flat code.
 */
export function formatSource(src: string, width = PRINT_WIDTH): string {
  const out: string[] = [];
  let inDoc = false;
  for (const lineText of src.split("\n")) {
    const t = lineText.trimStart();
    if (t.startsWith("/*")) inDoc = !t.includes("*/");
    else if (inDoc) {
      if (t.includes("*/")) inDoc = false;
      out.push(lineText);
      continue;
    }
    if (t.startsWith("/*") || t.startsWith("*") || strWidth(lineText) <= width) {
      out.push(lineText);
      continue;
    }
    const ind = /^ */.exec(lineText)![0];
    if (t.startsWith("//")) {
      // Prettier leaves comments alone; long `//` comments are word-wrapped to keep lines readable.
      out.push(...wrapComment(t.replace(/^\/\/\s?/, ""), width - ind.length - 3).map((l) => `${ind}// ${l}`));
      continue;
    }
    out.push(formatStatement(t, ind) ?? lineText);
  }
  return out.join("\n");
}

function wrapComment(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    if (cur && strWidth(cur) + 1 + strWidth(w) > width) {
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  out.push(cur);
  return out;
}

/** One expression printed at `ind` (for emitters that build a statement around it). Exposed for tests. */
export function formatExpression(src: string, ind = ""): string {
  return printDoc(print(parseExpr(src), { parent: { k: "ExpressionStatement" } }), ind);
}
