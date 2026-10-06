# 05. Code Generation and Architecture

## 1. 構成案

```mermaid
flowchart LR
    U[Web editor\n図・フォーム・DSL] --> IR[Canonical domain IR]
    Y[Versioned YAML\nGitで管理] --> IR
    IR --> V[Parser・型検証・Rule検証]
    V --> G[Deterministic generator]
    G --> PY[Python domain package]
    G --> T[pytest tests]
    G --> TS[TypeScript domain package\nZod v4]
    G --> TT[vitest / bun tests]
    G --> M[Generation manifest]
    CLI[Local CLI / CI] --> Y
    CLI --> V
    CLI --> G
    PY --> X[Customer-owned extension code]
    TS --> X
```

## 2. 生成契約

### 必須の性質

- **決定的:** 同一モデル、設定、generator版ならファイル内容が同一。
- **差分生成:** 新規・更新・削除予定を実書き込み前に表示。
- **所有境界:** Generated領域は再生成可能。Extension領域はツールが更新しない。
- **読みやすさ:** 出力に意味のあるクラス名、メソッド名、docstring、型注釈を付ける。
- **一般的な実行:** 標準Pythonツールと通常のCIで動く。
- **削除の安全性:** モデルから削除したファイルは自動削除せず、stale候補として警告するか明示的承認を求める。例外は `tests/generated/` の生成テストで、生成したときのまま（hashが一致）なら `generate` が削除する（消えたコードをimportして必ず失敗するため）。手で編集してあれば何も書かずに止まり、`--prune --force` を求める。
- **読める整形:** 生成コードは1行100文字以内に収める。折り返しは括弧の中だけで行い、条件をくくる括弧をタプルに変えない（`if not (a or b,):` は常に真になり、ルールが働かなくなる）。TypeScript の生成物は Prettier（printWidth 100）の出力そのもの（§8。`return` / `throw` の直後や `=>` の前で改行しないことも Prettier の規則に含まれる）。1つの名前だけの import 行や長い文字列リテラルは、Prettier と同じく100文字を超えても折り返さない。 Python の出力は ruff format と同じ形に折り返し、`ruff format --check` と `ruff check` を通す（§4.1）。
- **失敗時の原子性:** 生成エラーやユーザー取消しで一部ファイルだけ更新された状態を作らない。

### 生成ディレクトリ案

```text
src/<package_name>/
  generated/
    domain/
      entities.py
      value_objects.py
      aggregates.py
      errors.py
      events.py
      commands.py
      invariants.py
    application/
      use_cases.py
      ports.py
    model_manifest.json
  extensions/
    domain/
    application/
tests/
  generated/
```

顧客の好みでモジュール分割を設定できるようにするが、MVPでは出力構造を限定し、安定した拡張契約を優先する。

## 3. 手書きコードとの接続

- 自動生成されたクラスに顧客コードを直接追記させない。
- 生成ファイルから呼び出す抽象Port、拡張関数、基底クラスのいずれかを提供する。
- 拡張ポイントは名前と型をモデルに登録し、未実装箇所を診断する。
- GeneratorのバージョンアップでExtension APIを破壊する場合は変更前に差分を出す。
- 生成物への手編集を検知した場合、黙って上書きせず差分を表示して停止する。

## 4. Python出力の初期方針

- Pythonを最初の生成対象にする。
- Python 3.11以上を暫定ターゲットとし、正式サポート範囲はPoC開始前に固定する。
- 型注釈、標準的なEnum、UUID、datetime、Protocol / ABC等を利用する。
- Value Objectは不変を既定にする。
- Entity / Aggregateは外部からの直接変更を避け、名前付き操作を通す。
- Pydantic v2を使う生成Profileを初期候補とする。標準ライブラリだけのProfileを求める顧客数をPoCで調べる。
- 生成結果はpytestで実行でき、mypyまたはpyrightのどちらを公式サポートするかを定める。
- Domain ErrorはHTTPやFastAPIの型から独立させる。
- 時計、ID生成、Repository、イベント通知などの外部依存はPortまたは明示入力にする。

### 4.1 生成コードの規約と互換性（2026-10-03）

監査の根拠・出典・従わなかった項目は [docs/09 §15](09-implementation-decisions.md)。

- **検証の保証**: 生成モデル（`DomainModel` を継承する Value Object・Entity・Aggregate・イベント・コマンド）は、どの経路で新しい状態を作っても検証する。対象はコンストラクタ、`model_validate`、`model_copy(update=...)`、`_replace`（Pydantic 2.10 以上なら `copy.replace` も）。制約違反は `ConstraintViolation`（`__cause__` に Pydantic の `ValidationError`）、Invariant 違反は宣言した Domain Error になる。検証しないのは `model_construct` だけで、検証済みのデータを再び読み込むときの逃げ道として残す。
- **型と書式**: Enum は `StrEnum`。定数は `Final`。`Transition`・`StateGuard`・`Rule`・`RecordedResult` は `@dataclass(frozen=True, slots=True)`。生成モジュールは `__all__` で公開名を示し、`src/<package>/py.typed` を雛形として作る。
- **イベント**: 各イベントは `event_type: Literal["<Context>.<Event>"]` を持つ（既定値つきなので、作るときに渡す必要はない）。コンテキストの `events.py` にはタグ付き共用体 `AnyEvent` と `parse_event(data)` があり、`model_dump()` / `model_dump(mode="json")` の結果からイベントを復元できる。イベントのフィールド名 `event_type` と型名 `AnyEvent` は予約名で、モデルの検証が `reserved-name` を出す。
- **整形**: 出力は `ruff check`（規則は例の `pyproject.toml`）と `ruff format --check` を通る。mypy は `--strict` に Pydantic プラグイン（`init_typed`・`init_forbid_extra`）を加えた設定で通る。

#### 移行の注意（generator 0.1.0 のこの版から）

公開 API の名前と引数は変えていない（`ddd diff` の破壊的変更の一覧には出ない）。ただし次の挙動が変わる。

| 変更 | 影響 | 対応 |
|---|---|---|
| `model_copy(update=...)` が検証する | 不正な値を渡すと `ConstraintViolation` か Domain Error が送出される。以前は黙って不正なインスタンスを返していた | 例外が出た箇所は、もともと不正な状態を作っていた。値を直すか、状態の変更をモデルの操作に置き換える |
| Enum が `StrEnum` | `str(Status.OPEN)` と f-string が `"open"` になる（以前は `"Status.OPEN"`）。比較・`.value`・JSON は同じ | 表示に `str(member)` を使っていたコードを確かめる |
| イベントに `event_type` | `model_dump()` の結果と JSON に `event_type` が増える。既定値があるので、`event_type` のない古い形の dict もクラスの `model_validate` で読める。他のシステムが dict のキーを厳密に検査していれば影響する | 保存済みイベントは `parse_event` で読み直せる（`event_type` がなければ、その dict を書いたクラスの `model_validate` を使う） |
| `ConstraintViolation` の連鎖 | `__cause__` が `ValidationError` になる（以前は `None`）。`details["errors"]` から各エラーの `url` がなくなる | `url` を参照していたコードを外す |
| dataclass の `slots=True` | `Transition` などに属性を追加できない（frozen なので以前もできなかった）、`__dict__` がない | なし（`__dict__` を使っていた場合だけ `dataclasses.asdict` に変える） |
| `__all__` | `from <module> import *` は `__all__` の名前だけを取り込む。mypy / pyright は生成モジュールが import しただけの名前（例えば events.py の `UUID`）を公開名とみなさない | 型や関数は、定義しているモジュールから import する |
| `py.typed` | 新しい雛形として作られる。既にあれば触らない | なし |
| 例の mypy 設定（Pydantic プラグインの `init_typed`） | この設定を写すと、lax な変換に頼った呼び出し（`Model(id="…")` で `id: UUID` など）を mypy が型エラーにする | 正しい型で渡すか、外部のデータは `Model.model_validate(data)` で読む |
| 予約名 `event_type`（イベントのフィールド）と `AnyEvent`（型名） | これらを使っていたモデルは `reserved-name` になる | 名前を変える |

## 5. ドメインコード生成の意味論

### Invariant

1. 入力フィールドの型・制約を検証する。
2. Invariant式を評価する。
3. 違反時は宣言されたDomain Errorを送出し、無効インスタンスを返さない（`details["rule"]` にルール名）。
4. 状態遷移時は候補状態を作り、全Invariantを通過した場合だけ結果を確定する。
5. シナリオの値から違反する値を導けるInvariantには、それを確かめるテストを生成する（`tests/generated/test_<context>_invariants.py`）。

### StateGuard

- Guardオブジェクトまたは等価な型付きAPIを生成する。
- `checks()`でboolを返す。
- `assert_holds()`で条件成立時は継続し、違反時は宣言Errorを送出する。`assert`はPythonの予約語として扱う。
- 操作側がGuardを自動適用するか、呼び出し側へ委ねるかをモデル上で明示する。
- Guard条件とOperationの対応をドキュメントへ出す。

### Use Case

