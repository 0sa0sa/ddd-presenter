import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkExpression, makeEnv, parseExpr, parseModel, resolveType, T, typeToString, validateModelText, type ExprEnv, type Type } from "../src/index.ts";

/** Order / OrderLine / Money model shared with the generator's Python-run test. */
const ORDERING = readFileSync(join(import.meta.dir, "../../generator/test/fixtures/ordering.ddd.yaml"), "utf8");
const ctx = parseModel(ORDERING).model!.contexts[0]!;
const order = ctx.aggregates.find((a) => a.name === "Order")!;

function fields(): Map<string, Type> {
  const m = new Map<string, Type>();
  for (const f of order.fields) {
    const r = resolveType(f.type, { context: ctx, aggregate: order.name });
    if (r.ok) m.set(f.name, f.required ? r.type : { k: "optional", inner: r.type });
  }
  return m;
}

/** Inside Order (like an operation's `changes`), with the given parameters. */
function inOrder(params: Record<string, Type> = {}): ExprEnv {
  return makeEnv(ctx, { self: { name: "Order", fields: fields(), aggregate: order }, params: new Map(Object.entries(params)) });
}

const typeOf = (src: string, env = inOrder(), expected?: Type) => {
  const r = checkExpression(src, env, expected);
  if (!r.expr) throw new Error(`${src}: ${JSON.stringify(r.errors)}`);
  return typeToString(r.expr.type);
};
const errors = (src: string, env = inOrder(), expected?: Type) => checkExpression(src, env, expected).errors;
const firstError = (src: string, env = inOrder(), expected?: Type) => errors(src, env, expected)[0];

describe("parser", () => {
  test("arithmetic binds tighter than comparison, * / tighter than + -, unary minus tightest", () => {
    const e = parseExpr("a + b * c > -d - 1");
    expect(e.t).toBe("binary");
    const cmp = e as Extract<typeof e, { t: "binary" }>;
    expect(cmp.op).toBe(">");
    expect((cmp.left as { op: string }).op).toBe("+");
    expect(((cmp.left as { right: { op: string } }).right).op).toBe("*");
    expect((cmp.right as { op: string; left: { t: string } }).left.t).toBe("neg");
  });

  test("negative numbers stay literals; lists and named arguments parse", () => {
    expect(parseExpr("-1.5")).toMatchObject({ t: "lit", value: "-1.5", kind: "decimal" });
    expect(parseExpr("[]")).toMatchObject({ t: "list", items: [] });
    expect(parseExpr("Money(amount=1, currency='USD')")).toMatchObject({ t: "call", named: [{ name: "amount" }, { name: "currency" }] });
  });

  test("assignment and misplaced named arguments are syntax errors", () => {
    expect(() => parseExpr("a = 1")).toThrow('Use "=="');
    expect(() => parseExpr("f(a=1, 2)")).toThrow("Positional arguments must come before named arguments");
    expect(() => parseExpr("f(a=1, a=2)")).toThrow("Duplicate argument");
  });
});

describe("arithmetic", () => {
  test("Integer and Decimal results; / always gives Decimal", () => {
    expect(typeOf("1 + 2")).toBe("Integer");
    expect(typeOf("discount * 2")).toBe("Decimal");
    expect(typeOf("count(lines) / 2")).toBe("Decimal");
    expect(typeOf("-discount")).toBe("Decimal");
    expect(typeOf("round(discount * 1.1, 2)")).toBe("Decimal");
    expect(typeOf("min(1, 2)")).toBe("Integer");
    expect(typeOf("max(discount, 0)")).toBe("Decimal");
    expect(errors("discount - refunded >= 0", inOrder(), T.Boolean)).toEqual([]);
  });

  test("clear diagnostics for value objects, strings and optionals", () => {
    const money = firstError("unit_price + 1", inOrder({ unit_price: { k: "vo", name: "Money" } }))!;
    expect(money.message).toBe('"+" is not defined for Money and Integer');
    expect(money.hint).toContain("compute with its numeric field (e.g. .amount)");
    expect(money.hint).toContain("Money(amount=..., currency=...)");
    expect(firstError("currency + 1")!.hint).toContain("Strings cannot be concatenated");
    expect(firstError("placed_at + hours(1) > placed_at")!.message).toContain("optional value");
    expect(errors("placed_at != null and placed_at + hours(1) > placed_at", inOrder(), T.Boolean)).toEqual([]);
    expect(firstError("round(discount, places)", inOrder({ places: T.Integer }))!.message).toContain("integer literal");
  });
});

