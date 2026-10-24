/**
 * SMT-LIB 2 terms built as text, and a Z3 session that evaluates them (docs/09 §29).
 *
 * Only strings cross into Z3 (`Z3_eval_smtlib2_string`): no Z3 object lives in JavaScript, so nothing is released by
 * the garbage collector while a check runs in Z3's worker thread (the high-level API's finalizers race with it under
 * Bun). Every query is also a standalone SMT-LIB script, which any SMT solver can re-check (`ddd verify --smt2`).
 *
 * The builder mirrors the small part of the Z3 API the encoder uses (`Int.const`, `And`, `x.add(y)`, …).
 */
import { init } from "z3-solver";

export type Sort = "Int" | "Real" | "Bool";

type Num = number | string;

/** A term: its SMT-LIB text and sort. Long compound terms are named with `define-fun` (Z3 expands them). */
export class T {
  constructor(
    readonly smt: Smt,
    readonly s: string,
    readonly sort: Sort,
  ) {}
  private lit(x: T | Num): T {
    if (x instanceof T) return x;
    return this.sort === "Real" ? this.smt.Real.val(String(x)) : this.smt.Int.val(Number(x));
  }
  private op(o: string, x: T | Num, sort: Sort = this.sort): T {
    return this.smt.make(`(${o} ${this.s} ${this.lit(x).s})`, sort);
  }
  add(x: T | Num): T {
    return this.op("+", x);
  }
  sub(x: T | Num): T {
    return this.op("-", x);
  }
  mul(x: T | Num): T {
    return this.op("*", x);
  }
  /** Real division (both operands Real). */
  div(x: T | Num): T {
    return this.op("/", x, "Real");
  }
  mod(x: T | Num): T {
    return this.op("mod", x, "Int");
  }
  neg(): T {
    return this.smt.make(`(- ${this.s})`, this.sort);
  }
  le(x: T | Num): T {
    return this.op("<=", x, "Bool");
  }
  lt(x: T | Num): T {
    return this.op("<", x, "Bool");
  }
  ge(x: T | Num): T {
    return this.op(">=", x, "Bool");
  }
  gt(x: T | Num): T {
    return this.op(">", x, "Bool");
  }
  eq(x: T | Num): T {
    return this.op("=", x, "Bool");
  }
}

const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A symbol: quoted with |…| unless it is a plain identifier. */
export function symbol(name: string): string {
  return SIMPLE.test(name) ? name : `|${name.replace(/[|\\]/g, "_")}|`;
}

function intLit(n: number | bigint): string {
  const v = BigInt(n);
  return v < 0n ? `(- ${-v})` : String(v);
}

/** `"7/2"`, `"-1.25"`, `"3"` → an SMT-LIB real. */
function realLit(s: string): string {
  const t = s.trim();
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  let out: string;
  if (body.includes("/")) {
    const [a, b] = body.split("/");
    out = `(/ ${dec(a!)} ${dec(b!)})`;
  } else out = dec(body);
  return neg ? `(- ${out})` : out;
}

