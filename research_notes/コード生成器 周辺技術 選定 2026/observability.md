# 生成コードへの OpenTelemetry 組み込み（トレーシングの抽象化）— 2026 年 10 月時点

対象: DDD Presenter が生成する Python（Pydantic、同期ポート）と TypeScript（Zod、非同期ユースケース、Web 標準の HTTP ハンドラ）のコード。ユースケース、クエリ（PostgreSQL、keyset、pg_trgm）、リポジトリ、ポリシー（イベント → ユースケース）、JWT、レート制限、tenant_id を含む。

凡例: [Stable] / [Development] は OTel 側の安定度。「(検索要約経由)」はページ本文を直接読まず、検索結果の要約だけで確認した項目。

---

## 1. OTel の API と SDK の分離、no-op の挙動、安定度、互換性

### Takeaway
OTel の仕様は、計装する側（ライブラリやフレームワーク）が **API だけ** に依存し、SDK の選択はアプリに任せる設計になっている。SDK が無ければ API 呼び出しは低オーバーヘッドの no-op になる。2026 年時点で Traces と Metrics は Python・JS とも Stable、Logs はどちらも Development。Span Events API（`AddEvent` / `RecordException`）は非推奨化が進んでおり、名前付きログ（Logs API）に置き換わる方向。

