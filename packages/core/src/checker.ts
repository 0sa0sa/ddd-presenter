import { countNodes, ExprSyntaxError, parseExpr, type BinaryOp, type Expr } from "./expr.ts";
import type { AggregateIR, ContextIR, StateGuardIR } from "./ir.ts";
import { assignable, closest, isNumeric, isOrderable, resolveType, sameType, T, typeToString, type Type } from "./types.ts";

export type BuiltinFn = "is_empty" | "contains" | "length";
export type Port = "clock" | "ids";

/** Typed, fully-resolved expression tree consumed by code generators. */
export type TExpr = { type: Type } & (
  | { t: "lit"; value: string | number | boolean | null; kind: "string" | "integer" | "decimal" | "boolean" | "null" }
  /** `owner` undefined → a field of the current object (self). */
  | { t: "field"; name: string; owner?: TExpr }
  | { t: "param"; name: string }
  | { t: "local"; name: string }
  | { t: "enumValue"; enumName: string; value: string }
  | { t: "port"; port: Port; member: "now" | "new" }
  /** `receiver` undefined → guard of the current aggregate. */
  | { t: "guard"; aggregate: string; guard: string; receiver?: TExpr; args: TExpr[] }
  | { t: "builtin"; fn: BuiltinFn; args: TExpr[] }
  | { t: "extension"; name: string; args: TExpr[] }
  | { t: "not"; operand: TExpr }
  | { t: "binary"; op: BinaryOp; left: TExpr; right: TExpr }
  | { t: "isNull"; negate: boolean; operand: TExpr }
);

export interface ExprError {
  message: string;
  hint?: string;
  start: number;
  end: number;
}

export interface ExprEnv {
  context: ContextIR;
  /** Bare field names of the current object. */
  self?: { name: string; fields: Map<string, Type>; aggregate?: AggregateIR };
  params: Map<string, Type>;
  locals: Map<string, Type>;
  /** Allow bare guard references of `self.aggregate` (operation `require`). */
  allowSelfGuards: boolean;
  /** Allow `var.guard(...)` on local aggregates (use case conditions). */
  allowReceiverGuards: boolean;
  /** Allow `clock.now` / `ids.new`. */
  allowPorts: boolean;
  /** Allow calls to extension points. */
  allowExtensions: boolean;
}

export function makeEnv(context: ContextIR, init: Partial<ExprEnv> = {}): ExprEnv {
  return {
    context,
    params: new Map(),
    locals: new Map(),
    allowSelfGuards: false,
    allowReceiverGuards: false,
    allowPorts: false,
    allowExtensions: false,
    ...init,
  };
}

export interface CheckResult {
  expr?: TExpr;
  errors: ExprError[];
  nodeCount: number;
}

const BOOL = T.Boolean;

class Checker {
  readonly errors: ExprError[] = [];
  constructor(readonly env: ExprEnv) {}

  fail(node: Expr, message: string, hint?: string): undefined {
    this.errors.push({ message, hint, start: node.start, end: node.end });
    return undefined;
  }

  enumOf(t: Type | undefined): string | undefined {
    if (!t) return undefined;
    if (t.k === "enum") return t.name;
    if (t.k === "optional" && t.inner.k === "enum") return t.inner.name;
    return undefined;
  }

  fieldsOfType(t: Type): Map<string, Type> | undefined {
    const ctx = this.env.context;
    const toMap = (fields: { name: string; type: string; required: boolean }[], aggregate?: string) => {
      const m = new Map<string, Type>();
      for (const f of fields) {
        const r = resolveType(f.type, { context: ctx, aggregate });
        if (r.ok) m.set(f.name, f.required ? r.type : { k: "optional", inner: r.type });
      }
      return m;
    };
    if (t.k === "vo") {
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      return vo ? toMap(vo.fields) : undefined;
    }
    if (t.k === "aggregate") {
      const ag = ctx.aggregates.find((a) => a.name === t.name);
      return ag ? toMap(ag.fields, ag.name) : undefined;
    }
    if (t.k === "entity") {
      const ag = ctx.aggregates.find((a) => a.name === t.aggregate);
      const en = ag?.entities.find((e) => e.name === t.name);
      return en ? toMap(en.fields, t.aggregate) : undefined;
    }
    return undefined;
  }

