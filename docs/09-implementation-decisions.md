# 09. Implementation Decisions (v0.1)

要件（01〜08）の未決事項・構文案に対し、初期実装で採用した決定を記録する。変更する場合はこの表を更新する。

## 1. 技術選定

| 項目 | 決定 | 理由 |
|---|---|---|
| 実装範囲 | Phase 1（CLI MVP）+ Phase 2（Web編集・チームレビュー） | 利用者指定 |
| ツール本体 | TypeScript / Bun（workspace, `bun test`, `bun:sqlite`） | WebとCLIで同一パーサ・検証・生成を共有する（FR-030/FR-034） |
| Web | Bun + Hono API、React + Vite SPA、SQLite | ローカル完結で動作確認できる。後でクラウドへ移行可能 |
| 認証 | パスワード（Bun.password / argon2id）＋セッションCookie。ローカルの初回だけユーザー名のみの簡易ログイン、認証プロキシのヘッダーも可（§11） | 当初は利用者指定で簡易ログインのみ。2026-10-03 に強化。認可（テナント分離・Owner/Editor/Viewer）は本実装する |
| 生成Python | Python 3.11+、Pydantic v2 profile、mypy公式サポート、pytest | 利用者指定 / docs/05 |
| 生成TypeScript | TypeScript（strict・ESM）、Zod v4、decimal.js、vitest または bun test（§14） | 利用者指定（2026-10-03） |
| 状態変更 | 不変オブジェクトの置換。操作は `Transition[T]`（新Aggregate + Events）を返す | 候補状態を作りInvariant通過時のみ確定する意味論と一致 |

## 2. DSL（schema_version: 1）の決定

- **Use Case手順は構造化オブジェクト**: `load / invoke / save / publish / publish_after_commit / if / let / fail / return`。文字列ミニ文法を使わない。
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
  - `tests/generated/test_<context>_<aggregate|use_case>.py` — シナリオから生成したpytest。`test_<context>_invariants.py` — シナリオの値から導いた違反値でInvariantを確かめるpytest（§10）。
  - `src/<package>/extensions/<context>/extensions.py` — 初回のみ作る雛形（以後は顧客所有で上書きしない）。
  - `src/<package>/generated/model_manifest.json` — モデルhash・generator版・生成ファイルのsha256・prune待ちのstaleファイル。
- 決定性: 生成物・マニフェストに時刻を含めない。マニフェストはモデルhash・generator版・各ファイルsha256。
- 手編集検知: ディスク上のhashがマニフェストと異なる生成ファイルがあれば停止し差分を表示（`--force`で上書き）。
- 削除: モデルから消えたファイルはstaleとして報告し、`--prune`指定時のみ削除。例外は生成したままの `tests/generated/` のテストで、`generate` が削除する（§10）。
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

## 7. ポリシーとコンテキストマップ（2026-09-27 追加）

- **ポリシーはコンテキストの要素**（`contexts[].policies`）。`when` はイベント（同じコンテキストなら `Event`、別のコンテキストなら `Context.Event`）、`run` は**自分のコンテキストの** Use case。別のコンテキストの Use case を直接呼ぶ書き方は作らない（コンテキストをまたぐのはイベントだけ）。
- **コンテキストマップはトップレベル**（`relationships`）。上流・下流・パターン（既定 `customer_supplier`）・イベント契約 `events` を書く。別のコンテキストのイベントを受けるポリシーは、上流＝イベントのコンテキスト・下流＝ポリシーのコンテキストの関係の `events` にそのイベントが載っていなければエラー（FR-002「Contextを越える参照には明示的な境界型またはイベント契約を使う」）。`separate_ways` はイベント契約を持てない。
- **args は写像だけ**: `event.<field>`（Value Object のフィールドをたどれる）・`clock.now`・`ids.new`・値。イベントのフィールドで計算する式は書かない（計算が必要なら Use case の手順に書く）。コンテキストをまたいで渡せるのは値だけで、上流の Value Object・Enum は渡せない（型名が同じでも別のクラスのため）。
- **生成**: ポリシーがあるコンテキストに `application/policies.py`（ハンドラ `<Name>Policy`、Use case に求める最小の Protocol `<UseCase>Runner`、`subscriptions()`）と `tests/generated/test_<context>_policies.py` を作る。下流は上流が生成したイベントクラスを `events as <upstream>_events` の別名で import する（published language。名前の衝突を避ける）。共通の `_runtime.py` に `EventHandler` とプロセス内配送用の `dispatch()` を加えた。確実な配送（Outbox 等）はこれまでどおりアダプタの責務。
- **Anticorruption layer**: 既存の拡張の仕組み（初回だけ作り、以後は上書きしない `extensions/`）に合わせ、`extensions/<context>/translators.py` に翻訳層の雛形（`From<Upstream>`）を作る。ハンドラは args から作った Command と上流のイベントを翻訳層に渡し、返った Command で Use case を実行する。生成テストは Command をそのまま返す `PassThrough<Upstream>Translator` を使う。雛形は再生成しないので、あとから ACL のポリシーを増やしたときは雛形にメソッドを足す（足りなければ mypy の `_conforms_*` で分かる。Extension point と同じ扱い）。
- **ポリシーのテスト**: 期待値の曖昧さを避けるため、イベントのサンプル値から Command の各フィールドを具体値で比べる。上流の Value Object は `model_construct` で作り、上流の制約に左右されない（テストの対象は対応付け）。下流の入力に厳しい制約（pattern 等）があると、サンプル値がそれに合わず失敗することがある（既知の制限）。
- **検査の追加**: ループ（Use case が自分を起動したイベントを直接・他のポリシー経由で再び公開する）は警告、どのポリシーも受けていない契約イベントは情報。診断メッセージはこれまでどおり英語（CLI と共通）、補完・ホバー・ボードの文言は日本語。
- **ボードからの反映**: 「イベント → ポリシー → コマンド」を、コマンドのコンテキストのポリシー（`run` はそのコマンドの Use case、`when` はイベント。コンテキストが違えば `Context.Event`）にする。コンテキストが違えば関係（既定 `customer_supplier`）を追加するか、既存の関係の `events` にイベントを足す。Use case の必須入力は、同じ名前のイベントのフィールド、または `<集約>_id ← event.id` で埋められるときだけ反映し、埋められなければ理由を示して手で書くものに回す。ポリシーの名前は付箋のコード名（snake_case）、なければ `<command>_on_<event>`。反映は追加だけで、既存の要素は変えない。

## 8. ワークショップの進行と、ボードとモデルの同期（2026-09-28 追加）

