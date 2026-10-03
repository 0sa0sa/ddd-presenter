/**
 * draw.io (diagrams.net) files ⇄ discovery boards.
 *
 * Import: a `.drawio` / `.xml` file (plain or compressed pages) or a `.drawio.svg` with the diagram embedded.
 * Shapes become stickies by their fill colour (the usual EventStorming colours are recognised; teams can
 * remap any colour before importing), containers and large empty rectangles become context frames,
 * and edges between stickies become arrows.
 * Export: the board as an uncompressed `.drawio` file that draw.io opens and that imports back unchanged.
 */
import { deflateSync, Inflate, strFromU8, strToU8 } from "fflate";
import { STICKY_KINDS, type Board, type BoardConnector, type BoardFrame, type BoardItem, type StickyKind } from "./discovery.ts";
import { STICKY_FILL } from "./workshop.ts";

// ---------------------------------------------------------------------------
// Minimal XML reading (no DOM: this runs in the browser, the server and tests)
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k === "nbsp") return " ";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

/** Largest draw.io file read (characters), and the most a file's compressed pages may inflate to in total. */
export const MAX_DRAWIO_INPUT = 20_000_000;
export const MAX_DRAWIO_INFLATED = 20_000_000;
/** Deeper elements are attached to the deepest allowed one (draw.io files are a few levels deep). */
const MAX_XML_DEPTH = 256;
/** Cells read per page (a board holds at most a few thousand stickies). */
const MAX_DRAWIO_CELLS = 50_000;
const MAX_BOUNDARY_CANDIDATES = 200;

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w:.-]/;

/** Reads `name="value"` pairs of a start tag in one pass (no backtracking regex). */
function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i]!)) i++;
    const start = i;
    while (i < n && NAME_CHAR.test(src[i]!)) i++;
    if (i === start) {
      i++; // stray character
      continue;
    }
    const name = src.slice(start, i);
    while (i < n && /\s/.test(src[i]!)) i++;
    if (src[i] !== "=") continue;
    i++;
    while (i < n && /\s/.test(src[i]!)) i++;
    const q = src[i];
    if (q !== '"' && q !== "'") continue;
    const close = src.indexOf(q, i + 1);
    if (close < 0) break;
    attrs[name] = decodeEntities(src.slice(i + 1, close));
    i = close + 1;
  }
  return attrs;
}

/**
 * Minimal XML reader. Every construct is found with `indexOf` from the current position, so unclosed
 * comments, processing instructions, CDATA sections or tags end the scan instead of re-scanning the rest
 * of the input from each `<` (which made hostile files quadratic).
 */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const n = xml.length;
  let pos = 0;
  while (pos < n) {
    const top = stack[stack.length - 1]!;
    const lt = xml.indexOf("<", pos);
    if (lt < 0) {
      top.text += decodeEntities(xml.slice(pos));
      break;
    }
    if (lt > pos) top.text += decodeEntities(xml.slice(pos, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) break;
      pos = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) break;
      pos = end + 2;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) break;
      top.text += xml.slice(lt + 9, end);
      pos = end + 3;
    } else if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) break;
      pos = end + 1;
    } else {
      const closing = xml[lt + 1] === "/";
      const nameStart = closing ? lt + 2 : lt + 1;
      if (!NAME_START.test(xml[nameStart] ?? "")) {
        pos = lt + 1; // a stray "<" in text
        continue;
      }
      // The tag ends at the first ">" outside a quoted attribute value.
      let i = nameStart;
      let quote = "";
      while (i < n) {
        const ch = xml[i]!;
        if (quote) {
          const close = xml.indexOf(quote, i);
          if (close < 0) {
            i = n;
            break;
          }
          i = close + 1;
          quote = "";
          continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
        i++;
      }
      if (i >= n) break; // unterminated tag
      let nameEnd = nameStart;
      while (nameEnd < i && NAME_CHAR.test(xml[nameEnd]!)) nameEnd++;
      const name = xml.slice(nameStart, nameEnd);
      pos = i + 1;
      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      let body = xml.slice(nameEnd, i);
      const selfClosing = body.trimEnd().endsWith("/");
      if (selfClosing) body = body.trimEnd().slice(0, -1);
      const node: XmlNode = { name, attrs: parseAttrs(body), children: [], text: "" };
      top.children.push(node);
      if (!selfClosing && stack.length < MAX_XML_DEPTH) stack.push(node);
    }
  }
  return root;
}