  /** Narrowing key for `x` / `x.y` paths so `x != null and x > y` type-checks. */
  key(e: TExpr): string | undefined {
    if (e.t === "field") return e.owner ? (this.key(e.owner) ? `${this.key(e.owner)}.${e.name}` : undefined) : `self.${e.name}`;
    if (e.t === "param") return `param.${e.name}`;
    if (e.t === "local") return `local.${e.name}`;
    return undefined;
  }

  narrow(e: TExpr, narrowed: Set<string>): TExpr {
    const k = this.key(e);
    if (k && narrowed.has(k) && e.type.k === "optional") return { ...e, type: e.type.inner };
    return e;
  }

  check(node: Expr, narrowed: Set<string>, expected?: Type): TExpr | undefined {
    switch (node.t) {
      case "lit": {
        const type =
          node.kind === "string" ? T.String : node.kind === "integer" ? T.Integer : node.kind === "decimal" ? T.Decimal : node.kind === "boolean" ? BOOL : T.Null;
        return { t: "lit", value: node.value, kind: node.kind, type };
      }
      case "name":
        return this.checkName(node, narrowed, expected);
      case "member":
        return this.checkMember(node, narrowed);
      case "call":
        return this.checkCall(node, narrowed);
      case "not": {
        const operand = this.check(node.operand, narrowed, BOOL);
        if (!operand) return undefined;
        if (!sameType(operand.type, BOOL)) return this.fail(node.operand, `"not" requires a Boolean, got ${typeToString(operand.type)}`);
        return { t: "not", operand, type: BOOL };
      }
      case "binary":
        return this.checkBinary(node, narrowed);
    }
  }

  checkName(node: Extract<Expr, { t: "name" }>, narrowed: Set<string>, expected?: Type): TExpr | undefined {
    const env = this.env;
    const n = node.name;
    const p = env.params.get(n);
    if (p) return this.narrow({ t: "param", name: n, type: p }, narrowed);
    const l = env.locals.get(n);
    if (l) return this.narrow({ t: "local", name: n, type: l }, narrowed);
    const f = env.self?.fields.get(n);
    if (f) return this.narrow({ t: "field", name: n, type: f }, narrowed);
    const en = this.enumOf(expected);
    if (en) {
      const def = env.context.enums.find((e) => e.name === en);
      if (def?.values.includes(n)) return { t: "enumValue", enumName: en, value: n, type: { k: "enum", name: en } };
    }
    if (env.allowSelfGuards && env.self?.aggregate) {
      const g = env.self.aggregate.stateGuards.find((x) => x.name === n);
      if (g) return this.guardRef(node, env.self.aggregate, g, undefined, []);
    }
    if (env.allowPorts && (n === "clock" || n === "ids")) {
      return this.fail(node, n === "clock" ? 'Use "clock.now"' : 'Use "ids.new"');
    }
    if (n === "clock" || n === "now" || n === "today") {
      return this.fail(node, `"${n}" is not available here`, "Rules cannot read a hidden clock. Pass the time as a parameter (e.g. `at: DateTime`) and supply `clock.now` from the use case");
    }
    const enumsWith = env.context.enums.filter((e) => e.values.includes(n));
    const candidates = [...env.params.keys(), ...env.locals.keys(), ...(env.self?.fields.keys() ?? [])];
    const suggestion = closest(n, candidates);
    return this.fail(
      node,
      `Unknown name "${n}"`,
      enumsWith.length
        ? `"${n}" is a value of ${enumsWith.map((e) => e.name).join(", ")}; write ${enumsWith[0]!.name}.${n} or compare it with an enum-typed field`
        : suggestion
          ? `Did you mean "${suggestion}"?`
          : undefined,
    );
  }