- ワークショップの段階は EventStorming の流れ（Big Picture → 時系列 → プロセス → 設計 → 境界）に合わせる。段階・タイマー・1人の票数はボードの JSON（`workshop`）に置き、同じボードを見る全員が同じ状態を見る。チェックは付箋の並びから自動で判定し、進行を止めない（次の段階へはいつでも進める）。
- 投票・コメント・解決済み・ピボタル・レーン・サブドメインはボードのデータとして保存する（モデルの意味は変えない）。複数人が同時に投票すると、ボード全体の楽観排他で後から保存した人に衝突の確認が出る（同時編集の改善は別の課題）。
- モデル → ボードは、付箋のモデルでの名前（`codeName`）で結び付ける。名前が見つからない付箋は、結び付いていない同じ種類の要素を候補として示し、勝手には付け替えない。型の名前の一括変更（F2・詳細）は、モデルを保存したときだけボードに伝える（保存されなかった変更でボードが食い違わないように）。
- モデルの要素をボードに置くときは、コンテキストの枠の中に「コマンド → 集約」と「コマンド → イベント」の矢印で並べる（`boardToModel` が読む形と同じにし、往復しても変わらないようにする）。
- サブドメインの分類はモデルにも持つ（コンテキストの任意キー `subdomain`）。ボードからの反映は分類のないコンテキストにだけ入れ、違いは「モデル」タブで示してどちらに合わせるかを選ばせる。ポリシーも付箋の名前で結び付け、モデル → ボードでは「イベント → ポリシー → コマンド」の並びで置く。
- ボードはプロジェクトに複数持てる（`project_boards`、既存のボードは「メイン」に移す）。旧 API（`/board`）はメインのボードを指す。
- 画像はブラウザで描画した画面ではなく、ボードのデータから SVG を作る（依存を増やさず、どの環境でも同じ結果になるように）。PNG はその SVG を canvas に描いて作る。

## 9. draw.io の読み込みと書き出し（2026-09-29 追加）

- draw.io のファイルは DOM を使わない小さな XML 読み取りで読む（ブラウザ・サーバー・テストで同じコードを使うため）。圧縮ページは fflate で展開する（core の依存に追加）。
- 図形の種類は、形で決まるもの（人型・コンテナ・画像）を先に決め、残りを塗りの色で決める。色の推測は、このツールの配色（往復で変わらないように最優先）→ draw.io の標準色 → よく使われる EventStorming の色の順に近いものを選ぶ。黄色はアクターと集約で共通なので大きさで分ける。色が手がかりにならない図は文字（過去形・辞書形・疑問）で推測する。
- 推測は必ずダイアログで見せ、色ごとに変えられるようにする（チームごとに色の決まりが違うため）。読み込みはボードに付箋を足すだけで、モデルは変えない。

## 10. QA 指摘の修正（生成と CLI, 2026-10-03）

- **長いルールの折り返し（重大）:** 100文字を超える行の折り返しが、条件をくくる括弧にも末尾カンマを付けていたため、長いInvariantが `if not ( <式>, ):`（1要素のタプル、常に真）になり、ルールが一度も働かなかった。末尾カンマは「すでに2つ以上の要素を持つ括弧（引数・タプル・リスト）」と「もともと末尾カンマのある括弧」にだけ付ける。1要素の括弧（条件のくくり、1引数、ジェネレータ式）は `or` / `and` の前で改行し、括弧の外にある長い真偽値（`if` / `return` / `holds=` など）は括弧でくくってから同じように折り返す。docstring・コメント・長い文字列リテラルも折り返し、生成コードは1行100文字以内に収まる。回帰テストは3重にした: TypeScript 側で「条件がタプルでない」ことを確かめる検査、生成物を Python の `ast` で読んで同じことを確かめる検査、長いInvariant・ガード・`when`・Use case条件を破るシナリオを持つ fixture（`long-rules.ddd.yaml`）を pytest で実行する検査。
- **違反値の導出テスト:** さらに、シナリオの値から「そのルールだけが最初に破れる」値を探し（参照するフィールドを1〜2個、null・別のEnum値・空リスト・同じ型の別フィールドの値・式中のリテラル±1などに変える。各フィールドの制約は守る）、見つかったInvariantにはオブジェクトを作って `details["rule"]` まで確かめるテストを生成する（`core/src/rulecheck.ts`）。導けないルールにテストを作ったふりはしない。探索は1ルールあたり400候補までで、エディタの打鍵ごとの再計算でも数ミリ秒で終わる。
- **ルールの検証の数え方:** 以前は「同じエラー型を送出するシナリオ」をすべてそのルールのテストとして数えていた。シナリオの経路でそのエラー型を送出しうるものがそのルールだけのときに限って数え、ほかにもあれば「not counted」として競合するものと一緒に示す。経路の見積もりは多めに取る（取りこぼすと誤って数えるため）。サンプルの2つのInvariantは同じエラーを共有しているので、`invitation_window_must_be_positive` はどちらのテストにも数えず、両方とも導出テストで検証される。
- **`ddd validate --strict`:** 警告を失敗にするのに加えて、`untested-rule`・`unused-error`・`unused-extension-point` を出す。エディタ（LSP・Web）には出さない（作りかけのモデルで常に出てしまうため）。
- **YAML の例外:** `yaml` ライブラリがエイリアスの展開しすぎで投げる `ReferenceError` を捕まえず、CLI がスタックトレース付きで終了コード3を返していた。`parseModel` で yaml ライブラリの例外をすべて診断（`yaml-aliases` / `yaml-syntax`、位置とパス付き）に変える。CLI は内部エラーでもスタックトレースを `DDD_DEBUG=1` のときだけ出す。
- **1トランザクションで複数の集約:** 型ではなく変数を数える（同じ型の2つのインスタンスの変更も一貫性の境界2つ）。if の両方の枝で別の変数を変える場合も合わせて数える既存の扱いは変えない。
- **古い生成テスト:** Use caseを消すと、そのテスト（消えたクラスをimportする）が残り、`generate` は0で終わるのに pytest が ImportError で失敗していた。`tests/generated/` の生成テストは、生成したときのままなら `generate` が削除する。手で編集してあれば何も書かずに止まり（終了コード1）、`--prune --force` を案内する。生成したソース（`policies.py` など）は従来どおり `--prune` のときだけ削除する（顧客コードがimportしているかもしれないため）。`ddd diff --check` の案内も実際に直る方法に合わせた（手編集の衝突 → 移すか `--force`、古いソース → `--prune`、手編集した古いファイル → `--prune --force`）。
- **`idempotency_key` / `retry`:** docstring に書くだけだった。`idempotency_key` は `IdempotencyStore` Port で実装する（成功した結果だけを、コミット前に同じトランザクションで記録し、同じキーでは手順を実行せずに記録を返す）。`retry: true` は呼び出し側が再送しうるという宣言とし、再試行ループは生成しない。安全にするのはキーなので、キーなしの `retry: true` はエラーにした（従来は警告）。キーは必須の String / UUID / Integer / Ref の入力に限る（`str()` で安定した文字列になるもの）。
- **診断の改善:** Entity型の引数を持つ操作に警告 `entity-parameter`（Use caseからは読み込んだ集約が持つEntityしか渡せない）。Enum値と同じ名前のフィールドがあるときの型エラーは、名前がフィールドに解決されたことと `Enum.value` の書き方を示す（この書き方はもともと使え、生成もEnum値になる）。`{ ... }` の中の引用符のない `[` は、その位置のパスと「引用符で囲んだ書き方」を示し、パーサが位置を見失って出す後続のエラーは出さない。型が解決できなかったフィールドや引数を使う箇所では「Unknown name」「has no field」を重ねて出さない。

