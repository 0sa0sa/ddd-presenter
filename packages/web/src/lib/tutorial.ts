/**
 * Hands-on tutorial: steps and automatic progress detection from the project's board and model.
 * Framework-free so it can be unit-tested.
 */
import { frameOf, suggestAggregates, type Board, type ModelIR } from "@ddd/core";

export type TutorialTab = "discovery" | "model" | "diagram" | "rules" | "scenarios" | "preview" | "history";

export interface TutorialStep {
  id: string;
  /** Short imperative title. */
  title: string;
  /** What this means in DDD terms (one or two sentences). */
  why: string;
  /** Concrete instructions for this tool. */
  how: string[];
  /** Example text the learner can copy. */
  examples?: string[];
  tab: TutorialTab;
  /** Steps that cannot be detected automatically are marked done by the learner. */
  manual?: boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "events",
    title: "起きる出来事を3つ以上並べる",
    why: "ドメインイベントは「業務で実際に起きた事実」です。仕様の議論を、画面や表ではなく出来事から始めると、業務の流れと言葉がそろいます。",
    how: ["「ディスカバリー」タブを開きます", "ツールバーの「ドメインイベント」（オレンジ）を押すか、キャンバスをダブルクリックして付箋を置きます", "過去形で書き、時間の流れに沿って左から右へ並べます"],
    examples: ["招待が送られた", "招待が受諾された", "招待が取り消された"],
    tab: "discovery",
  },
  {
    id: "commands",
    title: "出来事を起こすコマンドを置き、矢印でつなぐ",
    why: "コマンドは「誰かの意図・操作」です。コマンドが成功した結果としてイベントが起きます。",
    how: ["「コマンド」（青）の付箋を、対応するイベントの左に置きます", "コマンドにマウスを乗せると端に丸が出るので、そこからイベントへドラッグして矢印を引きます"],
    examples: ["招待を送る → 招待が送られた", "招待を受諾する → 招待が受諾された"],
    tab: "discovery",
  },
  {
    id: "actors",
    title: "コマンドを実行する人（アクター）をつなぐ",
    why: "誰の操作かが分かると、権限や画面の設計、Use case の Actor にそのままつながります。",
    how: ["「アクター」（黄色の小さな付箋）をコマンドの上に置き、アクターからコマンドへ矢印を引きます"],
    examples: ["清掃会社の管理者 → 招待を送る", "スタッフ候補 → 招待を受諾する"],
    tab: "discovery",
  },
  {
    id: "aggregate",
    title: "コマンドを受け止める集約を置く",
    why: "集約（Aggregate）は、コマンドを受けて「一度の変更で必ず守るべきルール」を守り、イベントを出すまとまりです。整合性の境界でもあり、保存はこの単位で行います。",
    how: [
      "「集約」（淡い黄色）の付箋を置き、コマンドから集約へ矢印を引きます",
      "迷ったら右パネル「集約の候補」を見ます。つながり方から候補を示し、「集約として置く」で付箋を置けます",
    ],
    examples: ["招待"],
    tab: "discovery",
  },
  {
    id: "rule",
    title: "集約が守るルールを書く",
    why: "ルールがはっきりしないまとまりは、集約にする必要がないかもしれません。ここで書いたルールが、あとでモデルの Invariant（常に守る条件）や State guard（操作の時点で確かめる条件）になります。",
    how: ["「ルール」（灰色）の付箋を集約の近くに置くか、集約へ矢印を引きます"],
    examples: ["期限切れの招待は受諾できない", "受諾・取り消し済みの招待は変更できない"],
    tab: "discovery",
  },
  {
    id: "context",
    title: "コンテキストの境界で囲む",
    why: "Bounded context は「同じ言葉が同じ意味で通じる範囲」です。言葉の意味が変わる所や、担当チームが変わる所で分けます。",
    how: ["付箋を範囲選択（空いている所をドラッグ）し、右パネルの「コンテキストで囲む」を押します", "フレームをダブルクリックして名前を付けます"],
    examples: ["スタッフ招待"],
    tab: "discovery",
  },
  {
    id: "reflect",
    title: "ボードをモデルに反映する",
    why: "ここまでの合意を、コードの設計図になるモデル（YAML）に移します。付箋のラベルはそのまま用語集に残り、コードでは英字の名前を使います。",
    how: ["右パネルの「モデルに反映…」を押します", "各付箋のコードで使う英字名を入れます（イベントとコンテキストと集約は PascalCase、コマンドは snake_case）", "差分を確認して「モデルに反映」を押し、YAML の画面で「保存」します"],
    examples: ["招待 → Invitation", "招待を受諾する → accept_invitation", "招待が受諾された → InvitationAccepted"],
    tab: "discovery",
  },
  {
    id: "fields",
    title: "集約に状態（フィールド）を足す",
    why: "ルールを書くには、ルールが参照する状態が必要です。たとえば「期限」を判定するには有効期限の日時を持ちます。",
    how: ["「モデル (YAML)」タブで集約の fields: に行を足します（補完が出ます）", "または左の一覧で集約を選び、右のパネルの「フィールド」から追加します"],
    examples: ["- { name: status, type: InvitationStatus }", "- { name: expires_at, type: DateTime }"],
    tab: "model",
  },
  {
    id: "rules-in-model",
    title: "ルールを Invariant か State guard として書く",
    why: "Invariant は「いつでも成り立つ条件」で、作るときと状態が変わるたびに自動で確かめます。State guard は「受諾するときは期限前であること」のように、特定の操作の時点で確かめる条件です。",
    how: [
      "集約に invariants: または state_guards: を追加し、expression に条件を書きます（フィールド名や Enum 値は補完されます）",
      "違反したときのエラーを errors: に定義して error: で指定します",
      "操作の require: に State guard を書くと、その操作の前に自動で確かめます",
    ],
    examples: ["expression: status == pending and at < expires_at", "require: [pending_until_expiry(at)]"],
    tab: "model",
  },
  {
    id: "scenario",
    title: "シナリオ（Given / When / Then）を書く",
    why: "シナリオは業務の具体例で、そのままテストになります。ドメインエキスパートと「この場合はこうなる」を合意する道具です。",
    how: ["集約か Use case に scenarios: を追加し、given（前提）・when（操作）・then（期待する結果）を書きます", "「シナリオ」タブで自然文として読めるか確認します"],
    examples: ["then: { raises: InvitationNotDeliverable }"],
    tab: "scenarios",
  },
  {
    id: "save",
    title: "エラーのない状態で保存する",
    why: "モデルに検証エラーがあるとコードを生成できません。画面下のステータスが「検証OK」になっていることを確かめて保存します。",
    how: ["エラーがあれば下の一覧をクリックして該当行へ移動し、直します（ヒントに直し方が出ます）", "「保存」を押します"],
    tab: "model",
  },
  {
    id: "preview",
    title: "生成されるコードとテストを見る",
    why: "モデルから Python のドメインコードと pytest が生成されます。ルールが、どのメソッドでどう確かめられるかを確認できます。",
    how: ["「生成プレビュー」タブを開き、aggregates.py やテストファイルを見ます", "ZIP でダウンロードすることもできます"],
    tab: "preview",
  },
  {
    id: "cli",
    title: "手元で生成してテストを実行する",
    why: "生成物はあなたのリポジトリのものです。CLI はオフラインで動き、CI でも同じ結果になります。",
    how: [
      "右上の「YAMLをエクスポート」で model.ddd.yaml を保存します",
      "リポジトリで `bun run ddd generate path/to/model.ddd.yaml` を実行します",
      "生成された tests/generated を pytest で実行します（詳しくは docs/12-tutorial.md）",
    ],
    tab: "preview",
    manual: true,
  },
];

