/**
 * Keeping the discovery board and the model in step after the first reflection.
 * The board → model direction is `boardToModel` (discovery.ts); this module covers the other one:
 * what the model has that the board does not, stickies whose element disappeared or was renamed,
 * and placing model elements on the board.
 */
import { frameOf, STICKY_KINDS, type Board, type BoardFrame, type BoardItem } from "./discovery.ts";
import type { ContextIR, ModelIR } from "./ir.ts";

export type SyncKind = "context" | "aggregate" | "command" | "event";

/** A model element, identified the way board stickies refer to it (their code name). */
export interface ModelElementRef {
  kind: SyncKind;
  context: string;
  name: string;
  /** Aggregate that owns an operation / event. */
  aggregate?: string;
  /** Text for a new sticky (description or glossary term when there is one). */
  label: string;
}

export interface StaleSticky {
  /** Sticky (or frame) id. */
  id: string;
  kind: SyncKind;
  codeName: string;
  text: string;
  /** Model elements of the same kind nobody links to: likely the new name after a rename. */
  candidates: string[];
}

export interface BoardModelComparison {
  /** Elements of the model that no sticky refers to. */
  missing: ModelElementRef[];
  /** Stickies whose code name is no longer in the model. */
  stale: StaleSticky[];
  /** Stickies that could become model elements but have no code name yet (not reflected). */
  unreflected: string[];
  /** Stickies and frames that match a model element. */
  linked: string[];
}

/** Every element a sticky can stand for, per context. */
export function modelElements(model: ModelIR): ModelElementRef[] {
  const out: ModelElementRef[] = [];
  for (const ctx of model.contexts) {
    out.push({ kind: "context", context: ctx.name, name: ctx.name, label: ctx.description?.split("\n")[0] || ctx.name });
    const events = new Set<string>();
    for (const ag of ctx.aggregates) {
      out.push({ kind: "aggregate", context: ctx.name, name: ag.name, label: termFor(ctx, ag.name) ?? ag.description?.split("\n")[0] ?? ag.name });
      for (const op of [...ag.factories, ...ag.operations]) {
        out.push({ kind: "command", context: ctx.name, name: op.name, aggregate: ag.name, label: op.description?.split("\n")[0] || op.name });
        for (const e of op.emits) {
          if (events.has(e.name)) continue;
          events.add(e.name);
          out.push({ kind: "event", context: ctx.name, name: e.name, aggregate: ag.name, label: termFor(ctx, e.name) ?? e.name });
        }
      }
    }
  }
  return out;
}

function termFor(ctx: ContextIR, name: string): string | undefined {
  const lower = name.toLowerCase();
  return ctx.glossary.find((g) => g.definition.includes(name) || g.term.toLowerCase() === lower)?.term;
}

const STICKY_SYNC: Partial<Record<BoardItem["kind"], SyncKind>> = { aggregate: "aggregate", command: "command", event: "event" };

export function compareBoardWithModel(board: Board, model: ModelIR): BoardModelComparison {
  const elements = modelElements(model);
  const key = (kind: SyncKind, name: string) => `${kind}:${name}`;
  const known = new Set(elements.map((e) => key(e.kind, e.name)));
  const linkedKeys = new Set<string>();
  const linked: string[] = [];
  const staleRaw: Omit<StaleSticky, "candidates">[] = [];
  const unreflected: string[] = [];

  for (const f of board.frames) {
    if (!f.codeName) continue;
    if (known.has(key("context", f.codeName))) {
      linked.push(f.id);
      linkedKeys.add(key("context", f.codeName));
    } else staleRaw.push({ id: f.id, kind: "context", codeName: f.codeName, text: f.title });
  }
  for (const i of board.items) {
    const kind = STICKY_SYNC[i.kind];
    if (!kind) continue;
    if (!i.codeName) {
      if (i.text.trim()) unreflected.push(i.id);
      continue;
    }
    if (known.has(key(kind, i.codeName))) {
      linked.push(i.id);
      linkedKeys.add(key(kind, i.codeName));
    } else staleRaw.push({ id: i.id, kind, codeName: i.codeName, text: i.text });
  }

  const missing = elements.filter((e) => !linkedKeys.has(key(e.kind, e.name)));
  const stale = staleRaw.map((s) => ({
    ...s,
    candidates: missing
      .filter((m) => m.kind === s.kind)
      .map((m) => m.name)
      .sort((a, b) => similarity(s.codeName, b) - similarity(s.codeName, a)),
  }));
  return { missing, stale, unreflected, linked };
}

/** Shared word parts (PascalCase / snake_case) — enough to rank rename candidates. */
function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/_+/).filter(Boolean));
  const wa = words(a);
  let n = 0;
  for (const w of words(b)) if (wa.has(w)) n++;
  return n;
}

/** Points the stickies (and frames) that used `from` at `to`, e.g. after a rename in the model. */
export function renameOnBoard(board: Board, from: string, to: string, kinds: SyncKind[] = ["aggregate", "event", "command", "context"]): Board {
  let changed = false;
  const items = board.items.map((i) => {
    const kind = STICKY_SYNC[i.kind];
    if (!kind || !kinds.includes(kind) || i.codeName !== from) return i;
    changed = true;
    return { ...i, codeName: to };
  });
  const frames = kinds.includes("context")
    ? board.frames.map((f) => {
        if (f.codeName !== from) return f;
        changed = true;
        return { ...f, codeName: to };
      })
    : board.frames;
  return changed ? { ...board, items, frames } : board;
}

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Places model elements on the board, linked by code name: a frame per context (reused when one is linked),
 * and per aggregate a row of command → aggregate with the events each command emits.
 * Elements already on the board are left where they are.
 */
