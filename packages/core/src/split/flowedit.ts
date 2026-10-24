/**
 * Editing one .flow block (a use case, query or policy) of a YAML model (docs/11 §12): the block is shown as the
 * .flow file writes it, and the edited block is read back through the multi-file assembler, so it means exactly
 * what it would in a .flow file. Only the keys a .flow block owns are written back into the YAML document; the
 * rest of the file (comments, order, the declarations of the .proto side) is left as it was.
 */
import { parse as parseYaml, parseDocument } from "yaml";
import type { Diagnostic, Path } from "../diagnostics.ts";
import { applyEdits, type EditOp } from "../edit.ts";
import { parseModel } from "../parse.ts";
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_MIN_SIMILARITY, DEFAULT_PAGE_SIZE, RELEVANCE } from "../queries.ts";
import { validateModelText } from "../validate.ts";
import { parseFlow } from "./behavior.ts";
import { validateModelFiles } from "./assemble.ts";
import { contextFlowBlocks, flowFileText, splitModelText, type FlowBlock } from "./emit.ts";
import { SplitSyntaxError } from "./lexer.ts";

export type { FlowBlock };

export interface FlowEditRef {
  context: string;
  kind: FlowBlock["kind"];
  name: string;
}

/** A problem in the edited block; `line` / `column` are 1-based within the block when known. */
export interface FlowEditProblem {
  message: string;
  hint?: string;
  line?: number;
  column?: number;
  code?: string;
}

export type FlowEditResult = { ok: true; text: string; changed: boolean } | { ok: false; error: string; problems: FlowEditProblem[] };

/** Keys of a YAML item that its .flow block decides (the rest comes from the .proto side). */
const OWNED: Record<FlowBlock["kind"], string[]> = {
  use_case: ["steps", "authorize"],
  query: ["from", "where", "search", "order_by", "page", "returns", "authorize"],
  policy: ["description", "when", "run", "args"],
};
const SECTION: Record<FlowBlock["kind"], string> = { use_case: "use_cases", query: "queries", policy: "policies" };
const KEYWORD: Record<FlowBlock["kind"], string> = { use_case: "flow", query: "query", policy: "policy" };

/** The .flow blocks of every context of a YAML model (empty when the model cannot be read). */
export function flowBlocks(text: string): { context: string; blocks: FlowBlock[] }[] {
  const parsed = parseModel(text);
  if (!parsed.model) return [];
  const doc = parseDocument(text);
  return parsed.model.contexts.map((ctx) => ({ context: ctx.name, blocks: contextFlowBlocks(ctx, doc) }));
}

export function flowBlock(text: string, ref: FlowEditRef): FlowBlock | undefined {
  return flowBlocks(text)
    .find((c) => c.context === ref.context)
    ?.blocks.find((b) => b.kind === ref.kind && b.name === ref.name);
}

const fail = (error: string, problems: FlowEditProblem[] = []): FlowEditResult => ({ ok: false, error, problems });
const diagKey = (d: Diagnostic) => `${d.code}\u0000${d.message}\u0000${(d.path ?? []).join(".")}`;

/**
 * Replaces one block with `source` and writes the result into the YAML model. Refused (with the problems) when the
 * block does not read, names another block, or makes the model invalid where it was valid.
 */
