/**
 * Parser of the .domain (aggregate rules) and .flow (use-case steps, queries, policies) sources (docs/10 §12).
 * Expressions are kept as source text: the existing expression checker reads them exactly as it reads the YAML
 * strings, so the rules mean the same in both formats.
 */
import { parse as parseYaml } from "yaml";
import { Cursor, describe, lex, SplitSyntaxError, type Tok } from "./lexer.ts";

export interface Expr {
  text: string;
  tok: Tok;
}

export interface Param {
  name: string;
  type: string;
  required: boolean;
  tok: Tok;
}

export interface Documented {
  doc?: string;
  comments?: string[];
  tok: Tok;
}

export interface Invariant extends Documented {
  name: string;
  expr: Expr;
  error: string;
  errorTok: Tok;
  checkOn?: string[];
}

export interface Guard extends Documented {
  name: string;
  params: Param[];
  expr: Expr;
  error: string;
  errorTok: Tok;
}

export interface Emit {
  name: string;
  fields: { name: string; value?: Expr; tok: Tok }[];
  when?: Expr;
  tok: Tok;
}

export interface Entry {
  key: string;
  value: Expr;
  tok: Tok;
}

export interface Factory extends Documented {
  name: string;
  params: Param[];
  requires: Expr[];
  fields: Entry[];
  emits: Emit[];
}

export interface Operation extends Documented {
  name: string;
  params: Param[];
  requires: Expr[];
  changes: Entry[];
  emits: Emit[];
}

export interface Extension extends Documented {
  name: string;
  params: Param[];
  returns: string;
  default?: { value: unknown; tok: Tok };
}

export interface AggregateBlock extends Documented {
  name: string;
  authorize?: Expr;
  invariants: Invariant[];
  guards: Guard[];
  factories: Factory[];
  operations: Operation[];
  entities: { name: string; invariants: Invariant[]; tok: Tok }[];
}

export interface DomainFile {
  context: string;
  contextTok: Tok;
  glossary: { term: string; definition: string; tok: Tok }[];
  extensions: Extension[];
  values: { name: string; invariants: Invariant[]; tok: Tok }[];
  aggregates: AggregateBlock[];
}

export type Stmt =
  | { kind: "load"; as: string; aggregate: string; by: Expr; notFound?: string; tok: Tok }
  /** `let x = Name.member(arg: expr, ...)`: a factory call when Name is an aggregate, else an ordinary `let`. */
  | { kind: "call"; as: string; target: string; member: string; args: Entry[]; raw: Expr; tok: Tok }
  | { kind: "let"; name: string; value: Expr; tok: Tok }
  | { kind: "invoke"; target: string; operation: string; args: Entry[]; tok: Tok }
  | { kind: "save"; target: string; tok: Tok }
  | { kind: "publish"; event: string; afterCommit: boolean; tok: Tok }
  | { kind: "if"; condition: Expr; then: Stmt[]; else: Stmt[]; tok: Tok }
  | { kind: "fail"; error: string; tok: Tok }
  | { kind: "return"; value: Expr; tok: Tok }
  | { kind: "authorize"; expr: Expr; tok: Tok };

export interface Flow extends Documented {
  name: string;
  params: { name: string; tok: Tok }[];
  steps: Stmt[];
  authorize?: Expr;
}

export interface Filter {
  field: string;
  op: string;
  param?: string;
  principal?: string;
  value?: unknown;
  hasValue: boolean;
  tok: Tok;
}

export interface Query extends Documented {
  name: string;
  params: { name: string; tok: Tok }[];
  from: string;
  authorize?: Expr;
  where: Filter[];
  search?: { param: string; fields: string[]; mode: string; minSimilarity?: number; tok: Tok };
  orderBy: { field: string; direction?: string; tok: Tok }[];
  page?: { size: number; maxSize?: number; tok: Tok };
  returns?: string[];
}

export interface Policy extends Documented {
  name: string;
  event: string;
  run: string;
  args: Entry[];
}

