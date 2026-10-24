/**
 * Conditions of the model put into words (Japanese), for the review questions (review.ts) and the flow diagrams
 * (flows.ts). Null checks before a comparison of the same value are left out; what is not put into words is shown
 * as written.
 */
import { formatPath, type Path } from "./diagnostics.ts";
import type { TExpr } from "./checker.ts";
import type { Analysis } from "./validate.ts";

/** What a reviewer calls an element: its short description, else its name. */
export const plainName = (x: { name: string; description?: string }) => {
  const d = x.description?.trim().split("\n")[0]?.replace(/[。.]$/, "");
  return d && d.length <= 30 ? d : x.name;
};

export interface Names {
  self?: string;
  locals?: Record<string, string>;
}

/** Words joined with a space only where one side is Latin (「本人の email が招待の email と同じ」). */
export const words = (...parts: string[]) =>
  parts.reduce((acc, w) => (!acc ? w : /[\x21-\x7e]$/.test(acc) || /^[\x21-\x7e]/.test(w) ? `${acc} ${w}` : `${acc}${w}`), "");

/**
 * A condition in words (Japanese); null checks before a comparison of the same value are left out. `self` names the
 * object whose fields are read by name (an aggregate's own `allow_if`), `locals` what a use case's variables hold.
 */
export function describeCondition(e: TExpr, names: Names = {}): string {
  switch (e.t) {
    case "binary": {
      if (e.op === "and") {
        const drop = (x: TExpr, other: TExpr) => {
          const checked = notNullOf(x);
          return !!checked && mentions(other, checked);
        };
        if (drop(e.left, e.right)) return describeCondition(e.right, names);
        if (drop(e.right, e.left)) return describeCondition(e.left, names);
        return `${describeCondition(e.left, names)}、かつ${describeCondition(e.right, names)}`;
      }
      if (e.op === "or") return `${describeCondition(e.left, names)}、または${describeCondition(e.right, names)}`;
      const l = value(e.left, names);
      const r = value(e.right, names);
      if (e.right.t === "lit" && e.right.kind === "null" && (e.op === "==" || e.op === "!=")) return words(l, `が${e.op === "!=" ? "ある" : "ない"}`);
      if (e.op === "==") return e.right.t === "enumValue" ? words(l, "が", r) : words(l, "が", r, "と同じ");
      if (e.op === "!=") return words(l, "が", r, "と違う");
      if (["<", "<=", ">", ">="].includes(e.op)) return `${l} ${e.op} ${r}`;
      throw new Unsupported();
    }
    case "isNull":
      return words(value(e.operand, names), `が${e.negate ? "ある" : "ない"}`);
    case "not":
      return `「${describeCondition(e.operand, names)}」ではない`;
    case "hasRole":
      return `${e.role} のロールを持つ`;
    case "hasPermission":
      return `${e.permission} の権限を持つ`;
    case "guard":
      return words(e.receiver ? words(value(e.receiver, names), "が") : "", e.guard, "を満たす");
    default:
      return value(e, names);
  }
}

function value(e: TExpr, names: Names = {}): string {
  switch (e.t) {
    case "principal":
      return e.member === "id" ? "本人の ID" : `本人の ${e.member}`;
    case "field":
      // A one-field value object reads as itself (`email.value` is the email).
      if (e.owner && e.name === "value") return value(e.owner, names);
      if (!e.owner) return names.self ? words(`${names.self}の`, e.name) : e.name;
      return words(`${value(e.owner, names)}の`, e.name);
    case "local":
      return names.locals?.[e.name] ?? e.name;
    case "param":
      return e.name;
    case "enumValue":
      return e.value;
    case "lit":
      return e.kind === "string" ? `"${e.value}"` : String(e.value);
    case "port":
      return e.port === "clock" ? "いまの時刻" : "新しい ID";
    case "binary":
    case "not":
    case "isNull":
    case "hasRole":
    case "hasPermission":
    case "guard":
      return describeCondition(e, names);
    default:
      // Arithmetic, collections, extension points, …: the caller shows the expression as written.
      throw new Unsupported();
  }
}

class Unsupported extends Error {}

/**
 * A condition of the model in words (the flow diagrams' branches, docs/11 §12): the typed expression the validator
 * stored at `path`, or `source` as written when there is none or it uses something not put into words.
 */
export function conditionWords(analysis: Analysis | undefined, context: string, path: Path, source: string, locals?: Record<string, string>): string {
  const e = analysis?.contexts.get(context)?.exprs.get(formatPath(path));
  if (!e) return source;
  try {
    return describeCondition(e, locals ? { locals } : {});
  } catch (err) {
    if (err instanceof Unsupported) return source;
    throw err;
  }
}

/** The condition in words, or as written when it uses something not put into words. */
export function conditionText(e: TExpr, names: Names | undefined, source: string): string {
  try {
    return describeCondition(e, names);
  } catch (err) {
    if (err instanceof Unsupported) return `「${source}」`;
    throw err;
  }
}

/** The same field / principal member / variable (types aside: one side may be the optional form). */
function sameValue(a: TExpr, b: TExpr): boolean {
  if (a.t === "principal" && b.t === "principal") return a.member === b.member;
  if ((a.t === "local" || a.t === "param") && a.t === b.t) return a.name === b.name;
  if (a.t === "field" && b.t === "field") return a.name === b.name && (!a.owner || !b.owner ? !a.owner && !b.owner : sameValue(a.owner, b.owner));
  return false;
}

/** The value a `x != null` (or `x is not null`) check is about. */
function notNullOf(e: TExpr): TExpr | undefined {
  if (e.t === "isNull" && e.negate) return e.operand;
  if (e.t === "binary" && e.op === "!=" && e.right.t === "lit" && e.right.kind === "null") return e.left;
  return undefined;
}

function mentions(e: TExpr, target: TExpr): boolean {
  if (sameValue(e, target)) return true;
  if (e.t === "binary") return mentions(e.left, target) || mentions(e.right, target);
  if (e.t === "not" || e.t === "isNull") return mentions(e.operand, target);
  return false;
}

