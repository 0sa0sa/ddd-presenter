# 09. Implementation Decisions (v0.1)

要件（01〜08）の未決事項・構文案に対し、初期実装で採用した決定を記録する。変更する場合はこの表を更新する。

## 1. 技術選定

| 項目 | 決定 | 理由 |
|---|---|---|
| 実装範囲 | Phase 1（CLI MVP）+ Phase 2（Web編集・チームレビュー） | 利用者指定 |
| ツール本体 | TypeScript / Bun（workspace, `bun test`, `bun:sqlite`） | WebとCLIで同一パーサ・検証・生成を共有する（FR-030/FR-034） |
| Web | Bun + Hono API、React + Vite SPA、SQLite | ローカル完結で動作確認できる。後でクラウドへ移行可能 |
| 認証 | 開発用簡易ログイン（ユーザー名のみ、セッションCookie） | 利用者指定。認可（テナント分離・Owner/Editor/Viewer）は本実装する |
| 生成Python | Python 3.11+、Pydantic v2 profile、mypy公式サポート、pytest | 利用者指定 / docs/05 |
| 状態変更 | 不変オブジェクトの置換。操作は `Transition[T]`（新Aggregate + Events）を返す | 候補状態を作りInvariant通過時のみ確定する意味論と一致 |

## 2. DSL（schema_version: 1）の決定

- **Use Case手順は構造化オブジェクト**: `load / invoke / save / publish / publish_after_commit / if / fail / return`。文字列ミニ文法を使わない。
- **Scenarioは構造化**: `given`（clock・既存Aggregateの全必須フィールド）、`when`（use case入力 / operation引数 / construct）、`then`（`state`・`emits`・`raises`）。機械検証できない`then`は検証エラー（FR-021）。
- **Enum値の文脈解決**: `status == pending` のように、比較相手・代入先がEnum型の場合は裸の識別子をEnum値として解決する。`InvitationStatus.pending`も可。
- **Invariant評価**: `check_on` に `construct` を含むものは全インスタンス化（遷移候補含む）で評価する。`transition` のみのものは操作の候補状態に対して明示評価する。
- **StateGuard適用**: 操作の `require:` に書いたGuardは操作が自動適用する。それ以外は呼び出し側（Use Caseの `if` 等）が明示的に使う。
- **ExtensionPoint**: 型付き宣言からProtocolを生成し、実装は顧客の `extensions/` に置く。Use Caseの分岐条件からのみ参照でき、Domain Rule式からは参照できない（信頼レベル分離）。
- **時計・ID**: `clock.now`・`ids.new` はUse Case手順内でだけ使えるPort参照。Domain式から暗黙に参照できない。

## 3. 生成契約の決定

- 出力（docs/05の案からの差分を含む）:
  - `src/<package>/generated/_runtime.py` — 基底クラス（DomainError / ValueObject / Entity / AggregateRoot / DomainEvent / Transition / StateGuard）。Pydantic v2 + 標準ライブラリのみ。
  - `src/<package>/generated/adapters.py` — `SystemClock`（aware UTC）と `RandomIds` の参照実装。
  - `src/<package>/generated/<context>/domain/{errors,enums,value_objects,entities,aggregates,events,commands,rules}.py`。docs/05の `invariants.py` は置かない: Invariant / StateGuard は対象クラスのメソッドとして生成し、`rules.py` はルールのカタログ（追跡用）とする。
  - `src/<package>/generated/<context>/application/{ports,use_cases}.py`、`testing.py`（In-memoryのPort実装）、`README.md`（ルール・適用箇所・テストの対応表）。
  - `tests/generated/test_<context>_<aggregate|use_case>.py` — シナリオから生成したpytest。
  - `src/<package>/extensions/<context>/extensions.py` — 初回のみ作る雛形（以後は顧客所有で上書きしない）。
  - `src/<package>/generated/model_manifest.json` — モデルhash・generator版・生成ファイルのsha256・prune待ちのstaleファイル。
