/**
 * Pure derivations from the model IR for the Web views (tree, diagram, scenarios).
 * Kept framework-free so they are unit-tested with `bun test`.
 */
import { formatPath, type Analysis, type Diagnostic, type ModelIR, type Path, type StepIR } from "@ddd/core";

export type Kind =
  | "context"
  | "aggregate"
  | "entity"
  | "valueObject"
  | "enum"
  | "error"
  | "event"
  | "useCase"
  | "invariant"
  | "guard"
  | "factory"
  | "operation"
  | "scenario"
  | "extension"
  | "policy";

export const KIND_LABEL: Record<Kind, string> = {
  context: "Bounded context",
  aggregate: "Aggregate",
  entity: "Entity",
  valueObject: "Value object",
  enum: "Enum",
  error: "Domain error",
  event: "Domain event",
  useCase: "Use case",
  invariant: "Invariant",
  guard: "State guard",
  factory: "Factory",
  operation: "Operation",
  scenario: "Scenario",
  extension: "Extension point",
  policy: "Policy",
};

/** Glyphs pair with colors so kinds never depend on color alone. */
export const KIND_GLYPH: Record<Kind, string> = {
  context: "▣",
  aggregate: "◆",
  entity: "■",
  valueObject: "●",
  enum: "≡",
  error: "✕",
  event: "⚑",
  useCase: "▶",
  invariant: "§",
  guard: "⊘",
  factory: "✦",
  operation: "ƒ",
  scenario: "✓",
  extension: "⎘",
  policy: "↯",
};

export interface OutlineNode {
  id: string;
  kind: Kind;
  name: string;
  context: string;
  /** Owning aggregate / use case, for members. */
  owner?: string;
  path: Path;
  children: OutlineNode[];
  errors: number;
  warnings: number;
}

export function buildOutline(model: ModelIR, diagnostics: readonly Diagnostic[] = []): OutlineNode[] {
  const counts = (path: Path) => {
    const prefix = formatPath(path);
    let errors = 0;
    let warnings = 0;
    for (const d of diagnostics) {
      const p = formatPath(d.path);
      if (p === prefix || p.startsWith(prefix + ".") || p.startsWith(prefix + "[")) {
        if (d.severity === "error") errors++;
        else if (d.severity === "warning") warnings++;
      }
    }
    return { errors, warnings };
  };
  const node = (kind: Kind, name: string, context: string, path: Path, children: OutlineNode[] = [], owner?: string): OutlineNode => ({
    id: [context, owner, kind, name].filter(Boolean).join("/"),
    kind,
    name,
    context,
    owner,
    path,
    children,
    ...counts(path),
  });

  return model.contexts.map((ctx) => {
    const c = ctx.name;
    const events = new Map<string, Path>();
    for (const a of ctx.aggregates) for (const m of [...a.factories, ...a.operations]) for (const e of m.emits) if (!events.has(e.name)) events.set(e.name, e.path);
    return node("context", c, c, ctx.path, [
      ...ctx.aggregates.map((a) =>
        node(
          "aggregate",
          a.name,
          c,
          a.path,
          [
            ...a.entities.map((e) => node("entity", e.name, c, e.path, [], a.name)),
            ...a.invariants.map((i) => node("invariant", i.name, c, i.path, [], a.name)),
            ...a.stateGuards.map((g) => node("guard", g.name, c, g.path, [], a.name)),
            ...a.factories.map((f) => node("factory", f.name, c, f.path, [], a.name)),
            ...a.operations.map((o) => node("operation", o.name, c, o.path, [], a.name)),
            ...a.scenarios.map((s) => node("scenario", s.name, c, s.path, [], a.name)),
          ],
        ),
      ),
      ...ctx.valueObjects.map((v) => node("valueObject", v.name, c, v.path, v.invariants.map((i) => node("invariant", i.name, c, i.path, [], v.name)))),
      ...ctx.enums.map((e) => node("enum", e.name, c, e.path)),
      ...[...events].map(([name, path]) => node("event", name, c, path)),
      ...ctx.errors.map((e) => node("error", e.name, c, e.path)),
      ...ctx.extensionPoints.map((x) => node("extension", x.name, c, x.path)),
      ...ctx.useCases.map((u) => node("useCase", u.name, c, u.path, u.scenarios.map((s) => node("scenario", s.name, c, s.path, [], u.name)))),
      ...ctx.policies.map((p) => node("policy", p.name, c, p.path)),
    ]);
  });
}