- 入力検証、Port呼び出し、Domain操作、保存、イベント公開順を明示する。
- Domain操作をHTTP handlerに直接結合しない。
- トランザクション境界とイベント公開タイミングの保証を設定に記録する。
- 再試行がある処理（`retry: true`）はidempotency keyがなければエラーにする。
- `idempotency_key` を持つUse caseは `IdempotencyStore` Portで成功した結果をキーごとに記録し、同じキーの2回目は手順を実行せず記録した結果を返す。記録はコミット前に同じトランザクションの中で行う。

## 6. WebとCLIの責務

### Web SaaS

- モデル編集、図、共同レビュー、診断、ドキュメント表示、ユーザー・課金管理を担う。
- 顧客のソースコードやSecretを既定で保存しない。
- Webでの生成はダウンロード可能なレビュー用結果に限り、顧客リポジトリへの書き込みには明示承認を要する。

### Local CLI

- モデル検証とコード生成の正規実行環境。
- オフライン利用可能。Webログインを必須にしない基本機能を提供する。
- CI上で固定版を実行し、モデルと出力の差分を検査する。
- ライセンスや有料機能確認で通信する場合は、送信データと頻度を明記し、失敗時の動作を契約する。

## 7. AI拡張の位置づけ

- AIはモデルから欠けた意味を推測して確定しない。
- 曖昧な箇所を質問し、回答をモデル差分へ反映する。
- AI生成コードにはシナリオ由来テスト、未カバー条件、推測箇所を添付する。
- 生成コードの所有権、学習利用、外部送信、保持期間をプランと設定で明示する。
- AIなしでもモデル検証と決定的生成が成立する。

## 8. TypeScript出力（Zod）

`generation.target: typescript` のとき、同じモデル・同じ意味論から TypeScript を生成する。決定・理由・Python との違いは [docs/09 §14](09-implementation-decisions.md)。

### 実行環境と依存

- TypeScript（strict、ESM / `module: NodeNext`、`verbatimModuleSyntax`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`erasableSyntaxOnly`）。生成物は `tsc --noEmit` をこの設定で通る。
- 整形と lint: 生成物は Prettier（`printWidth: 100`、scaffold の `.prettierrc.json`）で `prettier --check` が通り、typescript-eslint の `strict-type-checked`（未使用の引数は `_` で示す `argsIgnorePattern: "^_"` だけ追加）で警告が出ない。生成器のテストが実行テストの全モデルで確かめる（docs/09 §16）。
- 実行時の依存は `zod`（v4）と `decimal.js` だけ。DDD Presenter のランタイムライブラリには依存しない（共通部分は `generated/runtime.ts` として生成する）。
- テストは vitest（既定）か `bun test`（`generation.typescript.test_runner`）。初回だけ `package.json`・`tsconfig.json` を作り、以後は顧客所有。

### 生成物と所有

```text
src/<package>/generated/runtime.ts        # 値のスキーマ、DomainError、Entity / AggregateRoot、Transition、StateGuard、ポート、dispatch
src/<package>/generated/{adapters,testing,index}.ts
src/<package>/generated/<context>/domain/{errors,enums,value-objects,entities,aggregates,events,commands,rules}.ts
src/<package>/generated/<context>/application/{ports,use-cases,policies}.ts
src/<package>/generated/<context>/{testing,index}.ts, README.md
src/<package>/generated/model_manifest.json
src/<package>/extensions/<context>/{extensions,translators}.ts   # 顧客所有（初回のみ）
package.json, tsconfig.json, .prettierrc.json                    # 顧客所有（初回のみ）
tests/generated/<context>-<name>.test.ts
```

手編集の検知、stale の扱い（生成したままの `tests/generated/` は削除、ソースは `--prune`）、`ddd.lock`、マニフェストは Python と同じ。破壊的変更の検出は、生成した `.ts` の export（クラス・関数・定数・型）とクラスの公開メンバーの引数を比べる。

### ドメインの意味論の対応

| 意味論 | TypeScript |
|---|---|
| Value Object | `z.strictObject(...).readonly()` のスキーマと推論型。正規化（`trim` / `toLowerCase` / `toUpperCase`）→ 制約 → Invariant の順。`X.create(input)` / `X.parse(unknown)`。結果は凍結したオブジェクト |
| Entity / Aggregate | 不変のクラス（`readonly` フィールド、`Object.freeze`）。`X.from(input)` がスキーマで検証し、construct の Invariant を評価する。コンストラクタは private |
| Invariant | クラスの private メソッド。違反は宣言した Domain Error で、`details.rule` にルール名と識別子が入る。制約違反は `ConstraintViolation`（`details.issues` に Zod の指摘の path・code・message、`cause` に ZodError）。Domain Error のコンストラクタは `(details, message, options?: ErrorOptions)` |
| 状態遷移 | 操作は `Transition<T>`（新しい Aggregate と発生イベント）を返す。`changes` は遷移前の状態で評価し、候補状態は `from` を通るので construct の Invariant が評価され、続いて transition だけの Invariant を評価する |
| StateGuard | `guard(...)` が `StateGuard` を返す（`checks()` / `assertHolds()`）。`require:` は操作の最初に `assertHolds()` |
| イベント | `type: "<Context>.<Event>"` を持つ凍結したオブジェクト。companion は `X.schema`（`type` を含むイベント全体の strict スキーマ）、`X.create(payload)`、`X.parse(unknown)`（シリアライズしたイベント用）、型ガード `X.is`（アロー関数なので `events.filter(X.is)` と渡せる）。コンテキストごとに判別共用体 `<Ctx>EventSchema` と `parse<Ctx>Event(unknown)`。`when` があれば変更後の状態で評価 |
| 日時 | DateTime は `Instant`（UTC に正規化した `2026-01-08T10:00:00.000Z` のブランド付き文字列、`InstantSchema`）。入力はオフセット付きの ISO 文字列か `Date`、出力は常にこの形なので `===` が値の等しさ、`<` が時刻の順になり、JSON でもそのまま。年は UTC で 0001〜9999。Date は `LocalDate`（`LocalDateSchema`）。runtime の `instant()`・`toDate()`・`nowInstant()`・`addDuration` / `subtractDuration` / `durationBetween`・`addDays` / `subtractDays` / `daysBetween`。`Clock.now()` は `Instant` を返す |
| Use case | 必要なポートだけをコンストラクタ（`deps` オブジェクト）で受け取るクラス。`execute(command): Promise<R>`。ポートは同期・非同期のどちらでも実装できる（`Awaitable<T>`）。手順を実行する `#run` は手順が `await` するときだけ `async`、コマンドを読むときだけ `command` を受け取る |
| トランザクション | `transaction: required` は UnitOfWork でくくり、失敗時は rollback して例外を投げ直す。`publish` はその場で、`publish_after_commit` はコミット成功後に公開 |
| 冪等性 | `IdempotencyStore` で `String(command.<key>)` ごとに成功した結果を記録（コミット前・同じトランザクション）し、同じキーでは手順を実行せず記録を返す |
| ポリシー | ハンドラクラス（`handle(event)` と、イベントバス用の `onEvent`）と `subscriptions({...})`（イベントの `type` → ハンドラ）。下流は上流の生成したイベントを名前空間 import で使う。anticorruption_layer は `<Upstream>Translator` を通す。コマンドがイベントから何も取らないときの引数名は `_event` |
| 生成テスト | シナリオ、導出した違反値（`details.rule` まで確認）、冪等性、ポリシーの対応付けをテストにする。期待値の比較は `plain(...)`（Decimal は値、Entity は識別子で比べる）。日時は正規化した文字列（`expect(String(x)).toBe("2026-01-08T10:00:00.000Z")`）で比べる。イベントを確かめるシナリオは、発生したイベントが JSON を経由して `parse<Ctx>Event` で同じイベントに戻ることも確かめる（Entity を含むイベントを持つコンテキストを除く）。保存された Aggregate は、Entity のフィールドを持たなければ JSON から `X.from` で同じ状態に戻ることも確かめる（`aggregateViaJson`）。インメモリのテストダブルは同期なので `await` しない |
| Extension point | モデルが宣言したときだけ `Extensions` インターフェース・`StubExtensions`・scaffold を出す。scaffold のメソッドは引数を取らない形で生成する（インターフェースに代入でき、使う引数だけ足す） |

### HTTP API と TanStack Query のクライアント（`generation.typescript.api`, 2026-10-04）

オプトイン（DSL は docs/10 §1.2、TkDodo のベストプラクティスとの対応は docs/09 §18）。設定がなければ生成物は以前とバイト単位で同じ。Python target には影響しない。

```text
src/<package>/generated/api/runtime.ts      # モデルに依存しない部分: エンドポイントの型、ハンドラ、fetch のトランスポート、エラーの対応（zod だけ）
src/<package>/generated/api/contract.ts     # 全コンテキストのエンドポイントと API_BASE_PATH
src/<package>/generated/api/server.ts       # createApiHandler(dependencies, options?) → (request: Request) => Promise<Response>
src/<package>/generated/api/client.ts       # createApiClient({ baseUrl, fetch, headers }) と ApiClient 型（React も TanStack Query も使わない）
src/<package>/generated/api/queries.ts      # createApiQueries(api) / createApiMutations(api): 全コンテキストのファクトリ、ApiQueries / ApiMutations 型
src/<package>/generated/api/register.ts     # TanStack Query の Register に defaultError: DomainError | ApiError を登録
src/<package>/generated/<context>/api/contract.ts  # Aggregate / Entity の JSON 形のスキーマ（XJson）と、そのコンテキストのエンドポイント
src/<package>/generated/<context>/api/queries.ts   # create<Context>Queries(api)（Aggregate ごとにキー + queryOptions）、create<Context>Mutations(api)
tests/generated/<context>-api.test.ts
```

