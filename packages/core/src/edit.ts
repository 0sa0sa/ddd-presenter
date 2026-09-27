/**
 * Structural edits on the YAML model text. Forms and the diagram produce these operations,
 * so every view edits the same document and comments / key order are preserved.
 */
import { isMap, isPair, isScalar, isSeq, parseDocument, visit, type Document, type Node, type Pair, type Scalar } from "yaml";
import type { Path } from "./diagnostics.ts";

export type EditOp =
  | { op: "set"; path: Path; value: unknown }
  /** Appends to the sequence at `path`, creating it when missing. */
  | { op: "add"; path: Path; value: unknown }
  | { op: "remove"; path: Path }
  /** Renames an enum, value object, entity, aggregate, error or event and updates every reference in the context. */
  | { op: "renameType"; context: string; from: string; to: string }
  /** Renames a state guard of an aggregate and updates `require` lists and use case conditions. */
  | { op: "renameGuard"; context: string; aggregate: string; from: string; to: string };

export type EditResult = { ok: true; text: string } | { ok: false; error: string };

export function applyEdits(text: string, ops: EditOp[]): EditResult {
  const doc = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length) return { ok: false, error: `The model has YAML syntax errors: ${doc.errors[0]!.message.split("\n")[0]}` };
  try {
    for (const op of ops) apply(doc, op);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, text: doc.toString({ lineWidth: 0, flowCollectionPadding: false }) };
}

function apply(doc: Document, op: EditOp): void {
  switch (op.op) {
    case "set":
      if (op.path.length === 0) throw new Error("Cannot replace the whole document");
      doc.setIn(op.path, styled(doc, op.value));
      return;
    case "add": {
      const existing = doc.getIn(op.path, true);
      const node = styled(doc, op.value);
      if (existing === undefined || existing === null || (isScalar(existing) && existing.value === null)) {
        const seq = doc.createNode([]);
        (seq as { flow?: boolean }).flow = false;
        doc.setIn(op.path, seq);
      } else if (!isSeq(existing)) {
        throw new Error(`${op.path.join(".")} is not a list`);
      } else if (existing.flow && existing.items.length === 0) {
        // `errors: []` in a template: switch to block style so added elements are readable.
        existing.flow = false;
      }
      doc.addIn(op.path, node);
      return;
    }
    case "remove":
      if (!doc.hasIn(op.path)) throw new Error(`Nothing at ${op.path.join(".")}`);
      doc.deleteIn(op.path);
      return;
    case "renameType":
      return renameType(doc, op.context, op.from, op.to);
    case "renameGuard":
      return renameGuard(doc, op.context, op.aggregate, op.from, op.to);
  }
}

/**
 * Creates a node in the house style: block collections, except small records (fields, parameters,
 * short step bodies) and short scalar lists, which read best in flow style: `{ name: id, type: UUID }`.
 */
function styled(doc: Document, value: unknown): Node {
  const node = doc.createNode(value) as Node;
  const walk = (n: unknown) => {
    if (isMap(n)) {
      // Single-entry maps (`- save: x`) stay in block style; small records go inline.
      n.flow = n.items.length > 1 && isFlowish(n.toJSON());
      if (!n.flow) for (const p of n.items) walk(p.value);
    } else if (isSeq(n)) {
      n.flow = n.items.length === 0 || (n.items.length <= 6 && n.items.every((i) => isScalar(i)));
      for (const i of n.items) walk(i);
    }
  };
  walk(node);
  return node;
}

/** Small records (fields, parameters) read best in flow style: `{ name: x, type: String }`. */
function isFlowish(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length <= 4 && entries.every(([, x]) => x === null || typeof x !== "object");
}

function findContext(doc: Document, name: string): Node {
  const contexts = doc.get("contexts", true);
  if (!isSeq(contexts)) throw new Error("The model has no contexts");
  const ctx = contexts.items.find((c) => isMap(c) && c.get("name") === name);
  if (!ctx) throw new Error(`Unknown context ${name}`);
  return ctx as Node;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function replaceToken(src: string, from: string, to: string): string {
  // Leave string literals untouched.
  return src.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b[A-Za-z_][A-Za-z0-9_]*\b/g, (m, str) => (str ? m : m === from ? to : m));
}

/**
 * Whether the scalar at this key path is a rule expression.
 * `keys` are the mapping keys from the context down to the scalar.
 */
function isExpressionPosition(keys: string[]): boolean {
  const key = keys[keys.length - 1] ?? "";
  const parent = keys[keys.length - 2] ?? "";
  if (keys.includes("scenarios")) return false; // scenario data are literals, never expressions
  if (["expression", "condition", "when", "return", "by"].includes(key)) return true;
  if (key === "value" && keys.includes("emits")) return true;
  if (parent === "changes" || parent === "args") return true;
  if (parent === "fields" && keys.includes("factories")) return true;
  return keys.includes("require");
}