export interface FlowFile {
  context: string;
  contextTok: Tok;
  flows: Flow[];
  queries: Query[];
  policies: Policy[];
}

const OPEN = new Set(["(", "["]);
const CLOSE = new Set([")", "]"]);

/** Reads an expression up to (not including) a stop: end of line, `,` `{` `}` or an unmatched `)` / `]` at depth 0, or a stop keyword. */
function expr(c: Cursor, stops: readonly string[] = [], what = "an expression"): Expr {
  const first = c.peek();
  let last: Tok | undefined;
  let depth = 0;
  for (;;) {
    const t = c.toks[c.p]!;
    if (t.k === "eof") break;
    if (t.k === "nl") {
      if (depth === 0) break;
      c.p++;
      continue;
    }
    if (depth === 0) {
      if (t.k === "punct" && (t.v === "," || t.v === "{" || t.v === "}" || CLOSE.has(t.v))) break;
      if (t.k === "id" && stops.includes(t.v)) break;
    }
    if (t.k === "punct" && OPEN.has(t.v)) depth++;
    if (t.k === "punct" && CLOSE.has(t.v)) depth--;
    last = t;
    c.p++;
  }
  if (!last) throw new SplitSyntaxError(`Expected ${what} but found ${describe(first)}`, first);
  return { text: c.text(first, last), tok: first };
}

/** End of a statement: a newline, or a `}` / end of file that the caller consumes. */
function endStatement(c: Cursor, what: string): void {
  const t = c.toks[c.p]!;
  if (t.k === "nl") {
    c.newlines();
    return;
  }
  if (t.k === "eof" || (t.k === "punct" && t.v === "}")) return;
  throw new SplitSyntaxError(`Unexpected ${describe(t)} after ${what}`, t, "Write one statement per line");
}

/** A type expression: `UUID`, `List[EmailAddress]`, `Ref[Order]`. */
function typeExpr(c: Cursor): { text: string; tok: Tok } {
  const first = c.ident("a type");
  let last = first;
  if (c.is("[")) {
    let depth = 0;
    for (;;) {
      const t = c.next();
      if (t.k === "eof" || t.k === "nl") throw new SplitSyntaxError(`Unclosed "[" in the type`, first);
      if (t.v === "[") depth++;
      if (t.v === "]") depth--;
      last = t;
      if (depth === 0) break;
    }
  }
  return { text: c.text(first, last).replace(/\s+/g, ""), tok: first };
}

function params(c: Cursor): Param[] {
  const out: Param[] = [];
  c.expect("(");
  c.newlines();
  while (!c.is(")")) {
    const name = c.ident("a parameter name");
    c.expect(":", `after parameter ${name.v}`);
    const type = typeExpr(c);
    const optional = !!c.accept("?");
    out.push({ name: name.v, type: type.text, required: !optional, tok: name });
    c.newlines();
    if (!c.accept(",")) break;
    c.newlines();
  }
  c.expect(")", "to close the parameters");
  return out;
}

/** `(name, other)`: the names of a flow's / query's request fields. */
function nameList(c: Cursor): { name: string; tok: Tok }[] {
  const out: { name: string; tok: Tok }[] = [];
  c.expect("(");
  c.newlines();
  while (!c.is(")")) {
    const t = c.ident("a request field name");
    out.push({ name: t.v, tok: t });
    c.newlines();
    if (!c.accept(",")) break;
    c.newlines();
  }
  c.expect(")");
  return out;
}

/** `(name: expr, ...)`. */
function namedArgs(c: Cursor): Entry[] {
  const out: Entry[] = [];
  c.expect("(");
  c.newlines();
  while (!c.is(")")) {
    const key = c.ident("an argument name");
    c.expect(":", `after argument ${key.v} (arguments are named: name: value)`);
    out.push({ key: key.v, value: expr(c, [], `the value of ${key.v}`), tok: key });
    c.newlines();
    if (!c.accept(",")) break;
    c.newlines();
  }
  c.expect(")", "to close the arguments");
  return out;
}