/** Name of the first element, skipping the XML declaration, comments and doctype (one forward pass). */
function firstElementName(xml: string): string {
  let pos = 0;
  for (;;) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) return "";
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.startsWith("<!--", lt) ? xml.indexOf("-->", lt + 4) : xml.indexOf(">", lt + 2);
      if (end < 0) return "";
      pos = end + 1;
      continue;
    }
    let i = lt + 1;
    while (i < xml.length && NAME_CHAR.test(xml[i]!)) i++;
    return xml.slice(lt + 1, i);
  }
}

/** Depth-first, pre-order, without recursion (deeply nested input cannot overflow the stack). */
const walk = (root: XmlNode, f: (n: XmlNode) => void) => {
  const todo: XmlNode[] = [root];
  while (todo.length) {
    const n = todo.pop()!;
    f(n);
    for (let i = n.children.length - 1; i >= 0; i--) todo.push(n.children[i]!);
  }
};

/** Shared by the pages of one file, so many small compressed pages cannot add up to a decompression bomb. */
interface InflateBudget {
  left: number;
}

/** A compressed page: base64 → raw deflate → URI-encoded XML. Throws when the output would exceed the budget. */
function inflatePage(data: string, budget: InflateBudget): string {
  const bin = atob(data.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const inflater = new Inflate((chunk) => {
    size += chunk.length;
    if (size > budget.left) throw new Error("inflated page is too large");
    chunks.push(chunk);
  });
  // Small input chunks keep the output of a single push bounded (deflate expands at most ~1000×).
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) inflater.push(bytes.subarray(i, i + CHUNK), i + CHUNK >= bytes.length);
  if (!bytes.length) inflater.push(new Uint8Array(0), true);
  budget.left -= size;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  const text = strFromU8(out, true);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** What a draw.io shape becomes on the board. */
export type DrawioTarget = StickyKind | "frame" | "ignore";

export interface DrawioShape {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Normalized fill colour (`#rrggbb`) or "none". */
  fill: string;
  /** Kind decided from the shape itself (actor figure, container, text, image), regardless of colour. */
  shapeKind?: DrawioTarget;
}

export interface DrawioEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface DrawioColor {
  fill: string;
  count: number;
  /** Suggested target for shapes of this colour. */
  suggested: DrawioTarget;
  examples: string[];
}

export interface DrawioPage {
  name: string;
  shapes: DrawioShape[];
  edges: DrawioEdge[];
  /** Colours of the shapes that are decided by colour (to review / remap before importing). */
  colors: DrawioColor[];
}

export type DrawioParseResult = { ok: true; pages: DrawioPage[] } | { ok: false; error: string };

const style = (s: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) out[part.trim()] = "1";
    else out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

function normalizeColor(c: string | undefined): string {
  if (!c || c === "none" || c === "default") return c === "none" ? "none" : "#ffffff";
  const v = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const named: Record<string, string> = { white: "#ffffff", black: "#000000", yellow: "#ffff00", orange: "#ffa500", red: "#ff0000", blue: "#0000ff", green: "#008000", pink: "#ffc0cb", purple: "#800080" };
  return named[v] ?? "#ffffff";
}

/** Label text: draw.io stores HTML when `html=1`. */
function labelText(value: string, html: boolean): string {
  let s = value;
  if (html) {
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h\d)>/gi, "\n")
      .replace(/<[^<>]*>/g, "");
    s = decodeEntities(s);
  }
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, a) => l || (i > 0 && i < a.length - 1))
    .join("\n")
    .trim();
}

