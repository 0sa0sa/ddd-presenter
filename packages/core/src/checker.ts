import { countNodes, ExprSyntaxError, isArithOp, parseExpr, type ArithOp, type BinaryOp, type Expr, type NamedArg } from "./expr.ts";
import type { AggregateIR, ContextIR, StateGuardIR } from "./ir.ts";
import { assignable, closest, isNumeric, isOrderable, resolveType, sameType, T, typeToString, type Type } from "./types.ts";

/** Built-in rule functions. Also reserved: they cannot name extension points, parameters or use case variables. */
export const BUILTIN_FUNCTIONS = [
  "is_empty",
  "contains",
  "length",
  "days",
  "hours",
  "minutes",
  "round",
  "min",
  "max",
  "count",
  "sum",
  "any",
  "all",
  "append",
  "remove",
  "remove_where",
  "replace_where",
  "with",
] as const;
export type BuiltinFn = Exclude<(typeof BUILTIN_FUNCTIONS)[number], "with">;
/** Functions whose 2nd (and 3rd) argument is evaluated once per element, with the element bound to `item`. */
export const ITEM_FUNCTIONS = new Set<string>(["count", "sum", "any", "all", "remove_where", "replace_where"]);
/** Name of the current element inside the per-element arguments of collection functions. */
export const ITEM_NAME = "item";
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
  /**
   * Built-in function. For collection functions (`ITEM_FUNCTIONS`) `args[0]` is the list and the
   * following arguments are evaluated per element with the element bound to `item`.
   */
  | { t: "builtin"; fn: BuiltinFn; args: TExpr[] }
  | { t: "extension"; name: string; args: TExpr[] }
  | { t: "not"; operand: TExpr }
  /** Comparison / logic (type Boolean) or arithmetic (`+ - * /`, type = result type). */
  | { t: "binary"; op: BinaryOp; left: TExpr; right: TExpr }
  | { t: "neg"; operand: TExpr }
  | { t: "list"; items: TExpr[] }
  /** Value object / entity built from named fields: `Money(amount=x, currency="JPY")`. */
  | { t: "construct"; kind: "vo" | "entity"; name: string; fields: NamedValue[] }
  /** Copy of an entity with some fields changed (all invariants run on the copy): `with(item, quantity=q)`. */
  | { t: "with"; target: TExpr; fields: NamedValue[] }
  /** The current element inside a collection function; `depth` 0 is the outermost. */
  | { t: "item"; depth: number }
  | { t: "isNull"; negate: boolean; operand: TExpr }
  /** `principal.id`, `principal.roles` or a declared claim `principal.<claim>` (authorization rules only). */
  | { t: "principal"; member: string }
  /** `has_role(principal, admin)`: the principal holds a declared role. */
  | { t: "hasRole"; role: string }
);

/** What authorization rules (`allow_if`) may read about the caller (docs/09 §20). */
export interface PrincipalEnv {
  /** `principal.id`, `principal.roles` and the declared claims, with their types (optional claims wrapped). */
  members: Map<string, Type>;
  roles: string[];
}