describe("time", () => {
  const at = { at: T.DateTime, on: T.Date, today: T.Date };
  test("DateTime ± Duration, DateTime - DateTime, Date ± days(n)", () => {
    expect(typeOf("at + hours(24)", inOrder(at))).toBe("DateTime");
    expect(typeOf("days(7) + at", inOrder(at))).toBe("DateTime");
    expect(typeOf("at - minutes(90)", inOrder(at))).toBe("DateTime");
    expect(typeOf("at - at", inOrder(at))).toBe("Duration");
    expect(typeOf("hours(1) * 3 + minutes(5)", inOrder(at))).toBe("Duration");
    expect(typeOf("today + days(14)", inOrder(at))).toBe("Date");
    expect(typeOf("on - today", inOrder(at))).toBe("Duration");
    expect(errors("at - at < hours(24)", inOrder(at), T.Boolean)).toEqual([]);
  });

  test("rejects mixing units and non-integer durations", () => {
    expect(firstError("today + hours(3)", inOrder(at))!.message).toBe("Only whole days can be added to or subtracted from a Date");
    expect(firstError("at + 1", inOrder(at))!.hint).toContain("days(n), hours(n) or minutes(n)");
    expect(firstError("hours(1.5)", inOrder(at))!.message).toBe("hours() expects an Integer, got Decimal");
    expect(firstError("hours(1) * 1.5", inOrder(at))!.message).toBe("A Duration can only be multiplied by an Integer");
    expect(firstError("at - today", inOrder(at))!.message).toBe('"-" is not defined for DateTime and Date');
  });

  test("Duration cannot be declared as a field type", () => {
    const r = resolveType("Duration", { context: ctx });
    expect(r.ok).toBe(false);
  });
});

describe("collections", () => {
  test("element functions bind item and are typed", () => {
    expect(typeOf("sum(lines, item.unit_price.amount * item.quantity)")).toBe("Decimal");
    expect(typeOf("sum(lines, item.quantity)")).toBe("Integer");
    expect(typeOf("count(lines, item.quantity > 1)")).toBe("Integer");
    expect(typeOf("any(lines, item.line_id == 3) or all(lines, item.quantity < 10)")).toBe("Boolean");
    expect(typeOf("remove_where(lines, item.line_id == 1)")).toBe("List[OrderLine]");
    expect(typeOf("replace_where(lines, item.line_id == 1, with(item, quantity=2))")).toBe("List[OrderLine]");
    expect(typeOf("sum([1, 2.5])")).toBe("Decimal");
  });

  test("[] takes its type from the context", () => {
    expect(typeOf("[]", inOrder(), { k: "list", item: { k: "entity", name: "OrderLine", aggregate: "Order" } })).toBe("List[OrderLine]");
    expect(firstError("[]")!.message).toBe("The item type of [] is unknown here");
    expect(typeOf("length(append([], 1))", inOrder(), T.Integer)).toBe("Integer");
  });

  test("diagnostics name the misuse", () => {
    expect(firstError("item.quantity > 1")!.message).toContain("only available inside collection functions");
    expect(firstError("sum(lines, item.sku)")!.message).toBe("sum() adds numbers, got String");
    expect(firstError("any(lines, item.quantity)")!.message).toBe("The condition of any() must be Boolean, got Integer");
    expect(firstError("count(currency)")!.message).toBe("count() expects a List as its first argument, got String");
    expect(firstError("any(lines, item.line_id == item_id)", inOrder({ item_id: T.Integer }))).toBeUndefined();
    expect(firstError("any(lines, item.line_id == 1 and item == 2)", inOrder({ item: T.Integer }))!.message).toContain("hides the parameter");
    expect(firstError("sumx(lines)")!.hint).toBe('Did you mean "sum"?');
  });
});