function keyOf(pair: unknown): string | undefined {
  if (isPair(pair) && isScalar(pair.key)) return String(pair.key.value);
  return undefined;
}

type Ancestors = readonly (Node | Pair | Document)[];

function nearestKeys(path: Ancestors): string[] {
  return path.filter(isPair).map((p) => keyOf(p) ?? "");
}

function renameType(doc: Document, context: string, from: string, to: string): void {
  if (!IDENT.test(to)) throw new Error(`"${to}" is not a valid name`);
  const ctx = findContext(doc, context);
  let definitions = 0;
  visit(ctx, {
    Scalar(_key, node: Scalar, path) {
      if (typeof node.value !== "string") return;
      const keys = nearestKeys(path);
      const key = keys[keys.length - 1];
      const v = node.value;
      // Definition sites: `- name: From` directly under a type collection, or an emitted event name.
      if (key === "name" && v === from) {
        const collection = keys[keys.length - 2];
        if (["errors", "enums", "value_objects", "aggregates", "entities", "emits"].includes(collection ?? "")) {
          node.value = to;
          definitions++;
        }
        return;
      }
      if (key === "type" || key === "returns") {
        node.value = replaceToken(v, from, to);
        return;
      }
      if (["aggregate", "error", "not_found", "raises", "fail", "publish", "publish_after_commit", "event", "command"].includes(key ?? "") && v === from) {
        node.value = to;
        if (key === "command") definitions++;
        return;
      }
      if (isExpressionPosition(keys)) node.value = replaceToken(v, from, to);
    },
  });
  if (definitions === 0) throw new Error(`No type named ${from} in context ${context}`);
}

function renameGuard(doc: Document, context: string, aggregate: string, from: string, to: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(to)) throw new Error(`"${to}" must be snake_case`);
  const ctx = findContext(doc, context);
  const aggs = (ctx as unknown as { get: (k: string, keep: boolean) => unknown }).get("aggregates", true);
  if (!isSeq(aggs)) throw new Error(`Context ${context} has no aggregates`);
  const agg = aggs.items.find((a) => isMap(a) && a.get("name") === aggregate);
  if (!isMap(agg)) throw new Error(`Unknown aggregate ${aggregate}`);
  const guards = agg.get("state_guards", true);
  const guard = isSeq(guards) ? guards.items.find((g) => isMap(g) && g.get("name") === from) : undefined;
  if (!isMap(guard)) throw new Error(`${aggregate} has no state guard ${from}`);
  guard.set("name", to);
  // require lists of the aggregate's operations
  visit(agg, {
    Scalar(_k, node: Scalar, path) {
      if (typeof node.value === "string" && nearestKeys(path).includes("require")) node.value = replaceToken(node.value, from, to);
    },
  });
  // use case conditions / returns / args in the same context (receiver.guard(...) syntax)
  const useCases = (ctx as unknown as { get: (k: string, keep: boolean) => unknown }).get("use_cases", true);
  if (isSeq(useCases)) {
    visit(useCases, {
      Scalar(_k, node: Scalar, path) {
        if (typeof node.value !== "string") return;
        const keys = nearestKeys(path);
        const key = keys[keys.length - 1] ?? "";
        if (["condition", "return"].includes(key) || keys[keys.length - 2] === "args") {
          node.value = node.value.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\.([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, str, name) =>
            str ? m : name === from ? `.${to}` : m,
          );
        }
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Templates for new elements (used by the Web forms)
// ---------------------------------------------------------------------------

export const templates = {
  context: (name: string) => ({ name, description: "", errors: [], aggregates: [], use_cases: [] }),
  error: (name: string) => ({ name, code: snake(name), message: name }),
  enum: (name: string) => ({ name, values: ["value_a", "value_b"] }),
  valueObject: (name: string) => ({ name, fields: [{ name: "value", type: "String" }] }),
  aggregate: (name: string) => ({ name, identity: "id", fields: [{ name: "id", type: "UUID" }] }),
  field: (name: string, type = "String") => ({ name, type }),
  invariant: (name: string, error: string) => ({ name, expression: "true", error, check_on: ["construct", "transition"] }),
  stateGuard: (name: string, error: string) => ({ name, expression: "true", error }),
  operation: (name: string) => ({ name, changes: {} }),
  useCase: (name: string) => ({ name, command: pascalCase(name), transaction: "required", input: [], steps: [] }),
};

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function pascalCase(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}