/** Reads every page of a draw.io file (`.drawio`, `.xml`, or `.drawio.svg`). */
export function parseDrawio(input: string): DrawioParseResult {
  if (input.length > MAX_DRAWIO_INPUT) return { ok: false, error: `ファイルが大きすぎます（${Math.round(MAX_DRAWIO_INPUT / 1_000_000)} MB まで）` };
  let text = input.trim();
  // An SVG exported with "include a copy of my diagram" carries the file in its `content` attribute.
  if (firstElementName(text).toLowerCase() === "svg") {
    const at = /\scontent="/.exec(text);
    const end = at ? text.indexOf('"', at.index + at[0].length) : -1;
    if (!at || end < 0) return { ok: false, error: "この SVG には draw.io の図が含まれていません（書き出すときに「図のコピーを含める」を選んでください）" };
    text = decodeEntities(text.slice(at.index + at[0].length, end));
  }
  const budget: InflateBudget = { left: MAX_DRAWIO_INFLATED };
  let doc: XmlNode;
  try {
    doc = parseXml(text);
  } catch {
    return { ok: false, error: "XML として読めませんでした" };
  }
  const models: { name: string; model: XmlNode }[] = [];
  walk(doc, (n) => {
    if (n.name !== "diagram") return;
    const inner = n.children.find((c) => c.name === "mxGraphModel");
    if (inner) models.push({ name: n.attrs.name ?? `ページ${models.length + 1}`, model: inner });
    else if (n.text.trim()) {
      try {
        const m = parseXml(inflatePage(n.text, budget)).children.find((c) => c.name === "mxGraphModel");
        if (m) models.push({ name: n.attrs.name ?? `ページ${models.length + 1}`, model: m });
      } catch {
        // An unreadable page is skipped; the others still import.
      }
    }
  });
  if (!models.length) {
    // A bare <mxGraphModel> (copied from draw.io's "Edit Diagram").
    const seen = new Set<XmlNode>();
    walk(doc, (n) => {
      if (n.name === "mxGraphModel" && !seen.has(n)) {
        seen.add(n);
        models.push({ name: "ページ1", model: n });
      }
    });
  }
  if (!models.length) return { ok: false, error: "draw.io の図が見つかりませんでした（.drawio / .xml / 図を含む .drawio.svg を選んでください）" };
  return { ok: true, pages: models.map(({ name, model }) => readPage(name, model)) };
}

interface RawCell {
  id: string;
  value: string;
  style: Record<string, string>;
  vertex: boolean;
  edge: boolean;
  parent?: string;
  source?: string;
  target?: string;
  geo?: { x: number; y: number; w: number; h: number; relative: boolean };
}

