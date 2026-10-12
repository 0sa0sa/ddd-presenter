# テスト手法の選定: プロパティベーステスト・契約テスト・BDD/Gherkin（2026-10 時点）

前提（リポジトリで確認した事実。URL は無くリポジトリ内のパス）:
- 生成器はすでにシナリオ由来の例示テスト、導出した違反値テスト（`details.rule` まで確認）、冪等性テスト、ポリシー対応テスト、イベントの JSON 往復（`parse<Ctx>Event`）、Aggregate の JSON 往復（`aggregateViaJson`）を出す — `docs/05-generation-and-architecture.md` L113-115, L198
- TS のテストランナーは vitest が既定で、`generation.typescript.test_runner: bun` で `bun test` に切り替えられる — `docs/05-generation-and-architecture.md` L165、`packages/core/src/ir.ts` L156
- 生成例の依存は `zod ^4.1.0` と `vitest ^5.0.3` — `examples/cleaning-platform-ts/package.json`
- **OpenAPI と AsyncAPI はどちらも出していない**。`packages/` と `docs/` を grep して該当なし（2026-10-12）。HTTP API と TanStack Query のクライアントはどちらも生成器が出している — `docs/05-generation-and-architecture.md` L244-L308

---

## 1. プロパティベーステスト（Hypothesis / fast-check、ステートフル・モデルベースを含む）

### Takeaway
どちらの言語でも、スキーマから自動で生成器を導く手段（Pydantic→Hypothesis、Zod→fast-check）は 2026 年時点で使えないか不完全だ。生成器は DSL の制約から**明示的な strategy / arbitrary をコードとして出す**べきで、DSL がすでに制約と不変条件を持っているのでこの方が筋もよい。ステートフルテストでは Hypothesis の `RuleBasedStateMachine` と fast-check の `fc.commands` がそれぞれ「操作＋状態ガード＋Invariant」に素直に対応する。

### Cited Findings

