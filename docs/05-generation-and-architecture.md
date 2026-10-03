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