## 11. セキュリティの強化（2026-10-03）

セキュリティ・QA レビューの指摘への対応。方針は「ひとりでローカルに使うときは今までどおり手間なく、ネットワークに出したら安全側」。

- **待ち受け**: 既定は `127.0.0.1`。`DDD_HOST`（`HOST`）で変えられ、loopback 以外なら起動時に警告する。zsh はシェル変数 `HOST` を持つので `DDD_HOST` を優先する。
- **アカウント**: パスワードは Bun.password（argon2id）でハッシュ化して `users.password_hash` に保存（マイグレーション 6）。8〜200 文字。存在しないユーザーでも固定のハッシュで照合して応答時間をそろえ、同じユーザー名への失敗が 15 分に 10 回を超えたら 429。登録は既定で開き、`DDD_REGISTRATION=closed` で止める（そのときは `bun run admin set-password` でアカウントを作る）。パスワードを変えると、その操作をしたセッション以外は終了する。
- **簡易ログインの規則**: `DDD_DEV_LOGIN=1` なら常に有効、`0` なら常に無効。未設定なら「このマシンだけから届く」かつ「パスワード付きアカウントが 1 つもない」ときだけ有効。「このマシンだけから届く」は、loopback で待ち受け、`DDD_ALLOWED_HOSTS` に loopback 以外の名前がなく（あれば同じマシンのリバースプロキシがネットワークから中継している）、`DDD_TRUSTED_USER_HEADER` も未設定で、さらに要求に `X-Forwarded-For`・`X-Forwarded-Host`・`X-Real-IP`・`Forwarded` が付いていないこと（`Host` を書き換えるプロキシ越しでも簡易ログインを使わせない）。初回起動は今までどおり名前だけで入れ、誰かがパスワードを設定・登録した時点で自動的に無効になる。パスワードのない既存ユーザーは、簡易ログインが有効な間に入ってメニューからパスワードを設定すれば、自分のアカウントとして引き継げる（現在のパスワードは不要）。簡易ログインが無効になったあとにパスワードのないユーザーが残った場合は、`bun run admin set-password <名前>` で設定するか、一時的に `DDD_DEV_LOGIN=1` で起動する。パスワードを持つアカウントは、簡易ログインが有効でも名前だけでは入れない。
- **既存のセッション**: マイグレーション 6 で旧方式（名前だけ）のセッションをすべて消し、全員に新しい規則でログインし直してもらう。
- **認証プロキシ**: `DDD_TRUSTED_USER_HEADER` を設定したときだけ、そのヘッダーの値（英数字と `_ . @ + -`、100 文字まで）をユーザー名として信頼し、初めての名前ならアカウントを作る。プロキシがクライアントからの同名ヘッダーを消し、サーバーにはプロキシ経由でしか届かないことが前提（起動時に注意を出す）。
- **ユーザー一覧**: `GET /api/users` はログイン必須にし、簡易ログイン中は全員、それ以外は同じワークスペースの人だけを返す。ログイン画面は公開の `GET /api/auth/config`（簡易ログインの有無・登録の可否・プロキシ認証の有無、簡易ログイン中だけパスワードのないユーザー名）を使う。
- **セッション**: 期限切れはログインのたびと 1 時間ごとに消す（`sessions(expires_at)` に索引）。`POST /api/logout-all` で自分のセッションをすべて終了する（メニューの「すべての端末からログアウト」）。トークンは 32 バイトの乱数。
- **DNS リバインディングと CSRF**: すべての要求で `Host` を許可リスト（`localhost`・`127.0.0.1`・`[::1]`・`DDD_ALLOWED_HOSTS`・具体的な `DDD_HOST`）と照合し、ほかは 421。更新系の API は、`Origin` があれば `Host` と一致すること（`Origin: null` や解釈できない値は 403。以前は 500 になっていた）、セッション Cookie かプロキシのヘッダーがあるのに `Origin` がなければ 403、本文があれば `Content-Type: application/json` 必須（HTML フォームは送れない。違えば 415）。Cookie を持たないクライアントには `Origin` を求めない。
- **セキュリティヘッダー**: すべての応答に CSP（`script-src 'self'`。Vite のビルドはインライン script を出さない。CodeMirror が実行時に `<style>` を入れるため `style-src` に `'unsafe-inline'`、Google Fonts を許可、書き出しのため `img-src data: blob:`、`frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` を付ける。`bun run start` はソースマップ（`*.map`）を配信しない（`DDD_SERVE_SOURCEMAPS=1` で配信）。静的ファイルの不正なパス（壊れた `%` エスケープ・NUL）は 400、dist の外は返さない。
- **本文の上限**: Bun の `maxRequestBodySize` を 4 MB にし、各 API は JSON を解析する前に大きさを確かめる（通常 64 KB、モデルを含む要求 約 1.25 MB、ボード 2 MB、レイアウト 1 MB）。レイアウトは 5000 件まで、値は `{x, y}` の数値だけを残す。ボードの保存と付箋の提案（`assist/board`）は同じ上限（2 MB・付箋 3000・枠 1000・矢印 10000）。
- **式の深さ**: 式の字句が 2000 を超えるか、括弧・`not`・引数の入れ子が 64 段を超えたら普通の診断（`invalid-expression`）にする（30 万段の括弧で RangeError になっていた）。式の言語の拡張と衝突しないよう、変更は `expr.ts` の深さカウンタと字句数の確認だけにした。サーバーは検証を例外で落とさない包みで呼び、検証できないモデルは保存しない。プレビューは保存済みの版が生成で失敗しても 500 にせず、版ごとの生成結果をメモリにキャッシュする（版は変わらないので古くならない。最大 64 件）。
- **生成先のパス**: `generation.src_dir` / `tests_dir` は `^[A-Za-z0-9_.-]+$` の区切りだけ（絶対パス・ドライブ文字・`~`・空・`.`・`..` は不可。`.` 単独は可）。ZIP を作るときもサーバー側で各エントリ名を同じ規則で確かめ、外れたものは入れない。
- **付箋の提案の計算量**: 空き場所の探索を、付箋を格子に振り分けて近くだけ調べ、ふさいでいる付箋の先まで 40px 単位で一気に進む方式にした（位置は以前の 1 歩ずつの探索と同じ）。12 件そろったら打ち切る。3000 枚が一列に並んでも 100 ms 未満（以前は 1000 枚で 10 秒超）。
- **draw.io の読み取り**: XML の読み取りを `indexOf` で前に進むだけの方式にした（閉じていないコメント・`<?`・CDATA・タグで二乗になっていた）。入れ子は 256 段まで、走査は再帰しない。入力は 20 MB まで、圧縮ページの展開は 1 ファイル合計 20 MB まで（fflate のストリーム展開で途中で止める）。ページあたりのセルは 50000 まで。補完の末尾一致の正規表現は値の末尾 256 文字だけに使う（40 KB の値で 0.9 秒かかっていた）。
- **AI の費用**: AI をオンにできるのはサーバーの運用者が許可した人だけ（`DDD_AI_ADMINS` のユーザー、または `DDD_AI_WORKSPACES` のワークスペースのオーナー）。どちらも未設定なら、このマシンだけから届くとき（簡易ログインと同じ判定。プロキシ経由の要求ではオンにできない）は最初に作られたユーザー、それ以外では誰も（ひとりで使うときは今までどおり自分でオンにできる）。オンにした人を `workspaces.ai_enabled_by` に記録し（マイグレーション 7。既にオンのワークスペースは最初のオーナーで埋める）、使うたびにその人がまだ許可されているかを確かめる。メンバーであることでは許可しない（オーナーは本人の同意なしに誰でもメンバーに追加できるため）。1 人あたりの呼び出しはトークンバケット（既定 毎分 30・まとめて 10、超えたら 429 と `Retry-After`）、ローカル CLI の待ち行列は 8 件まで（あふれたら 429）。`context`・`aggregate` は 200 文字、`instruction` は 2000 文字（ボードは 500）を超えたら 413（以前は黙って切り詰めていた）。
- **CLI の環境**: 子プロセスにはサーバーの環境をそのまま渡さず、PATH・HOME・USER・ロケール・TMPDIR・プロキシと CA の設定、その CLI の認証情報（Claude Code: `ANTHROPIC_*`・`CLAUDE_CODE_OAUTH_TOKEN`・`CLAUDE_CONFIG_DIR`・Bedrock/Vertex の変数、Codex: `OPENAI_API_KEY`・`OPENAI_BASE_URL`・`CODEX_HOME`）と `DDD_AI_PASS_ENV` に書いた名前だけを渡す。Codex は `--ignore-user-config --ignore-rules` で起動し、`~/.codex/config.toml`（MCP サーバー・プロファイル・通知フック）と execpolicy の規則を読まない。認証は `CODEX_HOME`（既定 `~/.codex`）のまま使える（codex-cli 0.160 で確認。`-c mcp_servers={}` は既存の定義と合成されて消せないため使わない）。独自のモデルプロバイダを config.toml に書いている場合は `DDD_CODEX_USER_CONFIG=1`。Claude Code はこれまでどおり `--strict-mcp-config --setting-sources= --tools=`。
- **残る制限**: 多要素認証・パスワード再設定メールはない。失敗回数の制限とレート制限はプロセス内のメモリで数える（再起動で戻る。複数プロセス構成は想定しない）。`Host` の照合はプロキシが `Host` を保つことが前提。