**Hypothesis（Python）: バージョンと保守状況**
- 最新は hypothesis 6.169.0（2026-10-11 公開）で、活発に保守されている — [PyPI hypothesis](https://pypi.org/project/hypothesis/)
- Pydantic v2 は Hypothesis プラグインを同梱しなくなった。ドキュメントには「別の仕組みを検討する間の一時的な削除」とあり、経過は pydantic#4682 で追う — [Pydantic docs: Hypothesis](https://pydantic.dev/docs/validation/latest/integrations/dev-tools/hypothesis/)
- pydantic#4682（"V2: hypothesis plugin rewrite"）は open のまま。メンテナー Viicos の 2025-08-03 のコメントは「nothing planned for the moment」で、2026-02 に help wanted ラベルが外れた — [pydantic#4682](https://github.com/pydantic/pydantic/issues/4682)
  - スレッドで挙がった回避策: `PositiveInt` などの annotated-types 制約は Hypothesis 側が対応済み。独自の `GroupedMetadata` から strategy を出せる。`hypothesis-jsonschema` の `from_schema` を使う。正規表現は `st.from_regex(pattern, dialect="jsonschema")` を使う（Zac-HD 推奨） — [pydantic#4682](https://github.com/pydantic/pydantic/issues/4682)
  - ただし `hypothesis-jsonschema` は 0.23.1（2024-02-28）以降リリースがなく、停滞気味 — [PyPI hypothesis-jsonschema](https://pypi.org/project/hypothesis-jsonschema/)
- `st.from_type()` は抽象クラスでなく必須引数がすべて型注釈付きのクラスを `builds()` で解決する。dataclass は型ヒントから推論でネイティブに扱い、`register_type_strategy()` で既定の解決を上書きできる。Pydantic への言及はない — [Hypothesis strategies reference](https://hypothesis.readthedocs.io/en/latest/reference/strategies.html)

**Hypothesis: ステートフルテスト（RuleBasedStateMachine）**
- `@rule()` が操作、`@initialize()` がどの rule より前に1回だけ走る初期化。`Bundle` は生成した値（例: 作った Aggregate の ID）をためておく場所で、`target=` で足し、`consumes()` で取り出して消す — [Hypothesis stateful](https://hypothesis.readthedocs.io/en/latest/stateful.html)
- `@precondition(lambda self: ...)` は当てはまらない rule を実行前に除外する仕組みで、`assume()` より推奨されている。precondition から bundle は参照できない — [Hypothesis stateful](https://hypothesis.readthedocs.io/en/latest/stateful.html)
- `@invariant()` は毎ステップの後に走る。precondition を付けられるが、bundle は参照できない — [Hypothesis stateful](https://hypothesis.readthedocs.io/en/latest/stateful.html)
- 設定例は `TestCase.settings = settings(max_examples=50, stateful_step_count=100)`。マシンは `Machine.TestCase`（unittest の TestCase）として pytest に集めさせる。rule は pytest の fixture や parametrize を引数に取れず、`sampled_from` などで代わりにする — [Hypothesis stateful](https://hypothesis.readthedocs.io/en/latest/stateful.html)

**Hypothesis: 失敗の保存と CI 設定**
- 環境変数 `CI` があると `ci` プロファイルが自動で有効になる。`ci` は `derandomize=True`、`deadline=None`、`database=None`、`print_blob=True`、`too_slow` の抑制を設定する — [Hypothesis API reference](https://hypothesis.readthedocs.io/en/latest/reference/api.html)
- 失敗例は既定で `.hypothesis/examples` の `DirectoryBasedExampleDatabase` に保存される。ドキュメントはこれを「a cache that you never need to invalidate」と呼び、「Do not rely on the database for correctness」とも書いている。`GitHubArtifactDatabase` を使うと CI で見つけた失敗を手元で再現でき、`ReadOnlyDatabase` で包んで使う — [Hypothesis API reference](https://hypothesis.readthedocs.io/en/latest/reference/api.html)
- `@example` で渡した入力は `explicit` フェーズで先に試され、`max_examples` には数えられず、縮小（shrink）もされない。`phases` で explicit / reuse / generate / target / shrink / explain を選べる — [Hypothesis API reference](https://hypothesis.readthedocs.io/en/latest/reference/api.html)

**fast-check（TS）: バージョンと保守状況**
- fast-check 4.10.2（2026-09-19）で活発に保守されている — [npm fast-check](https://registry.npmjs.org/fast-check)
- 公式の `@fast-check/vitest` 0.5.0（2026-09-11）は peer が `vitest ^4.1.0 || ^5.0.0` — [npm @fast-check/vitest](https://registry.npmjs.org/@fast-check/vitest)
  - `vitest` の import を差し替えて `test.prop([...arbs])` / `test.prop({...})` と書く。同期・非同期どちらの述語も使え、タイムアウトと beforeEach / afterEach の連携も面倒を見る。再現は `fc.configureGlobal({ seed })` で行う — [fast-check: vitest](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-vitest/)
  - `@fast-check/jest` と `@fast-check/ava` も公式。bun test 専用の公式コネクタはエコシステム一覧にない — [fast-check ecosystem](https://fast-check.dev/docs/ecosystem)
- **zod-fast-check は Zod 4 / fast-check 4 に対応していない**。最新 0.10.1 は 2023-09-13 公開で、peer は `zod ^3.18.0` と `fast-check >2.23.0 <4.0.0` — [npm zod-fast-check](https://registry.npmjs.org/zod-fast-check)、[GitHub DavidTimms/zod-fast-check](https://github.com/DavidTimms/zod-fast-check)
  - 機能面では intersection / lazy / never が非対応。refine はフィルタで実現するため、めったに満たされない条件では `ZodFastCheckGenerationError` になる — [GitHub zod-fast-check](https://github.com/DavidTimms/zod-fast-check)
- `@fast-check/zod` という公式パッケージは npm に存在しない（registry で Not found、2026-10-12） — [npm registry](https://registry.npmjs.org/@fast-check/zod)
- Zod 4 向けの候補:
  - `@traversable/zod-test` 0.0.28（2025-10-04、peer `zod 4` / `fast-check 3 - 4`）。エコシステム一覧の説明は「Generate random Zod schemas (v4) and data that will always pass」で、目的はスキーマ自体のランダム生成寄り — [fast-check ecosystem](https://fast-check.dev/docs/ecosystem)、[npm](https://registry.npmjs.org/@traversable/zod-test)
  - `zod-schema-faker` 2.1.2（2026-09-25、peer `zod ^3.25 || ^4`）は faker ベースで、fast-check の縮小は効かない — [npm zod-schema-faker](https://registry.npmjs.org/zod-schema-faker)

**fast-check: モデルベーステスト（fc.commands / modelRun）**
- `fc.commands` は「an enhanced version of the `array` designed to meet the requirements of model-based testing」で、失敗したシナリオを効率よく縮小できる — [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)
- コマンドは `check(model)`（今の状態で実行できるか）、`run(model, real)`（実システムとモデルの両方で実行してアサート）、`toString()` を実装する — [同上](https://fast-check.dev/docs/advanced/model-based-testing/)
- ランナーは同期用の `modelRun`、非同期用の `asyncModelRun`、競合を探す `scheduledModelRun` の3つ。失敗を再現するには `seed` と `path` に加えて `fc.commands(cmds, { replayPath })` を渡す — [同上](https://fast-check.dev/docs/advanced/model-based-testing/)

**周辺の動向**
- Antithesis が 2026 年に「Hegel」を公開した。Hypothesis 作者の David MacIver が Antithesis に移って作ったもので、Hypothesis をデータ生成エンジンとして各言語に持ち込む。記事時点では Rust が公開済み、Go は間近、TypeScript などは準備中だった（2026-10 時点の状況は未確認）。本人は「developer preview」と書いている。Python が必要になる点を短所として認めている — [Antithesis blog: Hegel](https://antithesis.com/blog/2026/hegel/)
- 同じ記事は、モデルベーステストを「単純なモデル（非効率なインメモリ版など）と実装が一致するかを PBT で確かめる」ものと説明している — [同上](https://antithesis.com/blog/2026/hegel/)

**ドメインモデルに PBT を書くための読み物**
- Scott Wlaschin のシリーズは、プロパティの型を7つ挙げる: different paths same destination（可換）、there and back again（往復）、some things never change（不変量）、the more things change the more they stay the same（冪等）、solve a smaller problem first、hard to prove easy to verify、test oracle — [F# for Fun and Profit: Choosing properties](https://fsharpforfunandprofit.com/posts/property-based-testing-2/)、[シリーズ一覧](https://fsharpforfunandprofit.com/series/property-based-testing/)
- John Hughes "Experiences with QuickCheck: testing the hard stuff and staying sane"（LNCS 9600, 2016）は、ステートフルなコード向けの Quviq QuickCheck 拡張、Volvo Cars の AUTOSAR 受け入れテスト、Klarna の競合検出を扱う — [Chalmers research](https://research.chalmers.se/en/publication/232550)、[InfoQ talk](https://infoq.com/presentations/testing-techniques-case-study)
- Hillel Wayne の PyCon 2018 "Beyond Unit Tests" は Hypothesis と契約（dpcontracts）の組み合わせを扱う — [Speaker Deck](https://speakerdeck.com/pycon2018/hillel-wayne-beyond-unit-tests-taking-your-testing-to-the-next-level?slide=41)

### Inferences
- **ローカル実験の結果**（URL なし。Python 3.9、hypothesis 6.141.1、pydantic 2.13.5 で 2026-10-12 に実行。最新の 6.169.0 ではない）:
  - `Annotated[int, Field(gt=0, le=10)]` と `Annotated[str, Field(min_length=1, max_length=5)]` を持つ BaseModel に `st.builds(M)` / `st.from_type(M)` を当てると、200 例すべて検証を通った。数値と長さの制約は守られる。
  - `Field(max_digits=6, decimal_places=2)` は「HypothesisWarning: Ignoring unsupported _PydanticGeneralMetadata(max_digits=6, decimal_places=2)」として無視され、Decimal フィールドのテストは `decimal.InvalidOperation` で落ちた。Decimal には範囲と桁を明示した strategy が要る。
  - `model_validator`（`lo <= hi`）は考慮されず、`{'lo': 0, 'hi': -1}` のような不正な入力が生成されて `ValidationError` になった。
  - 結論: 型からの自動推論では、Aggregate の Invariant や VO の複合制約を満たす値は作れない。
- 以上から、生成器は DSL の型と制約から strategy / arbitrary を**直接コード生成**するのがよい。
  - Python: `st.builds(Money, amount=st.decimals(min_value=0, max_value=..., places=2, allow_nan=False, allow_infinity=False))`
  - TS: `fc.record({ amount: fc.integer({min:0,max:...}).map(c => new Decimal(c).div(100)) })`
  - フィールドをまたぐ Invariant は、構成的に作る（例: `lo` を引いてから `hi = lo + delta`）か、Invariant 関数で `filter` する。filter の棄却率が高い場合は構成的な生成に切り替える。
  - こうすれば Zod / Pydantic のバージョン問題やサードパーティライブラリの停滞にも左右されない。
- **DSL → ステートフルテストの対応**:

  | DSL | Hypothesis | fast-check |
  |---|---|---|
  | operation | `@rule` | `Command` クラス |
  | `require`（状態ガード） | `@precondition` | `check(model)` |
  | 引数の型と制約 | rule の strategy | コマンドの arbitrary |
  | aggregate invariant | `@invariant` | `run` の末尾でアサート |
  | 作成系の操作が返す ID | `Bundle` | モデルが ID を保持 |
  | `changes` | モデル状態への期待値の適用 | 同左 |
  | `emits` | 発生したイベント列の比較 | 同左 |
  | 失敗系 | precondition を外した rule で Domain Error を期待 | `check` を外したコマンドで Domain Error を期待 |

  - モデル（オラクル）には DSL の `changes` から生成した単純な状態遷移関数を使える。これは Hughes や Hegel 記事が言うモデルベーステストそのものだ。
  - ただし、オラクルと実装を同じ DSL から生成すると、両方が同じ誤りを持つ可能性がある（共通原因）。この場合のテストで確かめられるのは「Invariant が全到達状態で保たれる」「ガード違反は必ず宣言 Error になる」「イベントの往復」で、`changes` の意味そのものの正しさは確かめられない。
- **既存テストをプロパティに一般化する**のが最も低リスクだ。コード経路がすでにあり、生成器の改修範囲が小さい。
  - JSON 往復（`parse<Ctx>Event`、`aggregateViaJson`）は "there and back again"
  - 違反値テストは「制約外の値なら必ず ConstraintViolation か宣言 Error」
  - 冪等性テストは "more things change..."
- **TS ランナー**: vitest（既定。生成例は vitest ^5）なら `@fast-check/vitest` の `test.prop`。`bun test` を選んだ場合は公式コネクタがないので、素の `fc.assert(fc.property(...))` / `fc.assert(fc.asyncProperty(...))` を出す。
- **CI 設定**:
  - Python: `ci` プロファイルの既定（derandomize、database=None）を活かしつつ、生成する `conftest.py` に `settings.register_profile("ci", max_examples=..., stateful_step_count=...)` を出す。
  - TS: `fc.configureGlobal({ numRuns })` を出す。
  - 失敗時は Hypothesis が `print_blob`、fast-check が seed / path を出力するので、再現情報はログに残る。

### Gaps
- 最新の hypothesis 6.169.0 と Python 3.12 以上で、Pydantic の `max_digits` / `decimal_places` を扱えるようになったかは未確認。手元に Python 3.9 しかなく、実験は 6.141.1 で行った。
- `fc.commands` の `size` オプションの詳細はドキュメントページに説明がなく、確認できなかった。
- `@traversable/zod-test` が「既存の Zod 4 スキーマから有効データの arbitrary を導く」用途にどこまで使えるかは README を読んでいないため未確認。
- Hillel Wayne が hillelwayne.com で書いた PBT とモデルの記事本文は見つけられなかった。
- Nicolas Dubien（fast-check 作者）の記事やトークは調べていない。fast-check ブログ（fast-check.dev/blog）が一次資料の候補。

---

## 2. 契約テスト（Pact、Specmatic、Schemathesis、AsyncAPI）

### Takeaway
クライアントとサーバーの両方を同じモデルから生成する場合、消費者駆動の Pact が足すものは小さい。価値があるのは次の3つで、どれも**OpenAPI（イベントには AsyncAPI）を出力すること**が前提になる。今の生成器はどちらも出していない。
- (a) 生成したサーバーが仕様どおりかを property-based に叩いて確かめる（Schemathesis）
- (b) モデルの版の間の破壊的変更を検出する（Specmatic の contract-vs-contract、または OpenAPI diff 系ツール）
- (c) 第三者の消費者に仕様を公開する

### Cited Findings

**Pact**
- pact-python 3.0.0（2025-10-06）で Ruby CLI ベースの実装を捨て、Rust の Pact FFI に移った。既定は Pact Specification v4。旧 API は `pact.v2` に残るが非推奨で、新機能は入らない。メッセージ pact には v3 API への完全移行が要る — [pact-python MIGRATION.md](https://github.com/pact-foundation/pact-python/blob/main/MIGRATION.md)、[CHANGELOG](https://github.com/pact-foundation/pact-python/blob/main/CHANGELOG.md)
- 最新は pact-python 3.4.1（2026-09-17）。直近の変更はメッセージハンドラ失敗の報告改善など — [PyPI pact-python](https://pypi.org/project/pact-python/)、[CHANGELOG](https://github.com/pact-foundation/pact-python/blob/main/CHANGELOG.md)
- v3 系では非同期・同期メッセージ（AsynchronousMessage / SynchronousMessage）とメッセージ検証が実装されている — [CHANGELOG](https://github.com/pact-foundation/pact-python/blob/main/CHANGELOG.md)
- pact-js（`@pact-foundation/pact`）は 17.1.4（2026-09-07）で、保守は継続している — [npm @pact-foundation/pact](https://registry.npmjs.org/@pact-foundation/pact)
- Rust のコアは V3 / V4 仕様に対応し、FFI で各言語から使われる — [Pact Rust docs](https://docs.pact.io/implementation_guides/rust/)、[Pact Ecosystem](https://docs.pact.io/diagrams/ecosystem)
- Pact 公式 FAQ の向き不向き:
  - 「If you don't know who these consumers are going to be, then Pact may not be for you」
  - 外部向けの公開 API には OpenAPI を挙げ、公開仕様への適合の確信を与えるとしている
  - 「全員同じチーム」という反論には、チームは時間とともに変わると答えている
  - 出典: [Pact docs: Convince me](https://docs.pact.io/faq/convinceme)
- **双方向契約テスト（BDCT）**（docs.pactflow.io の該当ページは取得時 404 だったため、検索スニペットに基づく）:
  - PactFlow 専用で、OSS の Pact にはない
  - 消費者の契約をプロバイダのコードに再生せず、プロバイダの OpenAPI と静的に比較する
  - プロバイダは別途、自分の OpenAPI と実装の一致を自己検証する必要がある
  - Pact を置き換えるものではなく、第三者 API などの代替手段と位置づけられている
  - 出典: [PactFlow BDCT guide](https://docs.pactflow.io/docs/bi-directional-contract-testing)、[SmartBear PactFlow on-prem docs](https://support.smartbear.com/pactflow-on-premises/docs/en/user-guide/user-interface/user-interface-2-x-x/bi-directional-contract-testing.html)、[pactflow/roadmap#4](https://github.com/pactflow/roadmap/issues/4)

**Schemathesis**
- 最新は 4.30.1（2026-10-09）で、活発に保守されている — [PyPI schemathesis](https://pypi.org/project/schemathesis/)
- OpenAPI / GraphQL スキーマから property-based テストを自動生成する。対応は OpenAPI 2.0 / 3.0 / 3.1 / 3.2 と GraphQL（2018-06 以降）。サーバーエラー、スキーマ違反、検証漏れを探し、失敗ごとに最小の curl 再現コマンドを出す。CLI、pytest、GitHub Actions に対応し、JUnit XML / Allure / HAR を出力する — [Schemathesis docs](https://schemathesis.readthedocs.io/en/stable/)
- ステートフルテストは OpenAPI links（例: `$response.body#/id` を `GET /users/{userId}` に渡す）に沿って操作をつなぐ。CLI では `Location` ヘッダからもリンクを学習する。pytest では `schema.as_state_machine()` をサブクラス化して `APIWorkflow.TestCase` として集める。既定は `max_examples=100`、`stateful_step_count=6` — [Schemathesis stateful guide](https://schemathesis.readthedocs.io/en/stable/guides/stateful-testing/)

**Specmatic**
- OpenAPI、AsyncAPI、GraphQL SDL、gRPC proto を「executable contracts」として使う。リポジトリのライセンスは MIT — [GitHub specmatic/specmatic](https://github.com/specmatic/specmatic)
- 仕様から自動でテストを生成し、プロバイダ不在でも消費者側の開発を進められるスタブを提供し、仕様の2版を比べて破壊的変更を出す（「Contract vs Contract」）。Kafka、SNS/SQS などの非同期にも対応する。OSS 版と有償版の機能の切り分けはサイト上で明示されていない — [specmatic.io](https://specmatic.io/)
- npm の `specmatic` は 2.55.3（2026-10-05）で、活発に保守されている — [npm specmatic](https://registry.npmjs.org/specmatic)

### Inferences
- **両側を生成する場合の評価**:
  - 同じ DSL から生成したクライアントとサーバーの間の「ずれ」は、生成器のバグからしか生まれない。それは生成器自身のゴールデンテストや往復テストで捕まえるべきもので、利用者のプロジェクトに Pact を入れても検出力はほとんど増えない。
  - 一方で次の3つは別問題で、ここに価値がある。
    - 利用者がハンドラや本文の前後処理を手で変えるなど、生成後に手が入るケース（`docs/05` L253 にこの逃げ道の記述がある）
    - デプロイの版ずれ（古いクライアントと新しいサーバー）
    - 第三者の消費者
- **推奨順**:
  1. **OpenAPI 3.1 を生成する**。operation、use case、query、Domain Error の 4xx 表と、作成系の応答から detail への OpenAPI links を含める。
  2. 生成するテストに **Schemathesis**（Python サーバー）を加える。TS サーバーに対しても、Schemathesis CLI を CI で回せば言語に依らず使える。
  3. モデルの版の差分で破壊的変更を検出する。Specmatic の contract-vs-contract を使うか、生成器自身が IR の差分を見て警告する。
  4. Pact は「利用者が第三者の消費者を持つ場合」の任意のガイドにとどめ、生成はしない。
- イベントについても、AsyncAPI 3 を出力しておけば Specmatic の非同期契約テストやスキーマレジストリ連携の土台になる。現状のイベント JSON 往復テストは「同じコード内での往復」しか確かめていない。

### Gaps
- AsyncAPI 3.x の現状、スキーマレジストリ（Confluent / Apicurio）との連携、AsyncAPI からの契約テスト生成は、時間の都合で調べていない。
- Schemathesis 4.x が ASGI アプリを直接読み込む API（旧 `from_asgi` 相当）の現行の名前は確認できなかった。
- Specmatic の OSS / 有償の境界（どの機能が Enterprise 限定か）は確認できなかった。
- OpenAPI diff 系ツール（oasdiff など）は調べていない。
- pact-js のメッセージ pact と V4 の対応状況、BDCT 以外の Pact Broker / PactFlow の機能（can-i-deploy など）は確認していない。

---

## 3. BDD / Gherkin（bddgen = playwright-bdd、代替、書き方、生成の是非）

### Takeaway
`bddgen` は playwright-bdd（vitalets/playwright-bdd）の CLI で、`.feature` ファイルから Playwright のテストファイルを生成する。UI レベルの受け入れテスト向けだ。生成器の Given/When/Then シナリオを `.feature` として出し、生成したステップ定義につなぐことは技術的には容易だが、既存の例示テストと同じ内容を二重に持つことになる。Cucumber 側の思想（BDD は協働の手段で、テストは副産物）からは「機械生成の Gherkin」は価値が薄い。出すなら、生きたドキュメントとして読み取り専用の `.feature` をドメインレベル（UI でない）で出す程度にとどめるのがよい。

### Cited Findings

**playwright-bdd / bddgen**
- 実行は `npx bddgen && npx playwright test`。`bddgen` が `.feature` から Playwright のテストファイルを生成し（`test.describe` / `test(...)` の中で `await Given('...')` を呼ぶ形）、次に Playwright の runner が実行する。ステップ定義からは `page` などの fixture を使える — [playwright-bdd docs index.md](https://github.com/vitalets/playwright-bdd/blob/main/docs/index.md)
- `bddgen test`（または `bddgen`）は `playwright.config` の中の `defineBddConfig()` を前提にする。`--tags "@foo and not @bar"` でタグ式による絞り込み、`--watch` で再生成ができる — [playwright-bdd docs cli.md](https://github.com/vitalets/playwright-bdd/blob/main/docs/cli.md)
- 生成を実行から切り離した理由: VS Code 拡張や UI モード、ブレークポイントなど Playwright の道具をそのまま使うため。最初は実行時にその場で変換していたが、config が何度も評価されて再生成が多すぎ、watch や UI モードで循環も起きた — [playwright-bdd FAQ](https://github.com/vitalets/playwright-bdd/blob/main/docs/faq.md)
- ステップ定義の書き方:
  - Playwright スタイルは `const { Given, When, Then } = createBdd()` で、第1引数が fixture、続く引数がステップのパラメータ。`this`（World）は使わない。パターンは Cucumber Expressions か正規表現 — [playwright-style.md](https://github.com/vitalets/playwright-bdd/blob/main/docs/writing-steps/playwright-style.md)
  - TypeScript 5 のデコレーター（`@Fixture('todoPage')`、`@Given`）で Page Object のメソッドにステップを付けられる — [decorators.md](https://github.com/vitalets/playwright-bdd/blob/main/docs/writing-steps/decorators.md)
  - Cucumber スタイル、スコープ付きステップ、パスからのタグ付け、特別タグ、AI エージェント向け skill もある — [GitHub vitalets/playwright-bdd](https://github.com/vitalets/playwright-bdd)
- 成熟度: v9.2.1（2026-09-06、peer `@playwright/test >=1.44`）、803 stars、最終 push は 2026-09-30。「the latest stable Playwright release and the 10 previous releases」をサポートする — [npm playwright-bdd](https://registry.npmjs.org/playwright-bdd)、[GitHub](https://github.com/vitalets/playwright-bdd)、[GitHub API](https://api.github.com/repos/vitalets/playwright-bdd)
- 自身の宣伝文句は「BDD in the Era of AI」。シナリオが readable かつ executable なので、AI エージェントの目標と検証に使える、としている — [playwright-bdd docs index.md](https://github.com/vitalets/playwright-bdd/blob/main/docs/index.md)

**代替**
- Cucumber.js `@cucumber/cucumber` 13.3.0（2026-10-05）、公式の Gherkin パーサー `@cucumber/gherkin` 42.0.1（2026-08-05）。どちらも活発 — [npm @cucumber/cucumber](https://registry.npmjs.org/@cucumber/cucumber)、[npm @cucumber/gherkin](https://registry.npmjs.org/@cucumber/gherkin)
- QuickPickle 1.11.2（2026-05-06、peer `vitest ^1 || >=2`）: Vite / vitest のプラグインで、公式 Gherkin パーサーで `.feature` を読んで vitest のテストとして走らせる。
  - ステップは `Given/When/Then` を import して書き、第1引数が `world` になる
  - `@skip` / `@todo` / `@concurrent` などのタグが vitest の機能に対応する
  - 52 stars と小規模で、README は一部の目標が「Cucumber のベストプラクティスと合わない」と自ら書いている
  - 出典: [GitHub dnotes/quickpickle](https://github.com/dnotes/quickpickle)、[npm quickpickle](https://registry.npmjs.org/quickpickle)
- pytest-bdd 9.0.0（2026-09-30）: `scenarios("features")` で一括に結び付け、`@given/@when/@then` と parsers（parse / cfparse / re）を使い、`target_fixture` で値を後のステップに渡す。`pytest-bdd generate` でスタブを生成でき、`--generate-missing` で未実装を報告する。8.0 で公式の `gherkin-official` パーサーに移り、Rule / 多言語対応などが入った。9.0 で Python 3.9 を切った — [pytest-bdd docs](https://pytest-bdd.readthedocs.io/en/latest/)、[PyPI pytest-bdd](https://pypi.org/project/pytest-bdd/)
- behave 1.3.3（2025-09-04）が最新で、それから約13か月リリースがない（保守状況の判断は推測になる） — [PyPI behave](https://pypi.org/project/behave/)

**Gherkin の書き方と「BDD はテストではない」**
- Cucumber 公式: 命令的な書き方（UI 操作を並べる）は実装に強く結びつき、「Any time the implementation changes, the tests need to be updated too」。宣言的な書き方は「describes the behaviour of the application, rather than the implementation details」で、壊れにくく生きたドキュメントになる — [Cucumber: Writing better Gherkin](https://cucumber.io/docs/bdd/better-gherkin/)
- Aslak Hellesøy（Cucumber 作者）は Cucumber をまず協働の手段とし、「regression tests are a by-product, the testing is not the activity」と述べている — [InfoQ 2015: BDD Tool Cucumber is Not a Testing Tool](https://www.infoq.com/news/2015/03/bdd-cucumber-testing/)
- Hellesøy によれば、Dan North が BDD を作ったのは、TDD がテストの話だと誤解されたからだ — [Semaphore interview](https://semaphore.io/blog/aslak-hellesoy-cucumber)
- Hellesøy は 2018 年に Gherkin を「requirements specifications, automated tests and living documentation」をまとめた形式と説明している — [InfoQ 2018](https://www.infoq.com/news/2018/04/cucumber-bdd-ten-years/)
- Seb Rose & Gáspár Nagy の "Formulation"（BDD Books 第2巻）は、Given/When/Then による良いシナリオの書き方を扱う。英語の Leanpub 版は取り下げられ、内容は Manning の "Effective Behavior-Driven Development" に統合された — [Leanpub](https://leanpub.com/bddbooks-formulation)
- Seb Rose の BRIEF: シナリオは Business language / Real data / Intention revealing / Essential / Focused で、全体として Brief に保つ。業務の言葉を使い（"click" や HTML 要素名を避ける）、1シナリオ1ルールにし、付随的な情報を削る — [Cucumber blog: Keep your scenarios BRIEF](https://cucumber.io/blog/bdd/keep-your-scenarios-brief)、[Effective BDD ch.7](https://livebook.manning.com/book/effective-behavior-driven-development/chapter-7)（各文字の展開は二次情報の要約による。下の Gaps 参照）

### Inferences
- DSL のシナリオ（Given = 既存の Aggregate やイベント、When = use case / operation、Then = 状態・emits・Error）は、そもそも宣言的でドメインの言葉で書かれている。そのため `.feature` に機械変換しても BRIEF の B / I / F は満たしやすい。逆に、UI 操作の命令的なステップを生成するのは Cucumber の指針に反し、壊れやすい。
- **重複のリスク**: 同じシナリオがすでに pytest / vitest の例示テストとして生成されている。`.feature` とステップ定義も生成すると、同じ検証が2系統になり、CI 時間と失敗の読み解きコストが倍になる。しかも生成された Gherkin は人が直しても再生成で上書きされるので、「協働のための文書」という BDD 本来の役割を果たせない。
- **現実的な選択肢**（推奨は a）:
  - (a) `.feature` を**生きたドキュメントとしてだけ**出す（`docs/generated/features/*.feature`）。実行はしない。DSL から変換した読み物として、非エンジニアとのレビューに使う。
  - (b) 実行するなら、ドメインレベルにとどめる。TS は vitest に乗る QuickPickle、Python は pytest-bdd で、ステップ定義は既存の生成テストと同じテストダブルを呼ぶ。このとき既存の例示テストは出さず、どちらか一方に寄せて重複を避ける。
  - (c) Playwright（playwright-bdd）による UI レベルの受け入れテストは、生成器が UI を持たない限り対象外。UI 層は利用者の持ち物なので、生成器は「ステップ文言の一覧（Cucumber Expressions）」と、HTTP API を叩く API レベルのステップ定義までを出し、UI ステップは利用者が書く、という分担なら成り立つ。
- playwright-bdd は「生成してから実行する」設計（bddgen）なので、生成器が `.feature` を出す方式とは相性が良い。ただし Playwright の runner が前提で、生成器が既定にしている vitest / bun test とは別系統になる。

### Gaps
- Dan North "Introducing BDD"（dannorth.net）は取得に失敗したため、North の一次資料からの引用はない。North については Hellesøy の発言（Semaphore）経由で記した。
- BRIEF の各文字の展開は Cucumber ブログの本文で直接確認できず、検索要約による。
- playwright-bdd 9.x の破壊的変更の内容（CHANGELOG）は読んでいない。

---

## 4. 推奨: 何から導入するか、出力の構成、CI コスト

### Takeaway
導入順は次のとおり。
1. **PBT（Hypothesis / fast-check）**: DSL の制約から strategy / arbitrary を明示的に生成し、まず既存の往復・違反値・冪等テストをプロパティに一般化する。続いて Aggregate ごとのステートフル（モデルベース）テストを出す。
2. **OpenAPI の生成と Schemathesis**
3. **AsyncAPI と破壊的変更の検出**
4. BDD は `.feature` を読み取り専用のドキュメントとして出すにとどめる。Pact は生成しない。

### Cited Findings
- スキーマから自動で導く手段は使えない。Pydantic v2 のプラグインは計画なし — [pydantic#4682](https://github.com/pydantic/pydantic/issues/4682)。zod-fast-check は Zod 3 / fast-check 3 止まり — [npm zod-fast-check](https://registry.npmjs.org/zod-fast-check)
- ステートフル PBT の部品（rule / precondition / invariant / Bundle、`fc.commands` の check / run）は DSL の操作・ガード・Invariant に1対1で対応する — [Hypothesis stateful](https://hypothesis.readthedocs.io/en/latest/stateful.html)、[fast-check model-based](https://fast-check.dev/docs/advanced/model-based-testing/)
- Hypothesis は CI で自動的に derandomize され、失敗の保存も無効になる — [Hypothesis API](https://hypothesis.readthedocs.io/en/latest/reference/api.html)
- Schemathesis のステートフルの既定は 100 シナリオ × 最大6呼び出し — [Schemathesis stateful](https://schemathesis.readthedocs.io/en/stable/guides/stateful-testing/)
- Pact は消費者が分からない場合には向かない — [Pact FAQ](https://docs.pact.io/faq/convinceme)。BDCT は PactFlow 専用 — [PactFlow BDCT](https://docs.pactflow.io/docs/bi-directional-contract-testing)
- 宣言的でない Gherkin は壊れやすい — [Cucumber](https://cucumber.io/docs/bdd/better-gherkin/)。BDD はテストより協働が主目的 — [InfoQ](https://www.infoq.com/news/2015/03/bdd-cucumber-testing/)

### Inferences
- **生成する出力の構成案**（既存の `tests/generated/` の流儀に合わせる）:

  ```
  # Python
  tests/generated/strategies_<context>.py        # VO・Entity・Aggregate・コマンド入力の strategy（DSL の制約から明示的に生成）
  tests/generated/test_<context>_properties.py   # 往復、違反値の一般化、冪等、可換（DSL が宣言した場合）
  tests/generated/test_<aggregate>_stateful.py   # RuleBasedStateMachine: rule = operation、precondition = require、invariant = aggregate invariant
  tests/generated/conftest.py                    # settings.register_profile("ci"/"dev"/"thorough") と load_profile(env)
  tests/generated/test_api_schemathesis.py       # OpenAPI を出すようになってから

  # TS
  tests/generated/<context>.arbitraries.ts       # fc.record / fc.constantFrom ...
  tests/generated/<context>.properties.test.ts   # vitest なら @fast-check/vitest の test.prop、bun なら fc.assert
  tests/generated/<aggregate>.model.test.ts      # fc.commands + fc.asyncModelRun（リポジトリが async の場合）
  ```

  - strategy / arbitrary は利用者も自分のテストで再利用できる公開物になる。生成器は版付きで出し、利用者は `register_type_strategy` や arbitrary の上書きで調整する。
- **CI コストの目安**（推定。実測はしていない）:
  - インメモリのテストダブルに対する PBT は1プロパティ 100 例で数百 ms から数秒。ステートフルは `max_examples × stateful_step_count` に比例する。
  - 既定は控えめにする（例: `max_examples=50`、`stateful_step_count=20`）。nightly で `thorough` プロファイル（1000 例など）を回す二段構えにする。
  - Schemathesis は実サーバーと DB を相手にするので最も重い。PR では対象を絞るか例数を減らし、本格的な実行は nightly にする。
  - BDD を実行しない (a) 案なら追加の CI コストはない。
- **生成器が持ちうる固有の強み**: DSL は「どの状態でどの操作が許されるか（ガード）」と「何が常に成り立つか（Invariant）」を明示しているので、手書きでは面倒なステートフル PBT のモデル側を自動で作れる。PBT は、生成器が既存ツールに対して差別化できる部分になりうる。
- **リスクと注意**:
  - オラクルと実装を同じ DSL から生成すると誤りが共通になりうる。そのため PBT が保証するのは「Invariant が保たれる」「ガードと Error の整合」「往復」に限られる、と明記する。
  - 生成した strategy が狭すぎると見逃しが出て、広すぎると filter の棄却で遅くなる。構成的な生成を優先する。
  - 時刻やランダムは生成するテストダブル（Clock）で決定的にする。

### Gaps
- 上記の CI 時間は実測していない。生成例（cleaning-platform）で試作して計測する必要がある。
- DSL の具体的な制約の種類（正規表現、Decimal の桁、列挙、日時の範囲など）ごとの Hypothesis / fast-check の対応表は作っていない。`docs/10-dsl-reference.md` と突き合わせて作る必要がある。
