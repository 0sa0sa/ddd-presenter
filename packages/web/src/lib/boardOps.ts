/** Immutable board operations used by the canvas (framework-free, unit-tested). */
import { itemsInFrame, STICKY_KINDS, type Board, type BoardConnector, type BoardFrame, type BoardItem, type StickyKind } from "@ddd/core";

let counter = 0;
export function newId(prefix: string): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addItem(board: Board, kind: StickyKind, at: { x: number; y: number }, text = ""): { board: Board; id: string } {
  const meta = STICKY_KINDS[kind];
  const id = newId("s");
  const item: BoardItem = { id, kind, text, x: Math.round(at.x - meta.w / 2), y: Math.round(at.y - meta.h / 2), w: meta.w, h: meta.h };
  return { board: { ...board, items: [...board.items, item] }, id };
}

export function addFrame(board: Board, at: { x: number; y: number }, title = ""): { board: Board; id: string } {
  const id = newId("f");
  const frame: BoardFrame = { id, title, x: Math.round(at.x - 300), y: Math.round(at.y - 200), w: 600, h: 400 };
  return { board: { ...board, frames: [...board.frames, frame] }, id };
}

export function addConnector(board: Board, from: string, to: string): Board {
  if (from === to || board.connectors.some((c) => c.from === from && c.to === to)) return board;
  const conn: BoardConnector = { id: newId("k"), from, to };
  return { ...board, connectors: [...board.connectors, conn] };
}

export function updateItem(board: Board, id: string, patch: Partial<BoardItem>): Board {
  return { ...board, items: board.items.map((i) => (i.id === id ? cleanItem({ ...i, ...patch }) : i)) };
}

export function updateFrame(board: Board, id: string, patch: Partial<BoardFrame>): Board {
  return { ...board, frames: board.frames.map((f) => (f.id === id ? cleanFrame({ ...f, ...patch }) : f)) };
}

export function updateConnector(board: Board, id: string, patch: Partial<BoardConnector>): Board {
  return { ...board, connectors: board.connectors.map((c) => (c.id === id ? { ...c, ...patch, label: patch.label || undefined } : c)) };
}

function cleanItem(i: BoardItem): BoardItem {
  const out = { ...i };
  if (!out.codeName) delete out.codeName;
  if (!out.creates || out.kind !== "command") delete out.creates;
  return out;
}

function cleanFrame(f: BoardFrame): BoardFrame {
  const out = { ...f };
  if (!out.codeName) delete out.codeName;
  return out;
}

/** Removes items / frames / connectors; connectors attached to removed items go too. */
export function removeIds(board: Board, ids: Iterable<string>): Board {
  const set = new Set(ids);
  const items = board.items.filter((i) => !set.has(i.id));
  const alive = new Set(items.map((i) => i.id));
  return {
    ...board,
    items,
    frames: board.frames.filter((f) => !set.has(f.id)),
    connectors: board.connectors.filter((c) => !set.has(c.id) && alive.has(c.from) && alive.has(c.to)),
  };
}

/** Copies the given items (and connectors between them) with an offset; returns the new ids. */
export function duplicate(board: Board, ids: Iterable<string>, offset = 32): { board: Board; ids: string[] } {
  const set = new Set(ids);
  const map = new Map<string, string>();
  const items = board.items.filter((i) => set.has(i.id)).map((i) => {
    const id = newId("s");
    map.set(i.id, id);
    return { ...i, id, x: i.x + offset, y: i.y + offset, codeName: undefined } as BoardItem;
  });
  const frames = board.frames.filter((f) => set.has(f.id)).map((f) => {
    const id = newId("f");
    map.set(f.id, id);
    return { ...f, id, x: f.x + offset, y: f.y + offset, codeName: undefined } as BoardFrame;
  });
  const connectors = board.connectors.filter((c) => map.has(c.from) && map.has(c.to)).map((c) => ({ ...c, id: newId("k"), from: map.get(c.from)!, to: map.get(c.to)! }));
  return {
    board: { ...board, items: [...board.items, ...items.map(cleanItem)], frames: [...board.frames, ...frames.map(cleanFrame)], connectors: [...board.connectors, ...connectors] },
    ids: [...map.values()],
  };
}

/** Ids of the items that travel with a frame when it is dragged (like Miro frames). */
export function frameContents(board: Board, frameId: string): string[] {
  const frame = board.frames.find((f) => f.id === frameId);
  return frame ? itemsInFrame(board, frame).map((i) => i.id) : [];
}

export function moveBy(board: Board, ids: Iterable<string>, dx: number, dy: number): Board {
  const set = new Set(ids);
  return {
    ...board,
    items: board.items.map((i) => (set.has(i.id) ? { ...i, x: Math.round(i.x + dx), y: Math.round(i.y + dy) } : i)),
    frames: board.frames.map((f) => (set.has(f.id) ? { ...f, x: Math.round(f.x + dx), y: Math.round(f.y + dy) } : f)),
  };
}

/** Snapshot history for undo / redo (boards are small JSON documents, so snapshots are simple and correct). */
export class History {
  private past: Board[] = [];
  private future: Board[] = [];
  constructor(private readonly limit = 100) {}

  push(previous: Board): void {
    this.past.push(previous);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: Board): Board | undefined {
    const prev = this.past.pop();
    if (prev) this.future.push(current);
    return prev;
  }

  redo(current: Board): Board | undefined {
    const next = this.future.pop();
    if (next) this.past.push(current);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
