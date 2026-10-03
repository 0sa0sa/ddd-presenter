import type { ContextIR } from "./ir.ts";

export const PRIMITIVES = ["String", "Integer", "Decimal", "Boolean", "UUID", "DateTime", "Date"] as const;
export type PrimitiveName = (typeof PRIMITIVES)[number];

export type Type =
  | { k: "primitive"; name: PrimitiveName }
  | { k: "enum"; name: string }
  | { k: "vo"; name: string }
  | { k: "entity"; name: string; aggregate: string }
  | { k: "aggregate"; name: string }
  /** Identity of another aggregate (`Ref[Order]`). Represented as UUID at runtime. */
  | { k: "ref"; target: string }
  | { k: "list"; item: Type }
  | { k: "optional"; inner: Type }
  | { k: "null" }
  | { k: "event"; name: string }
  /** Length of time (`hours(24)`, `at - placed_at`). Expression-only: not declarable as a field type. Python `timedelta`. */
  | { k: "duration" };

export const T = {
  String: { k: "primitive", name: "String" } as Type,
  Integer: { k: "primitive", name: "Integer" } as Type,
  Decimal: { k: "primitive", name: "Decimal" } as Type,
  Boolean: { k: "primitive", name: "Boolean" } as Type,
  UUID: { k: "primitive", name: "UUID" } as Type,
  DateTime: { k: "primitive", name: "DateTime" } as Type,
  Date: { k: "primitive", name: "Date" } as Type,
  Null: { k: "null" } as Type,
  Duration: { k: "duration" } as Type,
};

export type TypeExpr = { name: string; args: TypeExpr[] };

/** Parses `List[EmailAddress]`, `Ref[Order]`, `Optional[String]`. Returns undefined on syntax error. */
export function parseTypeExpr(src: string): TypeExpr | undefined {
  let i = 0;
  const s = src.replace(/\s+/g, "");
  function parse(): TypeExpr | undefined {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    const args: TypeExpr[] = [];
    if (s[i] === "[") {
      i++;
      for (;;) {
        const a = parse();
        if (!a) return undefined;
        args.push(a);
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") {
          i++;
          break;
        }
        return undefined;
      }
    }
    return { name: m[0], args };
  }
  const t = parse();
  return t && i === s.length ? t : undefined;
}

export interface TypeScope {
  context: ContextIR;
  /** Aggregate whose internal entities are visible, if any. */
  aggregate?: string;
}

export type ResolveResult = { ok: true; type: Type } | { ok: false; message: string; hint?: string };

export function resolveType(src: string, scope: TypeScope): ResolveResult {
  const expr = parseTypeExpr(src);
  if (!expr) return { ok: false, message: `Invalid type expression "${src}"`, hint: "Examples: String, List[EmailAddress], Ref[Order]" };
  return resolveExpr(expr, scope);
}