- **縦の配置**: コンテキストごとの API のファイルは、そのコンテキストのドメインと同じディレクトリ（`generated/<context>/api/`）に置く（一緒に変わるものを一緒に置く。docs/09 §18）。コンテキストをまたぐもの（runtime・全体の contract・server・client・register・全体の queries）は `generated/api/` に残す。
- `generated/index.ts` とコンテキストの `index.ts` は `api/` を再 export しない（ドメインだけを使うバックエンドが TanStack Query を読み込まないように）。API はファイルを直接 import する（`generated/api/queries.js` など）。
- 生成したファイルは React の API（フック・Context）を使わない。`queryOptions` / `mutationOptions` / `skipToken` は `@tanstack/react-query` から import するので、依存としての React は残る（`@tanstack/react-query` の peer）。
- `Api` という名前のコンテキストは `generated/api/` を共有のファイルと分け合う（ファイル名は重ならないが紛らわしい）。避けることを勧める。

#### 契約（サーバーとクライアントで共有、フレームワーク非依存）

| エンドポイント | 入力 | 出力 | エラー |
|---|---|---|---|
| Use case ごとに `POST <base>/<context>/<use-case>` | コマンドのスキーマ（`X.schema`）。JSON の本文 | Use case の戻り値のスキーマ（`200`、JSON）。戻り値がなければ `204`（本文なし、出力は `z.void()`） | その Use case が起こしうる Domain Error のコードと HTTP ステータス（`errors`） |
| Aggregate ごとに `GET <base>/<context>/<aggregate>/:id` | 識別子のスキーマ（`idSchema("X")`） | Aggregate の JSON 形（`XJson`） | `constraint_violation: 400`, `aggregate_not_found: 404` |
| クエリごとに `GET <base>/<context>/queries/<query>?…`（§9） | クエリの入力のスキーマ（`<Query>InputSchema`）。クエリ文字列（モデルの snake_case の名前） | 1ページ（`<Query>PageJson`: `{ items, nextCursor }`） | `constraint_violation: 400`, `invalid_cursor: 400` |

- **JSON 形**: Aggregate を `JSON.stringify` したもの（公開フィールドだけ。Instant・LocalDate・ID は文字列、Decimal は文字列、Value Object はオブジェクト、Entity はフィールドのオブジェクト）。クライアントは `XJson`（Entity は `<Entity>Json`）で検証する。振る舞いを持たない読み取り用の形で、Invariant は評価しない（サーバーで保存できた状態だけが届く）。`z.object` なので未知のキーは捨てる（サーバーがフィールドを足しても古いクライアントが壊れない）。
- **識別子**: Aggregate の識別子は UUID・String・Integer（core の検証）。GET の `id` は識別子のスキーマ（制約付き）で検証する。不正な percent-encoding のパスはどのエンドポイントにも一致しない（404。ハンドラは例外を投げない）。
- **Use case の戻り値**: ドメインのスキーマで検証する（UUID は `uuidSchema`、Decimal は `decimalSchema()` で `Decimal` に戻る）。戻り値が Aggregate / Entity なら JSON 形。
- **エラーの一覧**（`errors`）は生成器がモデルから求める: `constraint_violation` 400、load の `not_found`（なければ `aggregate_not_found`）404、invoke する操作・create するファクトリの `require` のガードのエラー 409、`fail` のエラー・変更する Aggregate（と Entity）の Invariant・入力の Value Object の Invariant 422。同じコードは先に決まったステータスを使う。一覧にないコードは 422。クエリ（§9）があるコンテキストでは、保存する Use case に `concurrency_conflict` 409 が加わる（PostgreSQL のリポジトリの楽観ロック）。クライアントの復元は一覧に依存しない（コンテキストの全エラーを code で引く。クエリのあるコンテキストでは `InvalidCursor`・`ConcurrencyConflict` も）。

#### サーバー（`createApiHandler`）

- Web 標準の `Request` → `Response` なので、Bun.serve・Deno.serve・Hono（`c.req.raw`）・Next.js の route handler・Cloudflare Workers などでそのまま使える。`dependencies` はオブジェクトか、リクエストごとの関数（リクエストごとの UnitOfWork など）。
- **渡したものだけを公開する**: `ApiDependencies` のコンテキスト・Use case・リポジトリはすべて省略可能で、渡していない Use case / リポジトリのパスは 404。ポリシーから動かすシステム用の Use case（例 `register_staff`）は渡さなければ公開されない。`security` があれば `authorize: internal` の Use case にはそもそもエンドポイントがない。
- **認証・認可**: `security` を書かなければ生成しないので、ハンドラの前（ミドルウェア、ルーター）に置く。書けば、認証のフック・認可・レート制限を生成する（下の「認証・認可・レート制限」）。本文の大きさの制限と CORS はホスト側で行う。
- 入力は `parseWith(コマンドのスキーマ)` で検証し、Use case を呼び、結果を `JSON.stringify` で返す（Instant・Decimal はそのまま JSON になる）。

| 状況 | ステータス | 本文 |
|---|---|---|
| 本文が JSON でない・スキーマに合わない・ID の形が違う・実行中の制約違反（`ConstraintViolation`）・クエリ文字列に知らない名前や重複 | 400 | `{ code: "constraint_violation", message, details: { model, issues } }` |
| クエリのカーソルが不正（改ざん・期限切れ・別のパラメータ。`InvalidCursor`） | 400 | `{ code: "invalid_cursor", message, details: { reason } }` |
| load で見つからない（`not_found` のエラー / `AggregateNotFound`）、GET で見つからない | 404 | `{ code, message, details }` |
| 現在の状態では操作できない（`require` のガードのエラー） | 409 | 同上 |
| それ以外の Domain Error（`fail`、Invariant など） | 422 | 同上 |
| パスがない・Use case / リポジトリを渡していない | 404 | `{ code: "route_not_found", message }` |
| メソッドが違う | 405（`Allow` ヘッダー） | `{ code: "method_not_allowed", message }` |
| それ以外の例外（DB の障害など） | 500 | `{ code: "internal_error", message: "Internal server error" }`。内容は返さず `options.onError`（既定 `console.error`）に渡す |

`message` は利用者に見せてよい文（モデルの `message`）。`details` はルール名（`rule` / `guard`）・識別子・宣言した詳細フィールド・制約違反の `issues` だけで、スタックや内部の値は含まない。runtime は `details` を「内部の診断データ」としているが、4xx の Domain Error ではクライアントがフォームの指摘や分岐に使えるように返す（500 では返さない）。返したくない項目があるなら、ハンドラの前後で本文を加工する。

#### クライアント（`createApiClient`）

- `api.<context>.useCases.<useCase>(input, { signal })` と `api.<context>.aggregates.<aggregate>(id, { signal })`。入力はコマンドの入力型（`XInput`: フォームの値のまま）で、送る前にコマンドのスキーマで検証する（不正なら通信せずに `ConstraintViolation` で reject）。
- レスポンスは契約の出力スキーマで検証する。合わなければ `ApiError`（`code: "invalid_response"`、`details.issues`）。
- エラーのレスポンスは `code` からそのコンテキストの Domain Error のクラス（`InvitationNotFound` など、runtime の `ConstraintViolation` / `AggregateNotFound` を含む）を作って reject する。知らないコード・JSON でない本文・通信の失敗（`network_error`、status 0）は `ApiError`（`status`・`code`・`details`）。中断（`signal`）はそのまま投げ直すので、TanStack Query がキャンセルとして扱う。
- `baseUrl`（既定 `""` = ページと同じオリジン。サーバー・SSR・テストでは絶対 URL）、`fetch`（`(request: Request) => Promise<Response>`。テストでは生成したハンドラをそのまま渡せる）、`headers`（オブジェクトか、リクエストごとの関数）。

#### TanStack Query（`<context>/api/queries.ts`・`api/queries.ts`）

アプリは API クライアントとファクトリを1回だけ作り、同じ options をどこでも使う（コンポーネント・ルートの loader・SSR・テスト）。

```ts
export const api = createApiClient({ baseUrl: "" });
export const queries = createApiQueries(api);     // queries.<context>.<aggregate>
export const mutations = createApiMutations(api); // mutations.<context>.<useCase>

useQuery(queries.cleaningStaff.cleaningStaffInvitation.detail(id));
useSuspenseQuery(queries.cleaningStaff.cleaningStaffInvitation.detail(id));
useQuery({ ...queries.cleaningStaff.cleaningStaffInvitation.detail(id), select: (i) => i.status });
useQuery(queries.cleaningStaff.cleaningStaffInvitation.detailOrSkip(maybeId));
useMutation(mutations.cleaningStaff.acceptInvitation).mutate(input, { onSuccess: () => navigate(...) });
await queryClient.query({ ...queries.cleaningStaff.cleaningStaffInvitation.detail(id), staleTime: "static" }); // loader
```