  checkMember(node: Extract<Expr, { t: "member" }>, narrowed: Set<string>): TExpr | undefined {
    const env = this.env;
    // Enum type access: InvitationStatus.pending
    if (node.object.t === "name") {
      const objName = node.object.name;
      const shadowed = env.params.has(objName) || env.locals.has(objName) || env.self?.fields.has(objName);
      if (!shadowed) {
        const en = env.context.enums.find((e) => e.name === objName);
        if (en) {
          if (!en.values.includes(node.name)) {
            return this.fail(node, `${en.name} has no value "${node.name}"`, `Values: ${en.values.join(", ")}`);
          }
          return { t: "enumValue", enumName: en.name, value: node.name, type: { k: "enum", name: en.name } };
        }
        if (objName === "clock" || objName === "ids") {
          if (!env.allowPorts) {
            return this.fail(node, `"${objName}.${node.name}" is only available in use case steps`, "Pass the value into the rule as a parameter instead of reading it implicitly");
          }
          if (objName === "clock" && node.name === "now") return { t: "port", port: "clock", member: "now", type: T.DateTime };
          if (objName === "ids" && node.name === "new") return { t: "port", port: "ids", member: "new", type: T.UUID };
          return this.fail(node, `Unknown port member "${objName}.${node.name}"`, 'Available: "clock.now", "ids.new"');
        }
      }
    }
    const owner = this.check(node.object, narrowed);
    if (!owner) return undefined;
    if (owner.type.k === "optional") {
      return this.fail(node, `"${node.name}" is accessed on an optional value`, "Check it first, e.g. `x != null and x.y == ...`");
    }
    if (owner.type.k === "aggregate" && env.allowReceiverGuards) {
      const ag = env.context.aggregates.find((a) => a.name === (owner.type as { name: string }).name);
      const g = ag?.stateGuards.find((x) => x.name === node.name);
      if (ag && g) return this.guardRef(node, ag, g, owner, []);
    }
    const fields = this.fieldsOfType(owner.type);
    if (!fields) return this.fail(node, `${typeToString(owner.type)} has no fields`);
    const ft = fields.get(node.name);
    if (!ft) {
      const s = closest(node.name, [...fields.keys()]);
      return this.fail(node, `${typeToString(owner.type)} has no field "${node.name}"`, s ? `Did you mean "${s}"?` : undefined);
    }
    return this.narrow({ t: "field", name: node.name, owner, type: ft }, narrowed);
  }

  guardRef(node: Expr, aggregate: AggregateIR, guard: StateGuardIR, receiver: TExpr | undefined, argNodes: Expr[]): TExpr | undefined {
    const ctx = this.env.context;
    if (argNodes.length !== guard.parameters.length) {
      return this.fail(
        node,
        `State guard ${guard.name} takes ${guard.parameters.length} argument(s), got ${argNodes.length}`,
        guard.parameters.length ? `Signature: ${guard.name}(${guard.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")})` : undefined,
      );
    }
    const args: TExpr[] = [];
    let ok = true;
    guard.parameters.forEach((param, i) => {
      const r = resolveType(param.type, { context: ctx, aggregate: aggregate.name });
      if (!r.ok) {
        ok = false;
        return;
      }
      const a = this.check(argNodes[i]!, new Set(), r.type);
      if (!a) {
        ok = false;
        return;
      }
      if (!assignable(a.type, r.type)) {
        ok = false;
        this.fail(argNodes[i]!, `Argument "${param.name}" of ${guard.name} expects ${typeToString(r.type)}, got ${typeToString(a.type)}`);
        return;
      }
      args.push(a);
    });
    if (!ok) return undefined;
    return { t: "guard", aggregate: aggregate.name, guard: guard.name, receiver, args, type: BOOL };
  }