function readPage(name: string, model: XmlNode): DrawioPage {
  const cells: RawCell[] = [];
  const root = model.children.find((c) => c.name === "root") ?? model;
  for (const n of root.children.slice(0, MAX_DRAWIO_CELLS)) {
    // <UserObject label="…"> / <object label="…"> wrap an mxCell and hold the label.
    const cellNode = n.name === "mxCell" ? n : n.children.find((c) => c.name === "mxCell");
    if (!cellNode) continue;
    const id = n.attrs.id ?? cellNode.attrs.id;
    if (!id) continue;
    const geoNode = cellNode.children.find((c) => c.name === "mxGeometry");
    const num = (v: string | undefined) => (v === undefined || v === "" ? 0 : Number(v) || 0);
    cells.push({
      id,
      value: n === cellNode ? (cellNode.attrs.value ?? "") : (n.attrs.label ?? cellNode.attrs.value ?? ""),
      style: style(cellNode.attrs.style),
      vertex: cellNode.attrs.vertex === "1",
      edge: cellNode.attrs.edge === "1",
      parent: cellNode.attrs.parent,
      source: cellNode.attrs.source,
      target: cellNode.attrs.target,
      geo: geoNode ? { x: num(geoNode.attrs.x), y: num(geoNode.attrs.y), w: num(geoNode.attrs.width), h: num(geoNode.attrs.height), relative: geoNode.attrs.relative === "1" } : undefined,
    });
  }
  const byId = new Map(cells.map((c) => [c.id, c]));
  // Absolute position: children of groups / containers are relative to their parent vertex.
  const absCache = new Map<string, { x: number; y: number }>();
  const abs = (c: RawCell, depth = 0): { x: number; y: number } => {
    const hit = absCache.get(c.id);
    if (hit) return hit;
    const p = c.parent ? byId.get(c.parent) : undefined;
    const base = p && p.vertex && depth < 20 ? abs(p, depth + 1) : { x: 0, y: 0 };
    const out = { x: base.x + (c.geo?.x ?? 0), y: base.y + (c.geo?.y ?? 0) };
    absCache.set(c.id, out);
    return out;
  };
  const hasChildren = new Set(cells.filter((c) => c.parent).map((c) => c.parent!));

  const shapes: DrawioShape[] = [];
  for (const c of cells) {
    if (!c.vertex || !c.geo || c.geo.relative) continue; // edge labels are relative vertices
    const s = c.style;
    const text = labelText(c.value, s.html === "1");
    const { x, y } = abs(c);
    const w = c.geo.w || 120;
    const h = c.geo.h || 60;
    const fill = normalizeColor(s.fillColor ?? (s.swimlane || s.text ? "none" : undefined));
    let shapeKind: DrawioTarget | undefined;
    if (s.shape === "image" || s.image || s.shape?.startsWith("mxgraph.") && !text) shapeKind = "ignore";
    else if (s.shape === "umlActor" || s.shape === "actor" || s.shape === "mxgraph.basic.person") shapeKind = "actor";
    else if (s.swimlane || s.container === "1" || s.group) shapeKind = s.group && !text ? "ignore" : "frame";
    else if (hasChildren.has(c.id) && w >= 300 && h >= 150) shapeKind = "frame";
    else if (s.text && !text) shapeKind = "ignore";
    else if (!text && fill === "none") shapeKind = "ignore";
    shapes.push({ id: c.id, text, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), fill, shapeKind });
  }
  // Large, unfilled or dashed rectangles that surround other shapes are boundaries (context frames).
  // At most MAX_BOUNDARY_CANDIDATES are checked, so a file of thousands of large rectangles stays linear.
  let candidates = 0;
  for (const sh of shapes) {
    if (sh.shapeKind || sh.w < 300 || sh.h < 150) continue;
    const cell = byId.get(sh.id)!;
    const outline = sh.fill === "none" || cell.style.dashed === "1" || cell.style.opacity !== undefined;
    if (!outline || ++candidates > MAX_BOUNDARY_CANDIDATES) continue;
    const surrounds = shapes.some((o) => o !== sh && o.x >= sh.x && o.y >= sh.y && o.x + o.w <= sh.x + sh.w && o.y + o.h <= sh.y + sh.h);
    if (surrounds) sh.shapeKind = "frame";
  }
  const vertexIds = new Set(shapes.map((s) => s.id));
  // Edge labels are vertices whose parent is the edge.
  const labelsOf = new Map<string, RawCell[]>();
  for (const l of cells) {
    if (!l.vertex || !l.parent) continue;
    const list = labelsOf.get(l.parent);
    if (list) list.push(l);
    else labelsOf.set(l.parent, [l]);
  }
  const edges: DrawioEdge[] = cells
    .filter((c) => c.edge && c.source && c.target && vertexIds.has(c.source) && vertexIds.has(c.target) && c.source !== c.target)
    .map((c) => {
      const label = labelText(c.value, c.style.html === "1") || (labelsOf.get(c.id) ?? []).map((l) => labelText(l.value, l.style.html === "1")).find(Boolean) || "";
      return { id: c.id, source: c.source!, target: c.target!, label };
    });
  return { name, shapes, edges, colors: colorGroups(shapes) };
}