## 12. 式の拡張（算術・時間・コレクション, 2026-10-03）

EC の試行（明細つきの注文・Money・返金・期限）で、合計・明細の追加削除・期限の判定が式で書けず、検査されない Extension point に逃げていた。式の言語を次のように広げた（詳細は docs/10 の 4.1〜4.4 と 6）。

- **算術**: `+ - * /`・単項 `-`・括弧。Integer どうしの `+ - *` は Integer、Decimal が混ざれば Decimal。**`/` は常に Decimal**（`Decimal(a) / b` を生成）。整数の切り捨て除算や float は作らない（金額で誤差・切り捨てを起こさないため）。端数は `round(x, 桁)`（`ROUND_HALF_UP`、桁はリテラル）で明示的に丸める。0 除算は実行時の例外で、ガード・Invariant で防ぐ（式の中で 0 除算を Domain Error に変える仕組みは作らない）。
- **型エラーの診断**: Value Object・String・optional・単位の違う時間の演算は、理由と書き直し方をヒントに出す（`Money` なら数値のフィールドと `Money(amount=..., currency=...)`）。
- **時間**: `days/hours/minutes(n: Integer)` で Duration（`timedelta`）を作り、DateTime・Date と足し引き・比較する。Duration は式の中だけの型にした（フィールド・入力・イベント・戻り値に置けない）。宣言できる型にすると、シナリオの値の書き方（ISO 8601 の期間）やコンテキストをまたぐ扱いまで決める必要があり、試行の用途（締め切りの判定）には不要だったため。Date には `days(...)` を直接書いたときだけ足し引きできる（`timedelta(hours=…)` を Date に足すと Python は時間を黙って捨てるため）。
- **コレクション**: ラムダは入れず、要素ごとの引数の中で予約名 `item` が要素を指す形にした（`any(lines, item.line_id == id)`）。型検査は「要素の型で `item` を束縛して式を検査する」だけで済み、ラムダの構文・変数名の衝突・クロージャを持ち込まない。関数は試行で必要だったものに絞った: `count` `sum` `any` `all` `append` `remove` `remove_where` `replace_where`。`find`（見つからないと null）は、式の中の null の絞り込みが式ひとつの範囲でしか効かないため入れず、存在確認は `any`、合計は `sum` で書く。
- **生成**: リストは従来どおり tuple。コレクション関数は生成器式ではなくリスト内包で出す（長い行を引数ごとに折り返したとき、`any(<生成器式>,)` は構文エラーになるため）。ループ変数は `item_`（DSL の `item` と同名の引数があっても Python 側で衝突しない）。Integer を Decimal の場所に渡すところ（引数・タプル・`min/max`・戻り値・Pydantic の構築）は `Decimal(...)` で明示し、mypy --strict を通す。
- **行の折り返しの修正（最小限）**: 1要素のグループ括弧（`if not (…)`・`holds=(…)`）を折り返すと末尾に `,` が付いてタプルになり、Invariant が常に成り立つ（検査が消える）不具合があった。式が長くなって起きやすくなったため、呼び出しでも元々のタプルでもない1要素の括弧には `,` を付けないようにした（layout.ts、別の作業で全体の修正が入る予定）。
- **値の組み立て**: `Type(field=値, ...)`。名前付き引数は `=`（YAML の `: ` と衝突しないように）。Value Object はどこでも、Entity は所属 Aggregate の中だけで作れる。「明細の追加」は、Use case が Entity を作って渡すのではなく、**操作が明細のフィールドを引数で受け取り `changes` で組み立てる**形を推奨とした（Entity を境界の外で作らせない。Use case で作ろうとすると、この形を勧めるエラーになる）。Entity の一部の変更は `with(item, quantity=q)`（`_replace` で不変条件を再検査、識別子は変えられない）。
- **Use case の `let`**: `- let: { name, value }` で計算した値に名前を付ける。スコープは `as` と同じ（if の枝の中の名前は枝の中だけ）。名前は Use case 全体で一意にした（枝ごとに型の違う同名の変数ができると、生成する型注釈付きの Python 変数が mypy で衝突するため）。Aggregate には付けられない（保存漏れの検査が `as` の変数を追っているため）。
- **YAML**: `lines: []` は YAML ではリストになるので、式の位置のリストはリスト式として読む（`[]` に引用符が要らない）。フロー形式 `{ ... }` の中では `,` が区切りになるため、引数が2つ以上ある呼び出しはブロック形式で書く（docs/10 に明記）。
- **予約名**: 組み込み関数名は Extension point の名前にできない。`len` `sum` `min` `max` `any` `all` `tuple` `item_` は引数・Use case の変数にできない（生成コードの Python 組み込みを隠すため）。`command` `emitted` `after_commit` `self` は Use case の変数にできない。
- **テスト**: 生成器のフィクスチャ `packages/generator/test/fixtures/ordering.ddd.yaml`（注文・明細・Money・割引・期限・返金）を追加し、生成した Python が pytest と mypy --strict を通ることを確かめる。
- **既知の制限**: 集約シナリオの `then.state` で Entity のリストを比べると識別子だけで比べる（数量の変更はイベントのペイロードなどで確かめる）。Web の手順の一覧（packages/web）はまだ `let` を表示しない。ルールの適用箇所の一覧（usage）は `let` の値の中のガード呼び出しを数えない。