export function addModelElementsToBoard(board: Board, model: ModelIR, elements: ModelElementRef[]): { board: Board; added: string[] } {
  if (!elements.length) return { board, added: [] };
  let b: Board = { ...board, items: [...board.items], frames: [...board.frames], connectors: [...board.connectors] };
  const added: string[] = [];
  const want = new Set(elements.map((e) => `${e.kind}:${e.context}:${e.name}`));
  const linkedItem = (kind: BoardItem["kind"], name: string) => b.items.find((i) => i.kind === kind && i.codeName === name);
  const connect = (from: string, to: string) => {
    if (!b.connectors.some((c) => c.from === from && c.to === to)) b.connectors.push({ id: newId("k"), from, to });
  };
  const content = [...b.items, ...b.frames];
  let nextY = content.length ? Math.max(...content.map((x) => x.y + x.h)) + 120 : 0;
  const left = content.length ? Math.min(...content.map((x) => x.x)) : 0;

  for (const ctx of model.contexts) {
    const inCtx = elements.filter((e) => e.context === ctx.name);
    if (!inCtx.length) continue;
    let frame: BoardFrame | undefined = b.frames.find((f) => f.codeName === ctx.name);
    const rows: { y: number; x: number }[] = [];
    // New rows go below the frame's existing content, or start a new frame below the board.
    const baseY = frame ? Math.max(frame.y + 60, ...b.items.filter((i) => frameOf(b, i)?.id === frame!.id).map((i) => i.y + i.h + 40)) : nextY + 60;
    const baseX = frame ? frame.x + 40 : left + 40;
    let y = baseY;
    for (const ag of ctx.aggregates) {
      const ops = [...ag.factories, ...ag.operations];
      const needs = want.has(`aggregate:${ctx.name}:${ag.name}`) || ops.some((op) => want.has(`command:${ctx.name}:${op.name}`) || op.emits.some((e) => want.has(`event:${ctx.name}:${e.name}`)));
      if (!needs) continue;
      let agItem = linkedItem("aggregate", ag.name);
      const rowStart = y;
      ops.forEach((op, k) => {
        const rowY = rowStart + k * 130;
        let cmd = linkedItem("command", op.name);
        if (!cmd && (want.has(`command:${ctx.name}:${op.name}`) || want.has(`aggregate:${ctx.name}:${ag.name}`))) {
          cmd = sticky("command", op.description?.split("\n")[0] || op.name, op.name, baseX, rowY, k < ag.factories.length);
          b.items.push(cmd);
          added.push(cmd.id);
        }
        op.emits.forEach((e, n) => {
          let ev = linkedItem("event", e.name);
          if (!ev && want.has(`event:${ctx.name}:${e.name}`)) {
            ev = sticky("event", termFor(ctx, e.name) ?? e.name, e.name, baseX + 460 + n * 190, rowY);
            b.items.push(ev);
            added.push(ev.id);
          }
          if (cmd && ev) connect(cmd.id, ev.id);
        });
      });
      if (!agItem && want.has(`aggregate:${ctx.name}:${ag.name}`)) {
        agItem = sticky("aggregate", termFor(ctx, ag.name) ?? ag.name, ag.name, baseX + 220, rowStart + Math.max(0, (ops.length - 1) * 65) - 10);
        b.items.push(agItem);
        added.push(agItem.id);
      }
      if (agItem) for (const op of ops) {
        const cmd = linkedItem("command", op.name);
        if (cmd) connect(cmd.id, agItem.id);
      }
      y = rowStart + Math.max(1, ops.length) * 130 + 40;
      rows.push({ y: rowStart, x: baseX });
    }
    const placed = b.items.filter((i) => i.y >= baseY - 10 && i.y < y && i.x >= baseX - 10);
    if (!frame && (want.has(`context:${ctx.name}:${ctx.name}`) || placed.length)) {
      const right = placed.length ? Math.max(...placed.map((i) => i.x + i.w)) + 40 : baseX + 600;
      frame = { id: newId("f"), title: ctx.description?.split("\n")[0] || ctx.name, codeName: ctx.name, x: baseX - 40, y: baseY - 60, w: Math.max(600, right - baseX + 40), h: Math.max(240, y - baseY + 60) };
      b.frames.push(frame);
      added.push(frame.id);
    } else if (frame && placed.length) {
      // Grow the frame so the new stickies stay inside it.
      const right = Math.max(frame.x + frame.w, ...placed.map((i) => i.x + i.w + 40));
      const bottom = Math.max(frame.y + frame.h, ...placed.map((i) => i.y + i.h + 40));
      b.frames = b.frames.map((f) => (f.id === frame!.id ? { ...f, w: right - f.x, h: bottom - f.y } : f));
    }
    nextY = Math.max(nextY, y + 40);
  }
  if (!added.length) return { board, added };
  b = { ...b };
  return { board: b, added };
}

function sticky(kind: BoardItem["kind"], text: string, codeName: string, x: number, y: number, creates = false): BoardItem {
  const meta = STICKY_KINDS[kind];
  const item: BoardItem = { id: newId("s"), kind, text, codeName, x: Math.round(x), y: Math.round(y), w: meta.w, h: meta.h };
  if (creates) item.creates = true;
  return item;
}