// ---------------------------------------------------------------------------
// Colours → sticky kinds
// ---------------------------------------------------------------------------

/** Reference colours: this tool's palette first (exact round trip), then draw.io's and common EventStorming colours. */
const REFERENCE: { color: string; kind: StickyKind }[] = [
  ...(Object.entries(STICKY_FILL) as [StickyKind, string][]).map(([kind, color]) => ({ color, kind })),
  // orange: domain events
  { color: "#ffa500", kind: "event" }, { color: "#ffb570", kind: "event" }, { color: "#fad7ac", kind: "event" }, { color: "#ffcc99", kind: "event" }, { color: "#ff9933", kind: "event" }, { color: "#ffe6cc", kind: "event" },
  // blue: commands
  { color: "#dae8fc", kind: "command" }, { color: "#99ccff", kind: "command" }, { color: "#66b2ff", kind: "command" }, { color: "#a9c4eb", kind: "command" }, { color: "#b1ddf0", kind: "command" },
  // yellow: aggregates (large) / actors (small) — decided by size below
  { color: "#fff2cc", kind: "aggregate" }, { color: "#ffff88", kind: "aggregate" }, { color: "#ffd966", kind: "aggregate" }, { color: "#ffff00", kind: "aggregate" }, { color: "#fff4c3", kind: "aggregate" },
  // lilac: policies
  { color: "#e1d5e7", kind: "policy" }, { color: "#cc99ff", kind: "policy" }, { color: "#d0cee2", kind: "policy" }, { color: "#e5ccff", kind: "policy" },
  // green: read models
  { color: "#d5e8d4", kind: "read_model" }, { color: "#b9e0a5", kind: "read_model" }, { color: "#99ff99", kind: "read_model" }, { color: "#cce5ff", kind: "command" },
  // pink: external systems
  { color: "#ffcce6", kind: "external_system" }, { color: "#ffb6c1", kind: "external_system" }, { color: "#ffccff", kind: "external_system" }, { color: "#ffc0cb", kind: "external_system" },
  // red: hotspots
  { color: "#f8cecc", kind: "hotspot" }, { color: "#ff6666", kind: "hotspot" }, { color: "#ea6b66", kind: "hotspot" }, { color: "#ff0000", kind: "hotspot" }, { color: "#ff9999", kind: "hotspot" },
  // grey: rules
  { color: "#e6e6e6", kind: "rule" }, { color: "#f5f5f5", kind: "rule" }, { color: "#eeeeee", kind: "rule" },
];

const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const;

function nearestKind(fill: string): StickyKind | undefined {
  if (fill === "none" || fill === "#ffffff") return undefined;
  const [r, g, b] = rgb(fill);
  let best: { kind: StickyKind; d: number } | undefined;
  for (const ref of REFERENCE) {
    const [r2, g2, b2] = rgb(ref.color);
    const d = Math.sqrt((r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2);
    if (!best || d < best.d) best = { kind: ref.kind, d };
  }
  return best && best.d <= 70 ? best.kind : undefined;
}

/** Guess from the wording when the colour says nothing (plain white diagrams). */
function kindFromTexts(texts: string[]): StickyKind {
  const votes: Partial<Record<StickyKind, number>> = {};
  for (const t of texts) {
    const s = t.replace(/\s+/g, "");
    const k: StickyKind | undefined = /[?？]$/.test(s)
      ? "hotspot"
      : /(た|だ|れた|ed)$/i.test(s)
        ? "event"
        : /(する|る|う|く|す|つ|ぬ|む|ぶ|ぐ)$/.test(s)
          ? "command"
          : undefined;
    if (k) votes[k] = (votes[k] ?? 0) + 1;
  }
  const best = (Object.entries(votes) as [StickyKind, number][]).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] * 2 >= texts.length ? best[0] : "note";
}