## 13. データ保全（2026-10-03 追加）

- ボードの衝突（409）は利用者に二択を迫らず、前回保存した版を基準にした3方向マージで解決する。要素は id ごとに「変えた側を採る」、両方が同じ要素を違う内容に変えたときだけ自分の版を残して知らせる。投票は人ごとの票の増減、コメントは id の集合として合わせる。マージ後は内容が変わらなくても必ず保存し直す。
- ボードの保存は失敗したら指数的に間隔を空けて再試行し（2秒〜30秒）、失敗をツールバーに表示する。アンマウント時は自動保存を待たずに保存し、未保存のままページを離れるときはブラウザの確認を出す。
- モデルの未保存の変更は `localStorage`（`ddd.draft.<プロジェクト>`）に元の版番号と一緒に残し、次に開いたときに復元を提案する。元の版より新しい版がある場合は、元の版番号で保存させて通常の衝突確認（差分）に回す。保存が成功するか、編集が保存済みの内容と同じに戻ったら消す。

## 14. TypeScript（Zod）の生成（2026-10-03）

同じモデルから TypeScript のドメイン層・アプリケーション層とテストを生成する（docs/05 §8、DSL は docs/10 §1.1）。Python の出力と生成物は変えていない（golden test でバイト単位に確認）。

- **選び方**: `generation.target: python | typescript`（既定 python）と `generation.typescript.test_runner: vitest | bun`（既定 vitest）。値は parse で検査し（`invalid-value`）、JSON Schema・補完・ホバーにも入れた。CLI は `generate` / `diff` がモデルの target を使い、`--target` で一時的に上書きできる。`ddd init --target typescript` は TypeScript 用のサンプル（`examples/cleaning-platform-ts/model.ddd.yaml`）を作る。サーバーのプレビューと ZIP はモデルの target で生成する（`generate()` に置き換えただけで、上限などは変えていない）。target を切り替えると前の target の生成物は stale になる（マニフェストの場所は同じ）。
- **配置**: `src/<package>/generated/` の下に `runtime.ts`（共通の基底・スキーマ・ポート）、`adapters.ts`、`testing.ts`（共通のテストダブル）、`index.ts`（runtime とコンテキストごとの名前空間）、`<context>/domain/*.ts`・`application/*.ts`・`testing.ts`・`index.ts`・`README.md`。ファイル名とディレクトリは kebab-case（`cleaning-staff/domain/value-objects.ts`）、import は `.js` 付きの相対パス（NodeNext でも bundler でも解決できる）。生成テストは `tests/generated/<context>-<name>.test.ts`（plan.ts の stale テスト削除がそのまま働く）。初回だけ `package.json`・`tsconfig.json`・`src/<package>/index.ts`・`extensions/<context>/{extensions,translators}.ts` を作る。ヘッダー・マニフェスト・`ddd.lock`・手編集の検知は Python と同じ。plan.ts に変えたのは破壊的変更の検出だけ（`.ts` の export とクラスの公開メンバーの引数を比べる）。
- **型の表現**: Value Object・コマンド・イベントは Zod スキーマと推論型（凍結したただのオブジェクト）。構造で比べる値なのでクラスにしない。Entity・Aggregate はクラス（`readonly`・`Object.freeze`・private コンストラクタ）。識別子で比べる、操作とガードをメソッドとして持つ、`instanceof` で Entity を見分けられる（`equals` と `remove` が識別子で比べるため）ことが理由。構築は `X.from(input)`（スキーマで検証してから construct の Invariant）。名前を `from` にしたのは、Python の予約語なのでモデルの操作・ファクトリ名（`create` など）と決してぶつからないため。Value Object は利用者の名前を持たないので `create` / `parse` にした。Entity のフィールドは `X.schema`（インスタンスだけを受け付ける。作るのは `X.from`）。
- **値の型**: Decimal は decimal.js（`Decimal.clone({ precision: 28, rounding: ROUND_HALF_EVEN })` で Python の既定の decimal と同じ精度・丸め。`round()` は `ROUND_HALF_UP`）。入力は文字列・数値・Decimal、`max_digits`・`decimal_places` は Pydantic と同じく末尾の0を数えない。UUID は `z.guid()` で検査し小文字に正規化したブランド付き文字列。`z.uuid()` は RFC 9562 の version / variant まで検査し、モデルの検証と Python の `uuid.UUID` が受け付ける `00000000-0000-0000-0000-000000000001` のような値を拒むため使わない。`Ref[X]` と Aggregate / Entity の UUID の識別子は `Id<"X">`（UUID のサブタイプ。UUID から渡すところは生成コードが `as Id<"X">` を書く）。DateTime は `Date`（入力は `Date` か `z.iso.datetime({ offset: true })` の文字列）、Date は `LocalDate`（ISO の日付文字列。文字列のまま大小を比べられる）、Duration はミリ秒の number。Integer は `z.number().int()`（安全な整数の範囲）。
- **式**: 演算子は型で出し分ける。Decimal の算術・比較は decimal.js のメソッド（`a.plus(b)`、`a.lt(b)`。Integer は `new Decimal(x)`、`Integer / Integer` も Decimal）、DateTime は `getTime()` で比べ、時間の計算は runtime の `plusDuration` / `durationBetween` / `plusDays` など、Value Object・リスト・null になりうる Decimal / DateTime・異なる Aggregate の ID の `==` は runtime の `equals`（Entity は識別子で比べる）。JavaScript の `!` は比較より強く結びつくので `not` は常に括弧でくくる（`!(a === b)`）。コレクション関数は `item` を引数にするコールバック（`xs.some((item) => …)`、`sumDecimals(xs, (item) => …)`）。null 確認で絞り込んだ省略可能なフィールドをコールバックの中で使うときは `!` を付ける（TypeScript はクロージャに絞り込みを持ち込まないため）。
- **名前**: フィールド・引数・メソッドは camelCase（`_` の後が英字なら大文字にし、それ以外の `_` は残すので、2つのモデル名が同じ名前になることはない）。予約語や生成コードが同じスコープで使う名前（`args` `aggregate` `events` `days` `equals` など）と同じ引数・変数には `_` を付ける。生成コードが同じモジュールで使う型名（`Map` `Promise` `Error` `Record`、`Id` `LocalDate` `Entity`、`OrderInput` `EmailAddressSchema` `OrderingEvent` など）とフィールド名 `constructor` は、target が typescript のときだけ `reserved-name` にした（2026-10-03 に `Omit` `ErrorOptions`、`<Event>Schema` `<Ctx>EventSchema`、イベントフィールド `type` を追加。§16）。Python の命名規則（予約語など）は target によらず適用する（target を切り替えても同じモデルが通るように）。
- **非同期とポート**: Use case は `async execute(command)`。Repository・UnitOfWork・EventPublisher・IdempotencyStore・Extension point は `Awaitable<T>`（同期でも Promise でも実装できる。テストの In-memory 実装は同期）。Clock と IdGenerator は同期。共通のポートは runtime.ts で一度だけ定義し、各コンテキストの ports.ts から再エクスポートする。コンストラクタは必要なポートだけを `deps` オブジェクトで受け取る（Python のキーワード専用引数と同じ規則）。
- **イベント**（2026-10-03 に strict スキーマ・`parse`・判別共用体を追加。§16）: `type` を `"<Context>.<Event>"` にした。`subscriptions()` と `dispatch()` は `type` で引くので、2つのコンテキストが同じ名前のイベントを持っても1つのバスで混ざらない（Python はクラスで引くので問題にならなかった）。イベントは `X.create(payload)` で作り（Zod で検証して凍結）、`X.is(event)` が型ガード。
- **エラー**: Domain Error ごとにクラス（`code`・既定メッセージ・型付きの `details`）。モデルの `details` は省略可能なプロパティとして型になる（生成コードが送出するときは `rule` / `guard` と識別子だけを入れるため）。
- **生成テスト**: シナリオ・導出した違反値・冪等性・ポリシーは Python と同じ内容。テスト名はシナリオ名（導出テストは `invariant_<owner>_<rule>`）。README の「Tested by」もこの名前で書く。期待値の比較は `plain(...)`（Decimal は正規化した文字列、日時は ISO 文字列、Entity は識別子）。ブランド付きの値は `expect(String(x)).toBe(...)`（`bun:test` の `toBe` は実際の値の型で引数を型付けするため）。シナリオの値はスキーマの入力としてそのまま書く（`X.from({ placedAt: "2026-…", total: "12.50" })`）。
- **整形**（2026-10-03 に Prettier の出力と一致させる方式へ置き換えた。演算子は行末、引数リストの末尾カンマなど。§16）: 1行100文字以内（1つの名前だけの import / export 行は除く）。折り返しは括弧の中だけ。`return` / `throw` の直後や `=>` の前では改行しない（自動セミコロン挿入で `return` が `undefined` を返すなど、Python のタプル化と同じ種類の「ルールが黙って消える」不具合になるため）。長い真偽値は `return (` のように開き括弧を同じ行に置いてから演算子の前で折る。1つのオブジェクト引数は `f({` … `})` とくっつける。
- **生成器のテスト**（`packages/generator/test/typescript.test.ts`）: 式の出力の単体テスト、TypeScript の例の golden test と決定性、plan（手編集・stale・破壊的変更）、検証と補完。「生成した TypeScript が実際に動く」テストは、zod・decimal.js・typescript・vitest・型定義を依存の版の hash ごとの一時ディレクトリに一度だけ `bun install` し、サンプル・kitchen-sink・context-map・ordering・long-rules を `test_runner: bun` で生成して `tsc` と `bun test` を通す（速いので）。サンプルは vitest でも実行する。さらに Invariant の `throw` をすべて無効にして導出テストを実行し、すべて失敗することを確かめる（検査が消えたらテストが気づく）。インストールできなければ理由を表示して skip する（`DDD_SKIP_TS_RUN=1` で明示的に skip）。
- **例**: `examples/cleaning-platform-ts/`（同じドメイン、生成物・顧客の拡張・手書きテストを含む）と `bun run verify:example:ts`（`diff --check` → `bun install` → `tsc --noEmit` → vitest）。ルートの `bunfig.toml` で `bun test` の対象を `packages/` に限った（例の生成テストは各例のランナーと依存で動かす）。
- **既知の制限・Python との違い**: `Date` は JavaScript では可変（生成コードは変更しないが、凍結もできない）で、精度はミリ秒（Python はマイクロ秒）。文字列の長さ（`min_length` / `max_length` / `length()`）は UTF-16 の単位で数える（Python はコードポイント。絵文字などで差が出る）。`pattern` は JavaScript の正規表現として解釈する（どちらも部分一致）。Decimal は末尾の0を付けずに文字列にする（`"2.5"`。値としては等しい）。Python の lax モードのような型の変換（`"1"` を Integer にする）はしない。破壊的変更の検出は行単位の簡易な解析で、型の変更までは見ない。Web の生成プレビューは TypeScript のファイルもそのまま表示する（Python と同じく構文の色付けはない）。scaffold の `package.json` は `typescript@^7`（このリポジトリと同じ版）を指定する。