/** `{ key: expr, other }` (commas or newlines separate entries; `other` alone means `other: other`). */
function entries(c: Cursor, shorthandValue: boolean): { key: string; value?: Expr; tok: Tok }[] {
  const out: { key: string; value?: Expr; tok: Tok }[] = [];
  c.expect("{");
  for (;;) {
    c.newlines();
    if (c.accept("}")) break;
    const key = c.ident("a field name");
    if (c.accept(":")) out.push({ key: key.v, value: expr(c, [], `the value of ${key.v}`), tok: key });
    else out.push({ key: key.v, ...(shorthandValue ? { value: { text: key.v, tok: key } } : {}), tok: key });
    c.newlines();
    c.accept(",");
  }
  return out;
}

function header(c: Cursor): { context: string; tok: Tok } {
  c.newlines();
  const kw = c.peek();
  if (!c.is("context")) throw new SplitSyntaxError(`Expected "context <Name>" at the top of the file but found ${describe(kw)}`, kw);
  c.next();
  const name = c.ident("the context name");
  endStatement(c, "the context name");
  return { context: name.v, tok: name };
}

function block(c: Cursor, what: string, body: () => void): void {
  const open = c.expect("{", `to open ${what}`);
  for (;;) {
    c.newlines();
    const t = c.peek();
    if (t.k === "eof") throw new SplitSyntaxError(`Expected "}" to close ${what}`, open);
    if (c.accept("}")) break;
    body();
  }
}

function invariant(c: Cursor): Invariant {
  const kw = c.expect("invariant");
  const name = c.ident("the invariant name");
  c.expect(":", `after invariant ${name.v}`);
  const e = expr(c, ["else"], "the rule");
  c.expect("else", "(invariant <name>: <rule> else <Error>)");
  const err = c.ident("the error raised when the rule does not hold");
  let checkOn: string[] | undefined;
  if (c.accept("on")) {
    checkOn = [];
    if (!c.accept("none")) {
      do checkOn.push(c.ident("construct or transition").v);
      while (separator(c));
    }
  }
  endStatement(c, `invariant ${name.v}`);
  return { name: name.v, expr: e, error: err.v, errorTok: err, ...(checkOn ? { checkOn } : {}), doc: kw.doc, comments: kw.comments, tok: kw };
}

/** `,` (or another separator) that may end a line: the list continues on the next. */
function separator(c: Cursor, v = ","): boolean {
  if (!c.accept(v)) return false;
  c.newlines();
  return true;
}

function requiresList(c: Cursor): Expr[] {
  const out: Expr[] = [];
  if (!c.accept("requires")) return out;
  do out.push(expr(c, [], "a guard call"));
  while (separator(c));
  return out;
}

function emit(c: Cursor): Emit {
  const kw = c.expect("emit");
  const name = c.ident("the event name");
  const fields = c.is("{") ? entries(c, false).map((e) => ({ name: e.key, ...(e.value ? { value: e.value } : {}), tok: e.tok })) : [];
  const when = c.accept("when") ? expr(c, [], "the condition") : undefined;
  endStatement(c, `emit ${name.v}`);
  return { name: name.v, fields, ...(when ? { when } : {}), tok: kw };
}

function memberBody(c: Cursor, what: string, mapKeyword: "new" | "change"): { entries: Entry[]; emits: Emit[] } {
  let out: Entry[] | undefined;
  const emits: Emit[] = [];
  block(c, what, () => {
    if (c.is(mapKeyword)) {
      const t = c.next();
      if (out) throw new SplitSyntaxError(`${what} has more than one "${mapKeyword}"`, t);
      out = entries(c, true).map((e) => ({ key: e.key, value: e.value!, tok: e.tok }));
      endStatement(c, mapKeyword);
      return;
    }
    if (c.is("emit")) {
      emits.push(emit(c));
      return;
    }
    const t = c.peek();
    throw new SplitSyntaxError(`Unexpected ${describe(t)} in ${what}`, t, `Write "${mapKeyword} { field: value }" and "emit Event { ... }"`);
  });
  return { entries: out ?? [], emits };
}

