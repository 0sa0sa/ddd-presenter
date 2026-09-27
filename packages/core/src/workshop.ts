/**
 * Facilitation support for an EventStorming workshop on the discovery board:
 * the steps (big picture → process → design → boundaries), what to check at each step,
 * timeline problems, duplicates, dot votes, and a static SVG of the board for sharing.
 */
import { frameOf, STICKY_KINDS, SUBDOMAIN_LABEL, type Board, type BoardItem, type StickyKind } from "./discovery.ts";

export interface WorkshopCheck {
  label: string;
  done: boolean;
  /** Stickies to look at when the check is not done. */
  itemIds: string[];
}

export interface WorkshopPhase {
  id: string;
  title: string;
  /** What the group produces in this step. */
  goal: string;
  /** What the facilitator says / asks. */
  prompts: string[];
  /** Sticky kinds used in this step (the palette highlights them). */
  kinds: StickyKind[];
  minutes: number;
  checks: (board: Board) => WorkshopCheck[];
}

const of = (b: Board, kind: StickyKind) => b.items.filter((i) => i.kind === kind && i.text.trim());
const center = (i: BoardItem) => i.x + i.w / 2;

export const WORKSHOP_PHASES: WorkshopPhase[] = [
  {
    id: "chaotic",
    title: "出来事を出し合う",
    goal: "業務で起きる出来事（ドメインイベント）を、一人ずつ思いつくだけ書き出す。順番や重複は気にしない。",
    prompts: ["この業務で起きることを、過去形で1枚に1つずつ書いてください（例: 招待が受諾された）", "うまくいかなかったとき・例外のときに起きることは？", "議論が始まったら、ホットスポットに書いて先に進みましょう"],
    kinds: ["event", "hotspot"],
    minutes: 15,
    checks: (b) => {
      const events = of(b, "event");
      const notPast = events.filter((e) => !/(た|だ|ed|en)\s*$/i.test(e.text.trim()));
      return [
        { label: "出来事が10枚以上ある", done: events.length >= 10, itemIds: [] },
        { label: "出来事が過去形で書かれている", done: events.length > 0 && notPast.length === 0, itemIds: notPast.map((e) => e.id) },
      ];
    },
  },
  {
    id: "timeline",
    title: "時系列に並べる",
    goal: "出来事を左から右へ起きる順に並べ、重複をまとめ、流れの節目になる出来事（ピボタルイベント）に印を付ける。",
    prompts: ["左から右へ、起きる順に並べ直しましょう", "同じ出来事を別の言葉で書いていませんか？", "ここで業務の段階が変わる、という出来事はどれですか？（ピボタルイベント）", "並べてみて分からない所はホットスポットにします"],
    kinds: ["event", "hotspot"],
    minutes: 20,
    checks: (b) => {
      const back = timelineIssues(b);
      const dups = duplicateStickies(b);
      return [
        { label: "矢印が時間の流れ（左→右）に沿っている", done: back.length === 0, itemIds: back.flatMap((x) => [x.from, x.to]) },
        { label: "同じ内容の付箋がまとめられている", done: dups.length === 0, itemIds: dups.flat() },
        { label: "ピボタルイベントに印がある", done: of(b, "event").some((e) => e.pivotal), itemIds: [] },
      ];
    },
  },
  {
    id: "process",
    title: "流れを説明する",
    goal: "出来事を起こすコマンド、実行するアクター、自動で反応するポリシー、判断に使う情報（リードモデル）と外部システムを足す。",
    prompts: ["この出来事は、誰の何という操作で起きますか？", "「〜が起きたら〜する」という自動の反応はありますか？（ポリシー）", "操作するとき、何を見て判断していますか？（リードモデル）", "外のシステムとのやり取りは？"],
    kinds: ["command", "actor", "policy", "read_model", "external_system"],
    minutes: 30,
    checks: (b) => {
      const incoming = (id: string) => b.connectors.filter((c) => c.to === id).map((c) => b.items.find((i) => i.id === c.from)?.kind);
      const uncaused = of(b, "event").filter((e) => !incoming(e.id).some((k) => k === "command" || k === "policy" || k === "external_system" || k === "aggregate"));
      const nobody = of(b, "command").filter((c) => !incoming(c.id).some((k) => k === "actor" || k === "policy"));
      return [
        { label: "どの出来事にも、起こしたもの（コマンド・ポリシー・外部システム）がある", done: of(b, "event").length > 0 && uncaused.length === 0, itemIds: uncaused.map((e) => e.id) },
        { label: "どのコマンドにも、実行する人かポリシーがある", done: of(b, "command").length > 0 && nobody.length === 0, itemIds: nobody.map((c) => c.id) },
      ];
    },
  },
  {
    id: "design",
    title: "集約とルールを決める",
    goal: "コマンドを受け止めて整合性を守るまとまり（集約）と、そこで必ず守るルールを決める。",
    prompts: ["このコマンドを受けたとき、同時に必ず正しくなければならないものは何ですか？", "そのルールは、少し遅れて守られるのでは困りますか？", "右パネルの「集約の候補」も参考にしましょう"],
    kinds: ["aggregate", "rule"],
    minutes: 30,
    checks: (b) => {
      const handled = new Set(b.connectors.filter((c) => b.items.find((i) => i.id === c.to)?.kind === "aggregate").map((c) => c.from));
      const loose = of(b, "command").filter((c) => !handled.has(c.id));
      return [
        { label: "どのコマンドも集約につながっている", done: of(b, "command").length > 0 && loose.length === 0, itemIds: loose.map((c) => c.id) },
        { label: "集約が守るルールが書かれている", done: of(b, "rule").length > 0, itemIds: [] },
      ];
    },
  },
  {
    id: "boundaries",
    title: "境界を引いて優先順位を決める",
    goal: "言葉の意味が変わる所で境界（コンテキスト）を引き、それぞれをコア・支援・汎用に分ける。残った論点に投票し、次に話す順を決める。",
    prompts: ["同じ言葉が違う意味になる所はどこですか？", "ピボタルイベントの前後で、担当や言葉が変わりませんか？", "競争力の源（コア）はどこですか？ 既製品で済む所（汎用）は？", "残ったホットスポットに1人3票で投票しましょう"],
    kinds: ["hotspot"],
    minutes: 20,
    checks: (b) => {
      const outside = b.items.filter((i) => ["event", "command", "aggregate"].includes(i.kind) && i.text.trim() && !frameOf(b, i));
      const unclassified = b.frames.filter((f) => !f.subdomain);
      const open = of(b, "hotspot").filter((h) => !h.resolved);
      return [
        { label: "コンテキストの枠がある", done: b.frames.length > 0, itemIds: [] },
        { label: "出来事・コマンド・集約がどれかの枠に入っている", done: b.frames.length > 0 && outside.length === 0, itemIds: outside.map((i) => i.id) },
        { label: "枠をコア・支援・汎用に分けた", done: b.frames.length > 0 && unclassified.length === 0, itemIds: unclassified.map((f) => f.id) },
        { label: "未解決のホットスポットに投票した", done: open.length === 0 || open.some((h) => (h.votes?.length ?? 0) > 0), itemIds: open.map((h) => h.id) },
      ];
    },
  },
  {
    id: "reflect",
    title: "モデルに反映する",
    goal: "決まった集約・コマンド・イベント・ポリシーをモデル（YAML）に反映し、ルールとシナリオを書き足す。",
    prompts: ["右パネルの「モデルに反映…」で差分を確認して反映します", "ルール付箋は、モデルで Invariant か State guard として書きます", "解決していない論点は、ドメインエキスパートへの質問として残します"],
    kinds: [],
    minutes: 15,
    checks: (b) => {
      const convertible = b.items.filter((i) => STICKY_KINDS[i.kind].code && i.text.trim());
      const unnamed = convertible.filter((i) => !i.codeName);
      return [{ label: "集約・コマンド・イベントがモデルに反映されている", done: convertible.length > 0 && unnamed.length === 0, itemIds: unnamed.map((i) => i.id) }];
    },
  },
];