export interface ProgressInput {
  board?: Board;
  /** Model parsed from the current editor text. */
  draft?: ModelIR;
  /** Model parsed from the last saved version. */
  saved?: ModelIR;
  savedOk: boolean;
  savedVersion: number;
  visited: Set<string>;
  manualDone: Set<string>;
}

const aggregatesOf = (m?: ModelIR) => m?.contexts.flatMap((c) => c.aggregates) ?? [];

/** Which steps are complete, detected from the actual board and model. */
export function tutorialProgress(input: ProgressInput): Record<string, boolean> {
  const b = input.board;
  const items = b?.items ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const connectors = b?.connectors ?? [];
  const linked = (fromKind: string, toKind: string) => connectors.some((c) => byId.get(c.from)?.kind === fromKind && byId.get(c.to)?.kind === toKind);
  const aggregates = items.filter((i) => i.kind === "aggregate");
  const anchored = b ? suggestAggregates(b).filter((c) => c.aggregateItemId && c.commandIds.length > 0) : [];
  const rules = items.filter((i) => i.kind === "rule");
  const ruleNearAggregate =
    rules.some((r) => connectors.some((c) => (c.from === r.id && byId.get(c.to)?.kind === "aggregate") || (c.to === r.id && byId.get(c.from)?.kind === "aggregate"))) ||
    rules.some((r) => aggregates.some((a) => Math.hypot(r.x - a.x, r.y - a.y) < 320));
  const framed = !!b && aggregates.some((a) => frameOf(b, a));

  const model = input.draft ?? input.saved;
  const aggs = aggregatesOf(model);
  const savedAggs = aggregatesOf(input.saved);
  const hasField = aggs.some((a) => a.fields.some((f) => f.name !== a.identity));
  const hasRule = aggs.some((a) => [...a.invariants, ...a.stateGuards].some((r) => r.expression.trim() !== "true"));
  const hasScenario = (model?.contexts ?? []).some((c) => c.aggregates.some((a) => a.scenarios.length > 0) || c.useCases.some((u) => u.scenarios.length > 0));

  return {
    events: items.filter((i) => i.kind === "event" && i.text.trim()).length >= 3,
    commands: linked("command", "event"),
    actors: linked("actor", "command"),
    aggregate: anchored.length > 0,
    rule: ruleNearAggregate,
    context: framed,
    reflect: savedAggs.length > 0 || aggs.length > 0,
    fields: hasField,
    "rules-in-model": hasRule,
    scenario: hasScenario,
    save: input.savedOk && savedAggs.length > 0 && input.savedVersion > 1,
    preview: input.visited.has("preview"),
    cli: input.manualDone.has("cli"),
  };
}

