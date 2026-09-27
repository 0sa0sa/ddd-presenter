/**
 * Discovery board (EventStorming) — pure logic shared by the server and the Web canvas:
 * geometry, heuristic assistance, aggregate / context suggestions and model skeleton generation.
 * Suggestions are proposals only; nothing is decided automatically.
 */
import { parseDocument } from "yaml";
import { applyEdits, type EditOp } from "./edit.ts";
import { parseModel } from "./parse.ts";
import { analyzeModel, parseEventRef, validateModelText } from "./validate.ts";
import type { Diagnostic } from "./diagnostics.ts";

// ---------------------------------------------------------------------------
// Board document
// ---------------------------------------------------------------------------

export type StickyKind = "event" | "command" | "actor" | "policy" | "aggregate" | "read_model" | "external_system" | "hotspot" | "rule" | "note";

export interface BoardItem {
  id: string;
  kind: StickyKind;
  text: string;
  /** Identifier used when the item becomes a model element (ASCII). */
  codeName?: string;
  /** Commands only: this command creates the aggregate (becomes a factory). */
  creates?: boolean;
  /** Events only: a pivotal event that marks a turning point (and often a context boundary). */
  pivotal?: boolean;
  /** Hotspots only: the team reached a conclusion (kept on the board as a record). */
  resolved?: boolean;
  resolution?: string;
  /** Usernames that dot-voted for this sticky (one entry per vote). */
  votes?: string[];
  comments?: BoardComment[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardComment {
  id: string;
  author: string;
  text: string;
  at: string;
}

export type Subdomain = "core" | "supporting" | "generic";

export const SUBDOMAIN_LABEL: Record<Subdomain, { label: string; help: string }> = {
  core: { label: "コア", help: "競争力の源。いちばん力を入れて作り込む" },
  supporting: { label: "支援", help: "業務に必要だが差別化にはならない。シンプルに作る" },
  generic: { label: "汎用", help: "どこでも同じ。既製品や外部サービスを使う" },
};

/** A horizontal band (e.g. one actor's or one process's lane) spanning the board. */
export interface BoardLane {
  id: string;
  title: string;
  y: number;
  h: number;
}

export interface BoardFrame {
  id: string;
  title: string;
  codeName?: string;
  subdomain?: Subdomain;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardConnector {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface Board {
  version: 1;
  items: BoardItem[];
  frames: BoardFrame[];
  connectors: BoardConnector[];
  lanes?: BoardLane[];
  /** Shared workshop state (everyone on the board sees the same step and timer). */
  workshop?: WorkshopState;
}

export interface WorkshopState {
  phase: string;
  /** ISO time the current timebox ends. */
  timerEndsAt?: string;
  /** Dot votes each person may place (default 3). */
  votesPerPerson?: number;
}

export interface StickyMeta {
  label: string;
  help: string;
  /** How the code name is written when the item becomes a model element; null = not converted. */
  code: "pascal" | "snake" | null;
  /** Default size. */
  w: number;
  h: number;
}

export const STICKY_KINDS: Record<StickyKind, StickyMeta> = {
  event: { label: "ドメインイベント", help: "業務で起きた事実。過去形で書く（例: 招待が受諾された）", code: "pascal", w: 160, h: 100 },
  command: { label: "コマンド", help: "誰かの意図・操作（例: 招待を受諾する）", code: "snake", w: 160, h: 100 },
  actor: { label: "アクター", help: "コマンドを実行する人・役割", code: null, w: 120, h: 60 },
  policy: { label: "ポリシー", help: "「〜が起きたら〜する」という自動の反応。イベント → ポリシー → コマンドとつなぐ", code: "snake", w: 160, h: 100 },
  aggregate: { label: "集約", help: "コマンドを受けて整合性を守り、イベントを出すまとまり", code: "pascal", w: 200, h: 120 },
  read_model: { label: "リードモデル", help: "判断に必要な情報・画面", code: null, w: 160, h: 100 },
  external_system: { label: "外部システム", help: "自分たちの外にあるシステム", code: null, w: 160, h: 100 },
  hotspot: { label: "ホットスポット", help: "疑問・対立・未確定の論点", code: null, w: 160, h: 100 },
  rule: { label: "ルール", help: "守るべき条件（不変条件・状態ガードの候補）", code: null, w: 160, h: 90 },
  note: { label: "メモ", help: "自由なメモ", code: null, w: 160, h: 100 },
};

export function emptyBoard(): Board {
  return { version: 1, items: [], frames: [], connectors: [] };
}

/** Validates and normalizes untrusted board JSON (from storage or the network). */
export function normalizeBoard(raw: unknown): Board | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const kinds = Object.keys(STICKY_KINDS);
  const items: BoardItem[] = Array.isArray(r.items)
    ? r.items.flatMap((x: any) => {
        if (!x || typeof x.id !== "string" || !kinds.includes(x.kind)) return [];
        const meta = STICKY_KINDS[x.kind as StickyKind];
        const item: BoardItem = { id: str(x.id, 64), kind: x.kind, text: str(x.text, 500), x: num(x.x, 0), y: num(x.y, 0), w: Math.max(40, num(x.w, meta.w)), h: Math.max(30, num(x.h, meta.h)) };
        if (typeof x.codeName === "string" && x.codeName) item.codeName = str(x.codeName, 80);
        if (x.creates === true) item.creates = true;
        if (x.pivotal === true && x.kind === "event") item.pivotal = true;
        if (x.resolved === true && x.kind === "hotspot") item.resolved = true;
        if (typeof x.resolution === "string" && x.resolution && x.kind === "hotspot") item.resolution = str(x.resolution, 1000);
        if (Array.isArray(x.votes)) {
          const votes = x.votes.filter((v: unknown) => typeof v === "string" && v).slice(0, 200).map((v: string) => v.slice(0, 64));
          if (votes.length) item.votes = votes;
        }
        if (Array.isArray(x.comments)) {
          const comments = x.comments
            .filter((c: any) => c && typeof c.id === "string" && typeof c.text === "string" && c.text.trim())
            .slice(0, 200)
            .map((c: any) => ({ id: str(c.id, 64), author: str(c.author, 64), text: str(c.text, 2000), at: str(c.at, 40) }));
          if (comments.length) item.comments = comments;
        }
        return [item];
      })
    : [];
  const frames: BoardFrame[] = Array.isArray(r.frames)
    ? r.frames.flatMap((f: any) => {
        if (!f || typeof f.id !== "string") return [];
        const frame: BoardFrame = { id: str(f.id, 64), title: str(f.title, 120), x: num(f.x, 0), y: num(f.y, 0), w: Math.max(120, num(f.w, 600)), h: Math.max(80, num(f.h, 400)) };
        if (typeof f.codeName === "string" && f.codeName) frame.codeName = str(f.codeName, 80);
        if (f.subdomain === "core" || f.subdomain === "supporting" || f.subdomain === "generic") frame.subdomain = f.subdomain;
        return [frame];
      })
    : [];
  const ids = new Set(items.map((i) => i.id));
  const connectors: BoardConnector[] = Array.isArray(r.connectors)
    ? r.connectors.flatMap((c: any) => {
        if (!c || typeof c.id !== "string" || !ids.has(c.from) || !ids.has(c.to) || c.from === c.to) return [];
        const conn: BoardConnector = { id: str(c.id, 64), from: c.from, to: c.to };
        if (typeof c.label === "string" && c.label) conn.label = str(c.label, 120);
        return [conn];
      })
    : [];
  const lanes: BoardLane[] = Array.isArray(r.lanes)
    ? r.lanes.flatMap((l: any) => (l && typeof l.id === "string" ? [{ id: str(l.id, 64), title: str(l.title, 120), y: num(l.y, 0), h: Math.max(60, num(l.h, 220)) }] : [])).slice(0, 50)
    : [];
  const board: Board = { version: 1, items, frames, connectors };
  if (lanes.length) board.lanes = lanes;
  const w = r.workshop as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && typeof w.phase === "string") {
    const workshop: WorkshopState = { phase: str(w.phase, 40) };
    if (typeof w.timerEndsAt === "string" && !Number.isNaN(Date.parse(w.timerEndsAt))) workshop.timerEndsAt = w.timerEndsAt;
    if (typeof w.votesPerPerson === "number" && w.votesPerPerson >= 1 && w.votesPerPerson <= 20) workshop.votesPerPerson = Math.round(w.votesPerPerson);
    board.workshop = workshop;
  }
  return board;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const center = (i: { x: number; y: number; w: number; h: number }) => ({ x: i.x + i.w / 2, y: i.y + i.h / 2 });

/** The (smallest) frame containing the item's center. Membership is purely geometric, as on a whiteboard. */
export function frameOf(board: Board, item: BoardItem): BoardFrame | undefined {
  const c = center(item);
  return board.frames
    .filter((f) => c.x >= f.x && c.x <= f.x + f.w && c.y >= f.y && c.y <= f.y + f.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
}

/** Items whose center lies inside the frame (used to move them together with the frame). */
export function itemsInFrame(board: Board, frame: BoardFrame): BoardItem[] {
  return board.items.filter((i) => frameOf(board, i)?.id === frame.id);
}

const dist = (a: BoardItem, b: BoardItem) => Math.hypot(center(a).x - center(b).x, center(a).y - center(b).y);

// ---------------------------------------------------------------------------
// Assistance
// ---------------------------------------------------------------------------

export interface Finding {
  severity: "warning" | "info";
  code: string;
  message: string;
  hint?: string;
  itemIds: string[];
}

const PAST_TENSE_JA = /(た|だ|済み|済|完了|終了|失敗)$/;
const PAST_TENSE_EN = /(ed|en|done|failed|sent|made|paid)$/i;

function label(i: BoardItem): string {
  return i.text.trim() || `（${STICKY_KINDS[i.kind].label}・無題）`;
}

export function analyzeBoard(board: Board): Finding[] {
  const out: Finding[] = [];
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const outgoing = (id: string) => board.connectors.filter((c) => c.from === id).map((c) => byId.get(c.to)!).filter(Boolean);
  const incoming = (id: string) => board.connectors.filter((c) => c.to === id).map((c) => byId.get(c.from)!).filter(Boolean);
  const of = (k: StickyKind) => board.items.filter((i) => i.kind === k);

  if (board.items.length === 0) {
    out.push({
      severity: "info",
      code: "empty-board",
      message: "まず、業務で起きる出来事（ドメインイベント）を時系列で左から右へ並べてみましょう",
      hint: "例:「招待が送られた」「招待が受諾された」。細かさより数を優先し、あとで整理します",
      itemIds: [],
    });
    return out;
  }

  for (const e of of("event")) {
    const t = e.text.trim();
    if (t && !PAST_TENSE_JA.test(t) && !PAST_TENSE_EN.test(t)) {
      out.push({ severity: "info", code: "event-not-past", message: `「${t}」は過去形になっていません`, hint: "イベントは起きた事実として書きます（〜した／〜された）", itemIds: [e.id] });
    }
    const sources = incoming(e.id).filter((x) => ["command", "policy", "external_system", "aggregate"].includes(x.kind));
    if (sources.length === 0) {
      out.push({ severity: "info", code: "event-without-cause", message: `「${label(e)}」を引き起こすものがありません`, hint: "コマンド・ポリシー・外部システムからイベントへ矢印を引くと、誰が何をしたかが分かります", itemIds: [e.id] });
    }
  }
  for (const c of of("command")) {
    if (!outgoing(c.id).some((x) => x.kind === "event")) {
      out.push({ severity: "warning", code: "command-without-event", message: `コマンド「${label(c)}」の結果のイベントがありません`, hint: "成功したら何が起きるか（イベント）を書き、コマンドから矢印を引きます", itemIds: [c.id] });
    }
    if (!incoming(c.id).some((x) => x.kind === "actor" || x.kind === "policy")) {
      out.push({ severity: "info", code: "command-without-trigger", message: `コマンド「${label(c)}」を誰が実行するかが分かりません`, hint: "アクターかポリシーからコマンドへ矢印を引きます", itemIds: [c.id] });
    }
  }
  for (const p of of("policy")) {
    if (!incoming(p.id).some((x) => x.kind === "event")) {
      out.push({ severity: "warning", code: "policy-without-trigger", message: `ポリシー「${label(p)}」のきっかけになるイベントがありません`, itemIds: [p.id] });
    }
    if (!outgoing(p.id).some((x) => x.kind === "command")) {
      out.push({
        severity: "warning",
        code: "policy-without-command",
        message: `ポリシー「${label(p)}」が実行するコマンドがありません`,
        hint: "ポリシーからコマンドへ矢印を引きます。モデルに反映すると、イベントを受けてそのコマンドの Use case を実行するポリシーになります",
        itemIds: [p.id],
      });
    }
  }

  const candidates = suggestAggregates(board);
  for (const a of of("aggregate")) {
    const anchored = candidates.some((c) => c.aggregateItemId === a.id && c.commandIds.length);
    if (!anchored) {
      out.push({ severity: "warning", code: "aggregate-without-commands", message: `集約「${label(a)}」が受け取るコマンドがありません`, hint: "コマンドから集約へ矢印を引くか、集約の近くに置きます", itemIds: [a.id] });
    }
    const rules = rulesOf(board, a);
    if (rules.length === 0) {
      out.push({
        severity: "info",
        code: "aggregate-without-rules",
        message: `集約「${label(a)}」が守るルールが書かれていません`,
        hint: "この集約が一度の変更で必ず守るべき条件（不変条件）をルール付箋で書きます。守るルールがなければ、集約にする必要がないかもしれません",
        itemIds: [a.id],
      });
    }
  }
  // Only groups with commands need an aggregate; a lone event may be a fact from outside.
  const floating = candidates.filter((c) => !c.aggregateItemId && c.commandIds.length > 0);
  for (const c of floating) {
    const existing = c.name ? of("aggregate").find((a) => a.text.trim() === c.name) : undefined;
    out.push({
      severity: "warning",
      code: "commands-without-aggregate",
      message: `${c.commandIds.length} 個のコマンドと ${c.eventIds.length} 個のイベントに、担当する集約がありません`,
      hint: existing
        ? `既存の集約「${existing.text.trim()}」が担当するなら、コマンドからその集約へ矢印を引きます`
        : c.name
          ? `「${c.name}」を集約にする案があります（補助パネルの候補から置けます）`
          : "どの集約がこのコマンドを受けて整合性を守るかを話し合います",
      itemIds: [...c.commandIds, ...c.eventIds],
    });
  }

  const hotspots = of("hotspot").filter((h) => !h.resolved);
  if (hotspots.length) {
    out.push({ severity: "warning", code: "open-hotspots", message: `未解決の論点が ${hotspots.length} 件あります`, hint: "モデルに反映する前に、ドメインエキスパートと結論を出します", itemIds: hotspots.map((h) => h.id) });
  }

  if (board.frames.length === 0 && board.items.length >= 12) {
    out.push({ severity: "info", code: "no-contexts", message: "コンテキストの境界（フレーム）がまだありません", hint: "言葉の意味が変わる所・担当チームが変わる所・ポリシーでつながる所が境界の候補です", itemIds: [] });
  }
  const outside = board.items.filter((i) => board.frames.length > 0 && !frameOf(board, i) && ["event", "command", "aggregate", "policy"].includes(i.kind));
  if (outside.length) {
    out.push({ severity: "info", code: "outside-contexts", message: `${outside.length} 枚の付箋がどのコンテキストにも入っていません`, itemIds: outside.map((i) => i.id) });
  }
  for (const f of board.frames) {
    const inside = itemsInFrame(board, f);
    const aggs = inside.filter((i) => i.kind === "aggregate").length;
    const events = inside.filter((i) => i.kind === "event").length;
    if (aggs > 4 || events > 25) {
      out.push({
        severity: "info",
        code: "large-context",
        message: `コンテキスト「${f.title || "無題"}」が大きくなっています（集約 ${aggs}・イベント ${events}）`,
        hint: "同じ言葉が別の意味で使われていないか、別のチームが担当する部分がないかを確認します。分割するかどうかは皆さんが決めます",
        itemIds: inside.map((i) => i.id),
      });
    }
  }
  for (const c of candidates) {
    if (c.extraAggregateIds.length) {
      out.push({
        severity: "info",
        code: "aggregates-linked",
        message: `複数の集約が同じコマンド・イベントの流れでつながっています`,
        hint: "1つのコマンドで複数の集約を同時に変えていないか確認します。集約をまたぐ変更はイベントで伝えるのが基本です",
        itemIds: [c.aggregateItemId!, ...c.extraAggregateIds],
      });
    }
  }
  return out;
}

/** Rule stickies connected to, or sitting close to, an aggregate. */
export function rulesOf(board: Board, aggregate: BoardItem): BoardItem[] {
  const connected = new Set(board.connectors.flatMap((c) => (c.from === aggregate.id ? [c.to] : c.to === aggregate.id ? [c.from] : [])));
  return board.items.filter((i) => i.kind === "rule" && (connected.has(i.id) || (dist(i, aggregate) < 260 && frameOf(board, i)?.id === frameOf(board, aggregate)?.id)));
}

// ---------------------------------------------------------------------------
// Aggregate candidates and context map
// ---------------------------------------------------------------------------

export interface AggregateCandidate {
  id: string;
  /** Existing aggregate sticky this group belongs to, if any. */
  aggregateItemId?: string;
  /** Other aggregate stickies in the same flow (a smell). */
  extraAggregateIds: string[];
  /** Suggested name for a new aggregate (derived from the sticky texts). */
  name?: string;
  frameId?: string;
  commandIds: string[];
  eventIds: string[];
  reason: string;
  /** Where to place a new aggregate sticky for this group. */
  position: { x: number; y: number };
}

/** Groups commands and events that change the same thing. Proposals only. */
export function suggestAggregates(board: Board): AggregateCandidate[] {
  const relevant = board.items.filter((i) => i.kind === "command" || i.kind === "event" || i.kind === "aggregate");
  const ids = new Set(relevant.map((i) => i.id));
  const adj = new Map<string, Set<string>>(relevant.map((i) => [i.id, new Set<string>()]));
  for (const c of board.connectors) {
    if (!ids.has(c.from) || !ids.has(c.to)) continue;
    const a = board.items.find((i) => i.id === c.from)!;
    const b = board.items.find((i) => i.id === c.to)!;
    // Event → command links are cross-aggregate reactions (via policies), not the same aggregate.
    if (a.kind === "event" && b.kind === "command") continue;
    adj.get(c.from)!.add(c.to);
    adj.get(c.to)!.add(c.from);
  }
  const seen = new Set<string>();
  const groups: BoardItem[][] = [];
  for (const item of relevant) {
    if (seen.has(item.id)) continue;
    const group: BoardItem[] = [];
    const stack = [item.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(board.items.find((i) => i.id === id)!);
      for (const n of adj.get(id) ?? []) stack.push(n);
    }
    groups.push(group);
  }

  const aggregates = board.items.filter((i) => i.kind === "aggregate");
  const out: AggregateCandidate[] = [];
  for (const g of groups) {
    const commands = g.filter((i) => i.kind === "command");
    const events = g.filter((i) => i.kind === "event");
    const aggs = g.filter((i) => i.kind === "aggregate");
    if (!commands.length && !events.length && aggs.length) {
      // An aggregate with nothing connected: still report it (no commands).
      out.push({ id: `cand-${aggs[0]!.id}`, aggregateItemId: aggs[0]!.id, extraAggregateIds: aggs.slice(1).map((a) => a.id), commandIds: [], eventIds: [], reason: "つながっているコマンドがありません", frameId: frameOf(board, aggs[0]!)?.id, position: { x: aggs[0]!.x, y: aggs[0]!.y } });
      continue;
    }
    if (!commands.length && !events.length) continue;
    const members = [...commands, ...events];
    const cx = members.reduce((n, i) => n + center(i).x, 0) / members.length;
    const cy = members.reduce((n, i) => n + center(i).y, 0) / members.length;
    const frame = frameOf(board, members[0]!);
    let anchor = aggs[0];
    let reason = anchor ? `矢印で「${label(anchor)}」とつながっています` : "";
    if (!anchor) {
      const near = aggregates
        .filter((a) => frameOf(board, a)?.id === frame?.id)
        .map((a) => ({ a, d: Math.hypot(center(a).x - cx, center(a).y - cy) }))
        .filter((x) => x.d < 450)
        .sort((x, y) => x.d - y.d)[0];
      if (near) {
        anchor = near.a;
        reason = `「${label(near.a)}」の近くにあります`;
      }
    }
    const name = anchor ? undefined : guessNoun(members.map((m) => m.text));
    out.push({
      id: `cand-${members[0]!.id}`,
      aggregateItemId: anchor?.id,
      extraAggregateIds: aggs.filter((a) => a.id !== anchor?.id).map((a) => a.id),
      name,
      frameId: frame?.id,
      commandIds: commands.map((c) => c.id),
      eventIds: events.map((e) => e.id),
      reason: anchor ? reason : name ? `コマンドとイベントの文に「${name}」が共通して出てきます` : "担当する集約がまだありません",
      position: { x: Math.round(cx - 100), y: Math.round(Math.max(...members.map((m) => m.y + m.h)) + 40) },
    });
  }
  return out;
}

/** Most common leading noun in the texts: 「招待を送る」「招待が受諾された」→「招待」, "Accept invitation" → "Invitation". */
export function guessNoun(texts: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const text = t.trim();
    if (!text) continue;
    const ja = /^(.+?)(を|が|は|の|に)/.exec(text);
    let noun: string | undefined;
    if (ja && /[぀-ヿ一-鿿]/.test(ja[1]!)) noun = ja[1];
    else if (/^[A-Za-z]/.test(text)) {
      const words = text.split(/\s+/).filter((w) => /^[A-Za-z]+$/.test(w));
      const stop = new Set(["a", "an", "the", "to", "of", "for", "was", "is", "be", "been"]);
      const content = words.filter((w) => !stop.has(w.toLowerCase()));
      // "Invitation accepted" → first word; "Accept invitation" → last word.
      noun = content.length > 1 && /(ed|en)$/i.test(content[content.length - 1]!) ? content[0] : content[content.length - 1];
      if (noun) noun = noun[0]!.toUpperCase() + noun.slice(1).toLowerCase();
    }
    if (noun) counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 1 ? best[0] : undefined;
}

export interface ContextLink {
  fromFrameId: string;
  toFrameId: string;
  /** Texts of the event → (policy →) command chain. */
  via: string[];
}

/** Relations between contexts: an event in one frame triggers (via a policy) a command in another. */
export function contextMap(board: Board): ContextLink[] {
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const links: ContextLink[] = [];
  const add = (from: BoardItem, to: BoardItem, via: string[]) => {
    const a = frameOf(board, from);
    const b = frameOf(board, to);
    if (a && b && a.id !== b.id) links.push({ fromFrameId: a.id, toFrameId: b.id, via });
  };
  for (const c of board.connectors) {
    const from = byId.get(c.from);
    const to = byId.get(c.to);
    if (!from || !to) continue;
    if (from.kind === "event" && to.kind === "command") add(from, to, [label(from), label(to)]);
    if (from.kind === "event" && to.kind === "policy") {
      for (const c2 of board.connectors.filter((x) => x.from === to.id)) {
        const cmd = byId.get(c2.to);
        if (cmd?.kind === "command") add(from, cmd, [label(from), label(to), label(cmd)]);
      }
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Board → model
// ---------------------------------------------------------------------------

export interface NameRequest {
  /** Item or frame id; "__default_context" when no frames exist. */
  id: string;
  kind: StickyKind | "context";
  text: string;
  /** Suggested code name (from ASCII text) or "" when the label is not ASCII. */
  suggested: string;
  style: "pascal" | "snake";
}

export interface ReflectResult {
  ok: boolean;
  /** Elements that need a valid code name before reflecting. */
  names: NameRequest[];
  missing: NameRequest[];
  yaml?: string;
  /** Items that are intentionally not converted (with the reason). */
  skipped: { id: string; text: string; reason: string }[];
  diagnostics: Diagnostic[];
  error?: string;
  summary: string[];
}

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;

function asciiWords(text: string): string[] | undefined {
  if (!/^[\x20-\x7e]+$/.test(text.trim())) return undefined;
  const words = text.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.length ? words : undefined;
}

export function suggestCodeName(text: string, style: "pascal" | "snake"): string {
  const words = asciiWords(text);
  if (!words) return "";
  if (style === "pascal") {
    const s = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
    return /^[A-Z]/.test(s) ? s : "";
  }
  const s = words
    .map((w) => w.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .join("_")
    .toLowerCase();
  return /^[a-z]/.test(s) ? s : "";
}

interface Plan {
  contexts: {
    frameId: string;
    name: string;
    title: string;
    aggregates: { item: BoardItem; name: string; rules: BoardItem[]; commands: { item: BoardItem; name: string; events: { item: BoardItem; name: string }[]; actor?: string }[] }[];
  }[];
}

/**
 * Converts the board into model elements. Existing elements are never modified: when the current model already
 * has content, only missing contexts / aggregates / operations / use cases are added through structural edits.
 */
export function boardToModel(board: Board, currentYaml: string, names: Record<string, string> = {}): ReflectResult {
  const skipped: ReflectResult["skipped"] = [];
  const requests: NameRequest[] = [];
  /** One rule for every element: explicit name > code name on the board > default > derived from ASCII text. */
  const resolve = (id: string, text: string, style: "pascal" | "snake"): string =>
    names[id] || boardCodeName(board, id) || (id === "__default_context" ? "Core" : "") || suggestCodeName(text, style);
  const nameOf = (id: string, kind: NameRequest["kind"], text: string, style: "pascal" | "snake", _fallback?: string): string => {
    requests.push({ id, kind, text, suggested: suggestCodeName(text, style) || (id === "__default_context" ? "Core" : ""), style });
    return resolve(id, text, style);
  };

  // Group aggregates by frame (or a default context).
  const aggregates = board.items.filter((i) => i.kind === "aggregate");
  const candidates = suggestAggregates(board);
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const frames = board.frames.length ? board.frames : [];
  const contextKey = (i: BoardItem) => frameOf(board, i)?.id ?? "__default_context";
  const plan: Plan = { contexts: [] };
  const contextFor = (key: string) => {
    let c = plan.contexts.find((x) => x.frameId === key);
    if (!c) {
      const frame = frames.find((f) => f.id === key);
      const title = frame?.title ?? "Core";
      c = { frameId: key, title, name: nameOf(key, "context", title, "pascal", frame?.codeName ?? (key === "__default_context" ? "Core" : undefined)), aggregates: [] };
      plan.contexts.push(c);
    }
    return c;
  };

  for (const a of aggregates) {
    const ctx = contextFor(contextKey(a));
    const cand = candidates.find((c) => c.aggregateItemId === a.id);
    const commands = (cand?.commandIds ?? []).map((id) => byId.get(id)!).filter(Boolean);
    const agg = { item: a, name: nameOf(a.id, "aggregate", a.text, "pascal", a.codeName), rules: rulesOf(board, a), commands: [] as Plan["contexts"][number]["aggregates"][number]["commands"] };
    for (const cmd of commands) {
      const events = board.connectors
        .filter((c) => c.from === cmd.id)
        .map((c) => byId.get(c.to)!)
        .filter((i) => i?.kind === "event")
        .map((e) => ({ item: e, name: nameOf(e.id, "event", e.text, "pascal", e.codeName) }));
      const actor = board.connectors
        .filter((c) => c.to === cmd.id)
        .map((c) => byId.get(c.from))
        .find((i) => i?.kind === "actor")?.text;
      agg.commands.push({ item: cmd, name: nameOf(cmd.id, "command", cmd.text, "snake", cmd.codeName), events, actor });
    }
    ctx.aggregates.push(agg);
  }
  for (const c of candidates.filter((x) => !x.aggregateItemId)) {
    for (const id of [...c.commandIds, ...c.eventIds]) skipped.push({ id, text: byId.get(id)?.text ?? "", reason: "担当する集約が決まっていません（補助パネルの候補から集約を置くと反映できます）" });
  }
  // Event → policy → command chains become policies of the command's context (names are requested like the rest).
  const policyChains: { item: BoardItem; name: string; event: BoardItem; eventName: string; command: BoardItem }[] = [];
  for (const p of board.items.filter((i) => i.kind === "policy")) {
    const events = board.connectors.filter((c) => c.to === p.id).map((c) => byId.get(c.from)).filter((i): i is BoardItem => i?.kind === "event");
    const commands = board.connectors.filter((c) => c.from === p.id).map((c) => byId.get(c.to)).filter((i): i is BoardItem => i?.kind === "command");
    if (!events.length || !commands.length) {
      skipped.push({ id: p.id, text: p.text, reason: events.length ? "実行するコマンドがありません（ポリシーからコマンドへ矢印を引くと反映できます）" : "きっかけのイベントがありません（イベントからポリシーへ矢印を引くと反映できます）" });
      continue;
    }
    const pairs = events.flatMap((e) => commands.map((c) => ({ e, c })));
    pairs.forEach(({ e, c }, i) => {
      const eventName = nameOf(e.id, "event", e.text, "pascal", e.codeName);
      const commandName = resolve(c.id, c.text, "snake");
      // Default: <command>_on_<event>, e.g. send_welcome_mail_on_invitation_accepted.
      const fallback = SNAKE.test(commandName) && PASCAL.test(eventName) ? `${commandName}_on_${snakeOf(eventName)}` : "";
      const base = names[p.id] || boardCodeName(board, p.id) || suggestCodeName(p.text, "snake") || fallback;
      if (i === 0) requests.push({ id: p.id, kind: "policy", text: p.text, suggested: suggestCodeName(p.text, "snake") || fallback, style: "snake" });
      policyChains.push({ item: p, name: i === 0 ? base : base && `${base}_${i + 1}`, event: e, eventName, command: c });
    });
  }
  for (const i of board.items) {
    if (i.kind === "hotspot") skipped.push({ id: i.id, text: i.text, reason: "未解決の論点です" });
    if (i.kind === "read_model" || i.kind === "external_system") skipped.push({ id: i.id, text: i.text, reason: `${STICKY_KINDS[i.kind].label}はモデルの対象外です` });
  }

  const unique = new Map<string, NameRequest>();
  for (const r of requests) unique.set(r.id, r);
  const allNames = [...unique.values()];
  const finalName = (r: NameRequest) => (r.kind === "policy" ? policyChains.find((x) => x.item.id === r.id)?.name ?? "" : resolve(r.id, r.text, r.style));
  const missing = allNames.filter((r) => {
    const n = finalName(r);
    return !(r.style === "pascal" ? PASCAL.test(n) : SNAKE.test(n));
  });
  const summary = plan.contexts.map((c) => `${c.name || c.title}: 集約 ${c.aggregates.length}・操作 ${c.aggregates.reduce((n, a) => n + a.commands.length, 0)}`);
  if (!plan.contexts.length) {
    return { ok: false, names: allNames, missing, skipped, diagnostics: [], error: "集約の付箋がありません。集約を置いてから反映します", summary };
  }
  if (missing.length) return { ok: false, names: allNames, missing, skipped, diagnostics: [], summary };

  // Build the model content for each context.
  const parsed = parseModel(currentYaml);
  if (!parsed.model) return { ok: false, names: allNames, missing: [], skipped, diagnostics: parsed.diagnostics, error: "現在のモデルを読み込めません（YAMLの構文エラーを直してから反映します）", summary };
  const model = parsed.model;
  // Only the untouched template may be replaced; anything the team already wrote is kept.
  const isEmpty = model.contexts.every(
    (c) =>
      c.aggregates.length === 0 &&
      c.useCases.length === 0 &&
      c.errors.length === 0 &&
      c.enums.length === 0 &&
      c.valueObjects.length === 0 &&
      c.extensionPoints.length === 0 &&
      c.glossary.length === 0,
  );

  const ops: EditOp[] = [];
  const doc = parseDocument(currentYaml);
  if (isEmpty) {
    // Replace the template contexts entirely (keeps schema_version / project / generation and comments above).
    doc.setIn(["contexts"], doc.createNode([]));
  }
  let working = isEmpty ? doc.toString({ lineWidth: 0 }) : currentYaml;
  const current = parseModel(working).model!;
  const currentEvents = analyzeModel(current).contexts;
  /** What the reflection produces, for wiring policies afterwards. */
  const produced = {
    contextIndex: new Map<string, number>(),
    /** context → event name → payload field names and emitting aggregate */
    events: new Map<string, Map<string, { fields: string[]; aggregate: string }>>(),
    /** command sticky id → the use case that will run it */
    useCases: new Map<string, { context: string; name: string; input: { name: string; required: boolean }[] }>(),
  };
  let newContexts = 0;

  for (const c of plan.contexts) {
    const ctxName = c.name;
    const existingCtx = current.contexts.find((x) => x.name === ctxName);
    const ctxIndex = existingCtx ? current.contexts.indexOf(existingCtx) : undefined;
    produced.contextIndex.set(ctxName, ctxIndex ?? current.contexts.length + newContexts++);
    const ctxPath = (idx: number) => ["contexts", idx];
    const errors: Record<string, unknown>[] = [];
    const aggregatesOut: Record<string, unknown>[] = [];
    const useCasesOut: Record<string, unknown>[] = [];
    const glossary: Record<string, unknown>[] = [];
    const needNotFound = new Set<string>();

    for (const a of c.aggregates) {
      const aggName = a.name;
      const existingAgg = existingCtx?.aggregates.find((x) => x.name === aggName);
      const operations: Record<string, unknown>[] = [];
      const factories: Record<string, unknown>[] = [];
      if (a.item.text.trim() && !/^[\x20-\x7e]+$/.test(a.item.text)) glossary.push({ term: a.item.text.trim(), definition: `集約 ${aggName}` });
      const ctxEvents = existingCtx ? currentEvents.get(existingCtx.name)?.events : undefined;
      const aggFieldNames = new Set(existingAgg?.fields.map((f) => f.name) ?? ["id"]);
      for (const cmd of a.commands) {
        const opName = cmd.name;
        // An event that already exists keeps its contract; reuse it only if its payload can be filled from the aggregate.
        const emits = cmd.events.flatMap((e) => {
          const known = ctxEvents?.get(e.name);
          if (!known) return [{ name: e.name, fields: ["id"] }];
          if (known.fields.every((f) => aggFieldNames.has(f.name))) return [{ name: e.name, fields: known.fields.map((f) => f.name) }];
          skipped.push({ id: e.item.id, text: e.item.text, reason: `既存のイベント ${e.name} は操作の引数を含むため、発生させる操作は手で書きます` });
          return [];
        });
        for (const e of cmd.events) {
          if (e.item.text.trim() && !/^[\x20-\x7e]+$/.test(e.item.text)) glossary.push({ term: e.item.text.trim(), definition: `イベント ${e.name}` });
        }
        const ctxProduced = produced.events.get(ctxName) ?? new Map<string, { fields: string[]; aggregate: string }>();
        for (const em of emits) ctxProduced.set(em.name, { fields: em.fields, aggregate: aggName });
        produced.events.set(ctxName, ctxProduced);
        const existingOp = existingAgg && [...existingAgg.operations, ...existingAgg.factories].find((o) => o.name === opName);
        const requiredFields = existingAgg?.fields.filter((f) => f.required && f.name !== existingAgg.identity) ?? [];
        if (!existingOp && cmd.item.creates && requiredFields.length) {
          skipped.push({ id: cmd.item.id, text: cmd.item.text, reason: `既存の集約 ${aggName} には必須フィールド（${requiredFields.map((f) => f.name).join(", ")}）があるため、ファクトリは手で書きます` });
          continue;
        }
        if (existingOp) {
          const invoker = existingCtx!.useCases.find((u) => u.name === opName) ?? existingCtx!.useCases.find((u) => JSON.stringify(u.steps).includes(`"${opName}"`));
          const invoked = !!invoker;
          const needsArgs = existingOp.parameters.some((p) => p.required);
          if (invoker) produced.useCases.set(cmd.item.id, { context: ctxName, name: invoker.name, input: invoker.input.map((f) => ({ name: f.name, required: f.required })) });
          if (invoked || needsArgs) {
            if (needsArgs && !invoked) skipped.push({ id: cmd.item.id, text: cmd.item.text, reason: `既存の操作 ${opName} は引数が必要なため、Use case は手で書きます` });
            continue;
          }
        }
        if (!existingOp) {
          if (cmd.item.creates) {
            factories.push({ name: opName, description: cmd.item.text.trim() || undefined, parameters: [{ name: "id", type: "UUID" }], fields: { id: "id" }, ...(emits.length ? { emits } : {}) });
          } else {
            operations.push({ name: opName, description: cmd.item.text.trim() || undefined, ...(emits.length ? { emits } : {}) });
          }
        }
        const existingUseCase = existingCtx?.useCases.find((u) => u.name === opName);
        if (existingUseCase) {
          produced.useCases.set(cmd.item.id, { context: ctxName, name: opName, input: existingUseCase.input.map((f) => ({ name: f.name, required: f.required })) });
          continue;
        }
        const command = opName
          .split("_")
          .map((w) => w[0]!.toUpperCase() + w.slice(1))
          .join("");
        const idField = `${aggName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}_id`;
        const variable = aggName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
        const steps: Record<string, unknown>[] = cmd.item.creates
          ? [
              { create: { aggregate: aggName, factory: opName, as: variable, args: { id: "ids.new" } } },
              { save: variable },
              ...emits.map((e) => ({ publish_after_commit: e.name })),
              { return: `${variable}.id` },
            ]
          : [
              { load: { aggregate: aggName, by: idField, as: variable, not_found: `${aggName}NotFound` } },
              { invoke: { target: variable, operation: opName } },
              { save: variable },
              ...emits.map((e) => ({ publish_after_commit: e.name })),
            ];
        if (!cmd.item.creates) needNotFound.add(aggName);
        produced.useCases.set(cmd.item.id, { context: ctxName, name: opName, input: cmd.item.creates ? [] : [{ name: idField, required: true }] });
        useCasesOut.push({
          name: opName,
          ...(cmd.actor ? { actor: cmd.actor } : {}),
          description: cmd.item.text.trim() || undefined,
          command: `${command}${current.contexts.some((x) => x.useCases.some((u) => u.command === command)) ? "Command" : ""}`,
          transaction: "required",
          input: cmd.item.creates ? [] : [{ name: idField, type: "UUID" }],
          steps,
        });
      }
      const ruleNotes = a.rules.map((r) => `TODO ルール: ${r.text.trim()}`).filter((x) => x.length > 11);
      if (existingAgg) {
        const aggIndex = existingCtx!.aggregates.indexOf(existingAgg);
        const base = [...ctxPath(ctxIndex!), "aggregates", aggIndex];
        for (const o of operations) ops.push({ op: "add", path: [...base, "operations"], value: clean(o) });
        for (const f of factories) ops.push({ op: "add", path: [...base, "factories"], value: clean(f) });
      } else {
        aggregatesOut.push(
          clean({
            name: aggName,
            description: [a.item.text.trim(), ...ruleNotes].filter(Boolean).join("\n") || undefined,
            identity: "id",
            fields: [{ name: "id", type: "UUID" }],
            ...(factories.length ? { factories } : {}),
            ...(operations.length ? { operations } : {}),
          }),
        );
      }
    }
    for (const agg of needNotFound) {
      const errName = `${agg}NotFound`;
      if (!existingCtx?.errors.some((e) => e.name === errName)) {
        errors.push({ name: errName, code: `${agg.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}_not_found`, message: `${agg} が見つかりません` });
      }
    }
    if (existingCtx) {
      const base = ctxPath(ctxIndex!);
      const knownTerms = new Set(existingCtx.glossary.map((g) => g.term));
      for (const g of dedupe(glossary)) if (!knownTerms.has(String(g.term))) ops.push({ op: "add", path: [...base, "glossary"], value: g });
      for (const e of errors) ops.push({ op: "add", path: [...base, "errors"], value: e });
      for (const a of aggregatesOut) ops.push({ op: "add", path: [...base, "aggregates"], value: a });
      for (const u of useCasesOut) ops.push({ op: "add", path: [...base, "use_cases"], value: clean(u) });
    } else {
      const frame = board.frames.find((f) => f.id === c.frameId);
      ops.push({
        op: "add",
        path: ["contexts"],
        value: clean({
          name: ctxName,
          description: frame?.title && !/^[\x20-\x7e]+$/.test(frame.title) ? frame.title : undefined,
          ...(dedupe(glossary).length ? { glossary: dedupe(glossary) } : {}),
          ...(errors.length ? { errors } : {}),
          aggregates: aggregatesOut,
          ...(useCasesOut.length ? { use_cases: useCasesOut.map(clean) } : {}),
        }),
      });
    }
  }

  // Policies and the context map: added after every context exists (indexes of new contexts are known now).
  const newRelationships: { upstream: string; downstream: string; pattern: string; events: string[] }[] = [];
  const policyCount = new Map<string, number>();
  for (const chain of policyChains) {
    const uc = produced.useCases.get(chain.command.id);
    const skip = (reason: string) => skipped.push({ id: chain.item.id, text: chain.item.text, reason });
    if (!uc) {
      skip(`コマンド「${label(chain.command)}」の Use case が反映されないため、ポリシーは手で書きます`);
      continue;
    }
    const eventCtx = plan.contexts.find((c) => c.frameId === contextKey(chain.event))?.name ?? resolve(contextKey(chain.event), frames.find((f) => f.id === contextKey(chain.event))?.title ?? "Core", "pascal");
    const known = currentEvents.get(eventCtx)?.events.get(chain.eventName);
    const event = produced.events.get(eventCtx)?.get(chain.eventName) ?? (known ? { fields: known.fields.map((f) => f.name), aggregate: known.sources[0]!.aggregate } : undefined);
    if (!event) {
      skip(`イベント ${chain.eventName} を発生させる操作が反映されないため、ポリシーは手で書きます`);
      continue;
    }
    // Map each required input from the event: same field name, or <aggregate>_id ← id.
    const args: Record<string, string> = {};
    const unmapped = uc.input.filter((f) => {
      if (event.fields.includes(f.name)) args[f.name] = `event.${f.name}`;
      else if (f.name === `${snakeOf(event.aggregate)}_id` && event.fields.includes("id")) args[f.name] = "event.id";
      return f.required && !(f.name in args);
    });
    if (unmapped.length) {
      skip(`Use case ${uc.name} の入力（${unmapped.map((f) => f.name).join(", ")}）をイベント ${chain.eventName} から決められないため、ポリシーは手で書きます`);
      continue;
    }
    const cross = eventCtx !== uc.context;
    const when = cross ? `${eventCtx}.${chain.eventName}` : chain.eventName;
    const existingCtx = current.contexts.find((c) => c.name === uc.context);
    const duplicate = existingCtx?.policies.find((x) => {
      const ref = parseEventRef(x.when);
      return x.name === chain.name || (x.run === uc.name && ref?.name === chain.eventName && (ref.context ?? uc.context) === eventCtx);
    });
    if (duplicate) continue;
    if (cross) {
      const existingRel = current.relationships.find((r) => r.upstream === eventCtx && r.downstream === uc.context);
      if (existingRel?.pattern === "separate_ways") {
        skip(`${eventCtx} と ${uc.context} は separate_ways（連携しない）の関係なので、ポリシーは反映しません`);
        continue;
      }
      if (existingRel) {
        if (!existingRel.events.includes(chain.eventName)) {
          ops.push({ op: "add", path: ["relationships", current.relationships.indexOf(existingRel), "events"], value: chain.eventName });
          existingRel.events.push(chain.eventName);
        }
      } else {
        const rel = newRelationships.find((r) => r.upstream === eventCtx && r.downstream === uc.context);
        if (!rel) newRelationships.push({ upstream: eventCtx, downstream: uc.context, pattern: "customer_supplier", events: [chain.eventName] });
        else if (!rel.events.includes(chain.eventName)) rel.events.push(chain.eventName);
      }
    }
    ops.push({
      op: "add",
      path: ["contexts", produced.contextIndex.get(uc.context)!, "policies"],
      // args is always written (block style, and the place to add inputs later is visible).
      value: clean({ name: chain.name, description: chain.item.text.trim() || undefined, when, run: uc.name, args }),
    });
    policyCount.set(uc.context, (policyCount.get(uc.context) ?? 0) + 1);
  }
  for (const rel of newRelationships) ops.push({ op: "add", path: ["relationships"], value: rel });
  for (const [ctx, n] of policyCount) summary.push(`${ctx}: ポリシー ${n}`);
  if (newRelationships.length) summary.push(`コンテキストマップ: ${newRelationships.map((r) => `${r.upstream} → ${r.downstream}`).join(", ")}`);

  const r = applyEdits(working, ops);
  if (!r.ok) return { ok: false, names: allNames, missing: [], skipped, diagnostics: [], error: r.error, summary };
  working = r.text;
  const v = validateModelText(working);
  return {
    ok: v.ok,
    names: allNames,
    missing: [],
    yaml: working,
    skipped: dedupeSkipped(skipped),
    diagnostics: v.diagnostics,
    error: v.ok ? undefined : "生成したモデルに検証エラーがあります（コード名の重複などを確認してください）",
    summary,
  };
}

function snakeOf(pascalName: string): string {
  return pascalName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function boardCodeName(board: Board, id: string): string | undefined {
  return board.items.find((i) => i.id === id)?.codeName ?? board.frames.find((f) => f.id === id)?.codeName;
}

/** Drops undefined values so the YAML stays clean. */
function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function dedupe(glossary: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return glossary.filter((g) => (seen.has(String(g.term)) ? false : (seen.add(String(g.term)), true)));
}

function dedupeSkipped(s: ReflectResult["skipped"]): ReflectResult["skipped"] {
  const seen = new Set<string>();
  return s.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}


// ---------------------------------------------------------------------------
// Sample board (cleaning staff invitations), so an empty board has a worked example
// ---------------------------------------------------------------------------

export function sampleBoard(): Board {
  const s = (id: string, kind: StickyKind, text: string, x: number, y: number, extra: Partial<BoardItem> = {}): BoardItem => ({
    id,
    kind,
    text,
    x,
    y,
    w: STICKY_KINDS[kind].w,
    h: STICKY_KINDS[kind].h,
    ...extra,
  });
  return {
    version: 1,
    frames: [
      { id: "f-invite", title: "スタッフ招待", codeName: "StaffInvitation", x: 0, y: 0, w: 1180, h: 640 },
      { id: "f-notify", title: "通知", codeName: "Notification", x: 1260, y: 0, w: 640, h: 640 },
    ],
    items: [
      s("a-admin", "actor", "清掃会社の管理者", 40, 70),
      s("c-issue", "command", "招待を送る", 40, 150, { codeName: "issue_invitation", creates: true }),
      s("e-issued", "event", "招待が送られた", 240, 150, { codeName: "InvitationIssued" }),
      s("a-staff", "actor", "スタッフ候補", 440, 70),
      s("c-accept", "command", "招待を受諾する", 440, 150, { codeName: "accept_invitation" }),
      s("e-accepted", "event", "招待が受諾された", 640, 150, { codeName: "InvitationAccepted" }),
      s("c-revoke", "command", "招待を取り消す", 440, 300, { codeName: "revoke_invitation" }),
      s("e-revoked", "event", "招待が取り消された", 640, 300, { codeName: "InvitationRevoked" }),
      s("ag-inv", "aggregate", "招待", 330, 440, { codeName: "Invitation" }),
      s("r-expiry", "rule", "期限切れの招待は受諾できない", 560, 450),
      s("r-once", "rule", "受諾・取り消し済みの招待は変更できない", 760, 450),
      s("h-resend", "hotspot", "期限切れの招待を再送できる？", 900, 150),
      s("x-mail", "external_system", "メール配信サービス", 1680, 300),
      s("p-welcome", "policy", "受諾されたら歓迎メールを送る", 1300, 150),
      s("c-welcome", "command", "歓迎メールを送る", 1500, 150, { codeName: "send_welcome_mail", creates: true }),
      s("e-welcome", "event", "歓迎メールが送られた", 1700, 150, { codeName: "WelcomeMailSent" }),
      s("ag-mail", "aggregate", "通知", 1500, 440, { codeName: "Notification" }),
      s("rm-list", "read_model", "未受諾の招待一覧", 900, 300),
    ],
    connectors: [
      { id: "k1", from: "a-admin", to: "c-issue" },
      { id: "k2", from: "c-issue", to: "e-issued" },
      { id: "k3", from: "a-staff", to: "c-accept" },
      { id: "k4", from: "c-accept", to: "e-accepted" },
      { id: "k5", from: "a-admin", to: "c-revoke" },
      { id: "k6", from: "c-revoke", to: "e-revoked" },
      { id: "k7", from: "c-issue", to: "ag-inv" },
      { id: "k8", from: "c-accept", to: "ag-inv" },
      { id: "k9", from: "c-revoke", to: "ag-inv" },
      { id: "k10", from: "e-accepted", to: "p-welcome" },
      { id: "k11", from: "p-welcome", to: "c-welcome" },
      { id: "k12", from: "c-welcome", to: "e-welcome" },
      { id: "k13", from: "c-welcome", to: "ag-mail" },
      { id: "k14", from: "c-welcome", to: "x-mail" },
      { id: "k15", from: "r-once", to: "ag-inv" },
    ],
  };
}
