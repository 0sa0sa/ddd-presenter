/**
 * Parser for the subset of proto3 the model's .proto files use (docs/10 §12.2): syntax, package, import, file /
 * message / field / enum value / method options (text-format values), messages (nested), enums and services.
 * It reads what protoc and buf read; it does not resolve imports or check types (the assembler does what matters).
 */
import { Cursor, lex, SplitSyntaxError, type Tok } from "./lexer.ts";

/** A text-format value: `{ a: 1 b: [x, y] c { d: "e" } }`, a string, a number, or an identifier (enum / bool). */
export type TfValue =
  | { k: "msg"; fields: { name: string; value: TfValue; tok: Tok }[]; tok: Tok }
  | { k: "list"; items: TfValue[]; tok: Tok }
  | { k: "str"; v: string; tok: Tok }
  | { k: "num"; v: number; tok: Tok }
  | { k: "id"; v: string; tok: Tok };

export interface ProtoOption {
  /** `ddd.v1.aggregate` for `(ddd.v1.aggregate)`, `idempotency_level` for a built-in option. */
  name: string;
  value: TfValue;
  tok: Tok;
}

export interface ProtoField {
  label: "" | "optional" | "repeated";
  type: string;
  name: string;
  number: number;
  options: ProtoOption[];
  doc?: string;
  comments?: string[];
  tok: Tok;
  typeTok: Tok;
}

export interface ProtoEnumValue {
  name: string;
  number: number;
  options: ProtoOption[];
  doc?: string;
  tok: Tok;
}

export interface ProtoEnum {
  name: string;
  values: ProtoEnumValue[];
  options: ProtoOption[];
  doc?: string;
  comments?: string[];
  tok: Tok;
}

export interface ProtoMessage {
  name: string;
  fields: ProtoField[];
  messages: ProtoMessage[];
  enums: ProtoEnum[];
  options: ProtoOption[];
  doc?: string;
  comments?: string[];
  tok: Tok;
}

export interface ProtoRpc {
  name: string;
  input: string;
  output: string;
  inputTok: Tok;
  options: ProtoOption[];
  doc?: string;
  comments?: string[];
  tok: Tok;
}

export interface ProtoService {
  name: string;
  rpcs: ProtoRpc[];
  options: ProtoOption[];
  tok: Tok;
}

export interface ProtoFile {
  syntax?: string;
  package?: string;
  imports: string[];
  options: ProtoOption[];
  /** Top-level declarations in source order. */
  decls: ({ kind: "message"; message: ProtoMessage } | { kind: "enum"; enum: ProtoEnum } | { kind: "service"; service: ProtoService })[];
}

function tfValue(c: Cursor): TfValue {
  return c.nested(c.peek(), () => tfValueInner(c));
}

function tfValueInner(c: Cursor): TfValue {
  const t = c.peek();
  if (c.is("{") || c.is("<")) return tfMessage(c);
  if (c.is("[")) {
    const open = c.next();
    const items: TfValue[] = [];
    while (!c.is("]")) {
      items.push(tfValue(c));
      if (!c.accept(",")) break;
    }
    c.expect("]", "to close the list");
    return { k: "list", items, tok: open };
  }
  if (t.k === "str") {
    c.next();
    let v = t.v;
    // Adjacent string literals concatenate ("a" "b").
    while (c.peek().k === "str") v += c.next().v;
    return { k: "str", v, tok: t };
  }
  if (c.is("-") && c.peek(1).k === "num") {
    c.next();
    const n = c.next();
    return { k: "num", v: -Number(n.v), tok: t };
  }
  if (t.k === "num") {
    c.next();
    return { k: "num", v: Number(t.v), tok: t };
  }
  if (t.k === "id") {
    c.next();
    return { k: "id", v: t.v, tok: t };
  }
  throw new SplitSyntaxError(`Expected an option value but found "${t.v || "the end of the file"}"`, t);
}

function tfMessage(c: Cursor): TfValue {
  const open = c.next();
  const close = open.v === "<" ? ">" : "}";
  const fields: { name: string; value: TfValue; tok: Tok }[] = [];
  while (!c.is(close)) {
    if (c.peek().k === "eof") throw new SplitSyntaxError(`Expected "${close}" to close the option value`, open);
    const key = c.peek();
    let name: string;
    if (c.is("[")) {
      // Extension or Any type URL inside text format: [ddd.v1.x]
      c.next();
      name = c.dotted("an extension name").v;
      c.expect("]");
    } else name = c.ident("a field name").v;
    if (c.accept(":")) fields.push({ name, value: tfValue(c), tok: key });
    else if (c.is("{") || c.is("<")) fields.push({ name, value: tfValue(c), tok: key });
    else if (c.is("[")) fields.push({ name, value: tfValue(c), tok: key });
    else throw new SplitSyntaxError(`Expected ":" after "${name}"`, c.peek());
    c.accept(",") ?? c.accept(";");
  }
  c.expect(close);
  return { k: "msg", fields, tok: open };
}

