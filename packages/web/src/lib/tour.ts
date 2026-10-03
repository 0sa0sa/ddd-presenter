/**
 * Spotlight tours: for each tutorial step, the concrete UI elements to highlight, in order,
 * with what to do there. Targets are `data-tour` attributes placed on real elements.
 */
import type { TutorialTab } from "./tutorial.ts";

export type TourDemo = "drag-arrow" | "double-click" | "range-select" | "complete";

export interface TourStop {
  /** Value of the element's data-tour attribute. */
  target: string;
  title: string;
  body: string;
  /** Move on automatically when the learner clicks the highlighted element. */
  advanceOnClick?: boolean;
  /** Small animated illustration of the gesture. */
  demo?: TourDemo;
  /** Tab to open before showing this stop. */
  tab?: TutorialTab;
  /** Shown when the element is not on screen (e.g. appears only after selecting something). */
  whenMissing?: string;
}

export const TOURS: Record<string, TourStop[]> = {
  events: [
    {
      target: "palette-event",
      tab: "discovery",
      title: "ここを押して、イベントの付箋を置きます",
      body: "オレンジの「ドメインイベント」を押すと、キャンバスの中央に付箋が1枚置かれ、すぐに文字を入力できます。押してみてください。",
      advanceOnClick: true,
    },
    {
      target: "board-canvas",
      title: "文字を入れて確定します",
      body: "「招待が送られた」のように過去形で入力し、⌘/Ctrl+Enter（または付箋の外をクリック）で確定します。あとで直すときは付箋をダブルクリックします。空いている所をダブルクリックすると、その位置に付箋を置けます。",
      demo: "double-click",
    },
    {
      target: "board-canvas",
      title: "時間の流れに沿って並べます",
      body: "付箋はドラッグで動かせます。起きる順に左から右へ、3枚以上並べましょう（例: 招待が送られた → 招待が受諾された → 招待が取り消された）。",
    },
    {
      target: "assist-panel",
      title: "書き方のヒントはここに出ます",
      body: "「過去形になっていません」のような指摘が出たら、付箋の文言を見直します。ヒントを押すと、該当の付箋へ移動します。",
    },
  ],
  commands: [
    {
      target: "palette-command",
      tab: "discovery",
      title: "コマンドの付箋を置きます",
      body: "青い「コマンド」を押して、「招待を受諾する」のような操作を書きます。対応するイベントの左側に置きます。",
      advanceOnClick: true,
    },
    {
      target: "board-canvas",
      title: "コマンドからイベントへ矢印を引きます",
      body: "付箋にマウスを乗せると、四辺に小さな丸が出ます。コマンドの丸を押したまま、イベントの付箋の上まで動かして離すと矢印が引けます。",
      demo: "drag-arrow",
    },
  ],
  actors: [
    {
      target: "palette-actor",
      tab: "discovery",
      title: "アクターの付箋を置きます",
      body: "黄色の「アクター」を押して、「スタッフ候補」のように操作する人を書き、コマンドの上に置きます。",
      advanceOnClick: true,
    },
    {
      target: "board-canvas",
      title: "アクターからコマンドへ矢印を引きます",
      body: "コマンドのときと同じく、付箋の端の丸からドラッグします。矢印を消すときは、矢印をクリックして Delete キーを押します。",
      demo: "drag-arrow",
    },
  ],
  aggregate: [
    {
      target: "assist-tab-aggregates",
      tab: "discovery",
      title: "まず候補を見てみましょう",
      body: "「集約の候補」タブには、矢印でつながったコマンドとイベントのまとまりが出ます。押してみてください。",
      advanceOnClick: true,
    },
    {
      target: "assist-candidates",
      title: "候補から集約を置けます",
      body: "担当する集約がまだないまとまりには「集約として置く」ボタンが出ます。押すと集約の付箋が置かれ、コマンドから矢印が引かれます。候補は提案なので、違うと思ったら自分で置いて構いません。",
      whenMissing: "コマンドとイベントを矢印でつなぐと、ここに候補が出ます。",
    },
    {
      target: "palette-aggregate",
      title: "自分で置くときはここから",
      body: "淡い黄色の「集約」を押して置き、コマンドから集約へ矢印を引きます。",
    },
  ],
  rule: [
    {
      target: "palette-rule",
      tab: "discovery",
      title: "ルールの付箋を置きます",
      body: "灰色の「ルール」を押して、集約が必ず守る条件（例: 期限切れの招待は受諾できない）を書きます。",
      advanceOnClick: true,
    },
    {
      target: "board-canvas",
      title: "集約の近くに置きます",
      body: "ルールの付箋を集約のすぐ近くへドラッグするか、集約へ矢印を引きます。これが後でモデルの Invariant / State guard になります。",
    },
  ],
  context: [
    {
      target: "board-canvas",
      tab: "discovery",
      title: "付箋を範囲選択します",
      body: "キャンバスの空いている所から斜めにドラッグすると、四角の中の付箋がまとめて選ばれます（Shift を押しながらクリックでも追加できます）。",
      demo: "range-select",
    },
    {
      target: "item-wrap-context",
      title: "「コンテキストで囲む」を押します",
      body: "選んだ付箋を囲むフレームができます。フレームは Bounded context の候補です。",
      advanceOnClick: true,
      whenMissing: "付箋を2枚以上選ぶと、右上のパネルに「コンテキストで囲む」ボタンが出ます。",
    },
    {
      target: "board-canvas",
      title: "フレームに名前を付けます",
      body: "フレームの見出しをダブルクリックして「スタッフ招待」のように名前を付けます。フレームを動かすと中の付箋も一緒に動きます。",
      demo: "double-click",
    },
  ],
  reflect: [
    {
      target: "assist-reflect",
      tab: "discovery",
      title: "「モデルに反映…」を押します",
      body: "ボードの集約・コマンド・イベントを、モデル（YAML）に追加する画面が開きます。",
      advanceOnClick: true,
    },
    {
      target: "reflect-names",
      title: "コードで使う英字の名前を入れます",
      body: "付箋のラベルは用語集に残ります。ここではコード用の名前だけ決めます。イベント・集約・コンテキストは PascalCase（例: InvitationAccepted）、コマンドは snake_case（例: accept_invitation）。赤い枠が未入力です。",
      whenMissing: "「モデルに反映…」を押すと、この画面が開きます。",
    },
    {
      target: "reflect-apply",
      title: "差分を確認して反映します",
      body: "下の差分で追加される内容を確認し、このボタンを押します。YAML の画面に「未保存の変更」として入ります。",
      advanceOnClick: true,
      whenMissing: "名前をすべて入れると、反映ボタンが押せるようになります。",
    },
    {
      target: "save-button",
      tab: "model",
      title: "保存します",
      body: "内容を確認したら「保存」を押します（⌘/Ctrl+S でも保存できます）。",
      advanceOnClick: true,
    },
  ],
  fields: [
    {
      target: "outline",
      tab: "model",
      title: "左の一覧から集約を選びます",
      body: "◆ の付いた集約（例: Invitation）を押すと、右のパネルにフィールドの一覧と追加フォームが出ます。",
    },
    {
      target: "inspector-add-field",
      title: "フィールドを追加します",
      body: "名前（例: expires_at）と型（例: DateTime）を入れて「追加」を押します。型の欄は候補から選べます。",
      whenMissing: "左の一覧で集約（◆）を選ぶと、ここに追加フォームが出ます。",
    },
    {
      target: "editor",
      title: "YAML で書いても同じです",
      body: "fields: の下に「- { name: status, type: InvitationStatus }」と書けます。Ctrl+Space で、その場所に書けるキーや型の候補が出ます。",
      demo: "complete",
    },
  ],
  "rules-in-model": [
    {
      target: "editor",
      tab: "model",
      title: "ルールを条件式で書きます",
      body: "集約に state_guards: を追加し、expression: に「status == pending and at < expires_at」のように書きます。status == の後で Ctrl+Space を押すと、Enum の値が候補に出ます。",
      demo: "complete",
    },
    {
      target: "diagnostics",
      title: "間違いはここに出ます",
      body: "存在しないフィールドや型の合わない比較は、この一覧と行の赤い印で知らせます。押すと該当行へ移動し、直し方のヒントが出ます。",
      whenMissing: "エラーや警告があると、エディタの下に一覧が出ます。",
    },
  ],
  scenario: [
    {
      target: "editor",
      tab: "model",
      title: "シナリオを書きます",
      body: "集約に scenarios: を追加し、given（前提の状態）・when（操作）・then（期待する結果）を書きます。書き方の見本はガイドのパネルからコピーできます。",
      demo: "complete",
    },
    {
      target: "tab-scenarios",
      title: "自然文で読めるか確認します",
      body: "「シナリオ」タブでは、書いたシナリオが Given / When / Then の文章で表示されます。ドメインエキスパートと一緒に確認しましょう。",
      advanceOnClick: true,
    },
  ],
  save: [
    {
      target: "status",
      tab: "model",
      title: "「検証OK」を確認します",
      body: "ここが「✕ エラー」なら、エディタの下の一覧から直します。警告は残っていても保存・生成できます。",
    },
    {
      target: "save-button",
      title: "保存します",
      body: "「変更の説明」を書いて保存すると、履歴に残ります。",
      advanceOnClick: true,
    },
  ],
  preview: [
    {
      target: "tab-preview",
      title: "「生成プレビュー」を開きます",
      body: "保存済みのモデルから生成される Python（または TypeScript）のコードとテストを確認できます。",
      advanceOnClick: true,
    },
    {
      target: "preview-files",
      title: "生成されるファイルの一覧です",
      body: "aggregates.py（TypeScript なら aggregates.ts）を選ぶと、ルールがメソッドとして確かめられている様子が見られます。tests/generated の下がシナリオから作られたテストです。変更の多い版では差分も表示します。",
      whenMissing: "モデルにエラーがあるとプレビューを作れません。先にエラーを直して保存します。",
    },
  ],
  cli: [
    {
      target: "export-link",
      title: "モデルを書き出します",
      body: "ここから model.ddd.yaml を保存し、自分のリポジトリに置きます。そのあと `bun run ddd generate model.ddd.yaml` で生成し、pytest（TypeScript なら vitest）でテストを実行します（手順は docs/12-tutorial.md）。",
    },
  ],
};
