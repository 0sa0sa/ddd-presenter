/**
 * The Rule expression language: a small, typed, side-effect-free subset.
 * Parsed into an AST; never evaluated with `eval`.
 */

export type BinaryOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type Expr =
  | { t: "lit"; value: string | number | boolean | null; kind: "string" | "integer" | "decimal" | "boolean" | "null"; start: number; end: number }
  | { t: "name"; name: string; start: number; end: number }
  | { t: "member"; object: Expr; name: string; start: number; end: number }
  | { t: "call"; callee: Expr; args: Expr[]; start: number; end: number }
  | { t: "not"; operand: Expr; start: number; end: number }
  | { t: "binary"; op: BinaryOp; left: Expr; right: Expr; start: number; end: number };

type Tok =
  | { k: "num"; v: string; s: number; e: number }
  | { k: "str"; v: string; s: number; e: number }
  | { k: "id"; v: string; s: number; e: number }
  | { k: "op"; v: string; s: number; e: number }
  | { k: "eof"; s: number; e: number };

export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const KEYWORDS = new Set(["and", "or", "not", "true", "false", "null"]);

/** Limits that keep hostile input (e.g. 300k nested parentheses) a diagnostic instead of a stack overflow. */
export const MAX_EXPR_TOKENS = 2000;
export const MAX_EXPR_NESTING = 64;

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c)) {
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      if (src[i] === "." && /[0-9]/.test(src[i + 1] ?? "")) {
        i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      toks.push({ k: "num", v: src.slice(start, i), s: start, e: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      toks.push({ k: "id", v: src.slice(start, i), s: start, e: i });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let out = "";
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[i + 1]!;
          out += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new ExprSyntaxError("Unterminated string literal", start);
      i++;
      toks.push({ k: "str", v: out, s: start, e: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) {
      toks.push({ k: "op", v: two, s: i, e: i + 2 });
      i += 2;
      continue;
    }
    if ("<>().,-".includes(c)) {
      toks.push({ k: "op", v: c, s: i, e: i + 1 });
      i++;
      continue;
    }
    if (c === "=") throw new ExprSyntaxError('Use "==" for comparison; assignment is not allowed in rules', i);
    if ("&|!".includes(c)) throw new ExprSyntaxError(`Use "and", "or", "not" instead of "${c}"`, i);
    throw new ExprSyntaxError(`Unexpected character "${c}"`, i);
  }
  toks.push({ k: "eof", s: src.length, e: src.length });
  return toks;
}

export function parseExpr(src: string): Expr {
  const toks = lex(src);
  if (toks.length > MAX_EXPR_TOKENS) throw new ExprSyntaxError(`Expression is too long (more than ${MAX_EXPR_TOKENS} tokens); split it into named rules`, 0);
  let p = 0;
  let depth = 0;
  const nested = <T>(parse: () => T): T => {
    if (++depth > MAX_EXPR_NESTING) throw new ExprSyntaxError(`Expression is nested too deeply (more than ${MAX_EXPR_NESTING} levels)`, peek().s);
    try {
      return parse();
    } finally {
      depth--;
    }
  };
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const isOp = (v: string) => peek().k === "op" && (peek() as { v: string }).v === v;
  const isKw = (v: string) => peek().k === "id" && (peek() as { v: string }).v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprSyntaxError(`Expected "${v}"`, peek().s);
    return next();
  };

  function parseOr(): Expr {
    let left = parseAnd();
    while (isKw("or")) {
      next();
      const right = parseAnd();
      left = { t: "binary", op: "or", left, right, start: left.start, end: right.end };
    }
    return left;
  }
  function parseAnd(): Expr {
    let left = parseNot();
    while (isKw("and")) {
      next();
      const right = parseNot();
      left = { t: "binary", op: "and", left, right, start: left.start, end: right.end };
    }
    return left;
  }
  function parseNot(): Expr {
    if (isKw("not")) {
      const t = next();
      const operand = nested(parseNot);
      return { t: "not", operand, start: t.s, end: operand.end };
    }
    return parseCmp();
  }
  function parseCmp(): Expr {
    const left = parsePostfix();
    const t = peek();
    if (t.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      next();
      const right = parsePostfix();
      const after = peek();
      if (after.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(after.v)) {
        throw new ExprSyntaxError("Chained comparisons are not allowed; combine them with \"and\"", after.s);
      }
      return { t: "binary", op: t.v as BinaryOp, left, right, start: left.start, end: right.end };
    }
    return left;
  }
  function parsePostfix(): Expr {
    let e = parsePrimary();
    for (;;) {
      if (isOp(".")) {
        next();
        const id = next();
        if (id.k !== "id") throw new ExprSyntaxError("Expected a name after \".\"", id.s);
        e = { t: "member", object: e, name: id.v, start: e.start, end: id.e };
      } else if (isOp("(")) {
        next();
        const args: Expr[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(nested(parseOr));
            if (isOp(",")) {
              next();
              continue;
            }
            break;
          }
        }
        const close = expectOp(")");
        e = { t: "call", callee: e, args, start: e.start, end: close.e };
      } else {
        return e;
      }
    }
  }
  function parsePrimary(): Expr {
    const t = next();
    if (t.k === "num") {
      const isDec = t.v.includes(".");
      return { t: "lit", value: isDec ? t.v : Number(t.v), kind: isDec ? "decimal" : "integer", start: t.s, end: t.e };
    }
    if (t.k === "op" && t.v === "-") {
      const n = next();
      if (n.k !== "num") throw new ExprSyntaxError("Only numeric literals can be negated", t.s);
      const isDec = n.v.includes(".");
      return { t: "lit", value: isDec ? `-${n.v}` : -Number(n.v), kind: isDec ? "decimal" : "integer", start: t.s, end: n.e };
    }
    if (t.k === "str") return { t: "lit", value: t.v, kind: "string", start: t.s, end: t.e };
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "lit", value: t.v === "true", kind: "boolean", start: t.s, end: t.e };
      if (t.v === "null") return { t: "lit", value: null, kind: "null", start: t.s, end: t.e };
      if (KEYWORDS.has(t.v)) throw new ExprSyntaxError(`Unexpected keyword "${t.v}"`, t.s);
      return { t: "name", name: t.v, start: t.s, end: t.e };
    }
    if (t.k === "op" && t.v === "(") {
      const e = nested(parseOr);
      expectOp(")");
      return e;
    }
    if (t.k === "eof") throw new ExprSyntaxError("Unexpected end of expression", t.s);
    throw new ExprSyntaxError(`Unexpected "${(t as { v: string }).v}"`, t.s);
  }

  const e = parseOr();
  if (peek().k !== "eof") throw new ExprSyntaxError(`Unexpected "${(peek() as { v: string }).v}"`, peek().s);
  return e;
}

export function countNodes(e: Expr): number {
  switch (e.t) {
    case "lit":
    case "name":
      return 1;
    case "member":
      return 1 + countNodes(e.object);
    case "call":
      return 1 + countNodes(e.callee) + e.args.reduce((n, a) => n + countNodes(a), 0);
    case "not":
      return 1 + countNodes(e.operand);
    case "binary":
      return 1 + countNodes(e.left) + countNodes(e.right);
  }
}