export function parseDomain(src: string): DomainFile {
  const c = new Cursor(lex(src), src, false);
  const h = header(c);
  const file: DomainFile = { context: h.context, contextTok: h.tok, glossary: [], extensions: [], values: [], aggregates: [] };
  for (;;) {
    c.newlines();
    const t = c.peek();
    if (t.k === "eof") break;
    if (c.is("glossary")) {
      c.next();
      block(c, "the glossary", () => {
        const term = c.next();
        if (term.k !== "str" && term.k !== "id") throw new SplitSyntaxError(`Expected a term but found ${describe(term)}`, term);
        c.expect(":", `after the term ${term.v}`);
        const def = c.next();
        if (def.k !== "str") throw new SplitSyntaxError(`Expected the definition of ${term.v} as a string`, def);
        file.glossary.push({ term: term.v, definition: def.v, tok: term });
        c.accept(",");
        endStatement(c, "the glossary entry");
      });
      continue;
    }
    if (c.is("extension")) {
      c.next();
      const name = c.ident("the extension point name");
      const ps = params(c);
      c.expect("->", `after the parameters of ${name.v} (extension name(params) -> ReturnType)`);
      const ret = typeExpr(c);
      let def: Extension["default"];
      if (c.accept("default")) {
        const first = c.peek();
        let last = first;
        while (c.toks[c.p]!.k !== "nl" && c.toks[c.p]!.k !== "eof") last = c.next();
        if (first.k === "nl" || first.k === "eof") throw new SplitSyntaxError("Expected the default value after default", first);
        const raw = c.text(first, last);
        try {
          def = { value: parseYaml(raw), tok: first };
        } catch {
          throw new SplitSyntaxError(`The default value ${raw} could not be read`, first, 'Write a literal: false, 0, "text" or { value: "x" }');
        }
      }
      endStatement(c, `extension ${name.v}`);
      file.extensions.push({ name: name.v, params: ps, returns: ret.text, ...(def ? { default: def } : {}), doc: t.doc, comments: t.comments, tok: t });
      continue;
    }
    if (c.is("value")) {
      c.next();
      const name = c.ident("the value object name");
      const invariants: Invariant[] = [];
      block(c, `value ${name.v}`, () => {
        if (!c.is("invariant")) throw new SplitSyntaxError(`Unexpected ${describe(c.peek())} in value ${name.v}`, c.peek(), "A value object block holds invariants; its fields are in the .proto file");
        invariants.push(invariant(c));
      });
      file.values.push({ name: name.v, invariants, tok: name });
      continue;
    }
    if (c.is("aggregate")) {
      c.next();
      const name = c.ident("the aggregate name");
      const agg: AggregateBlock = { name: name.v, invariants: [], guards: [], factories: [], operations: [], entities: [], tok: name, comments: t.comments, doc: t.doc };
      block(c, `aggregate ${name.v}`, () => {
        const k = c.peek();
        if (c.is("authorize")) {
          c.next();
          if (agg.authorize) throw new SplitSyntaxError(`aggregate ${name.v} has more than one authorize`, k);
          agg.authorize = expr(c, [], "the rule");
          endStatement(c, "authorize");
        } else if (c.is("invariant")) agg.invariants.push(invariant(c));
        else if (c.is("guard")) {
          c.next();
          const g = c.ident("the guard name");
          const ps = c.is("(") ? params(c) : [];
          c.expect(":", `after guard ${g.v}`);
          const e = expr(c, ["else"], "the condition");
          c.expect("else", "(guard <name>: <condition> else <Error>)");
          const err = c.ident("the error raised when the guard does not hold");
          endStatement(c, `guard ${g.v}`);
          agg.guards.push({ name: g.v, params: ps, expr: e, error: err.v, errorTok: err, doc: k.doc, comments: k.comments, tok: k });
        } else if (c.is("factory") || c.is("operation")) {
          const kind = c.next().v;
          const n = c.ident(`the ${kind} name`);
          const ps = c.is("(") ? params(c) : [];
          const req = requiresList(c);
          const body = memberBody(c, `${kind} ${n.v}`, kind === "factory" ? "new" : "change");
          endStatement(c, `${kind} ${n.v}`);
          if (kind === "factory") agg.factories.push({ name: n.v, params: ps, requires: req, fields: body.entries, emits: body.emits, doc: k.doc, comments: k.comments, tok: k });
          else agg.operations.push({ name: n.v, params: ps, requires: req, changes: body.entries, emits: body.emits, doc: k.doc, comments: k.comments, tok: k });
        } else if (c.is("entity")) {
          c.next();
          const en = c.ident("the entity name");
          const invariants: Invariant[] = [];
          block(c, `entity ${en.v}`, () => {
            if (!c.is("invariant")) throw new SplitSyntaxError(`Unexpected ${describe(c.peek())} in entity ${en.v}`, c.peek(), "An entity block holds invariants; its fields are in the .proto file");
            invariants.push(invariant(c));
          });
          agg.entities.push({ name: en.v, invariants, tok: en });
        } else throw new SplitSyntaxError(`Unexpected ${describe(k)} in aggregate ${name.v}`, k, "Expected authorize, invariant, guard, factory, operation or entity");
      });
      file.aggregates.push(agg);
      continue;
    }
    throw new SplitSyntaxError(`Unexpected ${describe(t)} in a .domain file`, t, "Expected glossary, extension, value or aggregate");
  }
  return file;
}