/** `(ddd.v1.rules).min_length` → name `ddd.v1.rules`, sub-path `["min_length"]`. */
function optionName(c: Cursor): { name: string; sub: string[]; tok: Tok } {
  const tok = c.peek();
  let name: string;
  if (c.accept("(")) {
    if (c.is(".")) c.next();
    name = c.dotted("an option name").v;
    c.expect(")");
  } else name = c.ident("an option name").v;
  const sub: string[] = [];
  while (c.accept(".")) sub.push(c.ident("an option field").v);
  return { name, sub, tok };
}

function wrap(sub: string[], value: TfValue, tok: Tok): TfValue {
  let v = value;
  for (let i = sub.length - 1; i >= 0; i--) v = { k: "msg", fields: [{ name: sub[i]!, value: v, tok }], tok };
  return v;
}

/** Adds an option, merging `(x).a = 1` and `(x).b = 2` into one message value. */
function addOption(list: ProtoOption[], name: string, value: TfValue, tok: Tok): void {
  const prev = list.find((o) => o.name === name);
  if (prev && prev.value.k === "msg" && value.k === "msg") {
    prev.value.fields.push(...value.fields);
    return;
  }
  list.push({ name, value, tok });
}

function optionStatement(c: Cursor, list: ProtoOption[]): void {
  c.expect("option");
  const n = optionName(c);
  c.expect("=");
  addOption(list, n.name, wrap(n.sub, tfValue(c), n.tok), n.tok);
  c.expect(";", "after the option");
}

function bracketOptions(c: Cursor): ProtoOption[] {
  const list: ProtoOption[] = [];
  if (!c.accept("[")) return list;
  while (!c.is("]")) {
    const n = optionName(c);
    c.expect("=");
    addOption(list, n.name, wrap(n.sub, tfValue(c), n.tok), n.tok);
    if (!c.accept(",")) break;
  }
  c.expect("]", "to close the field options");
  return list;
}

function enumDecl(c: Cursor): ProtoEnum {
  const kw = c.expect("enum");
  const name = c.ident("an enum name");
  c.expect("{");
  const e: ProtoEnum = { name: name.v, values: [], options: [], doc: kw.doc, comments: kw.comments, tok: name };
  while (!c.accept("}")) {
    if (c.peek().k === "eof") throw new SplitSyntaxError(`Expected "}" to close enum ${name.v}`, name);
    if (c.accept(";")) continue;
    if (c.is("option")) {
      optionStatement(c, e.options);
      continue;
    }
    if (c.is("reserved")) {
      while (!c.accept(";")) c.next();
      continue;
    }
    const vname = c.ident("an enum value name");
    c.expect("=");
    const neg = c.accept("-");
    const num = c.peek();
    if (num.k !== "num") throw new SplitSyntaxError(`Expected the number of ${vname.v}`, num);
    c.next();
    const options = bracketOptions(c);
    c.expect(";", `after ${vname.v}`);
    e.values.push({ name: vname.v, number: (neg ? -1 : 1) * Number(num.v), options, doc: vname.doc, tok: vname });
  }
  return e;
}

const SCALARS_AND_LABELS = new Set(["optional", "repeated", "required"]);

function messageDecl(c: Cursor): ProtoMessage {
  const kw = c.expect("message");
  const name = c.ident("a message name");
  c.expect("{");
  const m: ProtoMessage = { name: name.v, fields: [], messages: [], enums: [], options: [], doc: kw.doc, comments: kw.comments, tok: name };
  while (!c.accept("}")) {
    const t = c.peek();
    if (t.k === "eof") throw new SplitSyntaxError(`Expected "}" to close message ${name.v}`, name);
    if (c.accept(";")) continue;
    if (c.is("option")) {
      optionStatement(c, m.options);
      continue;
    }
    if (c.is("message")) {
      m.messages.push(c.nested(t, () => messageDecl(c)));
      continue;
    }
    if (c.is("enum")) {
      m.enums.push(enumDecl(c));
      continue;
    }
    if (c.is("reserved") || c.is("extensions")) {
      while (!c.accept(";")) c.next();
      continue;
    }
    if (c.is("oneof") || c.is("map") || c.is("extend") || c.is("group")) {
      throw new SplitSyntaxError(`"${t.v}" is not supported in model .proto files`, t, "Declare plain fields; a model field is optional, repeated or singular");
    }
    let label: ProtoField["label"] = "";
    const first = c.peek();
    if (SCALARS_AND_LABELS.has(first.v) && c.peek(1).k === "id") {
      c.next();
      if (first.v === "required") throw new SplitSyntaxError('"required" is proto2; model fields are proto3', first, "Leave the label out (the field is required) or write optional");
      label = first.v as ProtoField["label"];
    }
    const typeTok = c.peek();
    if (c.is(".")) c.next();
    const type = c.dotted("a field type").v;
    const fname = c.ident("a field name");
    c.expect("=");
    const num = c.peek();
    if (num.k !== "num") throw new SplitSyntaxError(`Expected the field number of ${fname.v}`, num);
    c.next();
    const options = bracketOptions(c);
    c.expect(";", `after field ${fname.v}`);
    m.fields.push({ label, type, name: fname.v, number: Number(num.v), options, doc: first.doc, comments: first.comments, tok: fname, typeTok });
  }
  return m;
}

