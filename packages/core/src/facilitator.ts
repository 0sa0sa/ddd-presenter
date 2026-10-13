/**
 * The AI facilitator of an EventStorming workshop (docs/11 §4, docs/09 §26): what the facilitator is told about
 * the board (the workshop step, its checks, the board's findings) and how its sticky suggestions become ghost
 * stickies. The facilitator never changes the board; people accept its suggestions.
 */
import type { BoardGhost } from "./assist.ts";
import { analyzeBoard, STICKY_KINDS, type Board, type BoardItem, type StickyKind } from "./discovery.ts";
import { phaseOf, WORKSHOP_PHASES } from "./workshop.ts";

/** A sticky an LLM suggests, next to an existing sticky (or an earlier suggestion, or on the timeline). */
export interface StickySuggestion {
  /** Short id other suggestions in the same answer may use as `near_item_id` (e.g. "s1"). */
  ref?: string;
  kind: string;
  text: string;
  /** An existing sticky's id, an earlier suggestion's `ref`, or "" to place it at the end of the timeline. */
  near_item_id: string;
  placement: "right" | "left" | "above" | "below";
  connect: "from_near" | "to_near" | "none";
  reason: string;
}

const GAP = 40;
const MAX_TEXT = 200;
const MAX_REASON = 300;

/**
 * Ghost stickies for suggestions: placed beside their anchor (an existing sticky or an earlier suggestion of the
 * same answer), moved sideways when the spot is taken. Suggestions with an unknown kind, an unknown anchor or no
 * text are dropped. A ghost anchored on another ghost connects to it by the ghost's id; accepting the first ghost
 * re-points the second (`retargetGhosts`).
 */
export function placeSuggestions(board: Board, suggestions: readonly StickySuggestion[], idPrefix: string, max = 20): BoardGhost[] {
  const out: BoardGhost[] = [];
  const byRef = new Map<string, BoardGhost>();
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const events = board.items.filter((i) => i.kind === "event");
  for (const [n, s] of suggestions.entries()) {
    if (out.length >= max) break;
    if (!(s.kind in STICKY_KINDS) || typeof s.text !== "string" || !s.text.trim()) continue;
    const kind = s.kind as StickyKind;
    const meta = STICKY_KINDS[kind];
    const id = `${idPrefix}-${n}`;
    const nearKey = typeof s.near_item_id === "string" ? s.near_item_id.trim() : "";
    const ghostNear = nearKey ? byRef.get(nearKey) : undefined;
    const itemNear = nearKey ? byId.get(nearKey) : undefined;
    let near: { id: string; x: number; y: number; w: number; h: number } | undefined;
    if (itemNear) near = itemNear;
    else if (ghostNear) near = { id: ghostNear.id, x: ghostNear.x, y: ghostNear.y, w: STICKY_KINDS[ghostNear.kind].w, h: STICKY_KINDS[ghostNear.kind].h };
    else if (nearKey) continue;
    const taken: (BoardItem | BoardGhost)[] = [...board.items, ...out];
    let x: number;
    let y: number;
    let dir: 1 | -1 = 1;
    if (near) {
      if (s.placement === "left") {
        x = near.x - meta.w - GAP;
        y = near.y;
        dir = -1;
      } else if (s.placement === "above") {
        x = near.x;
        y = near.y - meta.h - GAP;
      } else if (s.placement === "below") {
        x = near.x;
        y = near.y + near.h + GAP;
      } else {
        x = near.x + near.w + GAP;
        y = near.y;
      }
    } else {
      // The end of the timeline: right of the last event (or of everything), on the events' row.
      const row = [...events, ...out.filter((g) => g.kind === "event")];
      const right = (g: BoardItem | BoardGhost) => g.x + ("w" in g ? g.w : STICKY_KINDS[g.kind].w);
      const last = (row.length ? row : taken).reduce<BoardItem | BoardGhost | undefined>((a, b) => (!a || right(b) > right(a) ? b : a), undefined);
      x = last ? right(last) + GAP : 0;
      y = row.length ? Math.min(...row.map((g) => g.y)) : (last?.y ?? 0);
    }
    // Beside the anchor when that spot is free; otherwise in the rows below it (then above), which keeps a command
    // next to its event when the events stand side by side; only then further along the row.
    const spots = near ? [{ x, y }, ...[0, 1, 2, 3].map((k) => ({ x: near.x, y: near.y + near.h + GAP + k * (meta.h + GAP) })), { x: near.x, y: near.y - meta.h - GAP }] : [{ x, y }];
    const free = spots.find((p) => !collides(taken, p.x, p.y, meta.w, meta.h));
    if (free) ({ x, y } = free);
    else x = freeSpot(taken, x, y, meta.w, meta.h, dir);
    const connect = near && s.connect === "from_near" ? { from: near.id, to: id } : near && s.connect === "to_near" ? { from: id, to: near.id } : undefined;
    const ghost: BoardGhost = { id, kind, text: s.text.trim().slice(0, MAX_TEXT), x, y, ...(connect ? { connect } : {}), reason: String(s.reason ?? "").slice(0, MAX_REASON), source: "llm" };
    out.push(ghost);
    if (typeof s.ref === "string" && s.ref.trim()) byRef.set(s.ref.trim(), ghost);
  }
  return out;
}

const sizeOf = (g: BoardItem | BoardGhost) => ("w" in g ? { w: g.w, h: g.h } : STICKY_KINDS[g.kind]);

const MARGIN = 16;

