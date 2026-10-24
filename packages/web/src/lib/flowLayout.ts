/**
 * Layout of the flow diagrams (docs/11 §12) for SVG: a sequence diagram (columns, rows, blocks) and the event chain
 * (layers left to right). Pure and deterministic; text widths are estimated (CJK characters count double), so the
 * same model always draws the same picture.
 */
import type { EventFlowGraph, EventNode, SeqItem, SeqMessageStyle, SeqParticipant, SequenceDiagram } from "@ddd/core";

const CJK = 13;
const LATIN = 7.2;
export const LINE = 16;

/** Estimated width in px of a 12px line. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? CJK : LATIN;
  return w;
}

/** Splits text into lines of at most `width` px (Latin words are kept together where they fit). */
export function wrap(s: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  const tokens = s.match(/[\x21-\x7e]+|\s+|[^\x21-\x7e\s]/g) ?? [];
  for (const t of tokens) {
    if (!cur && /^\s+$/.test(t)) continue;
    if (textWidth(cur + t) <= width || !cur) {
      if (textWidth(t) > width && !cur) {
        // A long Latin token alone: cut it.
        let part = "";
        for (const ch of t) {
          if (textWidth(part + ch) > width && part) {
            lines.push(part);
            part = "";
          }
          part += ch;
        }
        cur = part;
      } else cur += t;
    } else {
      lines.push(cur.trimEnd());
      cur = /^\s+$/.test(t) ? "" : t;
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [""];
}

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

export interface SeqHeader {
  p: SeqParticipant;
  x: number;
  w: number;
}

export type SeqShape =
  | { kind: "msg"; x1: number; x2: number; y: number; lines: string[]; style: SeqMessageStyle; textX: number }
  | { kind: "note"; x: number; y: number; w: number; h: number; lines: string[] }
  | { kind: "frame"; x: number; y: number; w: number; h: number; type: "alt" | "opt"; label: string[]; separators: { y: number; label: string[] }[] };

export interface SeqLayout {
  width: number;
  height: number;
  headerHeight: number;
  headers: SeqHeader[];
  shapes: SeqShape[];
}

const HEADER_H = 50;
const MIN_GAP = 170;
const MAX_LABEL = 340;
const MARGIN = 24;

function involved(items: SeqItem[], out = new Set<string>()): Set<string> {
  for (const it of items) {
    if (it.kind === "msg") {
      out.add(it.from);
      out.add(it.to);
    } else if (it.kind === "note") it.over.forEach((x) => out.add(x));
    else it.branches.forEach((b) => involved(b.items, out));
  }
  return out;
}

export function layoutSequence(d: SequenceDiagram): SeqLayout {
  const ps = d.participants;
  const index = new Map(ps.map((p, i) => [p.id, i]));
  const headerW = ps.map((p) => Math.min(220, Math.max(120, textWidth(p.label) + 28, textWidth(p.sub ?? "") + 28)));
  const gaps = ps.slice(1).map((_, i) => Math.max(MIN_GAP, (headerW[i]! + headerW[i + 1]!) / 2 + 24));
  // Widen the gaps a message label needs (spread over the columns it crosses).
  const walk = (items: SeqItem[]) => {
    for (const it of items) {
      if (it.kind === "block") it.branches.forEach((b) => walk(b.items));
      if (it.kind !== "msg") continue;
      const a = index.get(it.from)!;
      const b = index.get(it.to)!;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (lo === hi) continue;
      const need = Math.min(MAX_LABEL, textWidth(it.text) + 24);
      const have = gaps.slice(lo, hi).reduce((n, g) => n + g, 0);
      if (need > have) for (let i = lo; i < hi; i++) gaps[i]! += (need - have) / (hi - lo);
    }
  };
  walk(d.items);
  const xs: number[] = [];
  let x = MARGIN + headerW[0]! / 2 + 40;
  ps.forEach((_, i) => {
    xs.push(x);
    x += gaps[i] ?? 0;
  });
  const colX = (id: string) => xs[index.get(id) ?? 0]!;
  const shapes: SeqShape[] = [];
  let y = HEADER_H + 28;
  let right = xs[xs.length - 1]! + headerW[headerW.length - 1]! / 2;

  const place = (items: SeqItem[], depth: number) => {
    for (const it of items) {
      if (it.kind === "msg") {
        const x1 = colX(it.from);
        const x2 = colX(it.to);
        const span = Math.max(120, Math.abs(x2 - x1) - 16);
        const lines = wrap(it.text, span);
        y += lines.length * LINE;
        shapes.push({ kind: "msg", x1, x2, y: y + 4, lines, style: it.style, textX: (x1 + x2) / 2 });
        y += 20;
      } else if (it.kind === "note") {
        const cols = it.over.map(colX);
        const lo = Math.min(...cols);
        const hi = Math.max(...cols);
        // As wide as the columns it is over, and wide enough for a short text on one or two lines.
        const w = Math.max(hi - lo + 120, Math.min(320, textWidth(it.text) + 20));
        const lines = wrap(it.text, Math.min(w, 420) - 16);
        const nw = Math.max(w, Math.min(420, Math.max(...lines.map(textWidth)) + 16));
        const nx = (lo + hi) / 2 - nw / 2;
        const h = lines.length * LINE + 10;
        shapes.push({ kind: "note", x: nx, y: y - 6, w: nw, h, lines });
        right = Math.max(right, nx + nw);
        y += h + 8;
      } else {
        const cols = [...involved([it])].map(colX);
        const inset = depth * 8;
        const fx = Math.min(...cols) - 80 + inset;
        const fw = Math.max(...cols) + 80 - inset - fx;
        const top = y - 4;
        const label = wrap(`[${it.branches[0]!.label}]`, Math.max(120, fw - 56));
        y += label.length * LINE + 10;
        const separators: { y: number; label: string[] }[] = [];
        it.branches.forEach((br, i) => {
          if (i > 0) {
            const sl = wrap(`[${br.label}]`, Math.max(120, fw - 16));
            separators.push({ y: y, label: sl });
            y += sl.length * LINE + 10;
          }
          place(br.items, depth + 1);
        });
        y += 4;
        shapes.push({ kind: "frame", x: fx, y: top, w: fw, h: y - top, type: it.type, label, separators });
        right = Math.max(right, fx + fw);
        y += 14;
      }
    }
  };
  place(d.items, 0);
  const left = Math.min(MARGIN, ...shapes.map((s) => (s.kind === "msg" ? MARGIN : s.x)));
  const shift = left < MARGIN ? MARGIN - left : 0;
  if (shift) {
    for (let i = 0; i < xs.length; i++) xs[i]! += shift;
    for (const s of shapes) {
      if (s.kind === "msg") {
        s.x1 += shift;
        s.x2 += shift;
        s.textX += shift;
      } else s.x += shift;
    }
    right += shift;
  }
  return {
    width: Math.ceil(right + MARGIN),
    height: Math.ceil(y + 16),
    headerHeight: HEADER_H,
    headers: ps.map((p, i) => ({ p, x: xs[i]!, w: headerW[i]! })),
    shapes,
  };
}

// ---------------------------------------------------------------------------
// Event chain
// ---------------------------------------------------------------------------

export interface EventBox {
  node: EventNode;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
}

export interface EventLine {
  from: EventBox;
  to: EventBox;
  label?: string;
  dashed?: boolean;
}

export interface EventLayout {
  width: number;
  height: number;
  boxes: EventBox[];
  lines: EventLine[];
}

const BOX_W = 196;
const COL_GAP = 84;
const ROW_GAP = 22;

/** Layers by longest path from the sources (cycles cut where first met), boxes in model order within a layer. */
export function layoutEvents(g: EventFlowGraph): EventLayout {
  const out = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) out.get(e.from)?.push(e.to);
  const layer = new Map<string, number>();
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}\u0000${t}`);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  const incoming = new Set(g.edges.map((e) => e.to));
  for (const n of g.nodes) if (!incoming.has(n.id) && !state.has(n.id)) visit(n.id);
  for (const n of g.nodes) if (!state.has(n.id)) visit(n.id);
  for (const n of g.nodes) layer.set(n.id, 0);
  for (let pass = 0; pass < g.nodes.length; pass++) {
    let moved = false;
    for (const e of g.edges) {
      if (back.has(`${e.from}\u0000${e.to}`)) continue;
      const want = layer.get(e.from)! + 1;
      if (layer.get(e.to)! < want) {
        layer.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const columns: EventNode[][] = [];
  for (const n of g.nodes) (columns[layer.get(n.id)!] ??= []).push(n);
  const boxes = new Map<string, EventBox>();
  let height = 0;
  columns.forEach((col, ci) => {
    let y = 24;
    for (const node of col ?? []) {
      const lines = wrap(node.label, BOX_W - 20).slice(0, 3);
      const extra = (node.context ? 1 : 0) + (node.detail && node.detail !== node.label ? 1 : 0);
      const h = 16 + (lines.length + extra) * LINE + 4;
      boxes.set(node.id, { node, x: 24 + ci * (BOX_W + COL_GAP), y, w: BOX_W, h, lines });
      y += h + ROW_GAP;
    }
    height = Math.max(height, y);
  });
  const lines = g.edges.flatMap((e) => {
    const from = boxes.get(e.from);
    const to = boxes.get(e.to);
    return from && to ? [{ from, to, ...(e.label ? { label: e.label } : {}), ...(e.dashed ? { dashed: true } : {}) }] : [];
  });
  return { width: 24 + columns.length * (BOX_W + COL_GAP) - COL_GAP + 24, height: height + 8, boxes: [...boxes.values()], lines };
}