export function phaseOf(board: Board): WorkshopPhase {
  return WORKSHOP_PHASES.find((p) => p.id === board.workshop?.phase) ?? WORKSHOP_PHASES[0]!;
}

/** Arrows that run against the timeline: an event (or its cause) placed to the right of what it leads to. */
export function timelineIssues(board: Board): { from: string; to: string }[] {
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const flow: StickyKind[] = ["event", "command", "policy"];
  return board.connectors.flatMap((c) => {
    const a = byId.get(c.from);
    const b = byId.get(c.to);
    if (!a || !b || !flow.includes(a.kind) || !flow.includes(b.kind)) return [];
    if (a.kind !== "event" && b.kind !== "event") return [];
    return center(b) + 20 < center(a) ? [{ from: a.id, to: b.id }] : [];
  });
}

const normalize = (s: string) => s.replace(/[\s　、。・,.!?！？「」『』()（）]/g, "").toLowerCase();

/** Groups of stickies of the same kind with the same text (ignoring spaces and punctuation). */
export function duplicateStickies(board: Board): string[][] {
  const groups = new Map<string, string[]>();
  for (const i of board.items) {
    if (!i.text.trim() || i.kind === "note") continue;
    const key = `${i.kind}:${normalize(i.text)}`;
    groups.set(key, [...(groups.get(key) ?? []), i.id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export const DEFAULT_VOTES = 3;

export function votesLeft(board: Board, user: string): number {
  const used = board.items.reduce((n, i) => n + (i.votes?.filter((v) => v === user).length ?? 0), 0);
  return (board.workshop?.votesPerPerson ?? DEFAULT_VOTES) - used;
}

/** Adds the user's vote (when they have one left) or, with `remove`, takes one back. */
export function toggleVote(board: Board, itemId: string, user: string, remove = false): Board {
  const item = board.items.find((i) => i.id === itemId);
  if (!item) return board;
  const votes = item.votes ?? [];
  let next: string[];
  if (remove) {
    const k = votes.lastIndexOf(user);
    if (k < 0) return board;
    next = votes.filter((_, i) => i !== k);
  } else {
    if (votesLeft(board, user) <= 0) return board;
    next = [...votes, user];
  }
  return { ...board, items: board.items.map((i) => (i.id === itemId ? (next.length ? { ...i, votes: next } : withoutKey(i, "votes")) : i)) };
}

const withoutKey = <T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> => {
  const { [k]: _, ...rest } = o;
  return rest;
};

/** Stickies with votes, most voted first. */
export function voteRanking(board: Board): { item: BoardItem; count: number }[] {
  return board.items
    .filter((i) => i.votes?.length)
    .map((item) => ({ item, count: item.votes!.length }))
    .sort((a, b) => b.count - a.count || a.item.x - b.item.x);
}

// ---------------------------------------------------------------------------
// Static SVG (for sharing the result of a workshop)
// ---------------------------------------------------------------------------

/** Sticky colours for the exported image (kept in sync with the canvas palette). */
export const STICKY_FILL: Record<StickyKind, string> = {
  event: "#f7a24f",
  command: "#7cc0f2",
  actor: "#ffe27a",
  policy: "#cfb0ec",
  aggregate: "#fff1a8",
  read_model: "#a5dca6",
  external_system: "#f5b1cd",
  hotspot: "#ff7a7a",
  rule: "#d7e1ea",
  note: "#f6f6f2",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Wraps text to fit a sticky (CJK text breaks anywhere; latin at spaces). */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const ch of para) {
      const width = [...line].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
      if (width + (ch.charCodeAt(0) > 0xff ? 2 : 1) > maxChars * 2) {
        lines.push(line);
        line = ch.trimStart();
      } else line += ch;
    }
    lines.push(line);
  }
  return lines.length > maxLines ? [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]}…`] : lines;
}

export function boardToSvg(board: Board, title = ""): string {
  const boxes = [...board.items, ...board.frames];
  if (!boxes.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="20" y="60" font-size="16">空のボード</text></svg>`;
  const pad = 40;
  const minX = Math.min(...boxes.map((b) => b.x)) - pad;
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
  const top = Math.min(...boxes.map((b) => b.y), ...(board.lanes ?? []).map((l) => l.y)) - pad - (title ? 40 : 0);
  const bottom = Math.max(...boxes.map((b) => b.y + b.h), ...(board.lanes ?? []).map((l) => l.y + l.h)) + pad;
  const width = maxX - minX;
  const height = bottom - top;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${top} ${width} ${height}" width="${width}" height="${height}" font-family="'Hiragino Sans','Noto Sans JP',sans-serif">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>`,
    `<rect x="${minX}" y="${top}" width="${width}" height="${height}" fill="#fafaf7"/>`,
  ];
  if (title) out.push(`<text x="${minX + pad}" y="${top + pad}" font-size="22" font-weight="600" fill="#222">${esc(title)}</text>`);
  for (const l of board.lanes ?? []) {
    out.push(`<rect x="${minX}" y="${l.y}" width="${width}" height="${l.h}" fill="#eef1f5" stroke="#cfd5dd" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${minX + 12}" y="${l.y + 22}" font-size="14" fill="#556">${esc(l.title || "レーン")}</text>`);
  }
  for (const f of board.frames) {
    out.push(`<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="10" fill="none" stroke="#6b7a90" stroke-width="2" stroke-dasharray="10 6"/>`);
    const sub = f.subdomain ? `［${SUBDOMAIN_LABEL[f.subdomain].label}］` : "";
    out.push(`<text x="${f.x + 12}" y="${f.y + 24}" font-size="16" font-weight="600" fill="#39465a">${esc(`${sub}${f.title || "無題のコンテキスト"}`)}</text>`);
  }
  const byId = new Map(board.items.map((i) => [i.id, i]));
  for (const c of board.connectors) {
    const a = byId.get(c.from);
    const b = byId.get(c.to);
    if (!a || !b) continue;
    const [x1, y1, x2, y2] = edgePoints(a, b);
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#555" stroke-width="1.5" marker-end="url(#arrow)"/>`);
    if (c.label) out.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" font-size="12" text-anchor="middle" fill="#333">${esc(c.label)}</text>`);
  }
  for (const i of board.items) {
    const faded = i.kind === "hotspot" && i.resolved ? ` opacity="0.55"` : "";
    out.push(`<g${faded}>`);
    out.push(`<rect x="${i.x}" y="${i.y}" width="${i.w}" height="${i.h}" rx="4" fill="${STICKY_FILL[i.kind]}" stroke="${i.pivotal ? "#c0392b" : "#00000022"}" stroke-width="${i.pivotal ? 3 : 1}"/>`);
    out.push(`<text x="${i.x + 8}" y="${i.y + 16}" font-size="10" fill="#0008">${esc(STICKY_KINDS[i.kind].label)}${i.resolved ? " ✓ 解決" : ""}</text>`);
    const lines = wrap(i.text || "", Math.max(4, Math.floor((i.w - 16) / 14)), Math.max(1, Math.floor((i.h - 30) / 17)));
    lines.forEach((line, k) => out.push(`<text x="${i.x + 8}" y="${i.y + 34 + k * 17}" font-size="14" fill="#111">${esc(line)}</text>`));
    if (i.votes?.length) out.push(`<text x="${i.x + i.w - 8}" y="${i.y + i.h - 8}" font-size="12" text-anchor="end" fill="#1a4fb4">${"●".repeat(Math.min(i.votes.length, 8))}${i.votes.length > 8 ? i.votes.length : ""}</text>`);
    out.push(`</g>`);
  }
  out.push(`</svg>`);
  return out.join("\n");
}

function edgePoints(a: BoardItem, b: BoardItem): [number, number, number, number] {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const clip = (box: BoardItem, c: { x: number; y: number }, toward: { x: number; y: number }) => {
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    const sx = dx ? box.w / 2 / Math.abs(dx) : Infinity;
    const sy = dy ? box.h / 2 / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy, 1);
    return { x: Math.round(c.x + dx * s), y: Math.round(c.y + dy * s) };
  };
  const p = clip(a, ac, bc);
  const q = clip(b, bc, ac);
  return [p.x, p.y, q.x, q.y];
}