export function applyFlowBlock(text: string, ref: FlowEditRef, source: string): FlowEditResult {
  const split = splitModelText(text);
  const parsed = parseModel(text);
  if (!parsed.model || !Object.keys(split.files).length) return fail("モデルにエラーがあるため、フローを書き換えられません。先にモデルを直してください。");
  const ctx = parsed.model.contexts.find((c) => c.name === ref.context);
  if (!ctx) return fail(`コンテキスト ${ref.context} がありません`);
  const doc = parseDocument(text);
  const blocks = contextFlowBlocks(ctx, doc);
  const index = blocks.findIndex((b) => b.kind === ref.kind && b.name === ref.name);
  if (index < 0) return fail(`${ref.name} がモデルにありません`);
  if (source.replace(/\s+$/, "") === blocks[index]!.source.replace(/\s+$/, "")) return { ok: true, text, changed: false };

  // The block alone must read as one block of the same kind and name.
  const header = `context ${ref.context}\n\n`;
  try {
    const one = parseFlow(header + source);
    const all = [...one.flows.map((x) => ({ kind: "use_case", name: x.name })), ...one.queries.map((x) => ({ kind: "query", name: x.name })), ...one.policies.map((x) => ({ kind: "policy", name: x.name }))];
    if (all.length !== 1) return fail(`ここには ${KEYWORD[ref.kind]} ${ref.name} を 1 つだけ書いてください（${all.length} 個あります）`);
    if (all[0]!.kind !== ref.kind || all[0]!.name !== ref.name) {
      return fail(`名前と種類は変えられません: ${KEYWORD[ref.kind]} ${ref.name} のまま書いてください`);
    }
  } catch (e) {
    if (e instanceof SplitSyntaxError) return fail("書き方に誤りがあります", [{ message: e.message, ...(e.hint ? { hint: e.hint } : {}), line: e.tok.line - 2, column: e.tok.col, code: "syntax" }]);
    throw e;
  }

  // Read it back through the assembler, in the context's .flow file.
  const flowPath = Object.keys(split.files).find((p) => p.endsWith(".flow") && split.files[p]!.startsWith(`context ${ref.context}\n`));
  if (!flowPath) return fail(`${ref.context} の .flow がありません`);
  const sources = blocks.map((b, i) => (i === index ? source : b.source));
  const files = { ...split.files, [flowPath]: flowFileText(ref.context, sources) };
  // First line of the block in the file: the header and the blocks before it, each followed by a blank line.
  const start = [`context ${ref.context}`, ...sources.slice(0, index).map((b) => b.replace(/\s+$/, ""))].join("\n\n").split("\n").length + 2;
  const lines = source.replace(/\s+$/, "").split("\n").length;
  // Semantic errors too (unknown variables, unsaved changes...), located in the .flow file; errors the model already had do not block.
  const known = (d: Diagnostic) => `${d.code}\u0000${d.message}`;
  const had = new Set(validateModelFiles(split.files).diagnostics.filter((d) => d.severity === "error").map(known));
  const checked = validateModelFiles(files);
  const assembled = checked.parsed;
  const errors = checked.diagnostics.filter((d) => d.severity === "error" && !had.has(known(d)));
  if (errors.length) {
    return fail(
      "このフローはモデルとして読めません",
      errors.map((d) => {
        const inBlock = d.file === flowPath && d.line !== undefined && d.line >= start && d.line < start + lines;
        return { message: d.message, ...(d.hint ? { hint: d.hint } : {}), code: d.code, ...(inBlock ? { line: d.line! - start + 1, column: d.column } : {}) };
      }),
    );
  }
  const ctxData = ((assembled.data?.contexts as Record<string, unknown>[] | undefined) ?? []).find((c) => c.name === ref.context);
  const item = ((ctxData?.[SECTION[ref.kind]] as Record<string, unknown>[] | undefined) ?? []).find((x) => x.name === ref.name);
  if (!item) return fail(`${ref.name} を読み戻せませんでした`);

  // Write back only what changed among the keys the block owns.
  const original = parseYaml(text) as Record<string, unknown>;
  const ci = parsed.model.contexts.indexOf(ctx);
  const list = ((original.contexts as Record<string, unknown>[])[ci]![SECTION[ref.kind]] as Record<string, unknown>[]) ?? [];
  const ii = list.findIndex((x) => x.name === ref.name);
  const old = list[ii]!;
  const base: Path = ["contexts", ci, SECTION[ref.kind], ii];
  const ops: EditOp[] = [];
  for (const key of OWNED[ref.kind]) {
    const prev = old[key];
    const next = reuse(item[key], prev, key);
    if (canonical(key, next) === canonical(key, prev)) continue;
    ops.push(next === undefined ? { op: "remove", path: [...base, key] } : { op: "set", path: [...base, key], value: next });
  }
  if (!ops.length) return { ok: true, text, changed: false };
  const r = applyEdits(text, ops);
  if (!r.ok) return fail(r.error);
  const was = new Set(validateModelText(text).diagnostics.filter((d) => d.severity === "error").map(diagKey));
  const added = validateModelText(r.text).diagnostics.filter((d) => d.severity === "error" && !was.has(diagKey(d)));
  if (added.length) return fail("この変更はモデルを不正にするため適用しませんでした", added.map((d) => ({ message: d.message, ...(d.hint ? { hint: d.hint } : {}), code: d.code })));
  return { ok: true, text: r.text, changed: true };
}