// ---------------------------------------------------------------------------
// .flow
// ---------------------------------------------------------------------------

function statements(c: Cursor, what: string): Stmt[] {
  const out: Stmt[] = [];
  c.nested(c.peek(), () => block(c, what, () => out.push(statement(c))));
  return out;
}

function statement(c: Cursor): Stmt {
  const t = c.peek();
  if (c.is("let")) {
    c.next();
    const name = c.ident("a name");
    c.expect("=", `after let ${name.v}`);
    if (c.is("load")) {
      c.next();
      const agg = c.ident("the aggregate to load");
      c.expect("(", `after load ${agg.v}`);
      const by = expr(c, [], "the identity to load by");
      c.expect(")");
      let notFound: string | undefined;
      if (c.accept("else")) {
        c.expect("fail", "(load X(id) else fail <Error>)");
        notFound = c.ident("the error raised when nothing is found").v;
      }
      endStatement(c, `let ${name.v}`);
      return { kind: "load", as: name.v, aggregate: agg.v, by, ...(notFound ? { notFound } : {}), tok: t };
    }
    // `let x = Name.member(arg: value)`: decided against the aggregates later.
    const save = c.p;
    const a = c.peek();
    if (a.k === "id" && /^[A-Z]/.test(a.v) && c.is(".", 1) && c.peek(2).k === "id" && c.is("(", 3)) {
      try {
        c.next();
        c.next();
        const member = c.next();
        const args = namedArgs(c);
        const end = c.toks[c.p]!;
        if (end.k === "nl" || end.k === "eof" || (end.k === "punct" && end.v === "}")) {
          const raw = { text: c.text(a, c.toks[c.p - 1]!), tok: a };
          endStatement(c, `let ${name.v}`);
          return { kind: "call", as: name.v, target: a.v, member: member.v, args, raw, tok: t };
        }
      } catch (e) {
        if (!(e instanceof SplitSyntaxError)) throw e;
      }
      c.p = save;
    }
    const value = expr(c, [], "a value");
    endStatement(c, `let ${name.v}`);
    return { kind: "let", name: name.v, value, tok: t };
  }
  if (c.is("authorize")) {
    c.next();
    const e = expr(c, [], "the rule");
    endStatement(c, "authorize");
    return { kind: "authorize", expr: e, tok: t };
  }
  if (c.is("if")) return ifStatement(c);
  if (c.is("fail")) {
    c.next();
    const err = c.ident("the error to raise");
    endStatement(c, "fail");
    return { kind: "fail", error: err.v, tok: t };
  }
  if (c.is("save")) {
    c.next();
    const target = c.ident("what to save");
    endStatement(c, "save");
    return { kind: "save", target: target.v, tok: t };
  }
  if (c.is("publish")) {
    c.next();
    const ev = c.ident("the event to publish");
    let afterCommit = false;
    if (c.accept("after")) {
      c.expect("commit", "(publish Event after commit)");
      afterCommit = true;
    }
    endStatement(c, "publish");
    return { kind: "publish", event: ev.v, afterCommit, tok: t };
  }
  if (c.is("return")) {
    c.next();
    const value = expr(c, [], "the value to return");
    endStatement(c, "return");
    return { kind: "return", value, tok: t };
  }
  if (t.k === "id" && c.is(".", 1) && c.peek(2).k === "id" && c.is("(", 3)) {
    c.next();
    c.next();
    const op = c.next();
    const args = namedArgs(c);
    endStatement(c, `${t.v}.${op.v}(...)`);
    return { kind: "invoke", target: t.v, operation: op.v, args, tok: t };
  }
  throw new SplitSyntaxError(`Unexpected ${describe(t)} in a flow`, t, "Expected let, if, fail, save, publish, return, authorize or target.operation(...)");
}