function collides(taken: readonly (BoardItem | BoardGhost)[], x: number, y: number, w: number, h: number): boolean {
  return taken.some((t) => t.x < x + w + MARGIN && t.x + sizeOf(t).w + MARGIN > x && t.y < y + h + MARGIN && t.y + sizeOf(t).h + MARGIN > y);
}

/** The nearest x (stepping in `dir`) where a w × h sticky at y keeps a small margin from every other sticky. */
function freeSpot(taken: readonly (BoardItem | BoardGhost)[], x: number, y: number, w: number, h: number, dir: 1 | -1): number {
  const row = taken.filter((t) => t.y < y + h + MARGIN && t.y + sizeOf(t).h + MARGIN > y);
  for (let n = 0; n < 500; n++) {
    const hit = row.find((t) => t.x < x + w + MARGIN && t.x + sizeOf(t).w + MARGIN > x);
    if (!hit) return x;
    x = dir === 1 ? hit.x + sizeOf(hit).w + MARGIN : hit.x - w - MARGIN;
  }
  return x;
}

/** After a ghost became the sticky `itemId`, ghosts connected to the ghost connect to the sticky instead. */
export function retargetGhosts(ghosts: readonly BoardGhost[], ghostId: string, itemId: string): BoardGhost[] {
  return ghosts.map((g) =>
    g.connect && (g.connect.from === ghostId || g.connect.to === ghostId)
      ? { ...g, connect: { from: g.connect.from === ghostId ? itemId : g.connect.from, to: g.connect.to === ghostId ? itemId : g.connect.to } }
      : g,
  );
}

/** What the facilitator is told about the board: the workshop step, its checks and the board's findings. */
export interface FacilitatorBrief {
  phase: { id: string; index: number; title: string; goal: string; prompts: string[]; kinds: string[]; minutes: number; timerEndsAt?: string };
  phases: { id: string; title: string }[];
  checks: { label: string; done: boolean; stickies: string[] }[];
  findings: { severity: string; message: string; hint?: string; stickies: string[] }[];
  counts: Record<string, number>;
}

const named = (board: Board, ids: string[]) =>
  ids
    .slice(0, 8)
    .map((id) => {
      const i = board.items.find((x) => x.id === id);
      return i ? `${id}「${i.text.trim() || "無題"}」` : (board.frames.find((f) => f.id === id)?.title ?? id);
    });

export function facilitatorBrief(board: Board): FacilitatorBrief {
  const phase = phaseOf(board);
  const counts: Record<string, number> = {};
  for (const i of board.items) if (i.text.trim()) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  counts.frame = board.frames.length;
  counts.arrow = board.connectors.length;
  return {
    phase: {
      id: phase.id,
      index: WORKSHOP_PHASES.indexOf(phase) + 1,
      title: phase.title,
      goal: phase.goal,
      prompts: phase.prompts,
      kinds: phase.kinds.map((k) => STICKY_KINDS[k].label),
      minutes: phase.minutes,
      ...(board.workshop?.timerEndsAt ? { timerEndsAt: board.workshop.timerEndsAt } : {}),
    },
    phases: WORKSHOP_PHASES.map((p) => ({ id: p.id, title: p.title })),
    checks: phase.checks(board).map((c) => ({ label: c.label, done: c.done, stickies: named(board, c.itemIds) })),
    findings: analyzeBoard(board)
      .slice(0, 12)
      .map((f) => ({ severity: f.severity, message: f.message, ...(f.hint ? { hint: f.hint } : {}), stickies: named(board, f.itemIds) })),
    counts,
  };
}

/** One message of a facilitation chat (kept in the browser per board). */
export interface FacilitatorMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Who wrote a user message. */
  author?: string;
  at: string;
  /** Assistant: suggested stickies (ghosts placed against the board as it was then). */
  ghosts?: BoardGhost[];
  /** Assistant: the workshop step it proposes to move to. */
  nextPhase?: string;
  /** Assistant: stickies it talks about. */
  focus?: string[];
  /** Assistant: short answers to click. */
  options?: string[];
}

/** The facilitator's answer after the server checked it against the board. */
export interface FacilitatorTurn {
  reply: string;
  ghosts: BoardGhost[];
  nextPhase?: string;
  focus: string[];
  options: string[];
}

/** Raw structured answer of the model (FACILITATOR_SCHEMA). */
export interface FacilitatorAnswer {
  reply: string;
  suggestions: StickySuggestion[];
  next_phase: string;
  focus_item_ids: string[];
  options: string[];
}

/** Checks a model answer against the board: known phases and stickies only, ghosts placed, lengths capped. */
export function facilitatorTurn(board: Board, answer: FacilitatorAnswer, idPrefix: string): FacilitatorTurn | undefined {
  const reply = typeof answer.reply === "string" ? answer.reply.trim().slice(0, 4000) : "";
  if (!reply) return undefined;
  const ids = new Set([...board.items.map((i) => i.id), ...board.frames.map((f) => f.id)]);
  const next = WORKSHOP_PHASES.find((p) => p.id === answer.next_phase);
  return {
    reply,
    ghosts: placeSuggestions(board, Array.isArray(answer.suggestions) ? answer.suggestions : [], idPrefix, 12),
    ...(next && next.id !== phaseOf(board).id ? { nextPhase: next.id } : {}),
    focus: (Array.isArray(answer.focus_item_ids) ? answer.focus_item_ids : []).filter((id) => typeof id === "string" && ids.has(id)).slice(0, 20),
    options: (Array.isArray(answer.options) ? answer.options : []).filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim().slice(0, 120)).slice(0, 4),
  };
}