- **クエリファクトリ**: Aggregate ごとに1つのオブジェクトに、無効化用のキーと `queryOptions` をまとめる。`create<Context>Queries(api)` が `{ <aggregate>: { all(), lists(), details(), detail(id), detailOrSkip(id) } }` を返す。`api` を引数に取るのは、SSR（リクエストごとの Cookie）とテスト（ハンドラにつなぐ `fetch`）で別のクライアントが要るため。リクエストごとに作るなら、ルーターの context などに `createApiQueries(api)` を入れる。`api` はキーに入れない（1つの QueryClient に1つの API クライアント）。
- **一覧のクエリ**（§9）: モデルのクエリは、読む Aggregate のファクトリに `infiniteQueryOptions` として入る（`queries.<context>.<aggregate>.<query>(params)`）。キーは `[{ scope, entity, kind: "list", query: "<query>", params }]` で `lists()` の下にあるので、その Aggregate を保存するミューテーションの無効化がそのまま当たる。`queryFn` は `({ queryKey: [{ params }], pageParam, signal })` でキーからパラメータを読み、`initialPageParam: null`、`getNextPageParam: (lastPage) => lastPage.nextCursor`（null で終わり）。`useInfiniteQuery` / `useSuspenseInfiniteQuery` / `queryClient.infiniteQuery(options)`（5.102 以上）で使う。
- **キー**: どれも「オブジェクトを1つだけ持つ配列」。`all()` = `[{ scope: "<context>", entity: "<aggregate>" }]`、`lists()` = `[{ …, kind: "list" }]`、`details()` = `[{ …, kind: "detail" }]`、`detail(id).queryKey` = `[{ …, kind: "detail", id }]`（kebab-case の文字列）。フィルタは名前で部分一致する（順序に依存しない）ので、`[{ scope: "cleaning-staff" }]` はそのコンテキストのすべて、`all()` はその Aggregate のすべて、`details()` はすべての detail、`detail(id).queryKey` はその ID だけに一致する。`detail(id)` は UUID の ID を小文字にする（スキーマと同じ正規化。`ABC…` と `abc…` が同じキャッシュになる）。String の識別子はそのまま、Integer の識別子は `number`（キーも引数も数値。パスの `:id` は数字の並びだけ数値として読む。契約の `idType: "number"`）。`lists()` はモデルのクエリ（§9）の接頭辞で、手で書く一覧クエリもその下に置ける（`[{ ...queries.x.y.lists()[0], filters }]`）。
- **query options**: `detail(id)` は `queryOptions({ queryKey, queryFn })`。`queryFn` は ID をキーから名前で取り出し（`({ queryKey: [{ id }], signal })`）、TanStack Query の `signal` を fetch に渡す。useQuery・useSuspenseQuery・`queryClient.query`・`getQueryData`（DataTag で型が付く）で使える。`detailOrSkip(id | undefined)` は id が undefined の間 `skipToken` で無効にする useQuery 用（useSuspenseQuery と `queryClient.query` の型は `skipToken` を受け付けないので、`detail` と分けた）。無効の間のキーは `id: undefined` で、ハッシュでは `details()` と同じになる（`details()` そのものはクエリにしないので衝突しない）。
- **設定できない**: ファクトリは引数に options を取らない。`select`・`staleTime`・`throwOnError` などは呼び出し側で `{ ...options, select }` と足すか、`QueryClient` の `defaultOptions` に書く。`onSuccess` などのクエリのコールバックは付けない。
- **mutation options**: `create<Context>Mutations(api)` が `{ <useCase>: mutationOptions({ mutationKey: [{ scope: "<context>", useCase: "<use-case>" }], mutationFn, onSuccess }) }` を返す。`onSuccess` は同じクエリファクトリのキーで無効化し、その Promise を返すので、ミューテーションは active なクエリの再取得が終わるまで pending のまま。`mutationKey` もオブジェクトなので `useIsMutating({ mutationKey: [{ scope: "cleaning-staff" }] })` で絞れる。
- **無効化の規則**（モデルから決める。保存しない Aggregate は対象外）:

| Use case の手順 | 無効化するキー |
|---|---|
| `load` した Aggregate を `save`（`by` が必須の入力のフィールド） | `queries.<aggregate>.detail(input.<field>).queryKey` と `lists()` |
| `load` した Aggregate を `save`（`by` が計算した値か省略可能な入力） | `queries.<aggregate>.details()` と `lists()` |
| `create` した Aggregate を `save` | `queries.<aggregate>.lists()`（新しい ID の detail はまだキャッシュにない） |
| 保存しない | なし（`onSuccess` を付けない） |

  `setQueryData` で結果を書き込むことはしない（Use case の戻り値は多くが ID や真偽値で、Aggregate の新しい状態ではない）。楽観的更新も生成しない。ポリシーがコミット後に別のコンテキストを変える影響（例: 招待の受諾 → Staffing がスタッフを登録）は結果整合なので無効化しない。必要ならアプリが `mutate(input, { onSuccess })` で無効化する。
- **フックは生成しない**: `useQuery(queries.x.y.detail(id))`・`useMutation(mutations.x.y)` と、TanStack Query のフックに生成した options をそのまま渡す。フックはコンポーネントの中でしか使えず、`useQuery` / `useSuspenseQuery` の選択を固定し、設定を共有するだけでロジックを足さないため（docs/09 §18）。UI の反応は `mutate(input, { onSuccess })` に書き、`useMutation` の `onSuccess` を上書きしない（無効化が消える）。
- **ルーター（TanStack Router など）**: loader は同じ options でキャッシュを満たすだけにし、コンポーネントは useSuspenseQuery / useQuery で購読する（observer をコンポーネントに置くので、フォーカス時の再取得や GC が働く）。TanStack Query 5.104 で `ensureQueryData` / `fetchQuery` は非推奨になったので、loader は `queryClient.query({ ...options, staleTime: "static" })`（`ensureQueryData` と同じく、キャッシュにあれば取得しない）か `queryClient.query(options)` を使う。それより前の版では `ensureQueryData(options)`。
- **QueryClient はアプリが作る**（`QueryClientProvider`）。`register.ts` をアプリのプログラムに含める（このパッケージの `tsconfig` の対象なら自動で、別のパッケージからは `import "<package>/generated/api/register.js"`）と、`error` の型が `DomainError | ApiError` になる。

#### 生成テスト（`tests/generated/<context>-api.test.ts`）

DOM もネットワークも使わない。クライアントの `fetch` を生成したハンドラにつなぎ（`connect()`）、`QueryClient`（再試行なし）と生成したインメモリのテストダブルで動かす。

- ルーティング: 未知のパスと渡していない Use case は 404、メソッド違いは 405（`Allow`）、不正な ID は 400、JSON でない本文は 400、予期しない例外は 500（メッセージを返さず `onError` に渡る）。
- アプリと同じく `createApiQueries(api)` / `createApiMutations(api)` を1回作り、`queries.<context>.<aggregate>` を使う。
- Aggregate ごと: `queryClient.query(queries.<context>.<aggregate>.detail(id))` のキー（`[{ scope, entity, kind: "detail", id }]`、ID の小文字化を含む）、取得したデータが保存した Aggregate の JSON と同じこと、未知の ID が `AggregateNotFound`（404）で reject され、クエリの `error` がそのインスタンスであること。
- Aggregate ごと: オブジェクトのキーの部分一致。`detail(id).queryKey` の無効化はその ID だけ、`details()` はすべての detail（一覧は除く）、`all()` は一覧も含むすべてに当たり、別の `scope` の同じ Aggregate・ID には当たらないこと。
- クエリごと: シナリオのデータをインメモリのリーダーに入れ、`infiniteQueryOptions` のキー（`lists()` の下）、`queryClient.infiniteQuery` で `nextCursor` をたどって読んだ全ページが1回で読んだ結果と同じこと、`lists()` の無効化が当たること、不正なカーソル（400 `invalid_cursor`）と知らないクエリパラメータ（400）を確かめる。
- Use case ごと（成功するシナリオと失敗するシナリオを1つずつ）: シナリオの前提をテストダブルに入れ、保存済みの Aggregate を `queryClient.query` で取得し、一覧とほかの ID の detail のプローブを置いてから `new MutationObserver(queryClient, mutations.<context>.<useCase>).mutate(input)`。戻り値・ステータス（200 / 204、失敗はエラーの一覧のステータス）・`observer.getCurrentResult().error` が復元した Domain Error であること、無効化されたキーがちょうど上の規則どおりであること（失敗時は何も無効化しない）、再取得したデータが保存された状態と同じことを確かめる。

#### 移行メモ（2026-10-04、HTTP API）