/**
 * The read-back value with the original's scalars kept where they say the same (`return: true` stays a boolean, not
 * the string the .flow reader gives), so unchanged steps keep their spelling in the YAML.
 */
function reuse(next: unknown, prev: unknown, key = ""): unknown {
  if (prev === undefined || prev === null) return literal(next, key);
  if (typeof next === "string" && typeof prev !== "object" && String(prev) === next) return prev;
  if (Array.isArray(next) && Array.isArray(prev)) {
    // Match items by meaning first (an inserted step shifts the rest), then by position.
    const free = prev.map((p) => [loose(p), p] as const);
    return next.map((x, i) => {
      const at = free.findIndex(([k]) => k === loose(x));
      if (at >= 0) return reuse(x, free.splice(at, 1)[0]![1], key);
      return reuse(x, prev[i], key);
    });
  }
  if (next && typeof next === "object" && !Array.isArray(next) && typeof prev === "object" && !Array.isArray(prev)) {
    // The original's key order first (an unchanged flow-style step keeps its line), new keys after.
    const p = prev as Record<string, unknown>;
    const n = next as Record<string, unknown>;
    const keys = [...Object.keys(p).filter((k) => k in n), ...Object.keys(n).filter((k) => !(k in p))];
    return Object.fromEntries(keys.map((k) => [k, reuse(n[k], p[k], key === "args" ? key : k)]));
  }
  return literal(next, key);
}

/** Every scalar as a string: `true` and "true" read the same in an expression. */
const loose = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (x === null || typeof x === "object" ? x : String(x)));

/** Expression values the .flow reader returns as strings, written the way a person writes them in YAML (`return: false`). */
const EXPRESSION_KEYS = new Set(["return", "value", "by", "args"]);
function literal(v: unknown, key: string): unknown {
  if (Array.isArray(v)) return v.map((x) => literal(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, literal(x, key === "args" ? key : k)]));
  if (typeof v !== "string" || !EXPRESSION_KEYS.has(key)) return v;
  if (v === "true" || v === "false") return v === "true";
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Equal meaning, different spelling: defaults written out or left out, key order, `true` / "true", a bare order field. */
function canonical(key: string, v: unknown): string {
  return loose(sortKeys(normalize(key, v)));
}

function normalize(key: string, v: unknown): unknown {
  if (key === "order_by" && Array.isArray(v)) {
    return v.map((o) => {
      const x = typeof o === "string" ? { field: o } : (o as { field: string; direction?: string });
      return { field: x.field, direction: x.direction ?? (x.field === RELEVANCE ? "desc" : "asc") };
    });
  }
  if (key === "page" && v && typeof v === "object") {
    const p = v as { size?: number; max_size?: number };
    const size = p.size ?? DEFAULT_PAGE_SIZE;
    return { size, max_size: p.max_size ?? Math.max(DEFAULT_MAX_PAGE_SIZE, size) };
  }
  if (key === "page" && v === undefined) return { size: DEFAULT_PAGE_SIZE, max_size: DEFAULT_MAX_PAGE_SIZE };
  if (key === "search" && v && typeof v === "object") {
    const x = v as { mode?: string; min_similarity?: number };
    return x.mode === "trigram" || x.mode === undefined ? { ...x, min_similarity: x.min_similarity ?? DEFAULT_MIN_SIMILARITY } : v;
  }
  return v;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