### Cited Findings
- 計装されたライブラリは「OpenTelemetry クライアントの API にのみ依存する」。SDK はアプリが選ぶ — [OTel Client Design Principles](https://opentelemetry.io/docs/specs/otel/library-guidelines/)
- 「SDK がインストールされていなければ、API 呼び出しは最小限のオーバーヘッドの no-op であるべき」。SDK 無し・特別なビルド無しでも計装済みコードは動く — [同上](https://opentelemetry.io/docs/specs/otel/library-guidelines/)
- API と SDK は独立した成果物として提供しなければならない（MUST）。それぞれ独自のバージョン番号を持ち、各リリースは実装している Specification のバージョンを明記する（MUST） — [同上](https://opentelemetry.io/docs/specs/otel/library-guidelines/)
- 状態ページの記載: Python は Traces Stable / Metrics Stable / Logs Development、JavaScript も Traces Stable / Metrics Stable / Logs Development — [OTel Status](https://opentelemetry.io/status/)
- 2026 年 8 月の記事も、JS の Logs は依然 Development としている — [azukiazusa.dev（Hono + Pino + OTel）](https://azukiazusa.dev/blog/instrument-hono-logs-with-opentelemetry)（検索要約経由）
- **Span Events API の非推奨化**: Tracing API の `Span.AddEvent` と `Span.RecordException` を非推奨にし、「events are logs with names」として Logs API に一本化する。「新しいコードは、現在のスパンに相関づけたログとしてイベントを書くべき」。既存の Stable なメジャー版は当面互換を保ち、各計装は次のメジャー版で移行する。SDK はログ由来のイベントをスパンイベントとして見せる互換オプションを用意する。`OTEL_SEMCONV_EXCEPTION_SIGNAL_OPT_IN` で、例外をログベースのイベントとしても出せる。追跡先は OTEP 4430 — [OTel Blog: Deprecating Span Events API (2026)](https://opentelemetry.io/blog/2026/deprecating-span-events/)
- semconv の `event.name` 属性は非推奨。値は LogRecord の EventName フィールドに入れなければならない（MUST） — [semconv event registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/event/index.md)（検索要約経由）
- 旧 Events API から LogRecord（event_name 付き）への移行例: 2025 年 11 月の OpenLLMetry PR（SDK 1.37.0+ 対象） — [traceloop/openllmetry#3453](https://github.com/traceloop/openllmetry/pull/3453)（検索要約経由）
- JS SDK 2.0（2025 年）: 最低要件が Node 18.19.0 / 20.6.0 以上、TypeScript 5.0.4、コンパイルターゲット ES2022 に上がった。Stable な SDK パッケージは 2.x、experimental なものは 0.200.x。`@opentelemetry/api` と `semantic-conventions` は 2.x 系に含まれず、独自にバージョン管理される — [Announcing the OTel JS SDK 2.0](https://opentelemetry.io/blog/2025/otel-js-sdk-2-0/)、[upgrade-to-2.x](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/HEAD/doc/upgrade-to-2.x.md)（検索要約経由）
- Python では、1.40.0 より前はログ自動計装に `OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=true` が必要だった — [OTel Python zero-code logs example](https://opentelemetry.io/docs/zero-code/python/logs-example/)

### Inferences
- 生成コードの依存は `opentelemetry-api`（Python）と `@opentelemetry/api`（TS）だけにする。SDK・エクスポータ・自動計装は、生成するコンポジションルートや起動スクリプト、または利用者側の設定に置く。こうすれば、利用者が SDK を入れない限りコストはほぼゼロになり、「常に含める」という要件と両立する。
- 生成コードでは `span.recordException` / `add_event` を主経路にしない。例外はスパンの status（Error）と `error.type` 属性で表し、ドメインエラーの詳細は名前付きログ（Logs API、Development）か通常のロガーで出す。Logs API が Development なので、ログは言語標準のロガー（Python `logging`、Node の pino）経由にして、OTel へはブリッジで送るのが無難（§8）。

### Gaps
- 「EventLogger API が 1.47.0 で削除された」という主張は単一ソースで、Java の話の可能性が高い。未検証のため採用しない。
- `@opentelemetry/api` 1.x と SDK 2.x の互換性マトリクスを明示した公式文書は確認できなかった（peerDependencies で確認すること）。
- Python の Logs API（`opentelemetry._logs`、アンダースコア付きモジュール）を Stable にする時期を示す公式ソースは見つからなかった。

---

## 2. 抽象化の選択肢: (a) OTel API を直接使う /(b) 生成した Telemetry ポート + アダプタ /(c) 組み立て時のデコレータ

### Takeaway（推奨）
**基本は (a) を「生成時に」適用し、(b) は採らない。(c) は補助として使ってよい。**
OTel 公式ブログ「Don't Wrap OpenTelemetry」は、独自ラッパー（`TelemetryHelper` や `IMetric`）を作らず OTel を直接使うよう勧めている。正当な例外として挙げているのが「独自スキーマから型安全なコードを生成し、そのコードが OTel を直接呼ぶ（ランタイムラッパーを置かない）」形で、これはコード生成器そのもののやり方に当てはまる。

具体的な層分け:
1. ドメイン層（エンティティ、値オブジェクト、ドメインサービス）は OTel を一切 import しない。
2. 生成したユースケース、クエリハンドラ、リポジトリ実装、ポリシーハンドラ、HTTP ハンドラ（アプリケーション層とインフラ層）は OTel API を直接呼ぶ。
3. コンポジションルートで SDK を組み立てる（生成器が任意で雛形を出す）。
4. テストは SDK の InMemory エクスポータで検証する（偽のポートは作らない）。

### Cited Findings
- 「Don't Wrap OpenTelemetry — You're Probably Hurting More Than Helping」の主張。例は .NET と Rust のメトリクスだが、著者は全言語・全シグナルに当てはまるとしている — [OTel Blog (2026)](https://opentelemetry.io/blog/2026/dont-wrap-opentelemetry/)
  - アロケーション: ラッパーのシグネチャがコレクション型を要求すると、計測のたびに呼び出し側がヒープ確保する。「The moment your wrapper signature requires any collection type, every caller heap-allocates on every measurement.」
  - 名前から計測器を毎回検索・生成するラッパーは、ホットパスに辞書検索やミューテックスを持ち込む。計測器は起動時に一度作って参照を持つべき。「The instrument *is* the fast path.」
  - スキル: 「Developers learn the wrapper, not OTel.」学んだ知識が他チームにも公式ドキュメントにも移らない。
  - 保守: API の上にもう一つ API を持つことになり、OTel の新機能を使うたびにラッパー側で再公開が要る。デバッグ時にも、問題が OTel・ラッパー・型変換のどこにあるか切り分けにくくなる。
  - 許容されるもの: SDK 設定（エクスポータ、サンプリング、リソース属性）の共通ヘルパー。
  - テストにラッパーは要らない: 各 SDK に InMemoryExporter があり、開発中は stdout エクスポータで中身を確認できる。
  - 例外: レガシーからの移行（旧メトリクス基盤との二重書き込み）と、ガバナンス（承認済みの属性や命名の強制）。後者には「独自スキーマから型安全なコードを生成し、生成コードが OTel を直接呼ぶ」形を勧めている。上流プロジェクトとして **OTel Weaver**（semconv 定義から型安全な計装コードを生成する）を挙げている。
  - 「OpenTelemetry was designed to be the stable, user-facing abstraction.」
  - この記事はコンテキスト伝播、semconv、自動計装との相互運用には触れていない。
- OTel API はそれ自体が抽象で、SDK が無ければ no-op になる — [OTel Client Design Principles](https://opentelemetry.io/docs/specs/otel/library-guidelines/)
- プラットフォームエンジニアリング系の記事は「薄い抽象」を勧めているが、例として包んでいるのは SDK の初期化であって計装 API ではない — [oneuptime: platform engineering observability layer](https://oneuptime.com/blog/post/2026-02-06-platform-engineering-observability-layer/view)（検索要約経由）

### Inferences
- **(b) 生成した Tracer/Telemetry ポートを採らない理由**: (1) ベンダー中立性は OTel API が既に提供している。(2) no-op は API 自身が持っている。(3) テストは InMemory エクスポータで足りる。(4) ポートを作ると、コンテキスト伝播、Span link、semconv 定数、自動計装スパンとの親子関係のどれかを再実装するか取りこぼす（記事が直接述べていない点を含むので、推論として扱う）。(5) 利用者が OTel の知識をそのまま使えなくなる（記事の skills と maintenance の論点）。
- **「ドメインに OTel の型を漏らさない」要件**: 計装の場所をアプリケーション層の境界（ユースケースの実行、リポジトリ、クエリ、ポリシーのディスパッチ、HTTP）に限れば満たせる。ドメインモデルは純粋に保つ。ここは OTel 文書ではなく、DDD/ヘキサゴナルの一般論からの推論。
- **(c) 組み立て時のデコレータ**: 例として、`UseCase` インターフェースを実装する `TracedUseCase` をコンポジションルートで被せる形がある。生成されるユースケース本体を計装コードなしで読みやすく保てる。ただし、ユースケース内部の業務イベント（どのルールで拒否されたか等）を属性に付けるには、本体から `trace.get_current_span()` / `trace.getActiveSpan()` を呼ぶ必要がある。そのため完全な外付けにはならない。実装案: 生成器が「ユースケース名・tenant・結果コードを付けるスパンの開始と終了」をデコレータ（Python）や高階関数（TS）として出し、本体は必要なときだけ現在のスパンに属性を足す。
- **性能**: 計測器（Counter/Histogram）はモジュールのロード時に一度作る（記事の指摘）。属性は固定キーの小さな dict や object にする。
- **OTel Weaver**: 生成器が独自の semconv 風 YAML（例: `ddd_presenter.use_case.name`）を持ち、Weaver で定数やドキュメントを生成する選択肢がある。ただし Weaver の成熟度は未調査（Gap）。

### Gaps
- Charity Majors、Jimmy Bogard 等が「ヘキサゴナルで OTel を包むべきか」について書いた一次記事は見つからなかった（Majors の立場は §3 のワイドイベント論として間接的に参照）。
- OTel Weaver の 2026 年時点の安定度と、Python・TS のコード生成テンプレートの対応状況は未確認。
- ブログ記事の著者と公開日はページから取得できなかった（URL から 2026 年とわかる）。

---

## 3. セマンティック規約、スパン名、独自属性、メトリクスのカーディナリティ、Exemplar

### Takeaway
HTTP（スパンとメトリクス）は Stable。DB スパンの規約は本文に Stable と書かれている（ただし移行ガイドとの記述が食い違う）。Messaging は Development。DB のスパン名は `{db.query.summary}`、それが無ければ `{db.operation.name} {target}`。`db.query.text` は、パラメータ化クエリならそのまま既定で収集してよい。パラメータ値は opt-in（PII のため）。独自属性には semconv の既存の名前空間（`app.*` 等）を使わず、生成器固有の接頭辞を付ける。tenant はスパンとログには付けるが、メトリクスには既定で付けない。

### Cited Findings
**DB**
- DB スパンの規約は「特記なき限り Stable」。`db.query.parameter.<key>` や `db.response.returned_rows` 等の一部は Development。既存の計装は `OTEL_SEMCONV_STABILITY_OPT_IN=database`（または `database/dup`）で新規約に移行する — [semconv DB spans](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)
  - 一方、移行ガイドには「DB 規約はまだ stable とマークされていない」とあり、記述が矛盾する。DB spans ページの方が新しく、移行ガイドは更新が遅れている可能性が高い — [DB semconv migration guide](https://opentelemetry.io/docs/specs/semconv/non-normative/db-migration)（検索要約経由）
- スパン名: `{db.query.summary}` → `{db.operation.name} {target}` → `{target}` → `{db.system.name}` の優先順。target は `db.collection.name`、`db.stored_procedure.name`、`db.namespace`、`server.address:server.port` の順で選ぶ — [semconv DB spans](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)
- `db.query.text`: 既定で収集してよいのはサニタイズ済み（リテラルを `?` に置換）の場合のみ。**パラメータ化クエリの本文はサニタイズ不要で、既定で収集される**。パラメータ値は opt-in で、PII を含み得るので既定では取らない。`IN (?, ?, ?)` は `IN (?)` に畳んでよい — [同上](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)
- `db.system.name` は必須で、PostgreSQL なら `postgresql`。`db.query.summary` は推奨・低カーディナリティで、`{operation} {target} ...` 形式、255 文字で切る。`db.collection.name` と `db.operation.name` は条件付き必須だが、複数テーブルにまたがるクエリの本文から抽出してはいけない。`error.type` は失敗時に条件付き必須 — [同上](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)
- Go の otelsql v0.43.0（2026 年 7 月）は opt-in 変数のサポートを削除し、Stable 規約だけを出すようになった。エコシステムが Stable への移行を進めている兆候 — [pkg.go.dev otelsql](https://pkg.go.dev/github.com/lwc/otelsql)（検索要約経由）

**HTTP**
- `http.server.request.duration`: Histogram、単位は `s`、Stable。推奨バケット `[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]`。必須属性は `http.request.method` と `url.scheme`。`http.response.status_code`、`http.route`、`error.type` は条件付き必須。`http.route` は低カーディナリティのルートテンプレートでなければならず、生のパスで代用してはいけない — [semconv HTTP metrics](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)

**Messaging**
- Messaging スパンの規約は **Development**。スパン名は `{messaging.operation.name} {destination}`。operation と span kind の対応は create=PRODUCER、send=PRODUCER/CLIENT、receive=CLIENT、process=CONSUMER、settle=CLIENT — [semconv messaging spans](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/)

**命名**
- 独自の名前は、まず既存の semconv に該当が無いか確認する。小文字・ドット区切り・単語内はアンダースコア。会社共通なら逆ドメイン接頭辞（`com.acme.shopname`）、アプリ固有なら組織内で十分ユニークなアプリ名を接頭辞にする。**既存の semconv 名前空間を接頭辞にしない**。`otel.*` は予約済み — [semconv naming](https://opentelemetry.io/docs/specs/semconv/general/naming/)
- `app.*` は既に semconv の名前空間になっている（`app.build_id`、`app.installation.id`、`app.screen.*` 等 12 属性、すべて Development）。tenant に当たる標準属性は存在しない — [semconv registry: app](https://opentelemetry.io/docs/specs/semconv/registry/attributes/app/)

**カーディナリティと Exemplar**
- メトリクス SDK の既定カーディナリティ上限は **2000**（Stable）。超えた分は `otel.metric.overflow=true` という単一の属性セットに集約される — [Metrics SDK spec](https://opentelemetry.io/docs/specs/otel/metrics/sdk/)
- Exemplar フィルタの既定は `TraceBased`（サンプリングされたスパンの中で記録された計測だけを対象にする）で、Stable。明示バケットのヒストグラムは `AlignedHistogramBucketExemplarReservoir` を使う。ただし既定値はマイナーバージョンで変わり得る — [同上](https://opentelemetry.io/docs/specs/otel/metrics/sdk/)
- ワイドイベント（Charity Majors、Honeycomb）: 「arbitrarily-wide structured log events」を単一の信頼できる情報源とし、高カーディナリティの次元（user_id 等）はイベント側に持たせて、メトリクスはそこから導出する。user_id や build_id をメトリクスのラベルにするとカーディナリティとコストが爆発する — [Honeycomb: bridge from observability 1.0 to 2.0](https://www.honeycomb.io/resources/bridge-from-observability1dot0-2dot0-logs-not-metrics)、[gotopia: Observability 2.0](https://gotopia.tech/articles/336)、[Greptime: wide events (2026)](https://greptime.com/tech-content/2026-06-10-wide-events-observability-2-0)（検索要約経由。Majors 本人の一次記事は未取得）

### Inferences（生成器向けの具体案）
- **独自属性の接頭辞**: `app.tenant.id` と `ddd.*` は避ける（`app.*` は semconv の名前空間。`ddd` は衝突こそ確認していないが汎用的すぎる）。生成器固有の `ddd_presenter.*` か、利用者が設定できる逆ドメイン接頭辞（既定 `ddd_presenter`）にする。案:
  - `ddd_presenter.use_case.name`（例 `PlaceOrder`）、`ddd_presenter.bounded_context`、`ddd_presenter.aggregate.type`
  - `ddd_presenter.query.name`、`ddd_presenter.policy.name`、`ddd_presenter.event.type`
  - `ddd_presenter.tenant.id`（JWT 検証後の値。スパンとログにだけ付ける）
  - `ddd_presenter.rule.code`（ドメインルール違反のコード。列挙値なので低カーディナリティ）
  - `ddd_presenter.outcome` = `ok` / `domain_error` / `not_found` / `forbidden` / `conflict` / `rate_limited`
  - ユーザー ID には semconv の `enduser.id` が使えるかどうか確認を要する（Gap）。
- **スパン名**: 低カーディナリティを保つ。案（推論）:
  - ユースケース: `use_case PlaceOrder`（kind INTERNAL）
  - クエリ: `query SearchProducts`（INTERNAL）。その下に DB スパン `SELECT products`（`db.query.summary` 形式、kind CLIENT）
  - ポリシー: `policy OrderPlaced→ReserveStock` か `process OrderPlaced`（CONSUMER）
  - リポジトリ: DB の自動計装スパンに任せて、独自スパンは作らない（二重スパン防止。§6）
- **DB スパンを手動で作る場合**（自動計装が無いランタイム、例えば Bun）: `db.system.name=postgresql`、`db.collection.name`、`db.operation.name`、`db.query.summary`、`db.query.text` を付ける。生成器が出すクエリはパラメータ化済みなので本文を既定で付けてよいが、パラメータ値は付けない。pg_trgm の検索語は特に PII になり得るので、値は記録しない。
- **メトリクスの属性**: tenant は既定で付けない。2000 系列の上限に当たると overflow に潰れて、全テナントの数値が壊れる。テナント別の内訳はスパンとログ（ワイドイベント）から集計する。どうしても必要な場合だけ opt-in にし、View で上限を明示する。

### Gaps
- `db.client.operation.duration` メトリクスの名前、単位、バケットはこのセッションでは取得できなかった（DB spans ページには記載が無い）。
- RPC 規約の 2026 年時点の安定度は未確認。
- semconv の `enduser.id` / `user.id` の安定度と推奨状況は未確認。

---

## 4. コンテキスト伝播: W3C Trace Context、Baggage、tenant、メッセージ、非同期境界

### Takeaway
トレースの伝播には W3C `traceparent` / `tracestate` を使う（OTel 既定のプロパゲータ）。**tenant や user の ID を Baggage に入れて、受信側で信頼してはいけない。** Baggage は第三者にも伝わる、未検証の入力であり、仕様もまだ Candidate Recommendation。tenant は毎リクエスト、検証済みの JWT（またはサービス間認証）から導き、スパン属性として付ける。メッセージ（ポリシー）経由では、作成時のコンテキストをメッセージに注入する。処理側のスパンは、周囲のスパンの子にして、作成時コンテキストへの link を張る。

### Cited Findings
- Baggage の値は他システムに伝播し得る（「keys and values can be propagated to other systems」）。伝えたくない私的情報は取り除くべきで、機密を入れないか、信頼境界を越えるリクエストに Baggage を載せないかのどちらかにする。「Systems MUST assess the risk of header abuse.」受信側は長さや内容のチェック等、悪意ある入力への標準的な防御をすべき。上限は最低 64 メンバー / 8192 バイト。仕様は 2024-05-30 の **Candidate Recommendation Snapshot** で、まだ Recommendation ではない — [W3C Baggage](https://www.w3.org/TR/baggage/)
- CloudEvents の Distributed Tracing 拡張: `traceparent`（必須）と `tracestate`（任意）。プロトコル固有のトレースヘッダを置き換えるものではない。マルチホップでは「伝送の起点のトレース」だけを運び、ホップごとの情報は載せてはいけない（MUST NOT）。ホップごとの情報はプロトコルヘッダ側で扱う — [CloudEvents distributed-tracing extension](https://github.com/cloudevents/spec/blob/main/cloudevents/extensions/distributed-tracing.md)
- Messaging: プロデューサは各メッセージに作成時コンテキストを付ける（中継者が改変できない形が望ましい）。Create スパンがあればそのコンテキストを、無ければ Send スパンのコンテキストを注入する。受信側の Receive/Process スパンは作成時コンテキストに link する。単一メッセージなら Process スパンの親を作成時コンテキストにしてもよいが、**既に別のスパンの中で処理している場合は、周囲のスパンの子にして作成時コンテキストに link する**ことを勧めている — [semconv messaging spans](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/)

### Inferences
- **tenant の伝播**: HTTP では JWT の検証後に tenant を取り出し、スパン属性と RLS 用のセッション変数（既存のマルチテナント設計）に使う。Baggage から読んで認可や RLS に使うことはしない（W3C の「header abuse」と未検証入力の記述に基づく）。トレース上の便宜のためだけに Baggage に入れることも既定では避ける。外部 API 呼び出し（undici/fetch の自動計装）で第三者にヘッダが漏れるため。
- **イベント → ポリシーの伝播**: 生成するドメインイベントのエンベロープに `traceparent` / `tracestate` を持たせる（CloudEvents 互換の名前）。ポリシーハンドラは、プロセス内の同期ディスパッチなら周囲のユースケーススパンの子になる。アウトボックス経由の非同期ディスパッチなら、新しいトレースか周囲のスパンの子として `process <EventType>`（CONSUMER）を作り、作成時コンテキストに link する。tenant はイベントのペイロード（永続化された、検証済みの値）から取り、Baggage からは取らない。
- **Messaging 規約は Development** なので、生成コードでは `messaging.*` 属性を最小限にとどめる（`messaging.operation.type=process` 程度）。独自属性の `ddd_presenter.event.type` を主に使う。
- **非同期境界**: OTel Python は `contextvars` ベース、Node は `AsyncLocalStorage` ベースのコンテキストマネージャを使う（一般知識。ソースは Gap 参照）。Python の生成コードは同期ポートなので、`start_as_current_span` の with ブロックで十分。ただしスレッドプールに投げる場合は、コンテキストを明示的に引き継ぐ必要がある。TS では `tracer.startActiveSpan(name, async span => {...})` を使い、`finally` で `span.end()` を呼ぶ。

### Gaps
- OTel Python の contextvars 実装と、Node の AsyncLocalStorageContextManager の一次ソースはこのセッションでは取得できなかった。
- Bun の AsyncLocalStorage 互換性（コンテキストが async 境界を正しく越えるか）を示す一次ソースは未確認。
- W3C Trace Context Level 2 の状況は未確認。

---

## 5. 自動計装との相互作用（Python、Node、Bun）と二重スパン

### Takeaway
Python は `opentelemetry-instrument` に加えて psycopg、FastAPI/Starlette 等の contrib 計装、Node は `@opentelemetry/auto-instrumentations-node`（pg、undici、http、pino 等）を使う。生成コードのスパンは、API のグローバル TracerProvider とアクティブなコンテキストを共有するので、自動計装の HTTP サーバースパンの子に自然にぶら下がり、DB スパンは生成スパンの子になる。**Bun ではプログラムからの初期化しか文書化されておらず、ベンダーのサポート外。require フックが効くかどうかは未確認。** そのため、生成コードの手動スパンが唯一のスパンになる可能性がある。これは手動スパンを「常に出す」根拠になる。

### Cited Findings
- Bun は Node API とほぼ互換なので、OTel の Node.js SDK で計装できる。ただし Datadog は「Custom Components」扱いで、ランタイムの機能や SDK の挙動は直接サポートしない。Node の preload（`--require`）方式はそのままでは使えず、Bun のモジュール解決が異なるため、`NodeSDK` と `getNodeAutoInstrumentations()` を別モジュールでプログラムから初期化する — [Datadog: Instrument Unsupported Runtimes](https://docs.datadoghq.com/opentelemetry/guide/instrument_unsupported_runtimes/)（検索要約経由）
- Node の自動計装は require フックでモジュールのロードを横取りし、export をラップする — [oneuptime: zero-code instrumentation options (2026)](https://oneuptime.com/blog/post/2026-02-06-opentelemetry-zero-code-instrumentation-options/markdown)（検索要約経由）
- Hono: `@hono/otel` 1.1.2 は `httpInstrumentationMiddleware(config)` を export する（旧 0.6.0 は `otel()`）。`NodeSDK` と組み合わせて使い、`serviceName`、`serviceVersion`、`captureRequestHeaders`（既定オフ）を設定できる。Cloudflare Workers では `@opentelemetry/sdk-node` が動かないため、`@microlabs/otel-cf-workers` を案内している — [jsr @hono/otel](https://jsr.io/@hono/otel)、[1.1.2 doc](https://jsr.io/@hono/otel@1.1.2/doc)、[1.0.0](https://jsr.io/@hono/otel@1.0.0)
- `opentelemetry-instrument` を使う場合、パイプラインの設定は環境変数か CLI オプションに限られる。細かく設定したいなら SDK と計装を直接 import する — [OTel Python zero-code logs example](https://opentelemetry.io/docs/zero-code/python/logs-example/)
- DB 計装は `OTEL_SEMCONV_STABILITY_OPT_IN=database` / `database/dup` で新規約に移行する（既定は旧規約のまま） — [semconv DB spans](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)

### Inferences
- **入れ子の形**（推論）: `HTTP POST /orders/{id}`（自動計装、SERVER）→ `use_case PlaceOrder`（生成、INTERNAL）→ `INSERT orders`（pg/psycopg 自動計装、CLIENT）。生成コードは独自の TracerProvider を作らず `trace.get_tracer("ddd_presenter.<context>")` を使うだけなので、このように自然に入れ子になる。
- **二重スパンの回避**: 生成するリポジトリ・クエリ層で **DB スパンを手動で作らない**のを既定にする。生成器の設定に `db_spans: auto | manual | off` を用意し、Bun など自動計装が効かない環境だけ `manual` にする。HTTP サーバースパンも同様で、生成する Web 標準ハンドラは、自動計装・フレームワーク計装が無い環境向けの `manual` オプションとしてだけ SERVER スパンを作る。既定では既存のアクティブスパンに `http.route` を付けるにとどめる（route テンプレートは生成器が知っている）。
- **http.route**: 生成器はルートテンプレートを確定的に知っているので、`trace.getActiveSpan()?.setAttribute('http.route', '/orders/{id}')` を出すと、フレームワーク計装が route を取れないケースを補える（semconv の「生パスで代用しない」要件を満たす）。
- **自動計装のメトリクス**: HTTP や DB の RED メトリクス（`http.server.request.duration` 等）は自動計装に任せ、生成器はユースケース単位のメトリクスだけを足す（§6）。

### Gaps
- Bun で require-in-the-middle / import-in-the-middle のフックが確実に動くか、Bun 公式または OTel JS の issue による 2026 年時点の確認は取れなかった。
- `@hono/otel` が `http.route` を記録するかどうかは不明。
- Python の psycopg（v3）・asyncpg 計装が `OTEL_SEMCONV_STABILITY_OPT_IN=database` に対応しているかは、contrib の CHANGELOG で要確認。
- FastAPI/Starlette 計装の 2026 年時点の semconv 準拠状況は未確認。
- 「二重スパンを避けるべき」という主張の公式ソースは未取得（上記は推論）。

---

## 6. 生成すべきメトリクス

### Takeaway
HTTP・DB の RED は自動計装（semconv の Stable メトリクス）に任せる。生成器が足すのは、ユースケース・クエリ・ポリシーの所要時間（秒単位の Histogram、HTTP と同じバケット）、ドメインルール違反の Counter（コード別）、レート制限による拒否の Counter。属性は低カーディナリティの列挙値だけにし、tenant は既定で外す。

### Cited Findings
- HTTP の duration は `s` 単位、バケット `[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]`、`error.type` は条件付き必須 — [semconv HTTP metrics](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)
- 既定のカーディナリティ上限は 2000 で、超えた分は `otel.metric.overflow` に集約される — [Metrics SDK spec](https://opentelemetry.io/docs/specs/otel/metrics/sdk/)
- 計測器は起動時に一度作って参照を保持する。名前で毎回検索するのはアンチパターン — [Don't Wrap OpenTelemetry](https://opentelemetry.io/blog/2026/dont-wrap-opentelemetry/)
- Exemplar の既定は TraceBased で、サンプリングされたスパン中の計測がヒストグラムのバケットにトレース ID 付きで添付される — [Metrics SDK spec](https://opentelemetry.io/docs/specs/otel/metrics/sdk/)

### Inferences（案）
| 名前（案） | 種別 / 単位 | 属性（すべて低カーディナリティ） |
|---|---|---|
| `ddd_presenter.use_case.duration` | Histogram / `s`（HTTP と同じバケット） | `ddd_presenter.use_case.name`、`ddd_presenter.outcome`、`error.type` |
| `ddd_presenter.query.duration` | Histogram / `s` | `ddd_presenter.query.name`、`ddd_presenter.query.kind`（`keyset` / `trgm_search`）、`ddd_presenter.outcome` |
| `ddd_presenter.policy.duration` | Histogram / `s` | `ddd_presenter.policy.name`、`ddd_presenter.event.type`、`ddd_presenter.outcome` |
| `ddd_presenter.domain_rule.violations` | Counter / `{violation}` | `ddd_presenter.use_case.name`、`ddd_presenter.rule.code` |
| `ddd_presenter.rate_limit.rejections` | Counter / `{request}` | `ddd_presenter.rate_limit.policy`（ルール名）、`http.route` |
| `ddd_presenter.auth.failures` | Counter / `{request}` | `ddd_presenter.auth.reason`（`expired`、`invalid_signature`、`forbidden` 等の列挙） |

- 呼び出し回数とエラー率は Histogram の count と `outcome` から導けるので、別の Counter は作らない（RED の R と E を duration ヒストグラム 1 本で賄う）。
- 単位の書き方は UCUM の `s` と `{annotation}`。semconv 全般の慣行に合わせた推論。
- tenant 別の SLO が必要な場合は、opt-in で `ddd_presenter.tenant.id` を付け、View で属性の許可リストとカーディナリティ上限を明示する。上位 N テナントだけ残し、残りを `other` にまとめる処理を生成するのも一案。

### Gaps
- semconv に「ユースケース」や「業務操作」に当たる汎用メトリクスがあるかは未確認。
- pg_trgm 検索のレイテンシ分布に合うバケットの実測根拠は無い（HTTP と同じバケットを流用する前提）。

---

## 7. ログ（相関、Python の logging ハンドラ、Node の pino/winston ブリッジ）

### Takeaway
Logs API・SDK は Python・JS とも Development なので、生成コードは言語標準のロガー（Python `logging`、Node は pino を推奨）に書く。trace_id / span_id の付与と OTLP への送出はブリッジに任せる。ドメインエラーやルール違反の「イベント」は、Span Events ではなくログ（相関付き）で出す方向が OTel の公式な方針になっている。

### Cited Findings
- Python: `opentelemetry-instrument --logs_exporter console,otlp` で、ルートロガーに OTLP ハンドラが付く。ログレコードに `otelTraceID`、`otelSpanID`、`otelTraceSampled`、`otelServiceName` が付与される。1.40.0 より前は `OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=true` が必要だった — [OTel Python zero-code logs example](https://opentelemetry.io/docs/zero-code/python/logs-example/)
- Node: `@opentelemetry/instrumentation-pino` は、(1) ログの相関（アクティブスパンの trace_id / span_id / trace_flags を pino のレコードに注入）と、(2) ログの送出（OTel Logs SDK へ転送）を行い、`disableLogCorrelation` / `disableLogSending` で個別にオフにできる。対応する pino は `>=5.14.0 <10`、送出には pino 7 以上が必要。最新の pino 10.x は範囲外の可能性がある。auto-instrumentations-node に同梱されている — [npm/yarn @opentelemetry/instrumentation-pino](https://classic.yarnpkg.com/en/package/@opentelemetry/instrumentation-pino)、[azukiazusa.dev](https://azukiazusa.dev/blog/instrument-hono-logs-with-opentelemetry)（検索要約経由）
- Span Events は非推奨になり、「events are logs with names」として現在のスパンに相関づけたログで書く — [OTel Blog: Deprecating Span Events](https://opentelemetry.io/blog/2026/deprecating-span-events/)

### Inferences
- 生成コードは構造化ログ 1 件を「ユースケース 1 回の実行につき 1 行」のカノニカルログとして出すのが良い（ワイドイベントの考え方。§3 の Majors/Stripe）。中身は use_case、tenant、outcome、rule.code、duration。スパンと同じ属性名を使えば、バックエンドで突き合わせられる。
- pino のバージョン上限（<10）は、生成するテンプレートの依存バージョンで固定するか、利用時に確認する必要がある。
- winston にも `@opentelemetry/instrumentation-winston` と winston-transport があるはずだが、このセッションでは未確認（Gap）。

### Gaps
- winston のブリッジ（`@opentelemetry/winston-transport`）の現状は未取得。
- Python の `LoggingHandler` のクラスパスと安定度（`opentelemetry.sdk._logs`）の一次ソースは未取得。

---

## 8. 生成した計装のテスト

### Takeaway
ラッパーやポートを使わずに、各 SDK の InMemory エクスポータ（Python: InMemorySpanExporter、JS: `InMemorySpanExporter`）と InMemory のメトリクスリーダーを使い、生成されたテストでスパン名、属性、親子関係、status を検証する。OTel ブログも「テストのためにラッパーは不要」と明言している。

### Cited Findings
- 「テストにラッパーは要らない。各 SDK にはユニットテストで記録済みのテレメトリを検証する `InMemoryExporter` があり、開発中は stdout エクスポータで確認できる」 — [Don't Wrap OpenTelemetry](https://opentelemetry.io/blog/2026/dont-wrap-opentelemetry/)

### Inferences
- 生成テストの雛形（推論）:
  - Python: テストの fixture で `TracerProvider` + `SimpleSpanProcessor(InMemorySpanExporter())` をグローバルに設定する（グローバルの provider は一度しか設定できないので、セッションスコープで設定し、テストごとに `exporter.clear()` する）。ユースケースを実行したら、`use_case PlaceOrder` スパンの存在、`ddd_presenter.outcome`、`ddd_presenter.tenant.id`、ルール違反時の status=ERROR と `ddd_presenter.rule.code` を検証する。
  - TS: `BasicTracerProvider` に `SimpleSpanProcessor(new InMemorySpanExporter())` を付け、`AsyncLocalStorageContextManager` を登録する（未登録だと async 境界で親子関係が切れる）。Bun のテストランナーで動かす場合は、AsyncLocalStorage の互換性を CI で確認する。
  - メトリクスは InMemoryMetricExporter + PeriodicExportingMetricReader（または手動の collect）で、`ddd_presenter.domain_rule.violations` の値と属性を検証する。
  - SDK を入れない no-op 経路でも生成コードが動くこと（API のみに依存していること）を、別のテストで保証する。
- 既存の生成器テスト（golden 出力、pytest、mypy、ruff、typescript-eslint）に「計装ありの fixture」を 1 つ追加し、上記を生成させて実行する形が自然。

### Gaps
- Python の `InMemorySpanExporter` の正確なモジュールパス（`opentelemetry.sdk.trace.export.in_memory_span_exporter`）と、JS の InMemoryMetricExporter の 2026 年時点の API は、このセッションで一次ソースを取得していない（一般知識）。
- Bun テストランナーでの OTel SDK の動作報告は未確認。