function ifStatement(c: Cursor): Stmt {
  const t = c.expect("if");
  const condition = expr(c, ["fail"], "the condition");
  if (c.is("fail")) {
    const f = c.next();
    const err = c.ident("the error to raise");
    endStatement(c, "if ... fail");
    return { kind: "if", condition, then: [{ kind: "fail", error: err.v, tok: f }], else: [], tok: t };
  }
  const then = statements(c, "the if branch");
  let els: Stmt[] = [];
  const save = c.p;
  c.newlines();
  if (c.accept("else")) {
    if (c.is("if")) els = [c.nested(c.peek(), () => ifStatement(c))];
    else {
      els = statements(c, "the else branch");
      endStatement(c, "else");
    }
  } else {
    c.p = save;
    endStatement(c, "if");
  }
  return { kind: "if", condition, then, else: els, tok: t };
}

const OPS: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };

function filters(c: Cursor): Filter[] {
  const out: Filter[] = [];
  do {
    const f = c.dotted("the field to filter on");
    const opTok = c.next();
    const op = OPS[opTok.v];
    if (!op || opTok.k !== "punct") throw new SplitSyntaxError(`Expected a comparison (== != < <= > >=) but found ${describe(opTok)}`, opTok);
    const filter: Filter = { field: f.v, op, hasValue: false, tok: f.tok };
    if (c.is(":") && c.peek(1).k === "id") {
      c.next();
      filter.param = c.next().v;
    } else if (c.is("principal") && c.is(".", 1)) {
      c.next();
      c.next();
      filter.principal = c.ident("a principal member").v;
    } else {
      const v = expr(c, ["and"], "a parameter (:name), principal.<member> or a literal");
      try {
        filter.value = parseYaml(v.text);
      } catch {
        throw new SplitSyntaxError(`The literal ${v.text} could not be read`, v.tok, 'Compare with :param, principal.<member>, or a literal such as "text", 3 or true');
      }
      filter.hasValue = true;
    }
    out.push(filter);
  } while (separator(c, "and"));
  return out;
}