- 既存の TypeScript プロジェクトは何も変わらない（`typescript.api` を書いたときだけ生成する）。
- `typescript.api` を足したら、顧客所有の `package.json` は書き換えられないので手で依存を足す: dependencies に `"@tanstack/react-query": "^5.102.0"` と `"react": "^19.0.0"`、devDependencies に `"@types/react": "^19.0.0"`（`bun add @tanstack/react-query react && bun add -d @types/react`）。ライブラリとして配布するなら `react` は peerDependencies に移す。TanStack Query は 5.102 以上が必要（`mutationOptions` 5.82、ミューテーションのコールバックの `context.client` 5.89、`queryClient.query` 5.102）。
- 生成した API のファイルは `tsconfig.json` の `include` の中にあるので、そのまま型検査とテストの対象になる。`lib` に DOM は要らない（`fetch` / `Request` / `Response` は `@types/node` か `bun-types` の型を使う）。
- `ddd diff` は `api` を外したとき、生成した API のファイルを stale として表示する（`--prune` で消す）。

#### 移行メモ（2026-10-06、TanStack Query のファクトリを TkDodo の最近の記事に合わせた。破壊的変更）

`typescript.api` を使っているプロジェクトだけが対象（理由は docs/09 §18）。`ddd diff` は次の変更を破壊的変更（`module removed` など）として表示する。

- **フックを削除**: `use<Aggregate>(id)` と `use<UseCase>()`（`api/<context>/hooks.ts`）、`ApiClientContext` / `useApiClient`（`api/react.ts`）はなくなった。`use<Aggregate>(id)` → `useQuery(queries.<context>.<aggregate>.detailOrSkip(id))`（id が必ずあるなら `detail(id)`）、`use<UseCase>()` → `useMutation(mutations.<context>.<useCase>)`。`<ApiClientContext value={api}>` は不要になり、`export const queries = createApiQueries(api)` をモジュールかルーターの context に置く。
- **ファクトリの名前と形**: `<aggregate>Keys` と `<aggregate>Queries` は `create<Context>Queries(api).<aggregate>` の1つのオブジェクトになった（`<aggregate>Queries.detail(api, id)` → `queries.<context>.<aggregate>.detail(id)`、`<aggregate>Keys.lists()` → `queries.<context>.<aggregate>.lists()`、`<aggregate>Keys.detail(id)` → `queries.<context>.<aggregate>.detail(id).queryKey`、`<aggregate>Keys.all` → `all()`（関数））。`<context>Mutations.<useCase>(api)` → `create<Context>Mutations(api).<useCase>`（関数ではなく options）。全体は `createApiQueries(api)` / `createApiMutations(api)`。
- **キーがオブジェクトに**: `["cleaning-staff", "cleaning-staff-invitation", "detail", id]` → `[{ scope: "cleaning-staff", entity: "cleaning-staff-invitation", kind: "detail", id }]`。`mutationKey` も `[{ scope, useCase }]`。手で書いた配列のキー（`[...xKeys.lists(), filters]` など）は `[{ ...queries.x.y.lists()[0], filters }]` に直す。永続化したキャッシュ（`persistQueryClient` など）は古いキーのエントリーを使わなくなるので、`buster` を変えて捨てる。
- **ファイルの移動**: `generated/api/<context>/contract.ts` → `generated/<context>/api/contract.ts`、`generated/api/<context>/queries.ts` → `generated/<context>/api/queries.ts`。`generated/api/queries.ts` が増えた。`generated/api/{runtime,contract,server,client,register}.ts` はそのまま。
- **古いファイル**: `ddd generate` は古い `generated/api/<context>/{contract,queries,hooks}.ts` と `generated/api/react.ts` を stale として残す（手を入れていなければ古いファイル同士の import は解決するので、そのままでも型検査は通る）。新しい API に書き換えたら `ddd generate --prune` で消す。
- **依存は同じ**: `@tanstack/react-query` ^5.102、`react`、`@types/react`。生成コードは React の API を呼ばないが、`@tanstack/react-query` が React を peer に要る。

### 認証・認可・レート制限（`security`, 2026-10-06）

モデルに `security` を書いたときだけ生成する（DSL は docs/10 §11、決定と出典は docs/09 §20）。書かなければ、Python・TypeScript・HTTP API のどの生成物も以前とバイト単位で同じ。

```text
# 両方の target
src/<package>/generated/security.(py|ts)                       # Role、Principal、NotAuthorized / Unauthenticated、authorize / allow_if、(bearer_jwt) クレーム → Principal
src/<package>/generated/<context>/application/read_access.py   # read-access.ts: authorize が principal を要る Aggregate の read_<aggregate>(repository, id, principal)
tests/generated/...                                             # シナリオの principal、導出した認可のテスト

# Python
src/<package>/generated/rate_limit.py                           # RateLimit・take_token・RateLimitStore・InMemoryRateLimitStore・RateLimiter・rate_limit_headers（標準ライブラリだけ）
src/<package>/generated/authentication.py                       # scheme: bearer_jwt のとき。PyJWT の BearerJwtAuthenticator
tests/generated/test_security.py

# TypeScript の HTTP API（typescript.api があるとき）
src/<package>/generated/api/rate-limit.ts                       # トークンバケット・RateLimitStore・InMemoryRateLimitStore・RateLimiter・rateLimitHeaders（依存なし）
src/<package>/generated/api/authentication.ts                   # scheme: bearer_jwt のとき。jose の createBearerJwtAuthenticator
tests/generated/security.test.ts
```

#### アプリケーション層の契約（両方の target）

- **Principal**: `id`（`security.principal.id` の型）、`roles`（宣言したロールの読み取り専用のリスト）、宣言したクレーム（省略可能なものは `null` が既定）。TypeScript は Zod のスキーマから作る型と `Principal.create(input)` / `Principal.parse(json)`、Python は凍結した Pydantic モデル `Principal(id=..., roles=(...))`。
- **`execute(command, principal)`**: `authorize` が `authenticated` か `{ roles, allow_if }` の Use case は、2つ目の引数に `Principal | null`（Python は `Principal | None`）を取る。`public` と `internal` の Use case は今までどおり `execute(command)`。コンテキストオブジェクトではなく引数1つにしたのは、Use case が読むのは principal だけで、型で「渡し忘れ」を防げるため。
- **順序**（迂回できない。生成コードに認可より前に手順を動かす経路はない）:
  1. `authorize(principal, "<use case>", roles)`: principal がなければ `Unauthenticated`、ロールのどれも持たなければ `NotAuthorized`。`execute` の最初の文で、冪等性の記録の参照・トランザクション・どの `load` よりも前（データがあるかどうかを漏らさない）。
  2. `allow_if` が入力だけを読むなら、その直後に `allow_if(<式>, "<use case>")`。
  3. `allow_if` が `load` した Aggregate を読むなら、それが使う最後の先頭の `load` の直後、最初の変更（`create` / `invoke`）の前。DSL がそれより後の変数を使わせない（docs/10 §11）。
- **冪等性**: principal が要る Use case の冪等性キーは principal ごと（`"<principal.id>:<key>"`）。認可は記録の参照より前なので、別の principal が同じキーで記録した結果を受け取ることはない。
- **エラー**: `NotAuthorized`（コード `not_authorized`）の `details` は `{ action, requiredRoles }`（Python は `required_roles`）か `{ action, rule: "allow_if" }`。比べた値は入れない。`Unauthenticated`（`unauthenticated`）の `details` は `{ action }`、認証器が拒否したトークンなら `{ error: "invalid_token" }`。どちらも Domain Error なので、既存のエラー処理（`ALL_ERRORS` とは別の `SECURITY_ERRORS`）で扱える。
- **読み取り**: `authorize` が principal を要る Aggregate は、`read_<aggregate>(repository, id, principal)` / `read<Aggregate>(repository, id, principal)` を生成する。ロールを確かめてから読み込み、見つかれば `allow_if` を確かめる。`public` の Aggregate は生成しない（リポジトリをそのまま読む）。
- **テストダブル**: 既存のインメモリのダブルはそのまま。生成テストは `Principal.create(...)` / `Principal(...)` を作って渡す。

#### HTTP API（TypeScript、`typescript.api`）

- **契約**: エンドポイントごとに `auth`（`{ kind: "public" }` か `{ kind: "principal", roles }`）と `rateLimit`（`{ name, requests, windowSeconds, by }` か `null`）を持つ。principal が要るエンドポイントの `errors` に `unauthenticated: 401` と `not_authorized: 403` が入る。`internal` の Use case はエンドポイントを持たない（契約・サーバー・クライアント・mutations のどれにも出ない）。
- **サーバー**: `createApiHandler(dependencies, { authenticate, rateLimiter, clientIp, onError })`。
  - `authenticate: Authenticator<Principal>`（`(request) => Promise<Principal | null>`）。資格情報がなければ `null`、不正なら `Unauthenticated`（`details.error: "invalid_token"`）を投げる。`scheme: bearer_jwt` なら生成した `createBearerJwtAuthenticator({ jwksUrl | key | getKey, issuer?, audience?, clockTolerance? })` を渡す。`scheme: custom`（セッションの Cookie や API キーなど）は自分で書く。渡さなければ principal が要るエンドポイントはすべて 401。
  - 1リクエストの流れ: ルートの照合 → `by: ip` / `global` のレート制限（認証より前なので、認証器と JWKS の取得も守る）→ principal が要るなら認証（なければ 401）→ `by: principal` のレート制限 → Use case / 読み取りのアクセス（ここで認可。403）→ レスポンスに RateLimit ヘッダーを付ける。`public` のエンドポイントは認証しない（`by: principal` の既定は IP ごとに数える）。
  - `rateLimiter`（既定はハンドラごとのインメモリ）、`clientIp`（既定は不明で、`by: ip` のリクエストはすべて同じバケットを使う。`X-Forwarded-For` は既定では読まない。信頼できるプロキシが上書きするときだけ読む。Bun なら `(r) => server.requestIP(r)?.address`）。
