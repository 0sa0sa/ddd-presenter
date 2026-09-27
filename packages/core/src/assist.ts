/**
 * Local (no-LLM) assistance: predicts the next piece of a model from its structure.
 * Used for Copilot-style ghost text and for "propose" actions when no LLM is configured.
 * Everything here is deterministic and never leaves the machine.
 */
import { parse as yamlParse } from "yaml";
import { suggestAggregates, type Board, type StickyKind } from "./discovery.ts";
import { applyEdits, type EditOp } from "./edit.ts";
import type { AggregateIR, ContextIR, ModelIR, OperationIR } from "./ir.ts";
import { parseModel } from "./parse.ts";
import { resolveType, type Type } from "./types.ts";
import { analyzeModel, pascal, toSnake, validateModelText } from "./validate.ts";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const IRREGULAR: Record<string, string> = {
  send: "sent",
  pay: "paid",
  make: "made",
  write: "written",
  begin: "begun",
  take: "taken",
  give: "given",
  put: "put",
  set: "set",
  sell: "sold",
  buy: "bought",
  build: "built",
  hold: "held",
  run: "run",
  choose: "chosen",
  get: "got",
  leave: "left",
  split: "split",
  shut: "shut",
  reset: "reset",
};

/** accept → accepted, revoke → revoked, submit → submitted, send → sent. */
export function pastParticiple(verb: string): string {
  const v = verb.toLowerCase();
  if (IRREGULAR[v]) return IRREGULAR[v]!;
  if (v.endsWith("e")) return `${v}d`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ied`;
  if (/^[^aeiou]*[aeiou][bdgklmnprt]$/.test(v) || /(mit|op|ip|an)$/.test(v)) return `${v}${v.at(-1)}ed`;
  return `${v}ed`;
}

/** accepted → accept, revoked → revoke, cancelled → cancel, submitted → submit. */
export function verbFromState(state: string): string | undefined {
  const s = state.toLowerCase();
  const irregular = Object.entries(IRREGULAR).find(([, p]) => p === s);
  if (irregular) return irregular[0];
  if (s.endsWith("ied")) return `${s.slice(0, -3)}y`;
  if (/([bdgklmnprt])\1ed$/.test(s)) return s.slice(0, -3);
  if (s.endsWith("ed")) {
    const stem = s.slice(0, -2);
    // revoked → revoke (stem ends with a consonant after a vowel+consonant pattern that needs "e")
    if (/(v|c|z|s|u|g)$/.test(stem) || /[aeiou][^aeiou]$/.test(stem) && !/(en|er|on|el)$/.test(stem)) return `${stem}e`;
    return stem;
  }
  return undefined;
}

/**
 * Event name for an operation: accept on Invitation → InvitationAccepted; send_welcome_mail → WelcomeMailSent.
 * `existingEvents` lets the name follow the subject the team already uses (InvitationIssued → "Invitation").
 */
export function eventNameFor(operation: string, aggregate: string, existingEvents: string[] = []): string {
  const words = operation.split("_").filter(Boolean);
  const verb = words[0] ?? operation;
  const object = words.slice(1);
  const counts = new Map<string, number>();
  for (const e of existingEvents) {
    const m = /^([A-Z][A-Za-z0-9]*?)([A-Z][a-z]+(?:ed|en|t|d))$/.exec(e);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const subject = object.length ? pascal(object.join("_")) : (usual ?? aggregate);
  return `${subject}${pascal(pastParticiple(verb))}`;
}

function eventsOf(ag: AggregateIR): string[] {
  return [...ag.factories, ...ag.operations].flatMap((m) => m.emits.map((e) => e.name));
}

// Japanese: 「招待を受諾する」→「招待が受諾された」, 「招待を送る」→「招待が送られた」.
const GODAN_PASSIVE: Record<string, string> = { う: "われた", く: "かれた", ぐ: "がれた", す: "された", つ: "たれた", ぬ: "なれた", ぶ: "ばれた", む: "まれた", る: "られた" };

export function eventTextFor(command: string): string {
  const t = command.trim();
  if (!t) return "";
  if (/^[A-Za-z]/.test(t)) {
    const [verb, ...rest] = t.split(/\s+/);
    const object = rest.join(" ");
    const past = pastParticiple(verb!);
    return object ? `${object[0]!.toUpperCase()}${object.slice(1)} ${past}` : `${verb} ${past}`;
  }
  const withSubject = t.replace(/を(?=[^を]*$)/, "が");
  if (withSubject.endsWith("する")) return `${withSubject.slice(0, -2)}された`;
  const last = withSubject.at(-1)!;
  if (GODAN_PASSIVE[last]) return `${withSubject.slice(0, -1)}${GODAN_PASSIVE[last]}`;
  return `${withSubject}（完了した）`;
}

export function commandTextFor(event: string): string {
  const t = event.trim();
  if (!t) return "";
  if (/^[A-Za-z]/.test(t)) {
    const words = t.split(/\s+/);
    const past = words.pop()!.toLowerCase();
    const verb = verbFromState(past) ?? past;
    return `${verb[0]!.toUpperCase()}${verb.slice(1)} ${words.join(" ").toLowerCase()}`.trim();
  }
  const withObject = t.replace(/が(?=[^が]*$)/, "を");
  if (withObject.endsWith("された")) {
    // 受諾された → 受諾する (noun + する), 取り消された → 取り消す (godan verb ending in す)
    const stem = withObject.slice(0, -3);
    const nounVerb = /[\u4e00-\u9fff\u30a0-\u30ff]{2}$/.test(stem);
    return nounVerb ? `${stem}する` : `${stem}す`;
  }
  for (const [base, passive] of Object.entries(GODAN_PASSIVE)) {
    if (withObject.endsWith(passive)) return `${withObject.slice(0, -passive.length)}${base}`;
  }
  return withObject.replace(/た$/, "する");
}

// ---------------------------------------------------------------------------
// Sample values (for generated scenarios)
// ---------------------------------------------------------------------------

const LATE_FIELD = /(expires|deadline|until|end|due|valid)/;

function sampleValue(t: Type, name: string, ctx: ContextIR, fieldTypes: (owner: string) => Map<string, Type>, depth = 0): unknown {
  if (t.k === "optional") return sampleValue(t.inner, name, ctx, fieldTypes, depth);
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String":
          return name.includes("email") ? "user@example.com" : `sample ${name}`;
        case "Integer":
          return 1;
        case "Decimal":
          return "1.00";
        case "Boolean":
          return true;
        case "UUID":
          return "00000000-0000-0000-0000-000000000001";
        case "DateTime":
          return LATE_FIELD.test(name) ? "2026-01-08T10:00:00+00:00" : "2026-01-01T10:00:00+00:00";
        case "Date":
          return LATE_FIELD.test(name) ? "2026-01-08" : "2026-01-01";
      }
      break;
    case "ref":
      return "00000000-0000-0000-0000-0000000000a1";
    case "enum":
      return ctx.enums.find((e) => e.name === t.name)?.values[0];
    case "list":
      return depth > 2 ? [] : [sampleValue(t.item, name, ctx, fieldTypes, depth + 1)];
    case "vo":
    case "entity": {
      if (depth > 3) return {};
      const out: Record<string, unknown> = {};
      // Keep the parent's name so `email.value` gets an e-mail-shaped sample.
      for (const [k, ft] of fieldTypes(t.name)) if (ft.k !== "optional") out[k] = sampleValue(ft, `${name}.${k}`, ctx, fieldTypes, depth + 1);
      return out;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

interface Ctx {
  model: ModelIR;
  fieldTypes: (owner: string) => Map<string, Type>;
}

function load(text: string): Ctx | undefined {
  const parsed = parseModel(text);
  if (!parsed.model) return undefined;
  let analysis;
  try {
    analysis = analyzeModel(parsed.model);
  } catch {
    return undefined;
  }
  return {
    model: parsed.model,
    fieldTypes: (owner) => {
      for (const ca of analysis.contexts.values()) {
        const m = ca.fieldTypes.get(owner);
        if (m) return m;
      }
      return new Map();
    },
  };
}

/** The first enum-typed field of the aggregate (its lifecycle state), if any. */
function stateField(ag: AggregateIR, ctx: ContextIR): { field: string; values: string[] } | undefined {
  for (const f of ag.fields) {
    const r = resolveType(f.type, { context: ctx, aggregate: ag.name });
    if (r.ok && r.type.k === "enum") {
      const en = ctx.enums.find((e) => e.name === (r.type as { name: string }).name);
      if (en) return { field: f.name, values: en.values };
    }
  }
  return undefined;
}

function reachedStates(ag: AggregateIR, field: string): Set<string> {
  const out = new Set<string>();
  for (const m of [...ag.operations.map((o) => o.changes), ...ag.factories.map((f) => f.fields)]) {
    const v = m[field];
    if (v && /^[a-z][a-z0-9_]*$/.test(v)) out.add(v);
  }
  return out;
}

/** Guard that checks `field == value`, e.g. is_open for status == pending. */
function guardFor(ag: AggregateIR, field: string): { name: string; value: string; call: string; error: string } | undefined {
  // Prefer the simplest guard (fewest parameters, shortest condition), e.g. is_open over pending_until_expiry(at).
  const guards = [...ag.stateGuards].sort((a, b) => a.parameters.length - b.parameters.length || a.expression.length - b.expression.length);
  for (const g of guards) {
    const m = new RegExp(`\\b${field}\\s*==\\s*([a-z][a-z0-9_]*)`).exec(g.expression);
    if (m) return { name: g.name, value: m[1]!, call: g.parameters.length ? `${g.name}(${g.parameters.map((p) => p.name).join(", ")})` : g.name, error: g.error };
  }
  return undefined;
}

export interface OperationSketch {
  name: string;
  targetState?: string;
  require?: string;
  params: { name: string; type: string }[];
  event: string;
}

/** Proposes the next operation: a lifecycle state no operation reaches yet (e.g. "revoked" → revoke). */
export function nextOperation(ag: AggregateIR, ctx: ContextIR): OperationSketch | undefined {
  const sf = stateField(ag, ctx);
  const existing = new Set(ag.operations.map((o) => o.name));
  if (sf) {
    const reached = reachedStates(ag, sf.field);
    const initial = ag.factories.map((f) => f.fields[sf.field]).find(Boolean) ?? sf.values[0];
    for (const v of sf.values) {
      if (reached.has(v) || v === initial) continue;
      const verb = verbFromState(v) ?? v;
      if (existing.has(verb)) continue;
      const g = guardFor(ag, sf.field);
      const params = g?.call.includes("(") ? ag.stateGuards.find((x) => x.name === g.name)!.parameters.map((p) => ({ name: p.name, type: p.type })) : [];
      return { name: verb, targetState: v, require: g?.call, params, event: eventNameFor(verb, ag.name, eventsOf(ag)) };
    }
  }
  return undefined;
}

function yamlScalar(v: unknown): string {
  if (typeof v === "string") return /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(yamlScalar).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${yamlScalar(x)}`).join(", ")} }`;
  return String(v);
}

function operationLines(op: OperationSketch, stateFieldName?: string): string[] {
  const lines = [`name: ${op.name}`];
  if (op.params.length) {
    lines.push("parameters:");
    for (const p of op.params) lines.push(`  - { name: ${p.name}, type: ${p.type} }`);
  }
  if (op.require) lines.push(`require: [${op.require}]`);
  if (op.targetState && stateFieldName) lines.push("changes:", `  ${stateFieldName}: ${op.targetState}`);
  lines.push("emits:", `  - name: ${op.event}`, `    fields: [id${op.params.map((p) => `, ${p.name}`).join("")}]`);
  return lines;
}

export interface ScenarioSketch {
  name: string;
  lines: string[];
}

/** A failing scenario for an operation guarded by `field == value`, or a success scenario. */
export function scenarioFor(ag: AggregateIR, ctx: ContextIR, fieldTypes: Ctx["fieldTypes"]): ScenarioSketch | undefined {
  const existing = new Set(ag.scenarios.map((s) => s.name));
  const types = fieldTypes(ag.name);
  const sf = stateField(ag, ctx);
  const given = (overrides: Record<string, unknown>) => {
    const g: Record<string, unknown> = {};
    for (const [k, t] of types) if (t.k !== "optional") g[k] = sampleValue(t, k, ctx, fieldTypes);
    return { ...g, ...overrides };
  };
  const argsFor = (op: OperationIR) => {
    const out: Record<string, unknown> = {};
    for (const p of op.parameters) {
      const r = resolveType(p.type, { context: ctx, aggregate: ag.name });
      if (r.ok && p.required) out[p.name] = r.type.k === "primitive" && r.type.name === "DateTime" ? "2026-01-02T10:00:00+00:00" : sampleValue(r.type, p.name, ctx, fieldTypes);
    }
    return out;
  };
  const block = (name: string, givenMap: Record<string, unknown>, op: OperationIR, then: string[]) => {
    const args = argsFor(op);
    return [
      `name: ${name}`,
      "given:",
      "  aggregate:",
      ...Object.entries(givenMap).map(([k, v]) => `    ${k}: ${yamlScalar(v)}`),
      "when:",
      `  operation: ${op.name}`,
      ...(Object.keys(args).length ? [`  args: ${yamlScalar(args)}`] : []),
      "then:",
      ...then.map((l) => `  ${l}`),
    ];
  };
  for (const op of ag.operations) {
    for (const req of op.require) {
      const gName = /^([a-z][a-z0-9_]*)/.exec(req)?.[1];
      const g = ag.stateGuards.find((x) => x.name === gName);
      const cond = g && sf ? new RegExp(`\\b${sf.field}\\s*==\\s*([a-z][a-z0-9_]*)`).exec(g.expression) : null;
      if (!g || !sf || !cond) continue;
      // A violating state that no invariant talks about, so the guard (not an invariant) is what fails.
      const mentioned = (v: string) => ag.invariants.some((inv) => new RegExp(`\\b${v}\\b`).test(inv.expression));
      const others = sf.values.filter((v) => v !== cond[1]);
      const other = others.find((v) => !mentioned(v)) ?? others[0];
      const name = `${op.name}_is_rejected_when_${other}`;
      if (!other || existing.has(name)) continue;
      return { name, lines: block(name, given({ [sf.field]: other }), op, [`raises: ${g.error}`]) };
    }
  }
  for (const op of ag.operations) {
    const name = `${op.name}_succeeds`;
    if (existing.has(name)) continue;
    const g = op.require.map((r) => ag.stateGuards.find((x) => r.startsWith(x.name))).find(Boolean);
    const cond = g && sf ? new RegExp(`\\b${sf.field}\\s*==\\s*([a-z][a-z0-9_]*)`).exec(g.expression) : null;
    const state: string[] = Object.entries(op.changes)
      .filter(([, v]) => /^[a-z][a-z0-9_]*$/.test(v) && !op.parameters.some((p) => p.name === v))
      .map(([k, v]) => `${k}: ${v}`);
    const then = [...(state.length ? [`state: { ${state.join(", ")} }`] : []), ...(op.emits.length ? [`emits: [${op.emits.map((e) => e.name).join(", ")}]`] : [])];
    if (!then.length) continue;
    return { name, lines: block(name, given(cond && sf ? { [sf.field]: cond[1] } : {}), op, then) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Inline suggestion (ghost text)
// ---------------------------------------------------------------------------

export interface InlineSuggestion {
  /** Text inserted at the cursor. */
  text: string;
  /** Short description shown next to the ghost text. */
  label: string;
}

/** Keys of the block mappings enclosing a line with the given indentation (root first). */
function chainAt(lines: string[], lineIdx: number, indent: number): string[] {
  const chain: string[] = [];
  let cur = indent;
  for (let i = lineIdx - 1; i >= 0 && cur > 0; i--) {
    const l = lines[i]!;
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    const m = /^(\s*)(-\s+)?(?:([A-Za-z_]\w*)\s*:(.*))?/.exec(l)!;
    const base = m[1]!.length;
    const keyIndent = base + (m[2]?.length ?? 0);
    if (!m[3]) {
      if (m[2] && base < cur) cur = base;
      continue;
    }
    if (keyIndent < cur) {
      if (!m[4]!.trim() || m[4]!.trim().startsWith("#")) chain.unshift(m[3]);
      cur = m[2] ? base : keyIndent;
    }
  }
  return chain;
}

function enclosing(ctxModel: ModelIR, lines: string[], lineIdx: number): { ctx?: ContextIR; ag?: AggregateIR; op?: OperationIR } {
  // Walk up to find `- name: X` lines under contexts / aggregates / operations.
  const names: { key: string; name: string }[] = [];
  let indent = Infinity;
  for (let i = lineIdx; i >= 0; i--) {
    const l = lines[i]!;
    const m = /^(\s*)-\s+name:\s*([A-Za-z_]\w*)/.exec(l);
    if (!m || m[1]!.length >= indent) continue;
    indent = m[1]!.length;
    const chain = chainAt(lines, i, m[1]!.length + 1);
    names.unshift({ key: chain[chain.length - 1] ?? "", name: m[2]! });
  }
  const ctx = ctxModel.contexts.find((c) => c.name === names.find((n) => n.key === "contexts")?.name);
  const ag = ctx?.aggregates.find((a) => a.name === names.find((n) => n.key === "aggregates")?.name);
  const op = ag?.operations.find((o) => o.name === names.find((n) => n.key === "operations")?.name);
  return { ctx, ag, op };
}

function indentBlock(lines: string[], indent: number, firstInline: boolean): string {
  const pad = " ".repeat(indent);
  return lines.map((l, i) => (i === 0 && firstInline ? l : `${pad}${l}`)).join("\n");
}

function errorsCount(text: string): number {
  const r = validateModelText(text);
  return r.diagnostics.filter((d) => d.severity === "error").length;
}

/**
 * Predicts what comes next at the cursor. Only offered at the end of a line, and only when inserting it
 * does not add validation errors.
 */
export function suggestInline(text: string, offset: number): InlineSuggestion | undefined {
  try {
    return suggestUnchecked(text, offset);
  } catch {
    return undefined;
  }
}

function suggestUnchecked(text: string, offset: number): InlineSuggestion | undefined {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEndRaw = text.indexOf("\n", offset);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  if (text.slice(offset, lineEnd).trim()) return undefined; // only at the end of a line
  const prefix = text.slice(lineStart, offset);
  const lines = text.split("\n");
  const lineIdx = text.slice(0, offset).split("\n").length - 1;

  // Context from the document without the current (possibly incomplete) line.
  const others = text.slice(0, lineStart) + text.slice(lineEnd);
  const c = load(others) ?? load(text);
  if (!c) return undefined;
  const where = enclosing(c.model, lines, Math.max(0, lineIdx - 1));
  const ctx = where.ctx;
  if (!ctx) return undefined;

  const dash = /^(\s*)-\s*$/.exec(prefix);
  const blank = /^(\s*)$/.exec(prefix);
  const keyValue = /^(\s*)(-\s+)?([A-Za-z_]\w*):\s*$/.exec(prefix);
  const accept = (sugg: InlineSuggestion): InlineSuggestion | undefined => {
    const before = errorsCount(text);
    const after = errorsCount(text.slice(0, offset) + sugg.text + text.slice(offset));
    return after <= before ? sugg : undefined;
  };

  // New list item: `- ` or a blank line at item indentation.
  const itemIndent = dash ? dash[1]!.length : blank ? blank[1]!.length : -1;
  if (itemIndent >= 0) {
    const chain = chainAt(lines, lineIdx, itemIndent + 1);
    const list = chain[chain.length - 1];
    const lead = dash ? (prefix.endsWith(" ") ? "" : " ") : "- ";
    const keyIndent = itemIndent + 2;
    const ag = where.ag;
    if (list === "operations" && ag) {
      const op = nextOperation(ag, ctx);
      if (op) return accept({ text: lead + indentBlock(operationLines(op, stateField(ag, ctx)?.field), keyIndent, true), label: `次の操作: ${op.name}（${op.targetState ?? ""}へ）` });
    }
    if (list === "state_guards" && ag) {
      const sf = stateField(ag, ctx);
      const has = new Set(ag.stateGuards.map((g) => g.name));
      const value = sf?.values.find((v) => !has.has(`is_${v}`));
      if (sf && value && ctx.errors[0]) {
        return accept({ text: lead + indentBlock([`name: is_${value}`, `expression: ${sf.field} == ${value}`, `error: ${ctx.errors[0].name}`], keyIndent, true), label: `ガード: is_${value}` });
      }
    }
    if (list === "scenarios" && ag) {
      const s = scenarioFor(ag, ctx, c.fieldTypes);
      if (s) return accept({ text: lead + indentBlock(s.lines, keyIndent, true), label: `シナリオ: ${s.name}` });
    }
    if (list === "use_cases") {
      const invoked = new Set(ctx.useCases.flatMap((u) => JSON.stringify(u.steps).match(/"operation":"(\w+)"/g) ?? []).map((m) => m.slice(13, -1)));
      for (const a of ctx.aggregates) {
        const op = a.operations.find((o) => !invoked.has(o.name) && o.parameters.every((p) => !p.required || /DateTime/.test(p.type)));
        if (!op) continue;
        const idField = `${toSnake(a.name)}_id`;
        const variable = toSnake(a.name);
        const args = op.parameters.filter((p) => p.required).map((p) => `${p.name}: clock.now`);
        const ucName = ctx.useCases.some((u) => u.name === op.name) ? `${op.name}_${variable}` : op.name;
        const body = [
          `name: ${ucName}`,
          `command: ${pascal(ucName)}`,
          "transaction: required",
          "input:",
          `  - { name: ${idField}, type: UUID }`,
          "steps:",
          `  - load: { aggregate: ${a.name}, by: ${idField}, as: ${variable}${ctx.errors.some((e) => e.name === `${a.name}NotFound`) ? `, not_found: ${a.name}NotFound` : ""} }`,
          `  - invoke: { target: ${variable}, operation: ${op.name}${args.length ? `, args: { ${args.join(", ")} }` : ""} }`,
          `  - save: ${variable}`,
          ...op.emits.map((e) => `  - publish_after_commit: ${e.name}`),
        ];
        return accept({ text: lead + indentBlock(body, keyIndent, true), label: `Use case: ${ucName}` });
      }
    }
    if (list === "errors") {
      const used = [...ctx.aggregates.flatMap((a) => [...a.invariants, ...a.stateGuards].map((r) => r.error))];
      const missing = used.find((e) => !ctx.errors.some((x) => x.name === e));
      if (missing) {
        return accept({ text: lead + indentBlock([`name: ${missing}`, `code: ${toSnake(missing)}`, `message: ${missing}`], keyIndent, true), label: `エラーの定義: ${missing}` });
      }
    }
    return undefined;
  }

  // `key:` with an empty value.
  if (keyValue && where.ag) {
    const ag = where.ag;
    const key = keyValue[3]!;
    const indent = keyValue[1]!.length + (keyValue[2]?.length ?? 0);
    const op = where.op;
    if (key === "emits" && op && op.emits.length === 0) {
      const params = op.parameters.map((p) => p.name);
      const body = [`- name: ${eventNameFor(op.name, ag.name, eventsOf(ag))}`, `  fields: [id${params.map((p) => `, ${p}`).join("")}]`];
      return accept({ text: `\n${indentBlock(body, indent + 2, false)}`, label: "イベントの内容" });
    }
    if (key === "changes" && op && Object.keys(op.changes).length === 0) {
      const sf = stateField(ag, ctx);
      const target = sf?.values.find((v) => verbFromState(v) === op.name.split("_")[0]);
      if (sf && target) return accept({ text: `\n${" ".repeat(indent + 2)}${sf.field}: ${target}`, label: `状態を ${target} に` });
    }
    if (key === "require" && op && op.require.length === 0) {
      const sf = stateField(ag, ctx);
      const g = sf ? guardFor(ag, sf.field) : undefined;
      if (g) return accept({ text: ` [${g.call}]`, label: `前提: ${g.name}` });
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Local proposals (used when no LLM is configured)
// ---------------------------------------------------------------------------

export type ProposalKind = "scenarios" | "next-operation" | "guards" | "events";

export interface Proposal {
  yaml: string;
  summary: string[];
  /** What the proposal is based on (facts read from the model). */
  facts: string[];
  /** What was guessed and needs review. */
  assumptions: string[];
  /** Questions for the domain expert. */
  questions: string[];
  source: "local" | "llm";
}

/** Structural proposal for one aggregate, computed locally. Returns undefined when there is nothing to propose. */
export function proposeLocally(text: string, contextName: string, aggregateName: string, kind: ProposalKind): Proposal | undefined {
  const c = load(text);
  if (!c) return undefined;
  const ctxIndex = c.model.contexts.findIndex((x) => x.name === contextName);
  const ctx = c.model.contexts[ctxIndex];
  const agIndex = ctx?.aggregates.findIndex((a) => a.name === aggregateName) ?? -1;
  const ag = ctx?.aggregates[agIndex];
  if (!ctx || !ag) return undefined;
  const base = ["contexts", ctxIndex, "aggregates", agIndex];
  const ops: EditOp[] = [];
  const summary: string[] = [];
  const facts: string[] = [];
  const assumptions: string[] = [];
  const questions: string[] = [];
  const sf = stateField(ag, ctx);
  if (sf) facts.push(`${ag.name} の状態は ${sf.field}（${sf.values.join(" / ")}）で表されています`);

  if (kind === "next-operation") {
    const op = nextOperation(ag, ctx);
    if (!op) return undefined;
    const value: Record<string, unknown> = { name: op.name };
    if (op.params.length) value.parameters = op.params.map((p) => ({ name: p.name, type: p.type }));
    if (op.require) value.require = [op.require];
    if (op.targetState && sf) value.changes = { [sf.field]: op.targetState };
    value.emits = [{ name: op.event, fields: ["id", ...op.params.map((p) => p.name)] }];
    ops.push({ op: "add", path: [...base, "operations"], value });
    summary.push(`操作 ${op.name} を追加（${sf?.field} を ${op.targetState} にする）`);
    facts.push(`どの操作も ${sf?.field} を ${op.targetState} にしていません`);
    assumptions.push(`${op.targetState} にする操作の名前を「${op.name}」と推測しました`, op.require ? `前提ガードに ${op.require} を使うと推測しました` : "前提ガードは付けていません");
    questions.push(`どの状態から ${op.targetState} にできますか？`, `${op.targetState} にするとき、ほかに変わる値はありますか？`);
  }
  if (kind === "guards" && sf) {
    const has = new Set(ag.stateGuards.map((g) => g.name));
    const err = ctx.errors[0]?.name;
    for (const v of sf.values) {
      if (has.has(`is_${v}`) || !err) continue;
      ops.push({ op: "add", path: [...base, "state_guards"], value: { name: `is_${v}`, expression: `${sf.field} == ${v}`, error: err } });
      summary.push(`State guard is_${v} を追加`);
    }
    if (err) assumptions.push(`違反時のエラーは既存の ${err} を仮に使っています。業務に合うエラーを定義してください`);
    questions.push("状態ごとに、してはいけない操作はどれですか？");
  }
  if (kind === "scenarios") {
    let working = text;
    for (let i = 0; i < 6; i++) {
      const cc = load(working);
      const a = cc?.model.contexts[ctxIndex]?.aggregates[agIndex];
      if (!cc || !a) break;
      const s = scenarioFor(a, cc.model.contexts[ctxIndex]!, cc.fieldTypes);
      if (!s) break;
      const doc = parseModel(working);
      if (!doc.model) break;
      const valueYaml = s.lines.join("\n");
      const value = parseYamlBlock(valueYaml);
      const r = applyEdits(working, [{ op: "add", path: [...base, "scenarios"], value }]);
      if (!r.ok) break;
      working = r.text;
      summary.push(`シナリオ ${s.name} を追加`);
    }
    if (!summary.length) return undefined;
    assumptions.push("前提の値（ID・日時・文字列）はサンプルです。業務の具体例に置き換えてください");
    questions.push("この操作が失敗する業務上のケースは、ほかにありますか？");
    facts.push("State guard を前提にする操作と、その違反時のエラーから失敗するケースを作りました");
    const v = validateModelText(working);
    if (!v.ok) return undefined;
    return { yaml: working, summary, facts, assumptions, questions, source: "local" };
  }
  if (kind === "events") {
    for (const [i, op] of ag.operations.entries()) {
      if (op.emits.length) continue;
      const name = eventNameFor(op.name, ag.name, eventsOf(ag));
      ops.push({ op: "add", path: [...base, "operations", i, "emits"], value: { name, fields: ["id", ...op.parameters.map((p) => p.name)] } });
      summary.push(`${op.name} にイベント ${name} を追加`);
    }
    assumptions.push("イベントの内容は識別子と操作の引数にしています。受け取る側が必要とする情報を確認してください");
  }
  if (!ops.length) return undefined;
  const r = applyEdits(text, ops);
  if (!r.ok) return undefined;
  return { yaml: r.text, summary, facts, assumptions, questions, source: "local" };
}

function parseYamlBlock(src: string): unknown {
  return yamlParse(src);
}

// ---------------------------------------------------------------------------
// Board suggestions (ghost stickies)
// ---------------------------------------------------------------------------

export interface BoardGhost {
  id: string;
  kind: StickyKind;
  text: string;
  x: number;
  y: number;
  /** Connector to add when the ghost is accepted. */
  connect?: { from: string; to: string };
  reason: string;
  source: "local" | "llm";
}

/** Predicts the next stickies from the board's structure (EventStorming grammar). */
export function boardGhosts(board: Board): BoardGhost[] {
  const out: BoardGhost[] = [];
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const occupied = (x: number, y: number) => board.items.some((i) => Math.abs(i.x - x) < 120 && Math.abs(i.y - y) < 70);
  for (const c of board.items.filter((i) => i.kind === "command" && i.text.trim())) {
    if (board.connectors.some((k) => k.from === c.id && byId.get(k.to)?.kind === "event")) continue;
    let x = c.x + c.w + 40;
    const y = c.y;
    while (occupied(x, y)) x += 40;
    out.push({ id: `ghost-evt-${c.id}`, kind: "event", text: eventTextFor(c.text), x, y, connect: { from: c.id, to: `ghost-evt-${c.id}` }, reason: `「${c.text}」が成功したときに起きる出来事`, source: "local" });
  }
  for (const e of board.items.filter((i) => i.kind === "event" && i.text.trim())) {
    if (board.connectors.some((k) => k.to === e.id && ["command", "policy", "external_system", "aggregate"].includes(byId.get(k.from)?.kind ?? ""))) continue;
    let x = e.x - 200;
    const y = e.y;
    while (occupied(x, y)) x -= 40;
    out.push({ id: `ghost-cmd-${e.id}`, kind: "command", text: commandTextFor(e.text), x, y, connect: { from: `ghost-cmd-${e.id}`, to: e.id }, reason: `「${e.text}」を起こす操作`, source: "local" });
  }
  for (const cand of suggestAggregates(board)) {
    if (cand.aggregateItemId || !cand.commandIds.length || !cand.name) continue;
    out.push({ id: `ghost-agg-${cand.id}`, kind: "aggregate", text: cand.name, x: cand.position.x, y: cand.position.y, reason: `${cand.commandIds.length} 個のコマンドを受け止める集約の案`, source: "local" });
  }
  return out.slice(0, 12);
}