- 決定性: 生成物・マニフェストに時刻を含めない。マニフェストはモデルhash・generator版・各ファイルsha256。
- 手編集検知: ディスク上のhashがマニフェストと異なる生成ファイルがあれば停止し差分を表示（`--force`で上書き）。
- 削除: モデルから消えたファイルはstaleとして報告し、`--prune`指定時のみ削除。
- 原子性: 一時ディレクトリへ全出力→バックアップ付き入替。失敗時は復元。
- `ddd.lock`: generator版とschema版を固定。不一致なら `--update-lock` なしでは生成しない。

## 4. Web（Phase 2）の決定

- モデル本文（YAML）と図レイアウトは別テーブルに保存（意味とレイアウトの分離）。
- モデル保存は楽観的排他（`version`）。競合時は409で上書きしない。
- 全Workspace配下リソースはメンバーシップ検証を通す。他テナントIDは404。
- 監査ログ: メンバー変更、権限変更、削除、エクスポート。
- Web上の生成はレビュー用プレビュー（ファイル一覧・内容・差分）とダウンロードに限る。

## 5. ディスカバリーボード（2026-09-27 追加）

- 記法は EventStorming に合わせる（ドメインイベント・コマンド・アクター・ポリシー・集約・リードモデル・外部システム・ホットスポット・ルール・メモ、フレーム＝コンテキスト候補、矢印）。参加者が既存の知識を持ち込めるようにし、独自記法を作らない。
- 付箋がどのコンテキストに属するかは配置（付箋の中心がフレーム内か）で決める。親子関係は持たない（Miroと同じ自由配置）。
- 集約・コンテキストの候補は**提案のみ**。ツールが分割や所属を確定しない（FR-012、プロダクト原則6）。
- 付箋のラベルは自由文（日本語可）、モデルの識別子は付箋ごとの `codeName`（英字）。自動の翻字はしない。
- ボードからモデルへの反映は、既存要素を変えずに不足分だけを追加し、差分を確認してから適用する。ルール付箋は式を推測せず、Aggregateの説明に TODO として残す。
- ボードはモデルと別に保存し（版番号による楽観排他）、ボードの編集がモデルの意味を直接変えることはない。

## 6. 予測と AI の提案（2026-09-27 追加）

- 予測は「ローカル（構造から決まる続き）」を常に先に出し、AI の予測は届いたら置き換える。AI がなくても Tab で書き進める体験が成り立つようにする。
- AI は Claude（公式 SDK `@anthropic-ai/sdk`、既定モデル `claude-opus-5`、`DDD_AI_MODEL` / `DDD_AI_INLINE_MODEL` で変更）。API キーはサーバーだけが持ち、ブラウザから Anthropic に直接送らない。DSL リファレンス（docs/10）をシステムプロンプトに入れ、プロンプトキャッシュで再送のコストを抑える。
- AI の呼び出し先は差し替えられる（`Completer`）。Claude API のほか、サーバーのマシンにあるローカルの Claude Code（`claude -p`）と Codex CLI（`codex exec`）を使える。API キーがなくても、手元のサブスクリプションで予測と提案を試せるようにするため。プロンプトと検証は共通で、どの AI でも同じ確認を通る。
- ローカル CLI はエージェントの能力を使わない。ツール・MCP・フック・ユーザー設定を無効にし、空の一時ディレクトリで起動する（モデルの YAML に紛れた指示で、サーバーのファイルやコマンドに触れさせないため）。空の値は `--tools=` の形で渡す（別の引数の `""` はプロセス起動時に落ち、次のオプションを値として取り込んでしまう）。
- ワークスペースのオーナーが使う AI を選ぶ（`workspaces.ai_provider`、変更は監査ログ `ai.provider`）。選んだ AI がサーバーから消えたら、最初に見つかった AI を使う。
- FR-035 に従い、AI はワークスペース単位で既定オフ。オーナーだけが切り替えられ、監査ログに残す。オフのときは何も外部に送らない。
- 予測・提案は検証してから見せる。予測はエラーを増やすものを捨て、提案は検証エラーがあれば一度だけ修正させ、残ったエラーは適用前に表示する。
- 提案は差分として見せ、事実・推測・質問を分けて書かせる。確定するまでモデルは変わらない（プロダクト原則6：ツールが勝手に決めない）。
- 構造編集で YAML を書き直すとき、書式だけが変わる行（`{ name: x }` と `{name: x}` など）は元の行を残し、差分を最小にする。