- **JWT の検証**（`api/authentication.ts`、RFC 8725）: jose の `jwtVerify` に、モデルの `algorithms` だけ（`none` は宣言できない）、`issuer`・`audience`、`clockTolerance`、必須のクレーム `exp`・`sub` を渡す。鍵は JWKS の URL（jose がキャッシュと更新をする）、1つの鍵（公開鍵の `CryptoKey`、HS* なら秘密のバイト列）、自前の鍵の取得関数のどれか。`sub` が `id`、`roles_claim` がロール（宣言していないロールは捨てる）、宣言したクレームが値になり、Principal のスキーマに合わなければ不正なトークン。JWKS が取得できないのは呼び出し側の誤りではないので 500。
- **エラーの対応**（docs/05 §8 の表に足す）:

| 状況 | ステータス | ヘッダー | 本文 |
|---|---|---|---|
| principal が要るエンドポイントに資格情報がない | 401 | `WWW-Authenticate: Bearer` | `{ code: "unauthenticated", message }` |
| トークンが不正（署名・期限・iss・aud・アルゴリズム・クレーム） | 401 | `WWW-Authenticate: Bearer error="invalid_token"`（RFC 6750 §3.1） | `{ code: "unauthenticated", message, details: { error: "invalid_token" } }` |
| ロールがない・`allow_if` が成り立たない（`NotAuthorized`） | 403 | | `{ code: "not_authorized", message, details }` |
| レート制限を使い切った | 429（RFC 6585） | `Retry-After`（秒、RFC 9110 §10.2.3）、`RateLimit-Policy`、`RateLimit` | `{ code: "rate_limited", message, details: { retryAfter } }` |
| 制限のあるエンドポイントのそのほかの応答 | | `RateLimit-Policy: "<name>";q=<requests>;w=<秒>`、`RateLimit: "<name>";r=<残り>;t=<秒>`（IETF draft-ietf-httpapi-ratelimit-headers） | |

  `<name>` は Use case 名か `read_<aggregate>`。`t` は許可なら満杯に戻るまで、拒否なら次のトークンまでの秒数（`Retry-After` と同じ）。
- **トークンバケット**: 容量 `requests`、`windowSeconds` の間に均等に補充。キーは `<policy>\0<by>\0<principal id | IP | *>`。`takeToken(state, policy, now)` は純粋関数なので、ストアの実装はそれを原子的に実行すればよい。`RateLimitStore.consume(key, policy, now)` はキーごとに原子的でなければならない（2つのリクエストが最後の1つを取らない）。生成した `InMemoryRateLimitStore` は1プロセス用（満杯のバケットは `maxKeys` を超えたら捨てる）。複数のインスタンスでは共有のストアを実装する: Redis / Upstash なら、`{ tokens, updatedAt }` を1つのキーに保存し、`takeToken` と同じ計算を Lua スクリプト（`EVAL`）で行い、`PEXPIRE` を `windowSeconds` にする（Upstash の `@upstash/ratelimit` の token bucket もこの形）。Cloudflare なら Durable Object の中で `takeToken` を呼ぶ。
- **クライアント**: `createApiClient({ getToken })` は、リクエストのたびに `getToken()` を呼んで `Authorization: Bearer <token>` を付ける（更新したトークンがすぐ使われる。`null` / `undefined` なら付けない）。401 は `Unauthenticated`、403 は `NotAuthorized`（どちらも `code` から復元する Domain Error）、429 は `RateLimitedError`（`ApiError` のサブクラス、`retryAfter` は秒か `undefined`）で reject する。
- **再試行の方針**（生成した options には入れない。TkDodo のとおりアプリの `QueryClient` の既定に書く）:

```ts
import { apiRetry, apiRetryDelay } from "./generated/api/runtime.js";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: apiRetry, retryDelay: apiRetryDelay } } });
```

  `apiRetry` は最大3回、通信の失敗・5xx・429 だけを再試行し、ほかの 4xx（Domain Error・401・403・404）はしない。`apiRetryDelay` は 429 なら `Retry-After`（最大60秒）、それ以外は TanStack Query と同じ指数バックオフ（1秒・2秒・4秒…最大30秒）。ミューテーションは TanStack Query の既定（再試行なし）のまま。

#### Python（HTTP 層は生成しない）

- 認可はアプリケーション層なので TypeScript と同じ（`execute(command, principal)`、`read_<aggregate>`）。
- `authentication.py` の `BearerJwtAuthenticator(key=... | jwks_url=..., issuer=None, audience=None, leeway=...)` は PyJWT で検証する（`algorithms` はモデルのものだけ、`require: exp, sub, iss, aud`、`leeway`）。`authenticate(authorization_header)` は principal か `None` を返し、不正なトークンは `Unauthenticated(error="invalid_token")`。依存に `pyjwt[crypto]`（RS256 / ES256 / EdDSA は cryptography が要る）を足す。
- `rate_limit.py` の `RateLimiter(store, clock)` と `security.RATE_LIMITS`（エンドポイント名 → `RateLimit`）。

FastAPI の例（Starlette でも同じ考え方）:

```python
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from cleaning_platform.generated.authentication import BearerJwtAuthenticator
from cleaning_platform.generated.rate_limit import RateLimiter, rate_limit_headers
from cleaning_platform.generated.cleaning_staff.domain.commands import AcceptInvitation
from cleaning_platform.generated.security import RATE_LIMITS, NotAuthorized, Principal, Unauthenticated

authenticator = BearerJwtAuthenticator(jwks_url="https://auth.example.com/.well-known/jwks.json")
limiter = RateLimiter()  # 複数プロセスなら Redis などの RateLimitStore を渡す
app = FastAPI()

def principal(authorization: str | None = Header(default=None)) -> Principal | None:
    return authenticator.authenticate(authorization)

def limited(name: str):
    def check(request: Request, response: Response, who: Principal | None = Depends(principal)) -> None:
        limit = RATE_LIMITS[name]
        if limit.by == "principal" and who is not None:
            subject = str(who.id)
        elif limit.by == "global":
            subject = "*"
        else:  # ip、または principal のない公開エンドポイント（プロキシの裏では信頼できるヘッダーから）
            subject = request.client.host if request.client else "unknown"
        decision = limiter.consume(limit, subject)
        headers = rate_limit_headers(limit, decision)
        response.headers.update(headers)
        if not decision.allowed:
            raise HTTPException(429, "Too many requests", headers=headers)
    return check

@app.exception_handler(Unauthenticated)
def unauthenticated(_: Request, error: Unauthenticated) -> Response:
    challenge = 'Bearer error="invalid_token"' if error.details.get("error") == "invalid_token" else "Bearer"
    return Response(status_code=401, headers={"WWW-Authenticate": challenge})

@app.exception_handler(NotAuthorized)
def not_authorized(_: Request, error: NotAuthorized) -> Response:
    return Response(status_code=403)

@app.post("/api/cleaning-staff/accept-invitation", dependencies=[Depends(limited("accept_invitation"))])
def accept(command: AcceptInvitation, who: Principal | None = Depends(principal)) -> None:
    accept_invitation_use_case().execute(command, who)  # Use case の組み立て（リポジトリ・UnitOfWork）はアプリのもの
```

#### 移行メモ（2026-10-06、`security`）

- `security` を書かないプロジェクトは何も変わらない。
- 書くと、すべての Use case と Aggregate に `authorize` が要る（`ddd validate` が示す）。principal が要る Use case の `execute` に引数が増える（`ddd diff` は破壊的変更として表示する）。呼び出し側（ハンドラ、ジョブ、手書きのテスト）は principal を渡す。ポリシーが動かす Use case は `authorize: internal`。
- TypeScript の HTTP API で `scheme: bearer_jwt` なら、顧客所有の `package.json` に `"jose": "^6.1.0"` を手で足す（新しいプロジェクトの scaffold には入る）。Python で `bearer_jwt` なら `pyjwt[crypto]>=2.8` を足す（例の `pyproject.toml` を参照）。
- `internal` にした Use case はエンドポイントがなくなる（`mutations.<context>.<useCase>` も消える）。

### 移行メモ（2026-10-03、ベストプラクティスの見直し）

docs/09 §16 の見直しで生成 API が変わった。`ddd diff` は次の変更を「破壊的変更」として表示する（引数の追加のように互換性がある変更も、シグネチャの変化として表示される）。