/** A `field=value` argument; `fieldType` is the declared type of the field. */
export interface NamedValue {
  name: string;
  value: TExpr;
  fieldType: Type;
}

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
  /** Aggregate whose internal entities may be constructed (`OrderLine(...)`). Defaults to `self.aggregate`. */
  scopeAggregate?: string;
  /** Allow `principal.*` and `has_role(principal, role)` (authorization rules). */
  principal?: PrincipalEnv;
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
  /** Element types of the enclosing collection functions (innermost last). */
  readonly items: Type[] = [];
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
    if (e.t === "item") return `item.${e.depth}`;
    if (e.t === "principal") return `principal.${e.member}`;
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
        return this.checkCall(node, narrowed, expected);
      case "not": {
        const operand = this.check(node.operand, narrowed, BOOL);
        if (!operand) return undefined;
        if (!sameType(operand.type, BOOL)) return this.fail(node.operand, `"not" requires a Boolean, got ${typeToString(operand.type)}`);
        return { t: "not", operand, type: BOOL };
      }
      case "binary":
        return isArithOp(node.op) ? this.checkArith(node, narrowed) : this.checkBinary(node, narrowed);
      case "neg": {
        const operand = this.check(node.operand, narrowed);
        if (!operand) return undefined;
        if (operand.type.k === "optional") return this.fail(node.operand, "Cannot negate an optional value", "Check for null first, e.g. `x != null and -x < y`");
        if (!isNumeric(operand.type) && operand.type.k !== "duration") {
          return this.fail(node, `Unary "-" is not defined for ${typeToString(operand.type)}`, "Only Integer, Decimal and Duration values can be negated");
        }
        return { t: "neg", operand, type: operand.type };
      }
      case "list":
        return this.checkList(node, narrowed, expected);
    }
  }

  checkList(node: Extract<Expr, { t: "list" }>, narrowed: Set<string>, expected?: Type): TExpr | undefined {
    const target = expected?.k === "optional" ? expected.inner : expected;
    const expectedItem = target?.k === "list" ? target.item : undefined;
    if (node.items.length === 0) {
      if (!expectedItem) {
        return this.fail(node, "The item type of [] is unknown here", "Use [] where a List is expected: a List field in fields/changes, an argument of a List parameter, or append([], x)");
      }
      return { t: "list", items: [], type: { k: "list", item: expectedItem } };
    }
    const items: TExpr[] = [];
    for (const n of node.items) {
      const it = this.check(n, narrowed, expectedItem ?? items[0]?.type);
      if (!it) return undefined;
      items.push(it);
    }
    let itemType = expectedItem;
    if (!itemType) {
      itemType = items[0]!.type;
      // Integer and Decimal items make a List[Decimal].
      if (items.every((i) => isNumeric(i.type)) && items.some((i) => sameType(i.type, T.Decimal))) itemType = T.Decimal;
    }
    if (itemType.k === "optional" || itemType.k === "null") return this.fail(node, "Lists cannot contain null");
    for (const [i, it] of items.entries()) {
      if (!assignable(it.type, itemType)) {
        return this.fail(node.items[i]!, `List items must be ${typeToString(itemType)}, got ${typeToString(it.type)}`);
      }
    }
    return { t: "list", items, type: { k: "list", item: itemType } };
  }

  /** Result type of `left op right`, or an error with a hint. */
  arithType(op: ArithOp, l: TExpr, r: TExpr): Type | { message: string; hint?: string } {
    const lt = l.type;
    const rt = r.type;
    const isDur = (t: Type) => t.k === "duration";
    const prim = (t: Type, n: string) => t.k === "primitive" && t.name === n;
    if (isNumeric(lt) && isNumeric(rt)) {
      if (op === "/") return T.Decimal;
      return prim(lt, "Decimal") || prim(rt, "Decimal") ? T.Decimal : T.Integer;
    }
    const isDays = (e: TExpr) => e.t === "builtin" && e.fn === "days";
    if (op === "+" || op === "-") {
      if (prim(lt, "DateTime") && isDur(rt)) return T.DateTime;
      if (op === "+" && isDur(lt) && prim(rt, "DateTime")) return T.DateTime;
      if (op === "-" && prim(lt, "DateTime") && prim(rt, "DateTime")) return T.Duration;
      if (op === "-" && prim(lt, "Date") && prim(rt, "Date")) return T.Duration;
      if ((prim(lt, "Date") && isDur(rt)) || (op === "+" && isDur(lt) && prim(rt, "Date"))) {
        if (isDays(prim(lt, "Date") ? r : l)) return T.Date;
        return { message: "Only whole days can be added to or subtracted from a Date", hint: "Write the duration directly as days(n), e.g. due_on + days(30); use a DateTime for hours and minutes" };
      }
      if (isDur(lt) && isDur(rt)) return T.Duration;
    }
    if (op === "*") {
      if (isDur(lt) && prim(rt, "Integer")) return T.Duration;
      if (prim(lt, "Integer") && isDur(rt)) return T.Duration;
      if ((isDur(lt) && isNumeric(rt)) || (isNumeric(lt) && isDur(rt))) return { message: "A Duration can only be multiplied by an Integer" };
    }
    const message = `"${op}" is not defined for ${typeToString(lt)} and ${typeToString(rt)}`;
    for (const t of [lt, rt]) {
      if (t.k === "vo") {
        const fields = this.fieldsOfType(t) ?? new Map<string, Type>();
        const numeric = [...fields].filter(([, ft]) => isNumeric(ft)).map(([n]) => n);
        return {
          message,
          hint: `${t.name} is a value object: compute with its ${numeric.length ? `numeric field (e.g. .${numeric[0]})` : "fields"} and build a new value with ${t.name}(${[...fields.keys()].map((f) => `${f}=...`).join(", ")})`,
        };
      }
    }
    if (prim(lt, "String") || prim(rt, "String")) return { message, hint: "Strings cannot be concatenated or used in arithmetic in rules" };
    if ([lt, rt].some((t) => prim(t, "DateTime") || prim(t, "Date"))) {
      return { message, hint: "Add or subtract a Duration: days(n), hours(n) or minutes(n). DateTime - DateTime gives a Duration" };
    }
    if (isDur(lt) || isDur(rt)) return { message, hint: "Durations can be added to each other or to a DateTime, and multiplied by an Integer" };
    return { message, hint: "Arithmetic works on Integer and Decimal values, DateTime/Date and Duration" };
  }

  checkArith(node: Extract<Expr, { t: "binary" }>, narrowed: Set<string>): TExpr | undefined {
    const op = node.op as ArithOp;
    const left = this.check(node.left, narrowed);
    const right = this.check(node.right, narrowed);
    if (!left || !right) return undefined;
    for (const [side, n] of [
      [left, node.left],
      [right, node.right],
    ] as const) {
      if (side.type.k === "optional") {
        return this.fail(n, `Cannot compute "${op}" with an optional value`, "Check for null first, e.g. `x != null and x + 1 > y`");
      }
    }
    const r = this.arithType(op, left, right);
    if ("message" in r) return this.fail(node, r.message, r.hint);
    return { t: "binary", op, left, right, type: r };
  }

  checkName(node: Extract<Expr, { t: "name" }>, narrowed: Set<string>, expected?: Type): TExpr | undefined {
    const env = this.env;
    const n = node.name;
    if (n === ITEM_NAME && this.items.length) {
      if (this.isKnownName(n, false)) {
        return this.fail(node, `"${ITEM_NAME}" is the current element here and hides the parameter, variable or field "${ITEM_NAME}"`, `Rename "${ITEM_NAME}" outside; inside collection functions "${ITEM_NAME}" always means the element`);
      }
      const depth = this.items.length - 1;
      return this.narrow({ t: "item", depth, type: this.items[depth]! }, narrowed);
    }
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
    if (n === "principal" && env.principal) {
      const claims = [...env.principal.members.keys()].filter((k) => k !== "id" && k !== "roles");
      return this.fail(node, '"principal" is read through its members', `Use principal.id, principal.roles${claims.map((k) => `, principal.${k}`).join("")} or has_role(principal, ${env.principal.roles[0] ?? "role"})`);
    }
    if (n === "principal") {
      return this.fail(node, '"principal" is only available in authorization rules (allow_if)', "Declare security and use it in a use case's or aggregate's authorize.allow_if");
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
    if (n === ITEM_NAME) {
      return this.fail(node, `"${ITEM_NAME}" is only available inside collection functions`, "e.g. any(lines, item.line_id == line_id), sum(lines, item.quantity)");
    }
    if (env.context.valueObjects.some((v) => v.name === n) || env.context.aggregates.some((a) => a.entities.some((e) => e.name === n))) {
      return this.fail(node, `${n} is a type; build a value with named fields, e.g. ${n}(field=...)`);
    }
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
        if (objName === "principal" && env.principal) {
          const t = env.principal.members.get(node.name);
          if (!t) {
            const s = closest(node.name, [...env.principal.members.keys()]);
            return this.fail(node, `The principal has no member "${node.name}"`, s ? `Did you mean "${s}"?` : `Members: ${[...env.principal.members.keys()].join(", ")} (declare more under security.principal.claims)`);
          }
          return this.narrow({ t: "principal", member: node.name, type: t }, narrowed);
        }
        if (objName === "principal") {
          return this.fail(node, '"principal" is only available in authorization rules (allow_if)', "Declare security and use it in a use case's or aggregate's authorize.allow_if");
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

  checkCall(node: Extract<Expr, { t: "call" }>, narrowed: Set<string>, expected?: Type): TExpr | undefined {
    const env = this.env;
    const callee = node.callee;
    if (callee.t === "name") {
      const name = callee.name;
      const isType = (n: string) =>
        env.context.valueObjects.some((v) => v.name === n) ||
        env.context.aggregates.some((a) => a.name === n || a.entities.some((e) => e.name === n)) ||
        env.context.enums.some((e) => e.name === n);
      if (isType(name)) return this.checkConstruct(node, name, narrowed);
      if (name === "with") return this.checkWith(node, narrowed);
      if (name === "has_role" && env.principal && !node.named) return this.checkHasRole(node, env.principal);
      if (node.named) {
        return this.fail(node, `${name}() does not take named arguments`, "Named arguments (field=value) are for building values: Money(amount=1, currency=\"JPY\") and with(entity, field=value)");
      }
      const more = this.checkMoreBuiltins(node, name, narrowed, expected);
      if (more !== false) return more;
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
      const s = closest(name, BUILTIN_FUNCTIONS);
      return this.fail(node, `Unknown function "${name}"`, s ? `Did you mean "${s}"?` : `Available functions: ${BUILTIN_FUNCTIONS.join(", ")}`);
    }
    if (node.named) return this.fail(node, "Named arguments (field=value) are only for building values, e.g. Money(amount=1, currency=\"JPY\")");
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

  /** `has_role(principal, admin)` or `has_role(principal, "admin")`: the role must be declared under security.roles. */
  checkHasRole(node: Extract<Expr, { t: "call" }>, principal: PrincipalEnv): TExpr | undefined {
    const usage = `has_role(principal, ${principal.roles[0] ?? "role"})`;
    const [who, role] = node.args;
    if (node.args.length !== 2 || !who || !role) return this.fail(node, "has_role() takes 2 arguments", `Usage: ${usage}`);
    if (who.t !== "name" || who.name !== "principal") return this.fail(who, 'The first argument of has_role() is "principal"', `Usage: ${usage}`);
    const name = role.t === "name" ? role.name : role.t === "lit" && role.kind === "string" ? String(role.value) : undefined;
    if (name === undefined) return this.fail(role, "The role of has_role() is a declared role name", `Usage: ${usage}`);
    if (!principal.roles.includes(name)) {
      const s = closest(name, principal.roles);
      return this.fail(role, `Unknown role "${name}"`, s ? `Did you mean "${s}"?` : `Declared roles: ${principal.roles.join(", ")}`);
    }
    return { t: "hasRole", role: name, type: BOOL };
  }

  /** Checks `field=value` arguments against a field map (used by constructors and `with`). */
  namedFields(owner: string, named: NamedArg[], fields: Map<string, Type>, narrowed: Set<string>): NamedValue[] | undefined {
    const out: NamedValue[] = [];
    let ok = true;
    for (const a of named) {
      const ft = fields.get(a.name);
      if (!ft) {
        const s = closest(a.name, [...fields.keys()]);
        this.errors.push({ message: `${owner} has no field "${a.name}"`, hint: s ? `Did you mean "${s}"?` : `Fields: ${[...fields.keys()].join(", ")}`, start: a.start, end: a.end });
        ok = false;
        continue;
      }
      const v = this.check(a.value, narrowed, ft);
      if (!v) {
        ok = false;
        continue;
      }
      if (!assignable(v.type, ft)) {
        this.fail(a.value, `Field "${a.name}" of ${owner} is ${typeToString(ft)}, got ${typeToString(v.type)}`);
        ok = false;
        continue;
      }
      out.push({ name: a.name, value: v, fieldType: ft });
    }
    return ok ? out : undefined;
  }

  checkConstruct(node: Extract<Expr, { t: "call" }>, name: string, narrowed: Set<string>): TExpr | undefined {
    const ctx = this.env.context;
    const sig = (fields: Map<string, Type>) => `${name}(${[...fields.keys()].map((f) => `${f}=...`).join(", ")})`;
    if (ctx.enums.some((e) => e.name === name)) return this.fail(node, `${name} is an enum; write a value such as ${name}.${ctx.enums.find((e) => e.name === name)!.values[0] ?? "value"}`);
    if (ctx.aggregates.some((a) => a.name === name)) {
      return this.fail(node, `Aggregate ${name} cannot be constructed in an expression`, "Aggregates are created by their factories (a create step in a use case)");
    }
    let kind: "vo" | "entity";
    let type: Type;
    const owner = ctx.aggregates.find((a) => a.entities.some((e) => e.name === name));
    if (owner) {
      const scope = this.env.scopeAggregate ?? this.env.self?.aggregate?.name;
      if (scope !== owner.name) {
        return this.fail(
          node,
          `Entity ${name} belongs to aggregate ${owner.name} and can only be constructed inside ${owner.name}'s factories and operations`,
          `Give the operation the entity's fields as parameters and build it in changes, e.g. ${toFieldName(name)}s: append(${toFieldName(name)}s, ${name}(...))`,
        );
      }
      kind = "entity";
      type = { k: "entity", name, aggregate: owner.name };
    } else {
      kind = "vo";
      type = { k: "vo", name };
    }
    const fields = this.fieldsOfType(type) ?? new Map<string, Type>();
    if (node.args.length) return this.fail(node, `Write the fields of ${name} by name`, `e.g. ${sig(fields)}`);
    const named = node.named ?? [];
    const values = this.namedFields(name, named, fields, narrowed);
    if (!values) return undefined;
    const missing = [...fields].filter(([f, t]) => t.k !== "optional" && !named.some((a) => a.name === f)).map(([f]) => f);
    if (missing.length) return this.fail(node, `Missing field${missing.length > 1 ? "s" : ""} ${missing.join(", ")} for ${name}`, `e.g. ${sig(fields)}`);
    // Keep the declaration order so the generated code is stable.
    const order = [...fields.keys()];
    values.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    return { t: "construct", kind, name, fields: values, type };
  }

  checkWith(node: Extract<Expr, { t: "call" }>, narrowed: Set<string>): TExpr | undefined {
    if (node.args.length !== 1 || !node.named?.length) {
      return this.fail(node, "with(entity, field=value, ...) takes one entity and at least one named field", "e.g. with(item, quantity=quantity)");
    }
    const target = this.check(node.args[0]!, narrowed);
    if (!target) return undefined;
    const t = target.type;
    if (t.k === "optional") return this.fail(node.args[0]!, "with() is applied to an optional value", "Check it for null first");
    if (t.k === "vo") {
      const fields = this.fieldsOfType(t) ?? new Map<string, Type>();
      return this.fail(node, "with() copies entities; build a new value object instead", `e.g. ${t.name}(${[...fields.keys()].map((f) => `${f}=...`).join(", ")})`);
    }
    if (t.k === "aggregate") return this.fail(node, "Aggregates change through their operations, not with()");
    if (t.k !== "entity") return this.fail(node.args[0]!, `with() expects an entity, got ${typeToString(t)}`);
    const ag = this.env.context.aggregates.find((a) => a.name === t.aggregate);
    const en = ag?.entities.find((e) => e.name === t.name);
    const scope = this.env.scopeAggregate ?? this.env.self?.aggregate?.name;
    if (scope !== t.aggregate) {
      return this.fail(node, `Entity ${t.name} can only be changed inside ${t.aggregate}'s operations`, `Invoke an operation of ${t.aggregate} instead`);
    }
    const idArg = node.named.find((a) => a.name === en?.identity);
    if (idArg) return this.fail(node, `with() must not change the identity field "${idArg.name}" of ${t.name}`, "Build a new entity instead");
    const fields = this.fieldsOfType(t) ?? new Map<string, Type>();
    const values = this.namedFields(t.name, node.named, fields, narrowed);
    if (!values) return undefined;
    const order = [...fields.keys()];
    values.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    return { t: "with", target, fields: values, type: t };
  }

  /** Time, number and collection functions. Returns `false` when `name` is not one of them. */
  checkMoreBuiltins(node: Extract<Expr, { t: "call" }>, name: string, narrowed: Set<string>, expected?: Type): TExpr | undefined | false {
    const args = node.args;
    const arity = (min: number, max: number, usage: string): boolean => {
      if (args.length < min || args.length > max) {
        this.fail(node, `${name}() takes ${min === max ? min : `${min} or ${max}`} argument${max === 1 ? "" : "s"}`, `Usage: ${usage}`);
        return false;
      }
      return true;
    };
    const nonOptional = (e: TExpr, n: Expr): boolean => {
      if (e.type.k !== "optional") return true;
      this.fail(n, `${name}() is given an optional value`, "Check for null first, e.g. `x != null and ...`");
      return false;
    };
    switch (name) {
      case "days":
      case "hours":
      case "minutes": {
        if (!arity(1, 1, `${name}(n: Integer)`)) return undefined;
        const a = this.check(args[0]!, narrowed, T.Integer);
        if (!a || !nonOptional(a, args[0]!)) return undefined;
        if (!sameType(a.type, T.Integer)) return this.fail(args[0]!, `${name}() expects an Integer, got ${typeToString(a.type)}`, "Durations are built from whole numbers of minutes, hours or days");
        return { t: "builtin", fn: name, args: [a], type: T.Duration };
      }
      case "round": {
        if (!arity(2, 2, "round(x: Integer | Decimal, places)")) return undefined;
        const x = this.check(args[0]!, narrowed);
        if (!x || !nonOptional(x, args[0]!)) return undefined;
        if (!isNumeric(x.type)) return this.fail(args[0]!, `round() expects a number, got ${typeToString(x.type)}`);
        const p = args[1]!;
        if (!(p.t === "lit" && p.kind === "integer" && (p.value as number) >= 0 && (p.value as number) <= 28)) {
          return this.fail(p, "round() takes the number of decimal places as an integer literal (0-28)", "e.g. round(price * rate, 2)");
        }
        return { t: "builtin", fn: "round", args: [x, { t: "lit", value: p.value, kind: "integer", type: T.Integer }], type: T.Decimal };
      }
      case "min":
      case "max": {
        if (!arity(2, 2, `${name}(a, b)`)) return undefined;
        const a = this.check(args[0]!, narrowed);
        const b = this.check(args[1]!, narrowed);
        if (!a || !b || !nonOptional(a, args[0]!) || !nonOptional(b, args[1]!)) return undefined;
        let type: Type | undefined;
        if (isNumeric(a.type) && isNumeric(b.type)) type = sameType(a.type, T.Decimal) || sameType(b.type, T.Decimal) ? T.Decimal : T.Integer;
        else if (sameType(a.type, b.type) && isOrderable(a.type) && !sameType(a.type, T.String)) type = a.type;
        if (!type) return this.fail(node, `${name}() is not defined for ${typeToString(a.type)} and ${typeToString(b.type)}`, "Both arguments must be numbers, or both DateTime, Date or Duration");
        return { t: "builtin", fn: name, args: [a, b], type };
      }
      case "count":
      case "sum":
      case "any":
      case "all":
      case "append":
      case "remove":
      case "remove_where":
      case "replace_where":
        return this.checkCollection(node, name, narrowed, expected);
    }
    return false;
  }

  checkCollection(node: Extract<Expr, { t: "call" }>, name: BuiltinFn, narrowed: Set<string>, expected?: Type): TExpr | undefined {
    const args = node.args;
    const usage: Record<string, [number, number, string]> = {
      count: [1, 2, "count(list) or count(list, <condition on item>)"],
      sum: [1, 2, "sum(list_of_numbers) or sum(list, <number from item>)"],
      any: [2, 2, "any(list, <condition on item>)"],
      all: [2, 2, "all(list, <condition on item>)"],
      append: [2, 2, "append(list, new_item)"],
      remove: [2, 2, "remove(list, existing_item)"],
      remove_where: [2, 2, "remove_where(list, <condition on item>)"],
      replace_where: [3, 3, "replace_where(list, <condition on item>, <new item>)"],
    };
    const [min, max, use] = usage[name]!;
    if (args.length < min || args.length > max) {
      return this.fail(node, `${name}() takes ${min === max ? min : `${min} or ${max}`} arguments`, `Usage: ${use}`);
    }
    const returnsList = name === "append" || name === "remove" || name === "remove_where" || name === "replace_where";
    let listExpected = returnsList ? expected : undefined;
    // append([], x): the empty list takes the type of x.
    if (name === "append" && listExpected === undefined && args[0]!.t === "list" && args[0]!.items.length === 0) {
      const probe = new Checker(this.env);
      probe.items.push(...this.items);
      const x = probe.check(args[1]!, narrowed);
      if (x && x.type.k !== "optional" && x.type.k !== "null") listExpected = { k: "list", item: x.type };
    }
    const list = this.check(args[0]!, narrowed, listExpected);
    if (!list) return undefined;
    if (list.type.k !== "list") {
      return this.fail(args[0]!, `${name}() expects a List as its first argument, got ${typeToString(list.type)}`, `Usage: ${use}`);
    }
    const listType = list.type;
    const itemType = listType.item;
    /** Checks a per-element argument with `item` bound to the element. */
    const perItem = (n: Expr, exp?: Type): TExpr | undefined => {
      this.items.push(itemType);
      try {
        return this.check(n, new Set(narrowed), exp);
      } finally {
        this.items.pop();
      }
    };
    const condition = (n: Expr): TExpr | undefined => {
      const c = perItem(n, BOOL);
      if (!c) return undefined;
      if (!sameType(c.type, BOOL)) {
        return this.fail(n, `The condition of ${name}() must be Boolean, got ${typeToString(c.type)}`, `Compare a field of the element, e.g. ${ITEM_NAME}.id == id`);
      }
      return c;
    };
    switch (name) {
      case "count": {
        if (args.length === 1) return { t: "builtin", fn: "count", args: [list], type: T.Integer };
        const c = condition(args[1]!);
        return c && { t: "builtin", fn: "count", args: [list, c], type: T.Integer };
      }
      case "sum": {
        const value = args.length === 2 ? perItem(args[1]!) : undefined;
        if (args.length === 2 && !value) return undefined;
        const t = value ? value.type : itemType;
        if (!isNumeric(t) && t.k !== "duration") {
          return this.fail(
            args.length === 2 ? args[1]! : args[0]!,
            `sum() adds numbers, got ${typeToString(t)}`,
            args.length === 2 ? `Pick a numeric field of the element, e.g. ${ITEM_NAME}.quantity` : `Name the number to add: sum(${"list"}, ${ITEM_NAME}.<numeric field>)`,
          );
        }
        return { t: "builtin", fn: "sum", args: value ? [list, value] : [list], type: t };
      }
      case "any":
      case "all": {
        const c = condition(args[1]!);
        return c && { t: "builtin", fn: name, args: [list, c], type: BOOL };
      }
      case "append":
      case "remove": {
        const x = this.check(args[1]!, narrowed, itemType);
        if (!x) return undefined;
        if (!assignable(x.type, itemType)) return this.fail(args[1]!, `${name}() item must be ${typeToString(itemType)}, got ${typeToString(x.type)}`);
        return { t: "builtin", fn: name, args: [list, x], type: listType };
      }
      case "remove_where": {
        const c = condition(args[1]!);
        return c && { t: "builtin", fn: "remove_where", args: [list, c], type: listType };
      }
      case "replace_where": {
        const c = condition(args[1]!);
        if (!c) return undefined;
        const x = perItem(args[2]!, itemType);
        if (!x) return undefined;
        if (!assignable(x.type, itemType)) return this.fail(args[2]!, `The replacement must be ${typeToString(itemType)}, got ${typeToString(x.type)}`, `e.g. with(${ITEM_NAME}, quantity=quantity)`);
        return { t: "builtin", fn: "replace_where", args: [list, c, x], type: listType };
      }
    }
    return undefined;
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

  isKnownName(n: string, withItem = true): boolean {
    const env = this.env;
    if (withItem && n === ITEM_NAME && this.items.length) return true;
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
  if (e.t === "field" && !e.owner) out.add(e.name);
  for (const c of exprChildren(e)) referencedFields(c, out);
  return out;
}

/** Direct sub-expressions of a typed expression (for generic walks). */
export function exprChildren(e: TExpr): TExpr[] {
  switch (e.t) {
    case "field":
      return e.owner ? [e.owner] : [];
    case "guard":
      return [...(e.receiver ? [e.receiver] : []), ...e.args];
    case "builtin":
    case "extension":
      return e.args;
    case "not":
    case "neg":
    case "isNull":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "list":
      return e.items;
    case "construct":
      return e.fields.map((f) => f.value);
    case "with":
      return [e.target, ...e.fields.map((f) => f.value)];
    case "lit":
    case "param":
    case "local":
    case "enumValue":
    case "port":
    case "item":
    case "principal":
    case "hasRole":
      return [];
  }
}

function toFieldName(typeName: string): string {
  return typeName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