export function flatten(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** The outline node whose YAML path is the longest prefix of `path` (for cursor → selection sync). */
export function nodeAtPath(nodes: OutlineNode[], path: Path): OutlineNode | undefined {
  let best: OutlineNode | undefined;
  for (const n of flatten(nodes)) {
    if (n.path.length <= path.length && n.path.every((p, i) => p === path[i]) && (!best || n.path.length > best.path.length)) best = n;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: Kind;
  name: string;
  context: string;
  x: number;
  y: number;
  /** Short lines rendered inside the node (fields, operations, steps). */
  lines: string[];
  errors: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: "holds" | "emits" | "uses" | "publishes" | "references";
}

/** Columns: use cases → aggregates (value objects stacked below) → events. */
const COL = { useCase: 0, aggregate: 360, event: 720, valueObject: 360 } as const;
const ROW = 190;

export function buildGraph(model: ModelIR, analysis: Analysis | undefined, positions: Record<string, { x: number; y: number }> = {}, diagnostics: readonly Diagnostic[] = []): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const outline = buildOutline(model, diagnostics);
  const errorsOf = (id: string) => flatten(outline).find((n) => n.id === id)?.errors ?? 0;
  let baseY = 0;
  for (const ctx of model.contexts) {
    const c = ctx.name;
    const key = (kind: Kind, name: string) => `${c}/${kind}/${name}`;
    const rows: Record<keyof typeof COL, number> = { useCase: 0, aggregate: 0, event: 0, valueObject: 0 };
    const place = (col: keyof typeof COL, id: string) => {
      const p = positions[id];
      const auto = { x: COL[col], y: Math.round(baseY + rows[col] * ROW) };
      rows[col] += col === "aggregate" ? 1.6 : 1;
      return p ?? auto;
    };
    const add = (col: keyof typeof COL, kind: Kind, name: string, lines: string[]) => {
      const id = key(kind, name);
      nodes.push({ id, kind, name, context: c, lines, errors: errorsOf(id), ...place(col, id) });
      return id;
    };

    for (const a of ctx.aggregates) {
      add("aggregate", "aggregate", a.name, [
        ...a.fields.map((f) => `${f.name}: ${f.type}${f.required ? "" : "?"}`),
        ...a.operations.map((o) => `ƒ ${o.name}(${o.parameters.map((p) => p.name).join(", ")})`),
      ]);
      for (const f of a.fields) {
        const base = f.type.replace(/^(List|Optional)\[(.*)\]$/, "$2");
        const ref = /^Ref\[(.*)\]$/.exec(base);
        if (ctx.valueObjects.some((v) => v.name === base)) edges.push({ id: `${a.name}-holds-${base}-${f.name}`, source: key("aggregate", a.name), target: key("valueObject", base), label: f.name, kind: "holds" });
        if (ref) edges.push({ id: `${a.name}-ref-${ref[1]}-${f.name}`, source: key("aggregate", a.name), target: key("aggregate", ref[1]!), label: `${f.name} (id)`, kind: "references" });
      }
    }
    const events = new Map<string, string[]>();
    for (const a of ctx.aggregates) {
      for (const m of [...a.factories, ...a.operations]) {
        for (const e of m.emits) {
          if (!events.has(e.name)) events.set(e.name, e.fields.map((f) => f.name));
          edges.push({ id: `${a.name}-${m.name}-emits-${e.name}`, source: key("aggregate", a.name), target: key("event", e.name), label: m.name, kind: "emits" });
        }
      }
    }
    for (const [name, fields] of events) add("event", "event", name, fields);
    rows.valueObject = rows.aggregate + 0.4; // stack value objects under the aggregates they belong with
    for (const v of ctx.valueObjects) add("valueObject", "valueObject", v.name, v.fields.map((f) => `${f.name}: ${f.type}`));
    for (const u of ctx.useCases) {
      add("useCase", "useCase", u.name, describeSteps(u.steps));
      const touched = new Map<string, Set<string>>();
      walkSteps(u.steps, (s, vars) => {
        if (s.kind === "load" || s.kind === "create") {
          vars.set(s.as, s.aggregate);
          const set = touched.get(s.aggregate) ?? new Set();
          set.add(s.kind === "load" ? "load" : s.factory);
          touched.set(s.aggregate, set);
        }
        if (s.kind === "invoke") {
          const ag = vars.get(s.target);
          if (ag) touched.get(ag)?.add(s.operation);
        }
      });
      for (const [ag, ops] of touched) edges.push({ id: `${u.name}-uses-${ag}`, source: key("useCase", u.name), target: key("aggregate", ag), label: [...ops].join(", "), kind: "uses" });
    }
    void analysis;
    baseY += Math.max(rows.useCase, rows.aggregate, rows.event, rows.valueObject, 1) * ROW + 120;
  }
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

function walkSteps(steps: StepIR[], fn: (s: StepIR, vars: Map<string, string>) => void, vars = new Map<string, string>()): void {
  for (const s of steps) {
    fn(s, vars);
    if (s.kind === "if") {
      walkSteps(s.then, fn, vars);
      walkSteps(s.else, fn, vars);
    }
  }
}

/** One readable line per step, numbered in execution order (steps are a real sequence). */
export function describeSteps(steps: StepIR[], depth = 0, counter = { n: 0 }): string[] {
  const pad = "  ".repeat(depth);
  const out: string[] = [];
  for (const s of steps) {
    const n = ++counter.n;
    const args = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(", ");
    switch (s.kind) {
      case "load":
        out.push(`${pad}${n}. ${s.as} = load ${s.aggregate} by ${s.by}`);
        break;
      case "create":
        out.push(`${pad}${n}. ${s.as} = ${s.aggregate}.${s.factory}(${args(s.args)})`);
        break;
      case "invoke":
        out.push(`${pad}${n}. ${s.target}.${s.operation}(${args(s.args)})`);
        break;
      case "save":
        out.push(`${pad}${n}. save ${s.target}`);
        break;
      case "publish":
        out.push(`${pad}${n}. publish ${s.event}${s.afterCommit ? " (after commit)" : ""}`);
        break;
      case "fail":
        out.push(`${pad}${n}. fail ${s.error}`);
        break;
      case "return":
        out.push(`${pad}${n}. return ${s.value}`);
        break;
      case "if":
        out.push(`${pad}${n}. if ${s.condition}`);
        out.push(...describeSteps(s.then, depth + 1, counter));
        if (s.else.length) {
          out.push(`${pad}   else`);
          out.push(...describeSteps(s.else, depth + 1, counter));
        }
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenarios in plain language (for domain experts)
// ---------------------------------------------------------------------------

export interface ScenarioCard {
  owner: string;
  ownerKind: "aggregate" | "useCase";
  name: string;
  description?: string;
  given: string[];
  when: string;
  then: string[];
  path: Path;
}

const show = (v: unknown): string => {
  if (v === null) return "なし";
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "value") return show(entries[0]![1]);
    return entries.map(([k, x]) => `${k} = ${show(x)}`).join(", ");
  }
  return String(v);
};

export function scenarioCards(model: ModelIR): ScenarioCard[] {
  const out: ScenarioCard[] = [];
  for (const ctx of model.contexts) {
    for (const a of ctx.aggregates) {
      for (const s of a.scenarios) {
        const given = s.given ? Object.entries(s.given.aggregate).map(([k, v]) => `${k} が ${show(v)}`) : [];
        const when =
          s.when.kind === "construct"
            ? `${a.name} を ${Object.entries(s.when.fields).map(([k, v]) => `${k} = ${show(v)}`).join(", ")} で作る`
            : s.when.kind === "operation"
              ? `${s.when.operation}(${Object.entries(s.when.args).map(([k, v]) => `${k}: ${show(v)}`).join(", ")}) を実行する`
              : `${s.when.factory}(${Object.entries(s.when.args).map(([k, v]) => `${k}: ${show(v)}`).join(", ")}) で作る`;
        out.push({ owner: a.name, ownerKind: "aggregate", name: s.name, description: s.description, given, when, then: thenLines(s.then), path: s.path });
      }
    }
    for (const u of ctx.useCases) {
      for (const s of u.scenarios) {
        const given = [
          ...(s.given.clock ? [`現在時刻は ${s.given.clock}`] : []),
          ...s.given.aggregates.map((g) => `${g.type} が保存されている（${Object.entries(g.fields).map(([k, v]) => `${k} = ${show(v)}`).join(", ")}）`),
          ...Object.entries(s.given.extensions).map(([k, v]) => `${k} は ${show(v)} を返す`),
        ];
        const input = Object.entries(s.when.input).map(([k, v]) => `${k} = ${show(v)}`).join(", ");
        out.push({ owner: u.name, ownerKind: "useCase", name: s.name, description: s.description, given, when: `${u.actor ? `${u.actor}が ` : ""}${u.name} を実行する（${input}）`, then: thenLines(s.then), path: s.path });
      }
    }
  }
  return out;
}

function thenLines(t: ModelIR["contexts"][number]["useCases"][number]["scenarios"][number]["then"]): string[] {
  const out: string[] = [];
  if (t.raises) out.push(`${t.raises} で失敗する`);
  if (t.hasReturns) out.push(`${show(t.returns)} が返る`);
  if (Array.isArray(t.state)) for (const s of t.state) out.push(`${s.aggregate} ${show(s.id)} の ${Object.entries(s.fields).map(([k, v]) => `${k} は ${show(v)}`).join("、")}`);
  else if (t.state) out.push(Object.entries(t.state).map(([k, v]) => `${k} は ${show(v)}`).join("、"));
  if (t.emits) out.push(t.emits.length ? `${t.emits.map((e) => e.event).join("、")} が発生する` : "イベントは発生しない");
  return out;
}