- **イベント**: `X.is` はメソッドからアロー関数のプロパティになった（呼び方は同じ。分離して渡しても安全）。`<Event>Payload` 定数はなくなり、`X.schema`（`type` を含む strict スキーマ）と `X.parse` を使う。`<Event>Input` は `Omit<z.input<typeof <Event>Schema>, "type">`（形は以前と同じ）。新しく `<Ctx>EventSchema` と `parse<Ctx>Event` を出す。
- **エラー**: すべての Domain Error（`DomainError`・`ConstraintViolation`・`AggregateNotFound`・生成したエラー）のコンストラクタに省略可能な第3引数 `options?: ErrorOptions`（`cause`）が付いた。既存の呼び出しはそのまま動く。サブクラスを手書きしている場合は `super(details, message, options)` に揃える。`ConstraintIssue` に `code`（Zod の issue code）が増え、`ConstraintViolation.cause` は ZodError。
- **Extension point のないコンテキスト**: 空の `Extensions` インターフェースと空の `StubExtensions` を出さなくなった。import している手書きコードは削除する。
- **`RULES`**: `ReadonlyArray<Rule>` 型の注釈から `as const satisfies ReadonlyArray<Rule>` になった（各要素がリテラル型の読み取り専用タプル。`ReadonlyArray<Rule>` にはそのまま代入できる）。
- **runtime**: `dateTimeSchema` は入力の `Date` を複製する（同じオブジェクトではなくなる。下の「DateTime を Instant に」でさらに変わった）。`idSchema(owner)` のスキーマに説明文が付いた。`EventType<E, I>` に `schema`・`create`・`parse` が増え、`is` はプロパティになった。
- **生成テスト**: インメモリのダブルを `await` しない。`viaJson` と `plain` で JSON 往復を確かめる行が増えた。
- **scaffold**（既存のプロジェクトには書き込まれない）: 新しいプロジェクトには `.prettierrc.json`（`{ "printWidth": 100 }`）を作り、`tsconfig.json` に `noUnusedParameters`・`noImplicitReturns`・`erasableSyntaxOnly` を入れる。既存のプロジェクトで Prettier を使うなら `.prettierrc.json` を手で足す（Prettier の既定は80桁なので、無いと生成物が整形し直される）。extensions の scaffold のメソッドは引数を取らない。
- **検証**: TypeScript target では、型名 `Omit`・`ErrorOptions`、`<Event>Schema`・`<Ctx>EventSchema` と同じ名前の型、`type` という名前のイベントフィールドが `reserved-name` になった（生成コードがその名前を使うため）。


### 移行メモ（2026-10-03、DateTime を Instant に）

DSL の `DateTime` は JavaScript の `Date` ではなく、不変の `Instant`（UTC に正規化したミリ秒付きの ISO 8601 文字列 `"2026-01-08T10:00:00.000Z"` のブランド付き文字列）になった。理由は docs/09 §17。`ddd diff` は該当するシグネチャをすべて破壊的変更として表示する。

- **フィールド・引数・戻り値**: Aggregate / Entity / Value Object のフィールド、コマンド・イベント、操作・ファクトリの引数、Use case の戻り値で `Date` だった型が `Instant` になった。入力（`X.from` / `X.create`）は従来どおりオフセット付きの ISO 文字列か `Date` を受け付けるので、組み立てるコードはそのまま動く。読み出した値は文字列なので `.getTime()`・`.toISOString()` などの `Date` のメソッドは使えない。
- **比較**: `a.getTime() < b.getTime()` は `a < b`、等しさは `a === b` でよい（正規化してあるので文字列の順が時刻の順）。runtime の `equals` も `Date` を特別に扱わなくなった。
- **相互運用**: `Date` が要るところ（表示の書式、日付ライブラリ）は `toDate(i)` で新しい `Date` を作る（変更しても元の値に影響しない）。文字列から作るときは `instant("2026-01-08T19:00:00+09:00")`、現在時刻は `nowInstant()`。
- **ORM / Repository のアダプタ**: DB ドライバが返す `Date` や文字列は、リポジトリの境界で `InstantSchema`（またはそれを使う `X.from`）を通して `Instant` にする。書き込みは `Instant` の文字列をそのまま渡すか、`timestamptz` などの列型が `Date` を求めるなら `toDate(i)` を渡す。JSON の列やドキュメントストアには文字列のまま保存でき、Entity のフィールドを持たない Aggregate は `X.from(JSON.parse(json))` で戻せる。
- **ポートとテストダブル**: `Clock.now()` は `Instant` を返す。`SystemClock` は `nowInstant()`。`FixedClock` はオフセット付きの文字列か `Date` を受け取る（`new FixedClock("2026-01-01T10:00:00+00:00")`）。手書きの `Clock` は `instant(new Date())` などを返すように直す。
- **runtime の名前**: `dateTimeSchema` → `InstantSchema`、`dateTime()` → `instant()`、`localDateSchema` → `LocalDateSchema`、`plusDuration` / `minusDuration` → `addDuration` / `subtractDuration`、`plusDays` / `minusDays` → `addDays` / `subtractDays`。`earliest` / `latest` / `durationBetween` / `daysBetween` は `Instant` / `LocalDate` を受け取る。`uuidSchema` / `idSchema` / `decimalSchema` は変えていない。入力の `Date` を複製する処理と、「Aggregate が返す `Date` は可変」という既知の制限はなくなった。新しく `InstantInput`（入力の型）、testing の `jsonOf` / `aggregateViaJson`。
- **範囲と精度**: 年は UTC で 0001〜9999（Python の `datetime` と同じ範囲。外れると `ConstraintViolation`）。精度はミリ秒で、それより細かい桁は切り捨てる（以前の `Date` と同じ）。オフセットは保存しない（以前の `Date` も保存していなかった）。
- **検証**: TypeScript target では型名 `Instant`・`InstantSchema`・`LocalDateSchema` が `reserved-name` になった。

## 9. 読み取り（クエリ）と永続化（PostgreSQL, 2026-10-06）

DSL は docs/10 §10、決定と出典は docs/09 §19。**クエリを宣言したコンテキストだけ**が対象で、クエリのないモデルの生成物はバイト単位で以前と同じ（生成器のテストで確かめる）。両 target で同じ意味論を生成し、SQL は共通の生成器（`packages/generator/src/sql.ts`）が作る（Python はプレースホルダを psycopg の形にしただけの同じ文）。

### 生成物

```text
sql/<context>.sql                                   # 望ましいスキーマ（両 target で同じ内容）
# TypeScript
src/<package>/generated/persistence.ts              # モデルに依存しない部分: SqlClient、InvalidCursor / ConcurrencyConflict、
                                                    # HmacCursorCodec、指紋、runQuery、pg_trgm の similarity、readRows / readSql、PostgresStore
src/<package>/generated/<context>/application/queries.ts   # <Query>InputSchema・<Query>Params・<Query>ItemSchema・<Query>Page、
                                                    # <QUERY>_SPEC、<Query>Reader（ポート）、<Query>Query（execute）
src/<package>/generated/<context>/persistence/rows.ts      # Aggregate ↔ 行（読み込みで検証）、jsonb の JSON 形、<query>ItemFromRow
src/<package>/generated/<context>/persistence/postgres.ts  # <AGG>_TABLE と Postgres<Agg>Repository、<QUERY>_SQL と Postgres<Query>Reader
src/<package>/generated/<context>/testing.ts        # InMemory<Query>Reader が加わる
src/<package>/generated/api/query-runtime.ts        # API があるとき: GET のエンドポイント・ルート・クライアント
tests/generated/<context>-<query>.test.ts, <context>-persistence.test.ts
# Python
src/<package>/generated/_persistence.py             # 同上（SqlConnection は psycopg 3 の同期 Connection 互換）
src/<package>/generated/<context>/application/queries.py
src/<package>/generated/<context>/persistence/{__init__,rows,postgres}.py
tests/generated/test_<context>_<query>.py, test_<context>_persistence.py
```

コンテキストの `index.ts` は `application/queries.ts` を再 export する（アプリケーション層）。永続化のアダプタ（`persistence/`）と `persistence.ts` は再 export しない（テストダブルと同じく直接 import する）。

### 読み取りの契約

- **Query（アプリケーションサービス）**: `new <Query>Query({ reader, cursors })`、`execute(input)`（Python は `<Query>Query(reader=..., cursors=...)`、`execute(<Query>Input(...))`）。入力をスキーマで検証し（`ConstraintViolation`）、検索テキストの前後の空白を除き（空なら検索しない）、`limit` を既定値と上限で決め、カーソルを検証・復号して、リーダーを呼び、次のページのカーソルを作る。戻り値は `Page<Item>`（`{ items, nextCursor }` / Python `Page(items, next_cursor)`）。
- **リーダー（ポート）**: `read(request): Awaitable<QueryResult<Item>>`。`request` は `{ params, search, after, limit }`（`after` は前のページの最後の行のキー、`limit` は確定した大きさ）。結果は `{ items, last }`（`last` は次のページがあるときだけ、最後の項目のキー）。リーダーは `limit + 1` 行読んで次があるかを知る。実装は `Postgres<Query>Reader(client)` と `InMemory<Query>Reader(repository)`。
- **項目**: `returns` のフィールドの検証済みの値（`<Query>ItemSchema` / `<Query>Item` の Pydantic モデル）。行から作るときに Value Object・Enum・制約を検証する。
- **指紋**: クエリ名・有効な並び順・検索テキスト・null でないパラメータ（名前順、正規の文字列）の正規 JSON の SHA-256（22 文字）。`limit` は含めない。

### カーソル（トークン）の形式と安全性

