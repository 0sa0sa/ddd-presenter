/**
 * Rendering of the architecture model (architecture.ts): a small layered auto layout, Mermaid flowcharts,
 * the generated ARCHITECTURE.md, and SVG / draw.io exports of a positioned view. Pure and deterministic.
 */
import type { ArchElement, ArchKind, ArchView, Architecture } from "./architecture.ts";

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Sizes and auto layout
// ---------------------------------------------------------------------------

const WIDTH: Partial<Record<ArchKind, number>> = { person: 200, role: 200, port: 220, adapter: 220 };

/** Width units of a string (CJK characters count double). */
function units(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return n;
}

/** Box of an element in every rendering (Web nodes use it too, so auto-placed boxes never overlap). */
export function archNodeSize(e: ArchElement): Size {
  const w = WIDTH[e.kind] ?? 240;
  const perLine = Math.floor((w - 24) / 6.6);
  const label = Math.min(2, Math.max(1, Math.ceil(units(e.label) / Math.floor((w - 24) / 8.4))));
  const desc = e.description ? Math.min(2, Math.ceil(units(e.description) / perLine)) : 0;
  const badgeRows = e.badges.length ? Math.min(3, Math.ceil(e.badges.reduce((n, b) => n + units(b) + 4, 0) / perLine)) : 0;
  const h = 18 + label * 20 + (e.technology ? 16 : 0) + desc * 16 + badgeRows * 22 + 8;
  return { w, h: Math.max(64, h) };
}

const LAYER_GAP = 96;
const NODE_GAP = 48;
const MAX_PER_ROW = 6;

/**
 * Layered layout (top to bottom): cycles broken by DFS, longest-path layers, barycenter ordering, wide layers wrapped
 * into rows of at most six. Deterministic for the same view.
 */