  checkCall(node: Extract<Expr, { t: "call" }>, narrowed: Set<string>): TExpr | undefined {
    const env = this.env;
    const callee = node.callee;
    if (callee.t === "name") {
      const name = callee.name;
      if (name === "is_empty" || name === "length") {
        if (node.args.length !== 1) return this.fail(node, `${name}() takes 1 argument`);
        const a = this.check(node.args[0]!, narrowed);
        if (!a) return undefined;
        const ok = a.type.k === "list" || (a.type.k === "primitive" && a.type.name === "String");
        if (!ok) return this.fail(node.args[0]!, `${name}() expects a String or List, got ${typeToString(a.type)}`);
        return { t: "builtin", fn: name, args: [a], type: name === "length" ? T.Integer : BOOL };
      }
      if (name === "contains") {
        if (node.args.length !== 2) return this.fail(node, "contains(collection, item) takes 2 arguments");
        const coll = this.check(node.args[0]!, narrowed);
        if (!coll) return undefined;
        const itemExpected = coll.type.k === "list" ? coll.type.item : coll.type;
        const item = this.check(node.args[1]!, narrowed, itemExpected);
        if (!item) return undefined;
        if (coll.type.k === "list") {
          if (!assignable(item.type, coll.type.item)) {
            return this.fail(node.args[1]!, `contains() item must be ${typeToString(coll.type.item)}, got ${typeToString(item.type)}`);
          }
        } else if (coll.type.k === "primitive" && coll.type.name === "String") {
          if (!sameType(item.type, T.String)) return this.fail(node.args[1]!, "contains() on a String expects a String item");
        } else {
          return this.fail(node.args[0]!, `contains() expects a List or String, got ${typeToString(coll.type)}`);
        }
        return { t: "builtin", fn: "contains", args: [coll, item], type: BOOL };
      }
      if (env.allowSelfGuards && env.self?.aggregate && !env.params.has(name) && !env.locals.has(name)) {
        const g = env.self.aggregate.stateGuards.find((x) => x.name === name);
        if (g) return this.guardRef(node, env.self.aggregate, g, undefined, node.args);
      }
      const ext = env.context.extensionPoints.find((x) => x.name === name);
      if (ext) {
        if (!env.allowExtensions) {
          return this.fail(node, `Extension point ${name} cannot be used here`, "Extension points are customer code and may only be used in use case conditions, not in domain rules");
        }
        if (node.args.length !== ext.parameters.length) return this.fail(node, `${name}() takes ${ext.parameters.length} argument(s)`);
        const args: TExpr[] = [];
        for (let i = 0; i < ext.parameters.length; i++) {
          const pt = resolveType(ext.parameters[i]!.type, { context: env.context });
          if (!pt.ok) return undefined;
          const a = this.check(node.args[i]!, narrowed, pt.type);
          if (!a) return undefined;
          if (!assignable(a.type, pt.type)) {
            return this.fail(node.args[i]!, `Argument "${ext.parameters[i]!.name}" of ${name} expects ${typeToString(pt.type)}, got ${typeToString(a.type)}`);
          }
          args.push(a);
        }
        const rt = resolveType(ext.returns, { context: env.context });
        if (!rt.ok) return undefined;
        return { t: "extension", name, args, type: rt.type };
      }
      const g = env.context.aggregates.flatMap((a) => a.stateGuards).find((x) => x.name === name);
      if (g) {
        return this.fail(node, `State guard ${name} cannot be called here`, env.allowReceiverGuards ? `Call it on a loaded aggregate, e.g. \`invitation.${name}(...)\`` : "Guards are only referenced from operation `require` lists or use case conditions");
      }
      return this.fail(node, `Unknown function "${name}"`, "Available functions: is_empty, contains, length");
    }
    if (callee.t === "member" && env.allowReceiverGuards) {
      const owner = this.check(callee.object, narrowed);
      if (!owner) return undefined;
      if (owner.type.k === "aggregate") {
        const ag = env.context.aggregates.find((a) => a.name === (owner.type as { name: string }).name)!;
        const g = ag.stateGuards.find((x) => x.name === callee.name);
        if (g) return this.guardRef(node, ag, g, owner, node.args);
        return this.fail(callee, `${ag.name} has no state guard "${callee.name}"`);
      }
    }
    return this.fail(node, "Only named functions and state guards can be called");
  }