/** The first step not yet done (or undefined when everything is complete). */
export function nextStep(progress: Record<string, boolean>): TutorialStep | undefined {
  return TUTORIAL_STEPS.find((s) => !progress[s.id]);
}

// ---------------------------------------------------------------------------
// Per-browser tutorial state (which project is the tutorial, visited tabs, manual checks)
// ---------------------------------------------------------------------------

const KEY = "ddd.tutorial";

interface Stored {
  projectId?: string;
  visited: string[];
  manualDone: string[];
  collapsed?: boolean;
}

function read(): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Stored>;
    return { visited: [], manualDone: [], ...s };
  } catch {
    return { visited: [], manualDone: [] };
  }
}

function write(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode): the tutorial still works for this page view.
  }
}

export const tutorialStore = {
  get: read,
  startWith(projectId: string) {
    write({ ...read(), projectId, visited: [], manualDone: [], collapsed: false });
  },
  visit(tab: string) {
    const s = read();
    if (!s.visited.includes(tab)) write({ ...s, visited: [...s.visited, tab] });
  },
  toggleManual(id: string) {
    const s = read();
    write({ ...s, manualDone: s.manualDone.includes(id) ? s.manualDone.filter((x) => x !== id) : [...s.manualDone, id] });
  },
  setCollapsed(collapsed: boolean) {
    write({ ...read(), collapsed });
  },
  show(projectId: string) {
    write({ ...read(), projectId, collapsed: false });
  },
  hide() {
    write({ ...read(), projectId: undefined });
  },
};