## 16. 生成コードのベストプラクティス（TypeScript / Zod, 2026-10-03）

生成した TypeScript（サンプルと `packages/generator/test/fixtures/*.ddd.yaml`）を、公式ドキュメントと著名なエンジニアの推奨に照らしてファイルごとに見直した。判定は「採用」（今回変えた）・「済」（もともと従っていた）・「不採用」（理由つきで従わない）。生成 API の破壊的変更と移行は docs/05 §8 の「移行メモ（2026-10-03）」。

### 確認した方針と判定

| 方針 | 出典 | 生成コード（前 → 後） | 判定 |
|---|---|---|---|
| 生成物は Prettier 済みにする（整形は lint でなく formatter に任せる） | [Prettier Options](https://prettier.io/docs/options), [Rationale](https://prettier.io/docs/rationale), [typescript-eslint: What about formatting?](https://typescript-eslint.io/users/what-about-formatting) | 独自の折り返し（演算子が行頭、`f(\n  args: {…}\n)` など）で、どのモデルでも `prettier --check` が数十ファイル失敗 → Prettier の印字アルゴリズムを移植した `format.ts` で100文字を超える行を印字し直す。`.prettierrc.json`（`printWidth: 100`）を scaffold する | 採用 |
| typescript-eslint の strict-type-checked で警告ゼロ | [typescript-eslint Shared Configs](https://typescript-eslint.io/users/configs) と各ルール（[unbound-method](https://typescript-eslint.io/rules/unbound-method) [restrict-plus-operands](https://typescript-eslint.io/rules/restrict-plus-operands) [restrict-template-expressions](https://typescript-eslint.io/rules/restrict-template-expressions) [no-confusing-void-expression](https://typescript-eslint.io/rules/no-confusing-void-expression) [no-empty-object-type](https://typescript-eslint.io/rules/no-empty-object-type) [no-extraneous-class](https://typescript-eslint.io/rules/no-extraneous-class) [await-thenable](https://typescript-eslint.io/rules/await-thenable) [require-await](https://typescript-eslint.io/rules/require-await) [no-unnecessary-type-conversion](https://typescript-eslint.io/rules/no-unnecessary-type-conversion)） | 1モデルあたり10〜19件 → 0件。`events.filter(X.is)`（unbound）→ `is` をアロー関数のプロパティに、`"…" + n` → テンプレートと `String(n)`、`!!(…)` → `not` の否定はそのまま条件に、空の `interface Extensions {}` と空の `StubExtensions` → 出さない、テストの同期ダブルへの `await` → 外す、`await` のない `async` → 同期の `#run` | 採用（`argsIgnorePattern: "^_"` だけ足す。下記） |
| `z.strictObject` で未知のキーを拒む | [Zod 4 changelog](https://zod.dev/v4/changelog) | Value Object・コマンド・イベント・Aggregate の props はすべて `z.strictObject` | 済 |
| `.readonly()` で解析結果を凍結する | [Zod API: readonly](https://zod.dev/api#readonly) | Value Object・コマンドは `.readonly()`、イベントは `Object.freeze` → イベントも `.readonly()` のスキーマに | 採用（イベント） |
| `z.output` / `z.input` を使い分ける（transform があると `z.infer` は出力型だけ） | [Zod API: transforms](https://zod.dev/api#transforms) | 型は `z.output`、入力は `z.input` | 済 |
| ブランドは Zod の `.brand<…>()`、手書きの型より Zod に任せる | [Zod API: branded types](https://zod.dev/api#branded-types), [Pocock: Four Essential TypeScript Patterns](https://www.totaltypescript.com/four-essential-typescript-patterns), Vanderkam『Effective TypeScript』第2版 Item 64 | UUID・LocalDate は `.brand<"UUID">()`。`Id<A>` は `UUID & z.$brand<A>`（Zod のブランドと同じ交差型）。`idSchema(owner)` は `.brand<A>()` を使いたいが、ジェネリックな `A` では TypeScript が型を解決できないためキャストを1回残す（説明文に owner を入れた） | 済（一部不採用: キャスト） |
| transform で失敗を伝えるときは `ctx.issues.push` と `z.NEVER`、transform 自体は throw しない | [Zod API: transforms](https://zod.dev/api#transforms)（"Transform functions should never throw"）, `.superRefine` は非推奨で `.check` | Decimal の検査は `ctx.addIssue` → `ctx.issues.push({ code: "custom", message, input })` | 採用 |
| ↑ ただし Value Object の Invariant は transform の中で宣言したドメインエラーを throw する | 同上 | `MoneyFields.transform(checkMoney)` が `InvalidOrder` を投げる | 不採用（入れ子の Value Object の Invariant も宣言したエラークラスで届く必要がある。issue にすると `ConstraintViolation` に変わり `details.rule` が失われる。代わりに `z.encode` / codec は使えない） |
| エラーメッセージの指定は `error` パラメータ、v3 の `.format()` / `.flatten()` は使わない | [Zod 4 changelog](https://zod.dev/v4/changelog), [Error formatting](https://zod.dev/error-formatting) | `z.custom(fn, "Expected a decimal")`（文字列の短縮形）。`.format/.flatten` は不使用 | 済 |
| 失敗の整形は `z.prettifyError` / `z.treeifyError` | [Error formatting](https://zod.dev/error-formatting) | `ConstraintViolation` は1行のメッセージと `details.issues`（path・message）→ issue の `code` を追加し、ZodError を `cause` に入れる | 一部採用（複数行で記号付きの `prettifyError` はログ・API の1行メッセージに向かないので使わない。構造化した情報は `details.issues` と `cause`） |
| UUID は `z.uuid()`（RFC 9562 の version / variant まで検査） | [Zod 4 changelog](https://zod.dev/v4/changelog) | `z.guid()` | 不採用（§14 のとおり、モデルの検証と Python が受け付ける `00000000-0000-0000-0000-000000000001` を拒むため） |
| 日時は `z.iso.datetime`、型変換は `z.coerce` より明示的なスキーマ | [Zod API: ISO datetimes](https://zod.dev/api#iso-datetimes) | `z.iso.datetime({ offset: true })` と `z.date()` の union。`z.coerce` は不使用（`"1"` を Integer にしない方針, §14） | 済 |
| Date の往復は codec（`z.codec`, Zod 4.1） | [Codecs](https://zod.dev/codecs) | 入力は `Date` と ISO 文字列の両方を受ける。JSON では `Date.toJSON` の ISO 文字列（`Z`）をそのまま受け付けるので往復できる | 不採用（codec は入力を1つの型に決める。transform を含むスキーマでは `z.encode` も動かない） |
| イベントは判別共用体で、外から来たイベントも厳密に解析する | [Zod API: discriminated unions](https://zod.dev/api#discriminated-unions), [Wlaschin: Making illegal states unrepresentable](https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/), [King: Parse, don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) | `type` で区別する union 型だけで、`X.create(payload)` しかない → `type: z.literal(…)` を含むイベント全体の strict スキーマ、`X.parse(unknown)`、コンテキストごとの `<Ctx>EventSchema = z.discriminatedUnion("type", […])` と `parse<Ctx>Event`。生成テストが発生したイベントの JSON 往復（`viaJson`）を確かめる | 採用 |
| 列挙は TypeScript の `enum` でなく `as const` オブジェクト + `z.enum(obj)` | [Pocock: Why I don't like enums](https://www.totaltypescript.com/why-i-dont-like-typescript-enums), Vanderkam Item 72, [Zod 4 changelog](https://zod.dev/v4/changelog)（`z.nativeEnum` は非推奨） | `as const` + `z.enum(InvitationStatus)` | 済 |
| 型を広げずに検査するには `satisfies` | [TS 4.9](https://devblogs.microsoft.com/typescript/announcing-typescript-4-9/), [Pocock: satisfies](https://www.totaltypescript.com/clarifying-the-satisfies-operator) | `RULES: ReadonlyArray<Rule>` → `[…] as const satisfies ReadonlyArray<Rule>`。イベントの companion は `as const satisfies EventType<X, XInput>`（runtime の `EventType` は使われていなかった） | 採用 |
| strict な tsconfig（`noUncheckedIndexedAccess` `exactOptionalPropertyTypes` `verbatimModuleSyntax` `isolatedModules` `noImplicitOverride` など）、Node の型除去に合わせた `erasableSyntaxOnly` | [Pocock: TSConfig Cheat Sheet](https://www.totaltypescript.com/tsconfig-cheat-sheet), [Pocock: erasableSyntaxOnly](https://www.totaltypescript.com/erasable-syntax-only), [TS 5.8](https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/), [TS 5.0](https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/), [TSConfig reference](https://www.typescriptlang.org/tsconfig/) | 前者は済。`noUnusedParameters` `noImplicitReturns` `erasableSyntaxOnly` を scaffold に追加（生成コードに enum・namespace・パラメータプロパティはない） | 採用（追加分） |
| ESM / NodeNext では相対 import に `.js`、型だけの import は `import type` | [TS 5.0](https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/)（verbatimModuleSyntax） | `.js` 付きの相対パス、`import type` / `type` 修飾 | 済 |
| `isolatedDeclarations` | [TS 5.5](https://devblogs.microsoft.com/typescript/announcing-typescript-5-5/) | 未設定 | 不採用（.d.ts を並列生成する用途向け。生成物はライブラリとして配布しない） |
| 実行時にも隠れる `#private`、`override` | [Pocock: classes](https://www.totaltypescript.com/books/total-typescript-essentials/classes) | Use case の依存・Aggregate の内部メソッドは `#`、コンストラクタだけ `private`（`#` のコンストラクタはない）、`override` 付き | 済 |
| エラーに ES2022 の `cause` | [MDN: Error cause](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause) | `DomainError(details, message)` → `(details, message, options?: ErrorOptions)`。生成するエラーと `ConstraintViolation` / `AggregateNotFound` も同じ。`ConstraintViolation` は ZodError を `cause` に持つ | 採用 |
| `Error.captureStackTrace` | [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/captureStackTrace) | 不使用（`class … extends Error` でスタックは正しく取れる） | 不採用（非標準で、利点がない） |
| catch した値は `unknown` | [TSConfig: useUnknownInCatchVariables](https://www.typescriptlang.org/tsconfig/#useUnknownInCatchVariables)（strict に含まれる） | `catch (error) { rollback; throw error; }` は unknown のまま投げ直す | 済 |
| 不変性: Value Object は不変、Aggregate はルートを通してだけ変える | [Fowler: ValueObject](https://martinfowler.com/bliki/ValueObject.html), [Fowler: DDD_Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html), [Vernon: Effective Aggregate Design](https://www.dddcommunity.org/library/vernon_2011/), [MDN: Object.freeze](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze) | Aggregate は `readonly` + `Object.freeze`、配列は `.readonly()`、状態の変更は必ず `X.from` を通る（スキーマ・正規化・Invariant を再評価）。`Object.freeze` は浅い | 済 |
| Date は可変（MDN は Date を legacy とし Temporal を勧める） | [MDN: Date](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date), [TC39 Temporal](https://github.com/tc39/proposal-temporal) | 呼び出し側の `Date` をそのまま保持していた（後から `setTime` すると検証済みの状態が変わる）→ 入力の `Date` を複製する。Aggregate が返す `Date` は可変のまま | 一部採用（Temporal は Stage 4 だが Safari が未対応で、Python と同じ `Date` 互換の API を保つため見送り。出力側の可変性は既知の制限） |
| お金は decimal.js、独立したコンストラクタで精度と丸めを固定、JSON は文字列 | [decimal.js API](https://mikemcl.github.io/decimal.js/) | `Decimal.clone({ precision: 28, rounding: ROUND_HALF_EVEN })`、`toJSON()` は文字列で往復できる | 済 |
| ポートは非同期を前提に Promise を返す | — | `Awaitable<T>`（同期・非同期どちらの実装も可） | 不採用（テストのインメモリ実装を同期のまま使えるようにするため。`await` は両方に正しく働き、`await-thenable` も union を受け付ける） |
| テストは `expect(fn).toThrow(Class)`（`toThrowError` は非推奨の別名）、`test.each` | [Vitest expect](https://vitest.dev/api/expect.html), [Vitest test.each](https://vitest.dev/api/#test-each), [Bun test](https://bun.com/docs/test/writing-tests) | `expectThrows(fn, Class)` が型付きのエラーを返し `details.rule` まで確かめる。`toThrowError` は不使用 | 済（helper は vitest と bun:test の両方で同じに動き、`toThrow` では取れないエラーの中身を型付きで検査できる） |
| zod/mini | [zod/mini](https://zod.dev/packages/mini)（"you should probably use regular Zod"） | 通常の zod | 不採用（サーバー側のドメインコードでバンドルサイズは問題にならない） |
| 文字列は二重引用符、ただしエスケープが少ない方の引用符 | [Prettier Rationale](https://prettier.io/docs/rationale) | `"currency != \"JPY\""` → `'currency != "JPY"'` | 採用 |

### 専門家の見解が分かれる点と、生成器の選択

- **Result 型か例外か**: Wlaschin（[Railway Oriented Programming](https://fsharpforfunandprofit.com/rop/)、ただし [Against ROP](https://fsharpforfunandprofit.com/posts/against-railway-oriented-programming/) で「業務上想定された失敗には Result、fail fast や相互運用には例外」）、Stemmler（[Functional error handling](https://khalilstemmler.com/articles/enterprise-typescript-nodejs/functional-error-handling/)）、[Effect の Expected errors / defects](https://effect.website/docs/error-management/two-error-types/)、[neverthrow](https://github.com/supermacro/neverthrow) は想定内の業務エラーを Result で返すことを勧める。一方 Stemmler 自身の [Value Object の記事](https://khalilstemmler.com/articles/typescript-value-object/) は例外を投げる。生成器は例外のままにした。モデルが宣言するエラーは `code` と型付きの `details` を持つクラスで、これが型付きの失敗の経路になる。投げずに確かめたいときは `StateGuard.checks()` を使える。UnitOfWork の rollback は例外を合図にしており、Python の出力とも揃う。Result が欲しい利用者は `execute` を包むアダプタを書ける。
- **Aggregate をクラスにするか、ただのデータと関数にするか**: Zod と Pocock の流儀はただのデータ寄り、Stemmler はクラス。生成器は §14 のとおり、識別子で比べる Entity / Aggregate だけクラス（`instanceof` で Entity を見分ける `equals`、操作とガードをメソッドに持つ）、構造で比べる Value Object・コマンド・イベントは凍結したただのオブジェクトにしている。今回の見直しでも変えない。
- **ブランド**: Pocock と Vanderkam（Item 64）はブランドで「検証済み」を型に残すことを勧め、Zod のブランドは型だけの印（実行時には何もしない）。生成器はスキーマを通った値だけがブランドを持つようにしている（`uuid()` / `id()` / スキーマ）。Use case が UUID を別の Aggregate の識別子として渡す箇所だけ `as Id<"X">` を書く。

### 整形と lint の保証の範囲

- `format.ts` は Prettier 3 の印字器（`printDocToString` / `fits` / `propagateBreaks`）と、生成コードが使う構文の印字規則（引数の最後の展開、メンバーチェーン、二項演算の連鎖、アロー関数、代入のレイアウト、シグネチャ、型エイリアス、括弧の要否）を移植したもの。生成器は同期・依存なしの純関数のままにしたいので Prettier 自体は呼ばない（Prettier の API は非同期）。100文字に収まる行は emitter が最初から Prettier の形で書き、収まらない行だけを印字し直す。東アジアの文字は Prettier と同じく2桁に数える。
- 保証は「実行テストの7モデル（サンプル・kitchen-sink・context-map・ordering・long-rules・ボードから反映したモデル・提案シナリオ付きサンプル）で本物の `prettier --check` が通る」ことで、任意のモデルで一致することまでは証明していない（ずれたら生成テストのように run suite のモデルを足して直す）。README の表は Prettier が列を揃えるが、生成物の Markdown は対象外にした。
- lint は typescript-eslint の strict-type-checked に、未使用の引数を `_` で示す一般的な設定（`argsIgnorePattern: "^_"`、TypeScript の `noUnusedParameters` と同じ約束）だけを足して実行する。`_command`（どの手順もコマンドを読まない Use case）と `_event`（イベントから何も取らないポリシー）のため。typescript-eslint は TypeScript 7 の API（7.1 まで未提供, [TS 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)）を使えないので、run suite は TypeScript ~6.0 を別のキャッシュに入れて lint する。
- 生成テストの JSON 往復は Entity を含まないイベントだけ（Entity のフィールドはインスタンスだけを受け付けるスキーマなので JSON から戻せない）。Aggregate の JSON 往復は提供しない（Repository のアダプタの責務）。