`base64url(JSON {"v":1,"keys":[...],"fp":"...","exp"?:n}) + "." + base64url(HMAC-SHA256(secret, その base64url))`。

- **不透明**: クライアントは中身を解釈せず、`nextCursor` をそのまま `cursor` に渡す。キーは読める（暗号化はしない）ので、並び順のキーに秘密を置かない。
- **完全性**: 署名を定数時間で比べ（`timingSafeEqual` / `hmac.compare_digest`）、合わなければ `InvalidCursor`（`details.reason`: `malformed` / `signature` / `expired` / `mismatch`）。指紋が違えば（別のパラメータ・検索テキスト・並び順）`mismatch`、キーの数が違っても `mismatch`。長さは 4096 文字まで。
- **秘密**: 32 文字以上。`secrets[0]` で署名し、どれでも検証する。ローテーションは新しい秘密を先頭に足し、古いカーソルが使われなくなったら古い秘密を外す。`ttlSeconds` で期限（`exp`、秒）を付けられる（既定はなし）。
- **範囲**: 発行した実装の中でだけ有効（TypeScript と Python で指紋の正規化が違う）。キーセットの値は DB の値なので、行が消えたり変わったりしてもカーソルは壊れない（その位置の後ろから読む）。

### SQL と実行の規約

- プレースホルダはすべて明示的なキャスト付き（`$1::uuid`、Python は `%(p1)s::uuid`、リテラルの `%` は `%%`）。node-postgres・PGlite・psycopg のどれでも型推論に頼らない。
- 文字列の並びは `COLLATE "C"`（コードポイント順）。ORDER BY・キーセットの条件・インデックスで同じにする。ORDER BY の列はテーブル名で修飾する（素の名前は SELECT の出力列 — `to_char(created_at …) AS created_at` — を指してしまう）。
- SELECT はドライバに依存しない形: 日時は UTC の ISO 8601（マイクロ秒）、日付は `YYYY-MM-DD`、numeric は text、キーは `_k0`, `_k1`… の text（スコアは `float8` の text で float4 の値をそのまま往復させ、次のページでは `$n::real` に戻す）。
- キーセット: 向きがそろえば行値の比較 `(a, b, id) < ($1, $2, $3)`（btree が1回のシークで使える）、混ざれば `(a > $1) OR (a = $1 AND b < $2) OR …`。OFFSET は使わない。
- 省略可能なパラメータは `($n::t IS NULL OR 列 = $n::t)`。検索あり・なし × 最初・次のページで4つの文に分ける（検索の条件が `IS NULL OR` の中に入らないので、パラメータの値が分かる計画でも汎用の計画でも trigram のインデックスを使える）。
- trigram の検索: `CROSS JOIN LATERAL (SELECT GREATEST(similarity(lower(c1), lower($q)), …) AS _score) AS _s` でスコアを1回だけ計算し、`(lower(c1) % lower($q) OR …)`（GIN で絞る）と `_s._score >= min_similarity`（決め手）で絞る。`%` は `pg_trgm.similarity_threshold`（既定 0.3）以上を通すので、`min_similarity` が 0.3 未満なら `%` を出さない（出すと行を取りこぼす）。
- **psycopg の注意**: psycopg 3 は同じ文を5回実行すると準備済みの文にし、PostgreSQL は汎用の計画を選ぶことがある。`IS NULL OR` のフィルタは汎用の計画でインデックスを使いにくい。大きなテーブルでは `prepare_threshold=None` か、フィルタの組み合わせごとのクエリに分けることを検討する。

### 永続化の契約

- **SqlClient / SqlConnection**: TypeScript は `{ query(text, values): Promise<{ rows }> }`（node-postgres の `Pool` / `Client`、PGlite がそのまま入る）。Python は `execute(query, params) -> cursor`（`description` と `fetchall()`。psycopg 3 の同期 `Connection`。行はタプルでも dict でもよい）。トランザクションはアプリが接続の上で管理する（Use case の `UnitOfWork` を接続の `commit` / `rollback` で実装する）。
- **リポジトリ**: `Postgres<Agg>Repository(client)` が生成したポート（`get` / `save`）を実装する。`get` は検証して Aggregate を作る（`X.from` / `model_validate`）。
- **楽観ロック**: Aggregate は不変のまま、リポジトリ（`PostgresStore`）が読み込んだ・保存した Aggregate の `version` を識別子ごとに覚える。読み込んでいない Aggregate の保存は `INSERT … ON CONFLICT (id) DO NOTHING RETURNING version`（version 1）、読み込んだものは `UPDATE … SET …, version = version + 1 WHERE id = … AND version = <読んだ版> RETURNING version`。行が返らなければ `ConcurrencyConflict`（HTTP 409）。`RETURNING` で判定するので、ドライバの `rowCount` に依存しない。**リポジトリは作業単位（リクエスト）ごとに作る**。
- **行の形**: 必須の Value Object は列に展開、省略可能な Value Object・List・Entity は jsonb（モデルのフィールド名。TypeScript は camelCase との変換を生成する）。両 target が同じスキーマを読み書きできる。

### スキーマ（DDL）とマイグレーション

`sql/<context>.sql` は**望ましいスキーマ**で、`CREATE … IF NOT EXISTS` だけの冪等な文（何度適用してもよい）。既存のテーブルは変えないので、列を足す・型を変えるときのマイグレーションは生成しない。運用ではこのファイルを「あるべき姿」として、スキーマ差分ツール（migra・Atlas・pgschema など）でデータベースとの差分からマイグレーションを作るか、手で書く。

- `CREATE EXTENSION IF NOT EXISTS pg_trgm`（trigram の検索があるとき。拡張を作る権限が要る）、`CREATE SCHEMA IF NOT EXISTS <context>`。
- テーブルごとに主キー（識別子）、Enum の CHECK、`version bigint NOT NULL`。
- インデックス: trigram は `USING gin (lower(列) gin_trgm_ops)`、prefix は `(lower(列) text_pattern_ops)`、exact は `(lower(列))`、並び順（relevance を除くキー）は `(列 COLLATE "C" DESC, …, id DESC)`。

### インデックスの助言

- **GIN と GiST**: pg_trgm はどちらも使える。GIN は検索が速くサイズが大きめで更新が遅め（`fastupdate` の保留リストあり）、GiST は更新が速く小さめだが検索が遅く、`<->`（距離）での KNN 並べ替え（`ORDER BY 列 <-> q LIMIT n`）ができる。読み取りの多い一覧・検索なので GIN を既定にした。「似ているものを上位 n 件だけ」でスコアの閾値を使わないなら、GiST と `<->` の方が向く（生成しない。手で足す）。
- **フィルタとの組み合わせ**: 等値のフィルタ（`status = $1`）が強く絞るなら、`(status, created_at DESC, id DESC)` のように等値の列を先頭に置いた複合インデックスが速い。生成するのは並び順のインデックスだけ（省略可能なパラメータでは先頭の列が使えないことがあるため）。`EXPLAIN (ANALYZE, BUFFERS)` で確かめて足す。
- **trigram が向かないもの**: 3文字未満の検索語（トリグラムがほとんどできず、結果が広すぎるか空）、日本語など分かち書きしない言語（ロケールによっては英数字以外を区切りとして扱い、トリグラムができない。全文検索や pg_bigm を検討）、ID やコードの完全一致（`exact` を使う）、長い本文の全文検索（`tsvector` と GIN の方が向く）。
- **min_similarity の調整**: 0.3（既定）は短い名前やメールアドレスでほどよい。上げるほど結果が少なく速く、下げると取りこぼしは減るが候補が増える。0.3 未満では `%`（インデックス）が使えない。DBA が `pg_trgm.similarity_threshold` を `min_similarity` より上げると行を取りこぼす（DDL のコメントにも書いてある）。

### インメモリのリーダー（テスト用）

生成した SQL と同じ意味論: フィルタ（NULL は一致しない、渡さないパラメータは無視）、検索（小文字にして、英数字の並びを単語とし、前に空白2つ・後ろに1つを足したトリグラムの集合で、共通 / 全体を float4 で — pg_trgm と同じ）、並び（文字列はコードポイント順）、キーセット、`limit + 1`。行は Aggregate をリポジトリと同じ行の形にしたもので、項目は同じ `<query>ItemFromRow` で作る。PGlite（WebAssembly の PostgreSQL 18 と pg_trgm）での生成器のテストが、同じデータに対するページごとの結果の一致を確かめる。`lower()` はデータベースのロケールに従うので、英数字以外の大文字小文字の扱いが違うことがある。

### 移行メモ（2026-10-06）

- 既存のモデルは何も変わらない（`queries:` を書いたコンテキストだけが対象）。
- `queries:` を足すと、そのコンテキストに `sql/<context>.sql` と永続化のファイルが増える。TypeScript の API を使っていれば `api/runtime.ts` の `send` が export され、`api/query-runtime.ts` が増え、保存する Use case のエラーの一覧に `concurrency_conflict: 409` が加わる。
- 依存は増えない（TypeScript は `node:crypto`、Python は標準ライブラリ）。PostgreSQL のドライバ（`pg` / PGlite / psycopg）はアプリが選んで入れる。