describe("constructors and with()", () => {
  const p = { line_id: T.Integer, sku: T.String, quantity: T.Integer, unit_price: { k: "vo", name: "Money" } as Type };
  test("value objects anywhere, entities inside their aggregate", () => {
    expect(typeOf("Money(amount=1, currency='USD')")).toBe("Money");
    expect(typeOf("append(lines, OrderLine(line_id=line_id, sku=sku, quantity=quantity, unit_price=unit_price))", inOrder(p))).toBe("List[OrderLine]");
    const useCase = makeEnv(ctx, { locals: new Map([["n", T.Integer]]), allowPorts: true });
    expect(typeOf("Money(amount=n, currency='USD')", useCase)).toBe("Money");
    const err = firstError("OrderLine(line_id=n, sku='a', quantity=1, unit_price=Money(amount=1, currency='USD'))", useCase)!;
    expect(err.message).toBe("Entity OrderLine belongs to aggregate Order and can only be constructed inside Order's factories and operations");
    expect(err.hint).toContain("build it in changes");
  });

  test("fields are checked by name", () => {
    expect(firstError("Money(amount=1)")!.message).toBe("Missing field currency for Money");
    expect(firstError("Money(amount=1, currency='USD', cents=1)")!.message).toBe('Money has no field "cents"');
    expect(firstError("Money(amount='x', currency='USD')")!.message).toBe('Field "amount" of Money is Decimal, got String');
    expect(firstError("Money(1, 'USD')")!.message).toBe("Write the fields of Money by name");
    expect(firstError("Order(id=id)")!.message).toContain("cannot be constructed");
  });

  test("with() copies entities only and keeps the identity", () => {
    expect(firstError("replace_where(lines, item.line_id == 1, with(item, line_id=2))")!.message).toContain("must not change the identity field");
    expect(firstError("with(Money(amount=1, currency='USD'), amount=2)")!.message).toContain("build a new value object");
  });
});

describe("models", () => {
  const codes = (text: string) => validateModelText(text).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);

  test("the ordering model validates without errors or warnings", () => {
    const r = validateModelText(ORDERING);
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  test("let names a value for later steps; branch values stay in their branch", () => {
    const outside = ORDERING.replace("          - return: 0\n", "          - return: still_paid\n");
    expect(codes(outside)).toContain('invalid-expression: Unknown name "still_paid"');
    const twice = ORDERING.replace("              name: total\n", "              name: order\n");
    expect(codes(twice)).toContain('duplicate-name: "order" is already defined in this use case');
    const reserved = ORDERING.replace("              name: line_count\n", "              name: sum\n").replace("- return: line_count", "- return: sum");
    expect(codes(reserved).some((c) => c.startsWith("reserved-name"))).toBe(true);
  });

  test("let of an aggregate and Duration events are rejected", () => {
    const alias = ORDERING.replace("              value: count(order.lines)\n", "              value: order\n").replace("- return: line_count", "- return: 1");
    expect(codes(alias)).toContain('invalid-let: "line_count" would name the aggregate Order; aggregates are named by the "as" of a load or create step');
    const dur = ORDERING.replace("{ name: cancel_deadline, value: at + hours(24) }", "{ name: cancel_deadline, value: hours(24) }");
    expect(codes(dur)).toContain('invalid-event-field: Event field "cancel_deadline" carries a Duration; events carry declarable values');
  });

  test("Integer and Decimal returns unify to Decimal", () => {
    const r = validateModelText(ORDERING);
    expect(r.analysis!.contexts.get("Sales")!.useCases.get("refund_order")!.returnType).toEqual(T.Decimal);
  });
});