function resolveExpr(e: TypeExpr, scope: TypeScope): ResolveResult {
  const ctx = scope.context;
  const argCount = (n: number): ResolveResult | undefined =>
    e.args.length === n ? undefined : { ok: false, message: `${e.name} takes ${n} type argument${n === 1 ? "" : "s"}` };

  if (e.name === "List" || e.name === "Optional") {
    const bad = argCount(1);
    if (bad) return bad;
    const inner = resolveExpr(e.args[0]!, scope);
    if (!inner.ok) return inner;
    if (e.name === "Optional") return { ok: true, type: { k: "optional", inner: inner.type } };
    return { ok: true, type: { k: "list", item: inner.type } };
  }
  if (e.name === "Ref") {
    const bad = argCount(1);
    if (bad) return bad;
    const target = e.args[0]!;
    if (target.args.length || !ctx.aggregates.some((a) => a.name === target.name)) {
      return { ok: false, message: `Ref[...] must name an aggregate in context ${ctx.name}, got "${target.name}"` };
    }
    return { ok: true, type: { k: "ref", target: target.name } };
  }
  if (e.args.length) return { ok: false, message: `${e.name} does not take type arguments` };
  if ((PRIMITIVES as readonly string[]).includes(e.name)) return { ok: true, type: { k: "primitive", name: e.name as PrimitiveName } };
  if (ctx.enums.some((x) => x.name === e.name)) return { ok: true, type: { k: "enum", name: e.name } };
  if (ctx.valueObjects.some((x) => x.name === e.name)) return { ok: true, type: { k: "vo", name: e.name } };
  const owner = ctx.aggregates.find((a) => a.entities.some((en) => en.name === e.name));
  if (owner) {
    if (scope.aggregate !== owner.name) {
      return {
        ok: false,
        message: `Entity ${e.name} belongs to aggregate ${owner.name} and cannot be referenced from outside its boundary`,
        hint: `Reference the aggregate by identity (Ref[${owner.name}]) or publish a Domain Event instead`,
      };
    }
    return { ok: true, type: { k: "entity", name: e.name, aggregate: owner.name } };
  }
  if (ctx.aggregates.some((a) => a.name === e.name)) {
    return { ok: true, type: { k: "aggregate", name: e.name } };
  }
  if (e.name === "Duration") {
    return {
      ok: false,
      message: "Duration is only available inside expressions (e.g. placed_at + hours(24)) and cannot be declared",
      hint: "Store the deadline as a DateTime or the length as an Integer (e.g. minutes) and convert with minutes(n) in rules",
    };
  }
  const suggestion = closest(e.name, [
    ...PRIMITIVES,
    ...ctx.enums.map((x) => x.name),
    ...ctx.valueObjects.map((x) => x.name),
    ...ctx.aggregates.flatMap((a) => a.entities.map((en) => en.name)),
  ]);
  return {
    ok: false,
    message: `Unknown type "${e.name}" in context ${ctx.name}`,
    hint: suggestion ? `Did you mean "${suggestion}"?` : "Define it as an enum, value object or entity, or use a primitive type",
  };
}

export function typeToString(t: Type): string {
  switch (t.k) {
    case "primitive":
      return t.name;
    case "enum":
    case "vo":
    case "entity":
    case "aggregate":
    case "event":
      return t.name;
    case "ref":
      return `Ref[${t.target}]`;
    case "list":
      return `List[${typeToString(t.item)}]`;
    case "optional":
      return `Optional[${typeToString(t.inner)}]`;
    case "null":
      return "null";
    case "duration":
      return "Duration";
  }
}

/** Strips Ref → UUID so identity comparisons work. */
function normalize(t: Type): Type {
  if (t.k === "ref") return T.UUID;
  return t;
}

export function sameType(a: Type, b: Type): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x.k !== y.k) return false;
  switch (x.k) {
    case "primitive":
      return x.name === (y as typeof x).name;
    case "enum":
    case "vo":
    case "entity":
    case "aggregate":
    case "event":
      return x.name === (y as typeof x).name;
    case "list":
      return sameType(x.item, (y as typeof x).item);
    case "optional":
      return sameType(x.inner, (y as typeof x).inner);
    case "null":
    case "duration":
      return true;
    case "ref":
      return true;
  }
}

export function isNumeric(t: Type): boolean {
  return t.k === "primitive" && (t.name === "Integer" || t.name === "Decimal");
}

export function isOrderable(t: Type): boolean {
  return t.k === "duration" || (t.k === "primitive" && ["Integer", "Decimal", "DateTime", "Date", "String"].includes(t.name));
}

/** Whether a value of type `from` may be used where `to` is expected. */
export function assignable(from: Type, to: Type): boolean {
  if (to.k === "optional") {
    return from.k === "null" || assignable(from.k === "optional" ? from.inner : from, to.inner);
  }
  if (from.k === "optional" || from.k === "null") return false;
  if (sameType(from, to)) return true;
  // Integer widens to Decimal.
  if (from.k === "primitive" && from.name === "Integer" && to.k === "primitive" && to.name === "Decimal") return true;
  return false;
}

export function closest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
