/** The AI facilitator's conversation in the browser: storage, what is sent with a turn, adding its stickies. */
import { retargetGhosts, STICKY_KINDS, type Board, type BoardGhost, type FacilitatorMessage } from "@ddd/core";
import { onBoard } from "./boardOps.ts";

/** Messages kept per board in this browser (the server accepts this many with each turn). */
export const FACILITATOR_KEEP = 80;
/** Longest history text the server accepts. */
const HISTORY_TEXT = 6000;

export const facilitatorStorageKey = (projectId: string, boardId: string) => `ddd:facilitator:${projectId}:${boardId}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isGhost = (g: unknown): g is BoardGhost => {
  const x = g as BoardGhost;
  return typeof x === "object" && x !== null && typeof x.id === "string" && typeof x.text === "string" && x.kind in STICKY_KINDS && Number.isFinite(x.x) && Number.isFinite(x.y);
};

/**
 * The stored conversation, keeping only well-formed messages (storage is per browser and may hold anything: an
 * older format, a hand edit, a cut-off write). Unreadable or blocked storage is an empty conversation.
 */
export function loadConversation(storage: Store | undefined, key: string): FacilitatorMessage[] {
  try {
    const raw = storage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((m: FacilitatorMessage): FacilitatorMessage[] => {
      if (typeof m !== "object" || m === null || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return [];
      const clean: FacilitatorMessage = { id: typeof m.id === "string" ? m.id : `m-${Math.random().toString(36).slice(2)}`, role: m.role, text: m.text, at: typeof m.at === "string" ? m.at : "" };
      if (typeof m.author === "string") clean.author = m.author;
      const ghosts = Array.isArray(m.ghosts) ? m.ghosts.filter(isGhost) : [];
      if (ghosts.length) clean.ghosts = ghosts;
      if (typeof m.nextPhase === "string") clean.nextPhase = m.nextPhase;
      const focus = Array.isArray(m.focus) ? m.focus.filter((id) => typeof id === "string") : [];
      if (focus.length) clean.focus = focus;
      const options = Array.isArray(m.options) ? m.options.filter((o) => typeof o === "string") : [];
      if (options.length) clean.options = options;
      return [clean];
    });
  } catch {
    return [];
  }
}

/** Keeps the most recent messages; an empty conversation removes the entry. Full or blocked storage is ignored. */
export function saveConversation(storage: Store | undefined, key: string, messages: readonly FacilitatorMessage[]): void {
  try {
    if (messages.length) storage?.setItem(key, JSON.stringify(messages.slice(-FACILITATOR_KEEP)));
    else storage?.removeItem(key);
  } catch {
    // The conversation still works for this visit.
  }
}

/** The earlier turns as sent with a new one: the reply plus the stickies it suggested, so the facilitator remembers them. */
export function historyFor(messages: readonly FacilitatorMessage[]): { role: "user" | "assistant"; text: string; author?: string }[] {
  return messages.slice(-FACILITATOR_KEEP).map((m) => {
    const text = m.role === "assistant" && m.ghosts?.length ? `${m.text}\n(suggested stickies: ${m.ghosts.map((g) => `${g.kind} "${g.text}"`).join(", ")})` : m.text;
    return { role: m.role, text: text.slice(0, HISTORY_TEXT), ...(m.author ? { author: m.author } : {}) };
  });
}

/**
 * The suggested stickies still to add: those not on the board yet, connected to the stickies already added (on the
 * canvas one by one, or earlier) instead of to their ghosts.
 */
export function ghostsToAdd(board: Board, ghosts: readonly BoardGhost[]): BoardGhost[] {
  let rest = [...ghosts];
  for (const g of ghosts) {
    const item = board.items.find((i) => onBoard({ ...board, items: [i] }, g));
    if (item) rest = retargetGhosts(rest, g.id, item.id);
  }
  return rest.filter((g) => !onBoard(board, g));
}