export function layoutArchitecture(view: ArchView): Record<string, Point> {
  const ids = view.elements.map((e) => e.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const seen = new Set<string>();
  for (const r of view.relations) {
    if (!index.has(r.source) || !index.has(r.target) || r.source === r.target) continue;
    const [from, to] = r.upward ? [r.target, r.source] : [r.source, r.target];
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.get(from)!.push(to);
  }
  // Break cycles: drop edges to a node on the DFS stack.
  const state = new Map<string, 1 | 2>();
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const visit = (n: string) => {
    state.set(n, 1);
    for (const m of out.get(n)!) {
      if (state.get(m) === 1) continue;
      dag.get(n)!.push(m);
      if (!state.has(m)) visit(m);
    }
    state.set(n, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  // Longest path from the sources.
  const layer = new Map<string, number>();
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const [, ms] of dag) for (const m of ms) indeg.set(m, indeg.get(m)! + 1);
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!;
    for (const m of dag.get(n)!) {
      layer.set(m, Math.max(layer.get(m) ?? 0, layer.get(n)! + 1));
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  const layers: string[][] = [];
  for (const id of ids) (layers[layer.get(id) ?? 0] ??= []).push(id);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [n, ms] of dag) for (const m of ms) preds.get(m)!.push(n);
  // Barycenter sweeps (down, then up).
  const order = new Map<string, number>();
  const renumber = () => layers.forEach((l) => l?.forEach((id, i) => order.set(id, i)));
  renumber();
  const bary = (id: string, nbrs: string[]) => (nbrs.length ? nbrs.reduce((s, n) => s + order.get(n)!, 0) / nbrs.length : order.get(id)!);
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const seq = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
    for (const li of seq) {
      const l = layers[li];
      if (!l) continue;
      const key = new Map(l.map((id) => [id, bary(id, down ? preds.get(id)! : dag.get(id)!)]));
      l.sort((a, b) => key.get(a)! - key.get(b)! || index.get(a)! - index.get(b)!);
      l.forEach((id, i) => order.set(id, i));
    }
  }
  const size = new Map(view.elements.map((e) => [e.id, archNodeSize(e)]));
  const rows: string[][] = [];
  for (const l of layers) {
    if (!l?.length) continue;
    for (let i = 0; i < l.length; i += MAX_PER_ROW) rows.push(l.slice(i, i + MAX_PER_ROW));
  }
  const rowWidth = (r: string[]) => r.reduce((s, id) => s + size.get(id)!.w, 0) + NODE_GAP * (r.length - 1);
  const maxWidth = Math.max(0, ...rows.map(rowWidth));
  const pos: Record<string, Point> = {};
  let y = 0;
  for (const r of rows) {
    let x = Math.round((maxWidth - rowWidth(r)) / 2);
    for (const id of r) {
      pos[id] = { x, y };
      x += size.get(id)!.w + NODE_GAP;
    }
    y += Math.max(...r.map((id) => size.get(id)!.h)) + LAYER_GAP;
  }
  return pos;
}

/**
 * Positions of every element: saved ones as they are; the others from the auto layout when nothing is saved, else in
 * rows below the saved ones (so a new element never lands on top of a placed one).
 */
export function placeArchitecture(view: ArchView, saved: Record<string, Point> = {}): Record<string, Point> {
  const auto = layoutArchitecture(view);
  const kept = view.elements.filter((e) => saved[e.id]);
  if (!kept.length) return auto;
  const pos: Record<string, Point> = {};
  for (const e of kept) pos[e.id] = { x: saved[e.id]!.x, y: saved[e.id]!.y };
  const fresh = view.elements.filter((e) => !saved[e.id]);
  if (!fresh.length) return pos;
  const left = Math.min(...kept.map((e) => pos[e.id]!.x));
  let y = Math.max(...kept.map((e) => pos[e.id]!.y + archNodeSize(e).h)) + LAYER_GAP;
  fresh.sort((a, b) => auto[a.id]!.y - auto[b.id]!.y || auto[a.id]!.x - auto[b.id]!.x);
  for (let i = 0; i < fresh.length; i += MAX_PER_ROW) {
    const row = fresh.slice(i, i + MAX_PER_ROW);
    let x = left;
    for (const e of row) {
      pos[e.id] = { x, y };
      x += archNodeSize(e).w + NODE_GAP;
    }
    y += Math.max(...row.map((e) => archNodeSize(e).h)) + LAYER_GAP;
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** Mermaid node ids of a view's elements and groups: `[A-Za-z0-9_]`, prefixed, unique, stable. */
export function mermaidIds(view: ArchView): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const id of [...view.groups.map((g) => g.id), ...view.elements.map((e) => e.id)]) {
    let m = `n_${id.replace(/[^A-Za-z0-9]+/g, "_").replace(/_+$/, "")}`;
    if (/[^\x00-\x7f]/.test(id) || used.has(m)) m = `${m}_${fnv(id)}`;
    while (used.has(m)) m = `${m}_`;
    used.add(m);
    ids.set(id, m);
  }
  return ids;
}

/** Text inside a quoted Mermaid label (entity codes for the characters Mermaid would parse). */
export function mermaidText(s: string): string {
  return s.replace(/#/g, "#35;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\r?\n/g, " ");
}

const SHAPE: Record<ArchKind, [string, string]> = {
  person: ['(["', '"])'],
  role: ['{{"', '"}}'],
  context: ['["', '"]'],
  external: ['[["', '"]]'],
  container: ['["', '"]'],
  database: ['[("', '")]'],
  idp: ['[["', '"]]'],
  aggregate: ['["', '"]'],
  use_case: ['("', '")'],
  query: ['("', '")'],
  policy: ['>"', '"]'],
  port: ['[/"', '"/]'],
  adapter: ['["', '"]'],
};

const CLASS_DEFS = [
  "classDef person fill:#08427b,stroke:#052e56,color:#fff",
  "classDef role fill:#5b3f8c,stroke:#3d2a5e,color:#fff",
  "classDef context fill:#1168bd,stroke:#0b4884,color:#fff",
  "classDef container fill:#438dd5,stroke:#2e6295,color:#fff",
  "classDef database fill:#2f7d6d,stroke:#1f5449,color:#fff",
  "classDef external fill:#8a8a8a,stroke:#6b6b6b,color:#fff",
  "classDef component fill:#85bbf0,stroke:#5d82a8,color:#000",
  "classDef port fill:#e8f1fb,stroke:#5d82a8,color:#000",
  "classDef adapter fill:#f4f4f4,stroke:#8a8a8a,color:#000,stroke-dasharray:4 3",
];

function classOf(kind: ArchKind): string {
  switch (kind) {
    case "person":
    case "role":
    case "context":
    case "container":
    case "database":
    case "port":
    case "adapter":
      return kind;
    case "external":
    case "idp":
      return "external";
    default:
      return "component";
  }
}

/** A view as a Mermaid flowchart (C4 colours; contexts / containers / components as nodes, groups as subgraphs). */
export function architectureToMermaid(view: ArchView): string {
  const ids = mermaidIds(view);
  const lines: string[] = ["flowchart TB"];
  const node = (e: ArchElement, indent: string) => {
    const parts = [`<b>${mermaidText(e.label)}</b>`];
    if (e.technology) parts.push(`[${mermaidText(e.technology)}]`);
    if (e.badges.length) parts.push(`<small>${mermaidText(e.badges.join(" · "))}</small>`);
    const [open, close] = SHAPE[e.kind];
    lines.push(`${indent}${ids.get(e.id)}${open}${parts.join("<br/>")}${close}`);
  };
  for (const g of view.groups) {
    const members = view.elements.filter((e) => e.group === g.id);
    if (!members.length) continue;
    lines.push(`  subgraph ${ids.get(g.id)}["${mermaidText(g.label)}"]`);
    for (const e of members) node(e, "    ");
    lines.push("  end");
  }
  for (const e of view.elements) if (!e.group || !view.groups.some((g) => g.id === e.group)) node(e, "  ");
  for (const r of view.relations) {
    const label = mermaidText(r.label) + (r.technology ? `<br/>[${mermaidText(r.technology)}]` : "");
    lines.push(`  ${ids.get(r.source)} ${r.dashed ? "-.->" : "-->"}|"${label}"| ${ids.get(r.target)}`);
  }
  lines.push(...CLASS_DEFS.map((c) => `  ${c}`));
  const byClass = new Map<string, string[]>();
  for (const e of view.elements) {
    const c = classOf(e.kind);
    byClass.set(c, [...(byClass.get(c) ?? []), ids.get(e.id)!]);
  }
  for (const [c, members] of byClass) lines.push(`  class ${members.join(",")} ${c}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// ARCHITECTURE.md
// ---------------------------------------------------------------------------

const cell = (s: string | undefined) => (s ? s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ") : "—");

const KIND_EN: Record<ArchKind, string> = {
  person: "Person",
  role: "Platform role",
  context: "Bounded context",
  external: "External system",
  container: "Container",
  database: "Database",
  idp: "Identity provider",
  aggregate: "Aggregate",
  use_case: "Use case",
  query: "Query",
  policy: "Policy",
  port: "Port",
  adapter: "Adapter",
};

function viewSection(view: ArchView, heading: string): string[] {
  const out: string[] = [heading, "", view.description, "", "```mermaid", architectureToMermaid(view).trimEnd(), "```", ""];
  const label = new Map(view.elements.map((e) => [e.id, e.label]));
  out.push("| Element | Kind | Technology | Description | Badges |", "|---|---|---|---|---|");
  for (const e of view.elements) out.push(`| ${cell(e.label)} | ${KIND_EN[e.kind]} | ${cell(e.technology)} | ${cell(e.description)} | ${e.badges.length ? e.badges.map((b) => `\`${b.replace(/`/g, "")}\``).join(" ") : "—"} |`);
  out.push("");
  if (view.relations.length) {
    out.push("| From | To | Relationship | Technology |", "|---|---|---|---|");
    for (const r of view.relations) out.push(`| ${cell(label.get(r.source))} | ${cell(label.get(r.target))} | ${cell(r.label)} | ${cell(r.technology)} |`);
    out.push("");
  }
  return out;
}

/** The generated ARCHITECTURE.md: L1, L2 and one L3 per context, each a Mermaid diagram plus tables. */
export function architectureMarkdown(arch: Architecture): string {
  const out: string[] = [`<!-- Generated by DDD Presenter from model "${arch.project}". DO NOT EDIT. -->`, "", `# Architecture of ${arch.project}`, ""];
  if (arch.description) out.push(arch.description, "");
  out.push(
    `Derived from the model by \`ddd generate\` (target: ${arch.target}) in the spirit of the C4 model: system context, containers, and the components of each bounded context. The diagrams are Mermaid flowcharts; edit the model, not this file.`,
    "",
  );
  out.push(...viewSection(arch.system, "## 1. System context"));
  out.push(...viewSection(arch.containers, "## 2. Containers"));
  arch.contexts.forEach((v, i) => out.push(...viewSection(v, `## 3.${i + 1} Components of ${v.level.slice("context:".length)}`)));
  return out.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// SVG and draw.io exports of a positioned view
// ---------------------------------------------------------------------------

export const ARCH_FILL: Record<ArchKind, { fill: string; stroke: string; text: string }> = {
  person: { fill: "#08427b", stroke: "#052e56", text: "#ffffff" },
  role: { fill: "#5b3f8c", stroke: "#3d2a5e", text: "#ffffff" },
  context: { fill: "#1168bd", stroke: "#0b4884", text: "#ffffff" },
  container: { fill: "#438dd5", stroke: "#2e6295", text: "#ffffff" },
  database: { fill: "#2f7d6d", stroke: "#1f5449", text: "#ffffff" },
  external: { fill: "#8a8a8a", stroke: "#6b6b6b", text: "#ffffff" },
  idp: { fill: "#8a8a8a", stroke: "#6b6b6b", text: "#ffffff" },
  aggregate: { fill: "#85bbf0", stroke: "#5d82a8", text: "#000000" },
  use_case: { fill: "#85bbf0", stroke: "#5d82a8", text: "#000000" },
  query: { fill: "#a9d0f5", stroke: "#5d82a8", text: "#000000" },
  policy: { fill: "#cfe2f7", stroke: "#5d82a8", text: "#000000" },
  port: { fill: "#e8f1fb", stroke: "#5d82a8", text: "#000000" },
  adapter: { fill: "#f4f4f4", stroke: "#8a8a8a", text: "#000000" },
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function clip(text: string, maxUnits: number): string {
  let n = 0;
  let out = "";
  for (const ch of text) {
    n += ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (n > maxUnits) return `${out}…`;
    out += ch;
  }
  return out;
}

function wrapUnits(text: string, maxUnits: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  let n = 0;
  for (const ch of text) {
    const u = ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (n + u > maxUnits) {
      lines.push(line);
      line = ch === " " ? "" : ch;
      n = line ? u : 0;
    } else {
      line += ch;
      n += u;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const last = clip(lines[maxLines - 1]!, maxUnits - 1);
    return [...lines.slice(0, maxLines - 1), last.endsWith("…") ? last : `${last}…`];
  }
  return lines;
}

interface Box extends Point, Size {}

function boxes(view: ArchView, positions: Record<string, Point>): Map<string, Box> {
  const auto = Object.keys(positions).length ? undefined : layoutArchitecture(view);
  const out = new Map<string, Box>();
  for (const e of view.elements) {
    const p = positions[e.id] ?? auto?.[e.id] ?? { x: 0, y: 0 };
    out.set(e.id, { ...p, ...archNodeSize(e) });
  }
  return out;
}

function groupBoxes(view: ArchView, b: Map<string, Box>): { id: string; label: string; box: Box }[] {
  const out: { id: string; label: string; box: Box }[] = [];
  for (const g of view.groups) {
    const members = view.elements.filter((e) => e.group === g.id).map((e) => b.get(e.id)!);
    if (!members.length) continue;
    const x = Math.min(...members.map((m) => m.x)) - 16;
    const y = Math.min(...members.map((m) => m.y)) - 34;
    const w = Math.max(...members.map((m) => m.x + m.w)) + 16 - x;
    const h = Math.max(...members.map((m) => m.y + m.h)) + 16 - y;
    out.push({ id: g.id, label: g.label, box: { x, y, w, h } });
  }
  return out;
}

function edgeEnds(a: Box, b: Box): [number, number, number, number] {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const at = (box: Box, c: Point, to: Point) => {
    const dx = to.x - c.x;
    const dy = to.y - c.y;
    const s = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity, 1);
    return { x: Math.round(c.x + dx * s), y: Math.round(c.y + dy * s) };
  };
  const p = at(a, ac, bc);
  const q = at(b, bc, ac);
  return [p.x, p.y, q.x, q.y];
}

/** A positioned view as a standalone SVG (C4 colours, groups as dashed frames, relation labels on the lines). */
export function architectureToSvg(view: ArchView, positions: Record<string, Point> = {}, title = view.title): string {
  const b = boxes(view, positions);
  const groups = groupBoxes(view, b);
  const all = [...b.values(), ...groups.map((g) => g.box)];
  if (!all.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="20" y="60" font-size="16">${xml(title)}</text></svg>\n`;
  const pad = 40;
  const minX = Math.min(...all.map((x) => x.x)) - pad;
  const minY = Math.min(...all.map((x) => x.y)) - pad - 40;
  const width = Math.max(...all.map((x) => x.x + x.w)) + pad - minX;
  const height = Math.max(...all.map((x) => x.y + x.h)) + pad - minY;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}" font-family="'Hiragino Sans','Noto Sans JP',system-ui,sans-serif">`,
    `<defs><marker id="arch-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${minX + pad}" y="${minY + pad}" font-size="20" font-weight="600" fill="#222">${xml(title)}</text>`,
  ];
  for (const g of groups) {
    out.push(`<rect x="${g.box.x}" y="${g.box.y}" width="${g.box.w}" height="${g.box.h}" rx="8" fill="none" stroke="#9aa6b2" stroke-width="1.5" stroke-dasharray="8 5"/>`);
    out.push(`<text x="${g.box.x + 10}" y="${g.box.y + 20}" font-size="13" font-weight="600" fill="#4a5868">${xml(g.label)}</text>`);
  }
  for (const r of view.relations) {
    const a = b.get(r.source);
    const c = b.get(r.target);
    if (!a || !c) continue;
    const [x1, y1, x2, y2] = edgeEnds(a, c);
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#666" stroke-width="1.4"${r.dashed ? ` stroke-dasharray="6 4"` : ""} marker-end="url(#arch-arrow)"/>`);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const text = clip(r.label, 34);
    const tw = Math.max(24, units(text) * 6 + 8);
    out.push(`<rect x="${mx - tw / 2}" y="${my - 15}" width="${tw}" height="${r.technology ? 30 : 17}" rx="3" fill="#ffffff" fill-opacity="0.85"/>`);
    out.push(`<text x="${mx}" y="${my - 3}" font-size="11" text-anchor="middle" fill="#333">${xml(text)}</text>`);
    if (r.technology) out.push(`<text x="${mx}" y="${my + 11}" font-size="10" text-anchor="middle" fill="#777">[${xml(clip(r.technology, 34))}]</text>`);
  }
  for (const e of view.elements) {
    const x = b.get(e.id)!;
    const c = ARCH_FILL[e.kind];
    const rx = e.kind === "person" || e.kind === "use_case" || e.kind === "query" ? 18 : 6;
    out.push(`<g>`);
    out.push(`<rect x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}" rx="${rx}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"${e.kind === "adapter" ? ` stroke-dasharray="5 3"` : ""}/>`);
    let y = x.y + 24;
    const cx = x.x + x.w / 2;
    for (const line of wrapUnits(e.label, Math.floor((x.w - 20) / 8.4), 2)) {
      out.push(`<text x="${cx}" y="${y}" font-size="14" font-weight="600" text-anchor="middle" fill="${c.text}">${xml(line)}</text>`);
      y += 18;
    }
    if (e.technology) {
      out.push(`<text x="${cx}" y="${y}" font-size="11" text-anchor="middle" fill="${c.text}" fill-opacity="0.85">[${xml(clip(e.technology, Math.floor((x.w - 24) / 6)))}]</text>`);
      y += 16;
    }
    if (e.description) {
      for (const line of wrapUnits(e.description, Math.floor((x.w - 24) / 6.6), 2)) {
        out.push(`<text x="${cx}" y="${y}" font-size="11" text-anchor="middle" fill="${c.text}">${xml(line)}</text>`);
        y += 16;
      }
    }
    if (e.badges.length) out.push(`<text x="${cx}" y="${Math.min(y + 4, x.y + x.h - 8)}" font-size="10" text-anchor="middle" fill="${c.text}" fill-opacity="0.9">${xml(clip(e.badges.join(" · "), Math.floor((x.w - 16) / 5.6)))}</text>`);
    out.push(`</g>`);
  }
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

const attr = (s: string) => xml(s).replace(/\n/g, "&#xa;");

/** A positioned view as a draw.io file (one page, uncompressed; groups as dashed frames behind the boxes). */
export function architectureToDrawio(view: ArchView, positions: Record<string, Point> = {}, name = view.title): string {
  const b = boxes(view, positions);
  const ids = mermaidIds(view);
  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];
  const geo = (x: Box) => `<mxGeometry x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}" as="geometry" />`;
  for (const g of groupBoxes(view, b)) {
    cells.push(`<mxCell id="${ids.get(g.id)}" value="${attr(g.label)}" style="rounded=1;arcSize=3;whiteSpace=wrap;html=0;fillColor=none;strokeColor=#9aa6b2;dashed=1;align=left;verticalAlign=top;spacingLeft=10;fontStyle=1;" vertex="1" parent="1">${geo(g.box)}</mxCell>`);
  }
  for (const e of view.elements) {
    const c = ARCH_FILL[e.kind];
    const value = [e.label, e.technology ? `[${e.technology}]` : "", e.description ?? "", e.badges.join(" · ")].filter(Boolean).join("\n");
    const shape = e.kind === "database" ? "shape=cylinder3;boundedLbl=1;size=12;" : e.kind === "person" ? "rounded=1;arcSize=40;" : "rounded=1;arcSize=8;";
    cells.push(`<mxCell id="${ids.get(e.id)}" value="${attr(value)}" style="${shape}whiteSpace=wrap;html=0;fillColor=${c.fill};strokeColor=${c.stroke};fontColor=${c.text};${e.kind === "adapter" ? "dashed=1;" : ""}" vertex="1" parent="1">${geo(b.get(e.id)!)}</mxCell>`);
  }
  view.relations.forEach((r, i) => {
    const value = r.technology ? `${r.label}\n[${r.technology}]` : r.label;
    cells.push(`<mxCell id="rel_${i}" value="${attr(value)}" style="html=0;endArrow=block;endFill=1;strokeColor=#666666;fontSize=10;${r.dashed ? "dashed=1;" : ""}" edge="1" parent="1" source="${ids.get(r.source)}" target="${ids.get(r.target)}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
  });
  return [
    `<mxfile host="DDD Presenter" type="device">`,
    `  <diagram id="ddd-architecture" name="${attr(name)}">`,
    `    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">`,
    `      <root>`,
    ...cells.map((c) => `        ${c}`),
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
    "",
  ].join("\n");
}