function dec(s: string): string {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a number: ${s}`);
  return s.includes(".") ? s : `${s}.0`;
}

/**
 * Collects declarations, definitions and assertions. `script()` is everything so far; `take()` is what was added
 * since the last `take()` (sent to Z3 incrementally).
 */
export class Smt {
  private lines: string[] = [];
  private sent = 0;
  private defs = 0;
  private declared = new Set<string>();

  make(s: string, sort: Sort): T {
    // Name long terms so repeated use does not grow the text (define-fun is a macro: no new variable).
    if (s.length > 160) {
      const name = `_t${this.defs++}`;
      this.lines.push(`(define-fun ${name} () ${sort} ${s})`);
      return new T(this, name, sort);
    }
    return new T(this, s, sort);
  }

  private declare(name: string, sort: Sort): T {
    const sym = symbol(name);
    if (!this.declared.has(sym)) {
      this.declared.add(sym);
      this.lines.push(`(declare-const ${sym} ${sort})`);
    }
    return new T(this, sym, sort);
  }

  readonly Int = {
    const: (name: string) => this.declare(name, "Int"),
    val: (n: number | bigint) => new T(this, intLit(n), "Int"),
  };

  readonly Real = {
    const: (name: string) => this.declare(name, "Real"),
    val: (s: string) => new T(this, realLit(s), "Real"),
  };

  readonly Bool = {
    const: (name: string) => this.declare(name, "Bool"),
    val: (b: boolean) => new T(this, b ? "true" : "false", "Bool"),
  };

  readonly Function = {
    /** An uninterpreted function `name: Int → Int`. */
    declare: (name: string) => {
      const sym = symbol(name);
      if (!this.declared.has(sym)) {
        this.declared.add(sym);
        this.lines.push(`(declare-fun ${sym} (Int) Int)`);
      }
      return { call: (x: T) => new T(this, `(${sym} ${x.s})`, "Int") };
    },
  };

  And(...xs: T[]): T {
    const parts = xs.filter((x) => x.s !== "true");
    if (parts.some((x) => x.s === "false")) return this.Bool.val(false);
    if (!parts.length) return this.Bool.val(true);
    return parts.length === 1 ? parts[0]! : this.make(`(and ${parts.map((x) => x.s).join(" ")})`, "Bool");
  }

  Or(...xs: T[]): T {
    const parts = xs.filter((x) => x.s !== "false");
    if (parts.some((x) => x.s === "true")) return this.Bool.val(true);
    if (!parts.length) return this.Bool.val(false);
    return parts.length === 1 ? parts[0]! : this.make(`(or ${parts.map((x) => x.s).join(" ")})`, "Bool");
  }

  Not(x: T): T {
    if (x.s === "true") return this.Bool.val(false);
    if (x.s === "false") return this.Bool.val(true);
    return this.make(`(not ${x.s})`, "Bool");
  }

  Implies(a: T, b: T): T {
    if (a.s === "false" || b.s === "true") return this.Bool.val(true);
    if (a.s === "true") return b;
    return this.make(`(=> ${a.s} ${b.s})`, "Bool");
  }

  If(c: T, a: T, b: T): T {
    if (c.s === "true") return a;
    if (c.s === "false") return b;
    if (a.s === b.s) return a;
    return this.make(`(ite ${c.s} ${a.s} ${b.s})`, a.sort === "Real" || b.sort === "Real" ? "Real" : a.sort);
  }

  Sum(first: T, ...rest: T[]): T {
    const all = [first, ...rest].filter((x) => x.s !== "0" && x.s !== "0.0");
    if (!all.length) return first;
    return all.length === 1 ? all[0]! : this.make(`(+ ${all.map((x) => x.s).join(" ")})`, first.sort);
  }

  ToReal(x: T): T {
    return x.sort === "Real" ? x : this.make(`(to_real ${x.s})`, "Real");
  }

  IsInt(x: T): T {
    return this.make(`(is_int ${x.s})`, "Bool");
  }

  /** Adds an assertion. */
  assert(x: T): void {
    if (x.s !== "true") this.lines.push(`(assert ${x.s})`);
  }

  /** Lines added since the last call. */
  take(): string {
    const out = this.lines.slice(this.sent).join("\n");
    this.sent = this.lines.length;
    return out;
  }

  /** Everything declared, defined and asserted so far. */
  script(): string {
    return this.lines.join("\n");
  }
}

type Z3Api = Awaited<ReturnType<typeof init>>;
let api: Promise<Z3Api> | undefined;

/** Z3 (WebAssembly), loaded once per process. */
export function z3(): Promise<Z3Api> {
  api ??= init();
  return api;
}

/** Z3's version, as Z3 prints it (`Z3 4.15.4.0`). */
export async function z3Version(): Promise<string> {
  const v = (await z3()).Z3.get_full_version?.() ?? "";
  return v.startsWith("Z3") ? v : `Z3 ${v}`.trim();
}

/** Z3 runs one query at a time per process: queries from concurrent verifications wait their turn. */
let queue: Promise<unknown> = Promise.resolve();
function serial<R>(fn: () => Promise<R>): Promise<R> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export type Status = "sat" | "unsat" | "unknown";

/** One Z3 context fed with the text of an `Smt` (incrementally); queries are push / assert / check-sat / pop. */
export class Session {
  private ctx: unknown;
  private closed = false;

  private constructor(
    private api: Z3Api,
    readonly smt: Smt,
  ) {}

  static async open(smt: Smt, timeoutMs: number): Promise<Session> {
    const a = await z3();
    const s = new Session(a, smt);
    const cfg = a.Z3.mk_config();
    a.Z3.set_param_value(cfg, "model", "true");
    s.ctx = a.Z3.mk_context(cfg);
    a.Z3.del_config(cfg);
    await s.eval(`(set-option :timeout ${Math.max(1, Math.round(timeoutMs))})`);
    return s;
  }

  private eval(text: string): Promise<string> {
    if (this.closed) throw new Error("session closed");
    return serial(() => this.api.Z3.eval_smtlib2_string(this.ctx as never, text));
  }

  /**
   * Checks the assertions so far plus `extra`. When satisfiable, the values of `terms` (by their text) are returned.
   */
  async check(extra: T[], terms: T[] = []): Promise<{ status: Status; values?: Map<string, string> }> {
    // Every name the query uses was defined while building it: send it at the top level (it outlives the scope).
    const pending = this.smt.take();
    if (pending) await this.eval(pending);
    const asserts = extra.filter((x) => x.s !== "true").map((x) => `(assert ${x.s})`);
    const out = (await this.eval(`(push 1)\n${asserts.join("\n")}\n(check-sat)`)).trim();
    const status: Status = out.endsWith("unsat") ? "unsat" : out.endsWith("sat") ? "sat" : "unknown";
    let values: Map<string, string> | undefined;
    if (status === "sat" && terms.length) {
      const unique = [...new Set(terms.map((t) => t.s))];
      values = new Map();
      // In chunks: one get-value with thousands of terms is slow to print and parse.
      for (let i = 0; i < unique.length; i += 400) {
        const chunk = unique.slice(i, i + 400);
        const text = await this.eval(`(get-value (${chunk.join(" ")}))`);
        const parsed = parse(text);
        if (Array.isArray(parsed)) for (const pair of parsed) if (Array.isArray(pair) && pair.length === 2) values.set(unparse(pair[0]!), unparse(pair[1]!));
        // Keys come back as Z3 prints them; map by position as well (Z3 echoes the terms in order).
        if (Array.isArray(parsed)) chunk.forEach((t, j) => {
          const pair = parsed[j];
          if (Array.isArray(pair) && pair.length === 2) values!.set(t, unparse(pair[1]!));
        });
      }
    }
    await this.eval("(pop 1)");
    return { status, ...(values ? { values } : {}) };
  }

  /** The script of one query: everything so far plus `extra` and `(check-sat)` (standalone SMT-LIB). */
  standalone(extra: T[]): string {
    return `(set-logic ALL)\n${this.smt.script()}\n${extra.map((x) => `(assert ${x.s})`).join("\n")}\n(check-sat)\n(get-model)\n`;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.api.Z3.del_context(this.ctx as never);
  }
}

// S-expressions -------------------------------------------------------------

type SExp = string | SExp[];

function parse(text: string): SExp {
  const tokens = text.match(/\|[^|]*\||\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const read = (): SExp => {
    const t = tokens[i++]!;
    if (t === "(") {
      const list: SExp[] = [];
      while (tokens[i] !== ")" && i < tokens.length) list.push(read());
      i++;
      return list;
    }
    return t;
  };
  return read();
}

function unparse(e: SExp): string {
  return Array.isArray(e) ? `(${e.map(unparse).join(" ")})` : e;
}

/** A value printed by Z3 as an exact rational `[numerator, denominator]` (`5`, `(- 5)`, `1.5`, `(/ 1.0 3.0)`). */
export function rationalOf(text: string): [bigint, bigint] | undefined {
  const e = parse(text);
  const go = (x: SExp): [bigint, bigint] | undefined => {
    if (typeof x === "string") {
      const m = /^(\d+)(?:\.(\d+))?$/.exec(x);
      if (!m) return undefined;
      const frac = m[2] ?? "";
      return [BigInt(m[1]! + frac), 10n ** BigInt(frac.length)];
    }
    if (x[0] === "-" && x.length === 2) {
      const v = go(x[1]!);
      return v && [-v[0], v[1]];
    }
    if (x[0] === "/" && x.length === 3) {
      const a = go(x[1]!);
      const b = go(x[2]!);
      return a && b ? [a[0] * b[1], a[1] * b[0]] : undefined;
    }
    return undefined;
  };
  return go(e);
}