  checkBinary(node: Extract<Expr, { t: "binary" }>, narrowed: Set<string>): TExpr | undefined {
    const { op } = node;
    if (op === "and" || op === "or") {
      const left = this.check(node.left, narrowed, BOOL);
      if (!left) return undefined;
      if (!sameType(left.type, BOOL)) return this.fail(node.left, `"${op}" requires Boolean operands, got ${typeToString(left.type)}`);
      const rightNarrowed = new Set(narrowed);
      for (const k of this.nullFacts(left, op === "and")) rightNarrowed.add(k);
      const right = this.check(node.right, rightNarrowed, BOOL);
      if (!right) return undefined;
      if (!sameType(right.type, BOOL)) return this.fail(node.right, `"${op}" requires Boolean operands, got ${typeToString(right.type)}`);
      return { t: "binary", op, left, right, type: BOOL };
    }

    // Null comparisons: x == null / x != null
    const leftIsNull = node.left.t === "lit" && node.left.kind === "null";
    const rightIsNull = node.right.t === "lit" && node.right.kind === "null";
    if (leftIsNull || rightIsNull) {
      if (op !== "==" && op !== "!=") return this.fail(node, `null can only be compared with "==" or "!="`);
      const operandNode = leftIsNull ? node.right : node.left;
      const operand = this.check(operandNode, new Set());
      if (!operand) return undefined;
      if (operand.type.k !== "optional") {
        return this.fail(operandNode, `${typeToString(operand.type)} is never null`, "Only optional fields (required: false) can be compared with null");
      }
      return { t: "isNull", negate: op === "!=", operand, type: BOOL };
    }

    // Contextual enum resolution: check the side that is not a bare name first.
    let left: TExpr | undefined;
    let right: TExpr | undefined;
    if (node.left.t === "name" && !this.isKnownName(node.left.name)) {
      right = this.check(node.right, narrowed);
      if (!right) return undefined;
      left = this.check(node.left, narrowed, right.type);
    } else {
      left = this.check(node.left, narrowed);
      if (!left) return undefined;
      right = this.check(node.right, narrowed, left.type);
    }
    if (!left || !right) return undefined;
    if (left.type.k === "optional" || right.type.k === "optional") {
      return this.fail(node, `Cannot compare optional value with "${op}"`, "Check for null first, e.g. `x != null and x " + op + " y`");
    }
    if (op === "==" || op === "!=") {
      const ok = sameType(left.type, right.type) || (isNumeric(left.type) && isNumeric(right.type));
      if (!ok) return this.fail(node, `Cannot compare ${typeToString(left.type)} with ${typeToString(right.type)}`);
      if (left.type.k === "list") return this.fail(node, "Lists cannot be compared with == / !=; use is_empty or contains");
    } else {
      const ok = (isNumeric(left.type) && isNumeric(right.type)) || (sameType(left.type, right.type) && isOrderable(left.type));
      if (!ok) return this.fail(node, `"${op}" is not defined for ${typeToString(left.type)} and ${typeToString(right.type)}`);
    }
    return { t: "binary", op, left, right, type: BOOL };
  }

  isKnownName(n: string): boolean {
    const env = this.env;
    return env.params.has(n) || env.locals.has(n) || !!env.self?.fields.has(n);
  }

  /** Keys proven non-null when `e` evaluates to `whenTrue`. */
  nullFacts(e: TExpr, whenTrue: boolean): string[] {
    if (e.t === "isNull") {
      const proven = whenTrue ? e.negate : !e.negate;
      const k = this.key(e.operand);
      return proven && k ? [k] : [];
    }
    if (e.t === "binary" && e.op === (whenTrue ? "and" : "or")) {
      return [...this.nullFacts(e.left, whenTrue), ...this.nullFacts(e.right, whenTrue)];
    }
    if (e.t === "not") return this.nullFacts(e.operand, !whenTrue);
    return [];
  }
}

/** Parses and type-checks an expression. `expected` enables contextual enum resolution and assignability checks. */
export function checkExpression(src: string, env: ExprEnv, expected?: Type): CheckResult {
  let ast: Expr;
  try {
    ast = parseExpr(src);
  } catch (e) {
    if (e instanceof ExprSyntaxError) {
      return { errors: [{ message: `Syntax error: ${e.message}`, start: e.offset, end: e.offset + 1 }], nodeCount: 0 };
    }
    throw e;
  }
  const c = new Checker(env);
  const expr = c.check(ast, new Set(), expected);
  if (expr && expected && !assignable(expr.type, expected)) {
    c.fail(ast, `Expected ${typeToString(expected)}, got ${typeToString(expr.type)}`);
    return { errors: c.errors, nodeCount: countNodes(ast) };
  }
  return { expr: c.errors.length ? undefined : expr, errors: c.errors, nodeCount: countNodes(ast) };
}

/** Collects the self-field names referenced by an expression (for rule traceability). */
export function referencedFields(e: TExpr, out = new Set<string>()): Set<string> {
  switch (e.t) {
    case "field":
      if (!e.owner) out.add(e.name);
      else referencedFields(e.owner, out);
      break;
    case "guard":
      if (e.receiver) referencedFields(e.receiver, out);
      e.args.forEach((a) => referencedFields(a, out));
      break;
    case "builtin":
    case "extension":
      e.args.forEach((a) => referencedFields(a, out));
      break;
    case "not":
      referencedFields(e.operand, out);
      break;
    case "binary":
      referencedFields(e.left, out);
      referencedFields(e.right, out);
      break;
    case "isNull":
      referencedFields(e.operand, out);
      break;
  }
  return out;
}