function serviceDecl(c: Cursor): ProtoService {
  c.expect("service");
  const name = c.ident("a service name");
  c.expect("{");
  const s: ProtoService = { name: name.v, rpcs: [], options: [], tok: name };
  while (!c.accept("}")) {
    if (c.peek().k === "eof") throw new SplitSyntaxError(`Expected "}" to close service ${name.v}`, name);
    if (c.accept(";")) continue;
    if (c.is("option")) {
      optionStatement(c, s.options);
      continue;
    }
    const kw = c.expect("rpc", "(each entry of a service is an rpc)");
    const rname = c.ident("an rpc name");
    c.expect("(");
    if (c.is("stream")) throw new SplitSyntaxError("Streaming rpcs are not supported in model .proto files", c.peek());
    const inputTok = c.peek();
    if (c.is(".")) c.next();
    const input = c.dotted("the request message").v;
    c.expect(")");
    c.expect("returns");
    c.expect("(");
    if (c.is("stream")) throw new SplitSyntaxError("Streaming rpcs are not supported in model .proto files", c.peek());
    if (c.is(".")) c.next();
    const output = c.dotted("the response message").v;
    c.expect(")");
    const rpc: ProtoRpc = { name: rname.v, input, output, inputTok, options: [], doc: kw.doc, comments: kw.comments, tok: rname };
    if (c.accept("{")) {
      while (!c.accept("}")) {
        if (c.peek().k === "eof") throw new SplitSyntaxError(`Expected "}" to close rpc ${rname.v}`, rname);
        if (c.accept(";")) continue;
        optionStatement(c, rpc.options);
      }
    } else c.expect(";", `after rpc ${rname.v}`);
    s.rpcs.push(rpc);
  }
  return s;
}

export function parseProto(src: string): ProtoFile {
  const c = new Cursor(lex(src), src, true);
  const file: ProtoFile = { imports: [], options: [], decls: [] };
  while (c.peek().k !== "eof") {
    const t = c.peek();
    if (c.accept(";")) continue;
    if (c.is("syntax") || c.is("edition")) {
      c.next();
      c.expect("=");
      const v = c.next();
      if (v.k !== "str") throw new SplitSyntaxError('Expected syntax = "proto3"', v);
      if (t.v === "edition" || v.v !== "proto3") throw new SplitSyntaxError(`Model .proto files are proto3 (found ${t.v} "${v.v}")`, v, 'Write syntax = "proto3";');
      file.syntax = v.v;
      c.expect(";");
      continue;
    }
    if (c.is("package")) {
      c.next();
      file.package = c.dotted("a package name").v;
      c.expect(";");
      continue;
    }
    if (c.is("import")) {
      c.next();
      if (c.is("public") || c.is("weak")) c.next();
      const p = c.next();
      if (p.k !== "str") throw new SplitSyntaxError("Expected the imported file name as a string", p);
      file.imports.push(p.v);
      c.expect(";");
      continue;
    }
    if (c.is("option")) {
      optionStatement(c, file.options);
      continue;
    }
    if (c.is("message")) {
      file.decls.push({ kind: "message", message: messageDecl(c) });
      continue;
    }
    if (c.is("enum")) {
      file.decls.push({ kind: "enum", enum: enumDecl(c) });
      continue;
    }
    if (c.is("service")) {
      file.decls.push({ kind: "service", service: serviceDecl(c) });
      continue;
    }
    if (c.is("extend")) {
      // Option definitions (e.g. ddd/v1/options.proto itself): skip the block.
      while (!c.accept("{")) c.next();
      let depth = 1;
      while (depth > 0) {
        const n = c.next();
        if (n.k === "eof") throw new SplitSyntaxError('Expected "}" to close extend', t);
        if (n.v === "{" && n.k === "punct") depth++;
        if (n.v === "}" && n.k === "punct") depth--;
      }
      continue;
    }
    throw new SplitSyntaxError(`Unexpected "${t.v}" at the top level of a .proto file`, t, "Expected syntax, package, import, option, message, enum or service");
  }
  return file;
}

/** Text-format value → plain JS (repeated keys become arrays; `true` / `false` become booleans). */
export function tfToJs(v: TfValue): unknown {
  switch (v.k) {
    case "str":
    case "num":
      return v.v;
    case "id":
      return v.v === "true" ? true : v.v === "false" ? false : v.v;
    case "list":
      return v.items.map(tfToJs);
    case "msg": {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) {
        const val = tfToJs(f.value);
        if (f.name in out) {
          const prev = out[f.name];
          out[f.name] = Array.isArray(prev) && !(f.value.k === "list") ? [...prev, val] : [prev, val];
        } else out[f.name] = val;
      }
      return out;
    }
  }
}

export function findOption(options: ProtoOption[], name: string): ProtoOption | undefined {
  return options.find((o) => o.name === name || o.name === `.${name}`);
}