export function parseFlow(src: string): FlowFile {
  const c = new Cursor(lex(src), src, false);
  const h = header(c);
  const file: FlowFile = { context: h.context, contextTok: h.tok, flows: [], queries: [], policies: [] };
  for (;;) {
    c.newlines();
    const t = c.peek();
    if (t.k === "eof") break;
    if (c.is("flow")) {
      c.next();
      const name = c.ident("the flow name");
      const ps = c.is("(") ? nameList(c) : [];
      const steps = statements(c, `flow ${name.v}`);
      endStatement(c, `flow ${name.v}`);
      file.flows.push({ name: name.v, params: ps, steps, doc: t.doc, comments: t.comments, tok: name });
      continue;
    }
    if (c.is("query")) {
      c.next();
      const name = c.ident("the query name");
      const ps = c.is("(") ? nameList(c) : [];
      c.expect("from", `(query ${name.v}(params) from <Aggregate> { ... })`);
      const from = c.ident("the aggregate the query reads");
      const q: Query = { name: name.v, params: ps, from: from.v, where: [], orderBy: [], doc: t.doc, comments: t.comments, tok: name };
      block(c, `query ${name.v}`, () => {
        const k = c.peek();
        if (c.accept("authorize")) q.authorize = expr(c, [], "the rule");
        else if (c.accept("where")) q.where.push(...filters(c));
        else if (c.accept("search")) {
          const param = c.ident("the search parameter");
          c.expect("on", `after search ${param.v}`);
          const fields: string[] = [];
          do fields.push(c.dotted("a field to search").v);
          while (separator(c));
          const mode = c.ident("the match mode (trigram, prefix or exact)");
          let minSimilarity: number | undefined;
          if (c.accept(">=")) {
            const n = c.next();
            if (n.k !== "num") throw new SplitSyntaxError("Expected the minimum similarity (a number)", n);
            minSimilarity = Number(n.v);
          }
          q.search = { param: param.v, fields, mode: mode.v, ...(minSimilarity !== undefined ? { minSimilarity } : {}), tok: k };
        } else if (c.accept("order")) {
          c.expect("by", "(order by field [asc|desc], ...)");
          do {
            const f = c.dotted("a field to order by");
            const dir = c.is("asc") || c.is("desc") ? c.next().v : undefined;
            q.orderBy.push({ field: f.v, ...(dir ? { direction: dir } : {}), tok: f.tok });
          } while (separator(c));
        } else if (c.accept("page")) {
          const n = c.next();
          if (n.k !== "num") throw new SplitSyntaxError("Expected the page size (a number)", n);
          let maxSize: number | undefined;
          if (c.accept("max")) {
            const m = c.next();
            if (m.k !== "num") throw new SplitSyntaxError("Expected the largest page size (a number)", m);
            maxSize = Number(m.v);
          }
          q.page = { size: Number(n.v), ...(maxSize !== undefined ? { maxSize } : {}), tok: k };
        } else if (c.accept("returns")) {
          q.returns = [];
          do q.returns.push(c.ident("a field to return").v);
          while (separator(c));
        } else throw new SplitSyntaxError(`Unexpected ${describe(k)} in query ${name.v}`, k, "Expected authorize, where, search, order by, page or returns");
        endStatement(c, "the query clause");
      });
      endStatement(c, `query ${name.v}`);
      file.queries.push(q);
      continue;
    }
    if (c.is("policy")) {
      c.next();
      const name = c.ident("the policy name");
      c.expect("on", `(policy ${name.v} on <Event> { run <use_case>(...) })`);
      const ev = c.dotted("the event");
      let run: Tok | undefined;
      let args: Entry[] = [];
      block(c, `policy ${name.v}`, () => {
        const k = c.expect("run", "(a policy runs one use case)");
        if (run) throw new SplitSyntaxError(`policy ${name.v} runs more than one use case`, k);
        run = c.ident("the use case to run");
        args = c.is("(") ? namedArgs(c) : [];
        endStatement(c, "run");
      });
      if (!run) throw new SplitSyntaxError(`policy ${name.v} does not run a use case`, name, "Write run <use_case>(input: value, ...)");
      endStatement(c, `policy ${name.v}`);
      file.policies.push({ name: name.v, event: ev.v, run: run.v, args, doc: t.doc, comments: t.comments, tok: t });
      continue;
    }
    throw new SplitSyntaxError(`Unexpected ${describe(t)} in a .flow file`, t, "Expected flow, query or policy");
  }
  return file;
}