function colorGroups(shapes: DrawioShape[]): DrawioColor[] {
  const groups = new Map<string, DrawioShape[]>();
  for (const s of shapes) {
    if (s.shapeKind) continue;
    const list = groups.get(s.fill);
    if (list) list.push(s);
    else groups.set(s.fill, [s]);
  }
  return [...groups.entries()]
    .map(([fill, list]) => {
      let suggested: DrawioTarget = nearestKind(fill) ?? kindFromTexts(list.map((s) => s.text).filter(Boolean));
      // Yellow is shared by actors (small) and aggregates (large) in EventStorming.
      if (suggested === "aggregate" || suggested === "actor") {
        const small = list.filter((s) => s.w * s.h <= 130 * 80).length;
        suggested = small * 2 > list.length ? "actor" : "aggregate";
      }
      return { fill, count: list.length, suggested, examples: list.map((s) => s.text).filter(Boolean).slice(0, 3) };
    })
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Page → board
// ---------------------------------------------------------------------------

export interface DrawioImport {
  board: Board;
  /** Stickies and frames added, by kind. */
  counts: Partial<Record<DrawioTarget, number>>;
  /** Shapes left out (ignored colours / images / empty shapes). */
  ignored: number;
  /** Arrows left out because one end was not imported. */
  droppedEdges: number;
  truncated: boolean;
}

export const MAX_IMPORTED_STICKIES = 3000;

/**
 * Adds a draw.io page to a board. `mapping` overrides the suggested target per colour.
 * The page is moved so its top-left corner lands at `at` (default: right of the existing content).
 */
export function drawioToBoard(page: DrawioPage, board: Board, mapping: Record<string, DrawioTarget> = {}, at?: { x: number; y: number }): DrawioImport {
  const targetOf = (s: DrawioShape): DrawioTarget => s.shapeKind ?? mapping[s.fill] ?? page.colors.find((c) => c.fill === s.fill)?.suggested ?? "note";
  const chosen = page.shapes.map((s) => ({ s, t: targetOf(s) })).filter((x) => x.t !== "ignore");
  const counts: Partial<Record<DrawioTarget, number>> = {};
  if (!chosen.length) return { board, counts, ignored: page.shapes.length, droppedEdges: page.edges.length, truncated: false };

  // reduce, not Math.min(...list): spreading a very large list overflows the argument limit.
  const minX = chosen.reduce((m, x) => Math.min(m, x.s.x), Infinity);
  const minY = chosen.reduce((m, x) => Math.min(m, x.s.y), Infinity);
  const existing = [...board.items, ...board.frames];
  const origin = at ?? (existing.length ? { x: existing.reduce((m, b) => Math.max(m, b.x + b.w), -Infinity) + 200, y: existing.reduce((m, b) => Math.min(m, b.y), Infinity) } : { x: 0, y: 0 });
  const dx = origin.x - minX;
  const dy = origin.y - minY;
  const suffix = Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
  const idOf = (drawioId: string, prefix: string) => `${prefix}dio${drawioId.replace(/[^A-Za-z0-9_-]/g, "").slice(-24)}${suffix}`;

  const room = Math.max(0, MAX_IMPORTED_STICKIES - board.items.length);
  let truncated = false;
  const items: BoardItem[] = [];
  const frames: BoardFrame[] = [];
  const idMap = new Map<string, string>();
  for (const { s, t } of chosen) {
    if (t === "frame") {
      const id = idOf(s.id, "f");
      frames.push({ id, title: s.text.slice(0, 120), x: s.x + dx, y: s.y + dy, w: Math.max(120, s.w), h: Math.max(80, s.h) });
      counts.frame = (counts.frame ?? 0) + 1;
      continue;
    }
    if (items.length >= room) {
      truncated = true;
      continue;
    }
    const kind = t as StickyKind;
    const id = idOf(s.id, "s");
    idMap.set(s.id, id);
    items.push({ id, kind, text: s.text.slice(0, 500), x: s.x + dx, y: s.y + dy, w: Math.max(40, s.w || STICKY_KINDS[kind].w), h: Math.max(30, s.h || STICKY_KINDS[kind].h) });
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const connectors: BoardConnector[] = [];
  let droppedEdges = 0;
  const linked = new Set<string>();
  for (const e of page.edges) {
    const from = idMap.get(e.source);
    const to = idMap.get(e.target);
    if (!from || !to || linked.has(`${from}\u0000${to}`)) {
      droppedEdges++;
      continue;
    }
    linked.add(`${from}\u0000${to}`);
    connectors.push({ id: idOf(e.id, "k"), from, to, ...(e.label ? { label: e.label.slice(0, 120) } : {}) });
  }
  return {
    board: { ...board, items: [...board.items, ...items], frames: [...board.frames, ...frames], connectors: [...board.connectors, ...connectors] },
    counts,
    ignored: page.shapes.length - chosen.length,
    droppedEdges,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Board → .drawio
// ---------------------------------------------------------------------------

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#xa;");

/** The board as a draw.io file (one page, uncompressed). Colours follow this tool's palette, so it imports back as-is. */
export function boardToDrawio(board: Board, name = "Board"): string {
  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];
  const geo = (x: number, y: number, w: number, h: number) => `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />`;
  const boxes = [...board.items, ...board.frames];
  const minX = boxes.length ? boxes.reduce((m, b) => Math.min(m, b.x), Infinity) - 240 : 0;
  const maxX = boxes.length ? boxes.reduce((m, b) => Math.max(m, b.x + b.w), -Infinity) + 240 : 800;
  for (const l of board.lanes ?? []) {
    cells.push(`<mxCell id="${escAttr(l.id)}" value="${escAttr(l.title)}" style="rounded=0;whiteSpace=wrap;html=0;fillColor=#eef1f5;strokeColor=#cfd5dd;dashed=1;align=left;verticalAlign=top;spacingLeft=10;fontStyle=1;" vertex="1" parent="1">${geo(minX, l.y, maxX - minX, l.h)}</mxCell>`);
  }
  for (const f of board.frames) {
    cells.push(`<mxCell id="${escAttr(f.id)}" value="${escAttr(f.title)}" style="rounded=1;arcSize=2;whiteSpace=wrap;html=0;fillColor=none;strokeColor=#6b7a90;strokeWidth=2;dashed=1;align=left;verticalAlign=top;spacingLeft=10;spacingTop=4;fontStyle=1;" vertex="1" parent="1">${geo(f.x, f.y, f.w, f.h)}</mxCell>`);
  }
  for (const i of board.items) {
    const stroke = i.pivotal ? "strokeColor=#c0392b;strokeWidth=3;" : "strokeColor=none;";
    cells.push(`<mxCell id="${escAttr(i.id)}" value="${escAttr(i.text)}" style="rounded=0;whiteSpace=wrap;html=0;fillColor=${STICKY_FILL[i.kind]};${stroke}shadow=1;align=left;verticalAlign=top;spacing=8;" vertex="1" parent="1">${geo(i.x, i.y, i.w, i.h)}</mxCell>`);
  }
  for (const c of board.connectors) {
    cells.push(`<mxCell id="${escAttr(c.id)}" value="${escAttr(c.label ?? "")}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;endArrow=block;endFill=1;strokeColor=#555555;" edge="1" parent="1" source="${escAttr(c.from)}" target="${escAttr(c.to)}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
  }
  return [
    `<mxfile host="DDD Presenter" type="device">`,
    `  <diagram id="ddd-board" name="${escAttr(name)}">`,
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

/** Encodes a page the way draw.io compresses it (used in tests and for files that want compression). */
export function compressDrawioPage(xml: string): string {
  const bytes = deflateSync(strToU8(encodeURIComponent(xml)));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
