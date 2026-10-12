# API 契約技術の選定: OpenAPI 3.1 vs gRPC vs ConnectRPC (2026-10 時点)

前提: DDD Presenter は現在、独自の JSON-over-HTTP 契約を出力している。中身は Zod スキーマ、Web 標準の Request→Response ハンドラ、型付き fetch クライアント、TanStack Query v5 の queryOptions / infiniteQueryOptions / mutationOptions ファクトリ (オブジェクト形式のキー) で、ブラウザ対応が必須。
バージョン情報は 2026-10-12 に `gh release list` / `npm view` で取得した。

## Q1. OpenAPI 3.1 + JSON Schema 2020-12: Zod v4 からの生成、TypeSpec、TanStack Query 向けクライアント生成器、FastAPI、互換性チェック

### Takeaway
OpenAPI 3.1 は既存の Zod 契約から機械的に導出できる。Zod 4 標準の `z.toJSONSchema` (既定は Draft 2020-12) か、zod-openapi 6.x / zod-to-openapi 9.x を使う。FastAPI も 3.1.0 を出力するため、TS と Python の両ターゲットで同じ公開契約を出せる。破壊的変更の検出には oasdiff (Apache-2.0、GitHub Action あり) が使える。一方、第三者の生成器 (hey-api、orval) のクエリキー形式は自前の TkDodo 流オブジェクトキーとは異なるので、使うとしても外部利用者向けの位置づけになる。

### Cited Findings
**Zod 4 ネイティブの JSON Schema 出力**
- 現行の Zod は 4.6.6 — [npm zod](https://www.npmjs.com/package/zod)
- `z.toJSONSchema()` の `target` は既定で Draft 2020-12。Draft-07、Draft-04、OpenAPI 3.0 も選べる — [zod.dev/json-schema](https://zod.dev/json-schema)
- `io` オプション: 既定は出力型。`io: "input"` を指定すると入力型を出す (例: string→number の pipe は既定で `number`、input 指定で `string`) — [zod.dev/json-schema](https://zod.dev/json-schema)
- `bigint` / `date` / `transform` / `map` / `set` は既定で例外になる。`unrepresentable: "any"` にすると `{}` へ落ちる。ハンドラ関数で個別に置換もできる。`override` は生成後の JSON Schema を書き換えるもので、unrepresentable の例外は `override` より先に発生する — [zod.dev/json-schema](https://zod.dev/json-schema)
- `metadata`: レジストリのメタデータが出力へコピーされ、生成キーワードより優先される。`reused: "ref"` で `$defs` へ切り出す。再帰スキーマは既定で `$ref` になる。`z.globalRegistry` を渡すと `id` 付きスキーマ群を相互参照付きで出力する — [zod.dev/json-schema](https://zod.dev/json-schema)

**Zod から OpenAPI を生成するライブラリ**
- zod-openapi
  - Zod 標準の `.meta()` でメタデータを付ける (monkey patch なし)。Zod 4.0.0 以上に対応。サポート対象として明記されているのは OpenAPI `3.1.0` / `3.1.1` — [GitHub samchungy/zod-openapi](https://github.com/samchungy/zod-openapi)
  - `createDocument` に `paths` と `components` を渡す。`.meta({ id })` を付けたスキーマはコンポーネントとして `$ref` 化される — [GitHub samchungy/zod-openapi](https://github.com/samchungy/zod-openapi)
  - リクエスト側は input、レスポンス側は output でレンダリングする。両方で使われたスキーマは 2 つのコンポーネントに分かれ、`outputIdSuffix` / `outputId` で命名を制御する — [GitHub samchungy/zod-openapi](https://github.com/samchungy/zod-openapi)
  - 最新は zod-openapi@6.0.2 (2026-08-31)。6.0.0 は 2026-06-14 — [releases](https://github.com/samchungy/zod-openapi/releases)
- @asteasolutions/zod-to-openapi: 最新 v9.1.0 (2026-07-19)、v9.0.0 は 2026-07-14 — [releases](https://github.com/asteasolutions/zod-to-openapi/releases)
- @hono/zod-openapi
  - 最新 1.6.3。依存は `zod ^4` と `@asteasolutions/zod-to-openapi ^9.1.0`。つまり内部では zod-to-openapi を使っている — [package.json](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/package.json), [npm](https://www.npmjs.com/package/@hono/zod-openapi)
  - 使い方は `createRoute` + `OpenAPIHono`。`c.req.valid('param')` で検証済みの値を受け取る — [hono.dev/examples/zod-openapi](https://hono.dev/examples/zod-openapi)
  - 3.1 の文書は `app.doc31('/docs', { openapi: '3.1.0', ... })` で出す — [README](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md)

**TypeSpec**
- typespec-stable@1.17.0 (2026-10-08)。同じ日に @typespec/versioning と @typespec/xml の 0.87.0 も出ている (コア以外のライブラリは 0.x) — [releases](https://github.com/microsoft/typespec/releases)
- ドキュメント上、Rest / Events / SSE / Streams は "preview" 表記。エミッタとして確認できたのは JSON Schema と OpenAPI3 — [typespec.io emitter docs](https://typespec.io/docs/emitters/openapi3/reference/emitter/)

**TanStack Query 向けのクライアント生成器**
- @hey-api/openapi-ts
  - TanStack Query プラグインがある。生成物は `getPetByIdOptions()` (queryOptions)、`getFooInfiniteOptions()` (infiniteQueryOptions。ページネーション用パラメータを持つ operation に限る)、`addPetMutation()` (mutationOptions) — [heyapi.dev](https://heyapi.dev/openapi-ts/plugins/tanstack-query)
  - クエリキーは `_id`、`baseUrl`、正規化済みパラメータ (`path` など) を持つオブジェクトを配列に入れた形。infinite では `_infinite: true` が付く。`tags: true` でタグも入れられる — [heyapi.dev](https://heyapi.dev/openapi-ts/plugins/tanstack-query)
  - 対応フレームワークは React / Vue / Angular / Svelte / Solid / Preact。Angular は `@tanstack/angular-query-experimental` を使う — [heyapi.dev](https://heyapi.dev/openapi-ts/plugins/tanstack-query)
  - **バージョンは 0.99.0 で 1.0 前**。リリースは日付ベースのタグで、最新は 2026-06-22 — [npm](https://www.npmjs.com/package/@hey-api/openapi-ts), [releases](https://github.com/hey-api/openapi-ts/releases)
- orval
  - `client: 'react-query'` を指定すると、path ごとのフックと `getXQueryOptions` / `getXQueryKey` を出す。キーは path 文字列の配列 (例 `[`/pets/${petId}`]`) — [orval.dev](https://orval.dev/docs/guides/react-query)
  - `useInfinite` と `useInfiniteQueryParam` で infinite query を出す。`useSkipToken` で skipToken にも対応 — [orval.dev](https://orval.dev/docs/guides/react-query)
  - 最新 v8.41.0 (2026-10-08)。リリース頻度が高い — [releases](https://github.com/orval-labs/orval/releases)
- openapi-typescript 系
  - openapi-react-query は `$api.queryOptions(...)` を提供し、openapi-fetch クライアントを包む — [openapi-ts.dev](https://openapi-ts.dev/openapi-react-query/query-options)
  - infiniteQueryOptions ヘルパーは feature request として issue が立っている — [issue #2462](https://github.com/openapi-ts/openapi-typescript/issues/2462)
  - **openapi-react-query は 0.5.4、openapi-fetch は 0.17.0 (いずれも 2026-02-11) で 1.0 前** — [releases](https://github.com/openapi-ts/openapi-typescript/releases)
- kubb: v5.6.2 (2026-10-11) — [releases](https://github.com/kubb-labs/kubb/releases)
- 参考: TanStack Query v5 は @tanstack/react-query 5.104.2 — [npm](https://www.npmjs.com/package/@tanstack/react-query)

**Python サーバー (FastAPI)**
- FastAPI は PR #9770 で OpenAPI 3.1.0 に移行した ("this uses JSON Schema 2020-12"、Swagger UI 5.x) — [FastAPI release notes](https://github.com/fastapi/fastapi/blob/master/docs/en/docs/release-notes.md)
- Pydantic v2 では入力と出力でスキーマを分ける (`Item-Input` / `Item-Output`)。0.102.0 以降は `separate_input_output_schemas=False` で 1 つにまとめられる — [fastapi.tiangolo.com](https://fastapi.tiangolo.com/how-to/separate-openapi-schemas/)

**互換性チェックとファジング**
- oasdiff
  - サブコマンドは `breaking` (クライアントを壊す変更のみ)、`changelog`、`diff`。ルールは `checks` で一覧でき、カスタマイズもできる — [GitHub oasdiff](https://github.com/oasdiff/oasdiff)
  - GitHub Action (oasdiff-action) がある。ライセンスは Apache-2.0。OpenAPI 3.1 / 3.2 対応についてはドキュメントへのリンクがある — [GitHub oasdiff](https://github.com/oasdiff/oasdiff)
  - 最新の安定版は v1.33.0 (2026-10-01)。v1.33.1 はまだ rc — [releases](https://github.com/oasdiff/oasdiff/releases)
- Schemathesis (ファジング。リンクのみ): https://github.com/schemathesis/schemathesis

### Inferences
- DDD の値型の扱い (推論)
  - Instant と Decimal は、Zod 側で `z.date()` や `transform` を使っていると `z.toJSONSchema` が例外を投げる。ワイヤー契約では文字列にする (Instant は RFC 3339 の `format: date-time`、Decimal は pattern 付き文字列) か、`io: "input"` や `unrepresentable` ハンドラで扱う必要がある。
  - ブランド型 ID は JSON Schema 上では基底型 (string や uuid) に潰れる。区別を残したいなら `.meta({ id: "OrderId" })` で名前付きコンポーネントにするのが現実的。
- 判別共用体のイベントは、Zod の discriminatedUnion から `oneOf` / `anyOf` と `discriminator` に落ちるはず。ただし実際の出力形式は未検証 (Gaps 参照)。
- input / output の分割は zod-openapi と FastAPI の両方が行うが、命名が違う (`outputIdSuffix` と `-Input` / `-Output`)。TS 出力と Python 出力の仕様を oasdiff で比べる場合、コンポーネント名を正規化するか、生成器側で命名規則を揃える必要がある (推論)。
- ジェネレータ自身が Zod 契約からパス・メソッド・スキーマを全部知っているので、hono/zod-openapi のようなフレームワーク依存は不要。zod-openapi の `createDocument`、または `z.toJSONSchema` と自前の paths 組み立てで、静的な `openapi.json` を出力物に加えるのが最も軽い (推論)。
- 第三者の生成器 (hey-api / orval / openapi-react-query) のキー形式はどれも既存のオブジェクトキーと互換がない。社内のフロントは既存の自前ファクトリを使い続け、OpenAPI は外部利用者 (他言語 SDK や第三者フロント) 向けとするのが整合的 (推論)。

### Gaps
- oasdiff の `--fail-on` による終了コードの挙動と、3.1 対応の成熟度は、リンク先ドキュメントを読んでいないため未確認。
- Optic の 2026 年時点の状況は調べていない。
- kubb の TanStack Query プラグインの詳細 (キー形式、queryOptions) は未確認。分かっているのはバージョンだけ。
- openapi-react-query の infinite 対応の現状は不明。issue #2462 は要望段階として見えている。
- `z.toJSONSchema` が discriminatedUnion を `oneOf` と `anyOf` のどちらで出すか、`discriminator` を付けるかは未確認。
- TypeSpec の OpenAPI3 エミッタが対応する `openapi-versions` (3.1 / 3.2) は、ページが途中で切れて確認できなかった。
- TypeSpec の protobuf エミッタが存在するか、存在するならどの程度安定しているかも、同じ理由で未確認。

## Q2. gRPC: ブラウザ対応、HTTP/2、ストリーミング、スキーマ進化、buf

### Takeaway
素の gRPC はブラウザから直接は呼べない。gRPC-Web でも、サーバー側の対応か Envoy などのプロキシが必要になり、ブラウザからは client streaming と双方向ストリーミングが使えない。そのため、ブラウザ必須の本ジェネレータで素の gRPC を主契約にする理由は薄い。protobuf の進化管理と `buf breaking` は優秀で、ブラウザ向けに JSON を使うなら最低 `WIRE_JSON` を選ぶべき。

### Cited Findings
**ブラウザと gRPC-Web**
- gRPC-Web を使うには、サーバー側に gRPC-Web 対応を入れるか、Envoy などのプロキシで変換する — [InfoQ](https://www.infoq.com/news/2020/06/microsoft-releases-grpc-web-net/), [Kreya blog](https://kreya.app/blog/grpc-web-deep-dive/)
- ブラウザからは client streaming と双方向ストリーミングが使えず、server streaming だけが使える。別オリジンから呼ぶ場合は CORS 設定が要る — [Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/grpc/grpcweb)
- この制約の原因は HTTP/1.x の意味論 (リクエストボディが揃うまでレスポンスを始められない) とする説明がある。ただし公式仕様ではなく一ブログの説明 — [Kreya blog](https://kreya.app/blog/grpc-web-deep-dive/)

**protobuf のスキーマ進化 (ProtoJSON)**
- 64bit 整数は文字列で出力する。Timestamp は RFC 3339 (Z 正規化)。Duration は `"1.5s"` 形式。enum は名前文字列。フィールド名は lowerCamelCase (`json_name` で上書きできる) — [protobuf.dev JSON](https://protobuf.dev/programming-guides/json/)
- presence のないフィールドは既定値のとき出力されない。未知フィールドはパーサが既定で拒否する。そのため、フィールドの追加は読み手を先にデプロイしてから書くのが前提 — [protobuf.dev JSON](https://protobuf.dev/programming-guides/json/)
- JSON にはフィールド名が埋め込まれるので、リネームは難しい。enum のリネームは alias を使って 3 段階で移行する — [protobuf.dev JSON](https://protobuf.dev/programming-guides/json/)

**buf breaking**
- カテゴリは厳しい順に FILE、PACKAGE、WIRE_JSON、WIRE。既定は FILE。JSON は多くのトランスポートで使われるので、WIRE_JSON を最低ラインとして推奨している — [buf.build/docs/breaking/rules](https://buf.build/docs/breaking/rules/)
- CI では `buf breaking --against '.git#branch=main'` を使う。GitHub Action `bufbuild/buf-action` もある。BSR 側でも破壊的変更のレビューフローがある — [buf.build/docs/breaking](https://buf.build/docs/breaking/)
- buf CLI の最新は v1.73.0 (2026-09-11) — [releases](https://github.com/bufbuild/buf/releases)

**Decimal**
- protobuf の標準型に decimal はない。googleapis の `google.type.Decimal` は文字列フィールド 1 つで値を表し、正規化が推奨されている — [Google common protos Decimal](https://docs.cloud.google.com/java/docs/reference/proto-google-common-protos/latest/com.google.type.Decimal)

### Inferences
- 素の gRPC (HTTP/2 + trailers) をブラウザ向けに使うと、プロキシの運用負担が増える。ブラウザ用途では、後述の Connect がプロキシなしで unary / server streaming を扱え (gRPC-Web も話せる)、この点で有利。
- WIRE カテゴリだけで検査すると、バイナリ上は安全でも JSON を壊すリネームを見逃す。ブラウザが JSON を使う以上、`WIRE_JSON` 以上が必須 (推論)。

### Gaps
- Python の gRPC エコシステム (grpcio、betterproto など) の 2026 年時点の状況は未調査。
- grpc.io の公式ドキュメントで gRPC-Web の現行仕様と Envoy 設定は確認していない (上記は二次情報を含む)。
- ブラウザで双方向ストリーミングを可能にする Fetch の duplex ストリーミングが普及したかどうかは、確かな一次情報が見つからなかった。

## Q3. ConnectRPC: プロトコル、connect-es v2、connect-python の成熟度、connect-query、サーバー側アダプタ

### Takeaway
Connect プロトコルの unary RPC は HTTP/1.1 上の素の POST (JSON または protobuf) なので、プロキシなしでブラウザから呼べる。同じサーバーで gRPC と gRPC-Web も話せる。connect-es は v2.2.0 で安定しており、connect-query (v2.3.1) が TanStack Query と統合する。ただし unary のみ対応で、キーは独自形式。**connect-python (PyPI `connectrpc`) は 0.12.1 でまだ 1.0 前**。Web 標準の Request→Response で動かすための公開アダプタパッケージはないが、低レベル API を使えば自分で組み立てられる。

### Cited Findings
**プロトコル**
- Connect は HTTP のバージョンに依存しない。unary、client streaming、server streaming は HTTP/1.1 でも HTTP/2 でも動き、双方向ストリーミングだけ HTTP/2 が必要。trailers は使わない — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/)
- unary は POST で、パスは protobuf スキーマから決まる。ボディは素のメッセージ (`application/json` または `application/proto`)。ステータスは意味のある HTTP コードを返す — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/)
- `idempotency_level = NO_SIDE_EFFECTS` を付けた RPC は GET (クエリパラメータにメッセージを載せる) で呼べ、ブラウザや CDN でキャッシュできる — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/)
- エラーは JSON の `{code, message?, details?}`。details は型付き protobuf メッセージを base64 で入れる。HTTP ステータスとの対応: invalid_argument=400、unauthenticated=401、permission_denied=403、not_found=404、resource_exhausted=429、unimplemented=501、unavailable=503、deadline_exceeded=504、canceled=499、それ以外は 500 — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/)
- ストリーミングは常に HTTP 200 を返し、エラーは end-stream メッセージで伝える — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/)

**connect-es (TypeScript)**
- 最新 v2.2.0 (2026-09-07)
  - サーバー向けに `requestGate` が追加された。ヘッダ受信後、メッセージを読む前に拒否できる — [release v2.2.0](https://github.com/connectrpc/connect-es/releases/tag/v2.2.0)
  - Node.js 20 のサポートを終了した — [release v2.2.0](https://github.com/connectrpc/connect-es/releases/tag/v2.2.0)
  - `readMaxBytes` の設定を推奨している — [release v2.2.0](https://github.com/connectrpc/connect-es/releases/tag/v2.2.0)
- @bufbuild/protobuf (protobuf-es v2 系) は 2.16.0 — [npm](https://www.npmjs.com/package/@bufbuild/protobuf)
- 公式のサーバーアダプタは connect-node、connect-fastify、connect-express、connect-next (ドキュメントには「Next.js 13」と書かれているが古い可能性がある)
  - Node http と Fastify は HTTP/2 で全プロトコル・全 RPC 種別に対応する — [server plugins](https://connectrpc.com/docs/node/server-plugins/)
  - Express と Next.js は HTTP/2 不可で、Connect と gRPC-Web のみ — [server plugins](https://connectrpc.com/docs/node/server-plugins/)
- Fetch 系の部品
  - `@connectrpc/connect/protocol` が `createFetchHandler`、`universalServerRequestFromFetch`、`universalServerResponseToFetch` を export している — [universal-fetch.ts](https://github.com/connectrpc/connect-es/blob/main/packages/connect/src/protocol/universal-fetch.ts)
  - リポジトリ内の Cloudflare conformance テスト用ハンドラが `createConnectRouter` とこれらを組み合わせている (公開された Workers アダプタではない)。また `@connectrpc/connect-cloudflare` は `"private": true` で、npm には公開されていない — [connect-cloudflare handler.ts](https://github.com/connectrpc/connect-es/blob/main/packages/connect-cloudflare/conformance/handler.ts), [packages](https://github.com/connectrpc/connect-es/tree/main/packages)
  - v2.2.0 で Cloudflare 上の gRPC conformance テストが有効になった — [release v2.2.0](https://github.com/connectrpc/connect-es/releases/tag/v2.2.0)

**connect-python**
- PyPI 名は `connectrpc`
  - WSGI / ASGI の両方に対応する。クライアントは同期と非同期 (`pyqwest` ベース) — [README](https://github.com/connectrpc/connect-python)
  - Connect、gRPC、gRPC-Web を HTTP/1.1 と HTTP/2 で話す。server / client / 双方向ストリーミングに対応する。公式 conformance テストで検証済み — [README](https://github.com/connectrpc/connect-python)
  - コード生成は `buf.build/bufbuild/py` と `buf.build/connectrpc/py` のリモートプラグインで行う — [README](https://github.com/connectrpc/connect-python)
  - リポジトリは `connectrpc/connect-py` にリネームされている (リリース URL は connect-py 側) — [README](https://github.com/connectrpc/connect-python)
- **最新は v0.12.1 (2026-09-04) で 1.0 前**。v0.11.1 は 2026-07-15 — [releases](https://github.com/connectrpc/connect-py/releases)
- v0.12.0 には挙動の破壊的変更が 2 つある。受信メッセージの既定上限が無制限から 4MB になった (`read_max_bytes`)。JSON の未知フィールドを許容するようになった — [release v0.12.0](https://github.com/connectrpc/connect-py/releases/tag/v0.12.0)
- 2025 年の issue では、alpha を 2025-07 に出したこと、connecpy をベースに 0.5.0 から再出発したこと、当面 alpha として開発を続けることが書かれている — [issue #2](https://github.com/connectrpc/connect-python/issues/2)
- 食い違いに注意: piwheels には別のパッケージ名 `connect-python` の 0.9.0 (2026-03-19) が載っているが、これは旧名・別パッケージで、`connectrpc` とは異なる — [piwheels connect-python](https://www.piwheels.org/project/connect-python), [piwheels connectrpc](https://www.piwheels.org/project/connectrpc/)
- Buf ブログの Connect タグには Connect-ES 2.0 と Connect-Swift 1.0 (2024-11) の記事はあるが、Python 1.0 の告知は見当たらない — [buf.build/blog-tag/connect](https://buf.build/blog-tag/connect)

**connect-query (TanStack Query 統合)**
- 最新 v2.3.1 (2026-08-09)。v2.3.0 は npm に上がらず、v2.3.1 として再リリースされた — [releases](https://github.com/connectrpc/connect-query-es/releases)
- 関数とキーの仕組み
  - `createConnectQueryKey` は `"connect-query"` で始まるキーを作る。キーにはスキーマ、transport、input、cardinality が入る。サービス単位の部分キーで絞り込みもでき、DataTag 付きなので `getQueryData` / `setQueryData` が型安全 — [GitHub connect-query-es](https://github.com/connectrpc/connect-query-es)
  - `createQueryOptions` は `queryKey` / `queryFn` / `structuralSharing` を返す。infinite には `createInfiniteQueryOptions` があり、`pageParamKey` と `getNextPageParam` が必要。`useMutation` もある — [GitHub connect-query-es](https://github.com/connectrpc/connect-query-es)
- **"Connect-Query currently only supports Unary RPC methods"**。`createProtobufSafeUpdater` は deprecated — [GitHub connect-query-es](https://github.com/connectrpc/connect-query-es)
- コード生成は protoc-gen-es が必須。protoc-gen-connect-query は任意 — [GitHub connect-query-es](https://github.com/connectrpc/connect-query-es)

### Inferences
- Bun、Hono、Next の Route Handler で Connect を動かすには、`createConnectRouter` と `universalServerRequestFromFetch` / `universalServerResponseToFetch` で Request→Response 関数を自作することになる。公式に公開されたアダプタはないので、保守責任は自分で持つことになる (推論)。
- connect-python は機能面 (conformance 合格、ストリーミング、WSGI / ASGI) では充実している。ただし 0.x で、0.12.0 のように既定挙動が変わることがあるため、Python ターゲットの本番契約に使うならバージョン固定が前提 (推論)。
- connect-query のキーは `"connect-query"` で始まる独自形式で、ストリーミング非対応。既存のオブジェクトキー方式とは共存はできても統一はできない (推論)。

### Gaps
- connect-python の公式な安定性ラベル (alpha / beta) の現状は、README とリリースノートに明記がなく、未確認。
- Hono 向けの公式または準公式のミドルウェアがあるかは、見つからなかった。
- connect-query がサポートする TanStack Query のバージョン範囲 (peerDependencies) は未確認。
- connect-web (ブラウザ) でサポートされる RPC 種別 (client streaming の可否) は未確認。

## Q4. DDD コード生成器としてのトレードオフ (第二のスキーマ源、値型、エラーモデル、ストリーミング、DX)

### Takeaway
gRPC や Connect を採ると .proto が新しい契約になり、Zod / Pydantic と並ぶ第二のスキーマ源が生まれる。ProtoJSON の規則 (int64 を文字列にする、既定値を省略する、lowerCamelCase、未知フィールドを拒否、RPC 形式の POST パス) は今の Zod JSON 契約とワイヤー互換ではない。OpenAPI は既存の Zod 契約からの派生物として作れて、既存クライアントもそのまま使えるため、ドメインモデルが一元のまま保たれる。

### Cited Findings
- ProtoJSON の規則: int64 は文字列、既定値は省略、lowerCamelCase、未知フィールドは既定で拒否、Timestamp は RFC 3339、enum は名前 — [protobuf.dev JSON](https://protobuf.dev/programming-guides/json/)。ただし未知フィールドの扱いは実装ごとに既定が違う。connect-python は v0.12.0 から JSON の未知フィールドを許容している — [release v0.12.0](https://github.com/connectrpc/connect-py/releases/tag/v0.12.0)
- Connect の unary はスキーマ由来の POST パス。エラーボディは `{code, message, details}` — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/)
- RFC 9457 (RFC 7807 を廃止)
  - メディアタイプは `application/problem+json`。メンバーは `type` (URI、既定は about:blank)、`title`、`status`、`detail`、`instance` — [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
  - 拡張メンバーを足せ、クライアントは知らないメンバーを無視しなければならない — [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
  - 複数の問題があるときは最も重要なものを返すことを推奨し、同種の問題が複数あるなら拡張メンバーの配列で表す — [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
- Zod から JSON Schema に変換するとき、date / bigint / transform は既定で例外になる — [zod.dev/json-schema](https://zod.dev/json-schema)
- protobuf に Decimal の標準型はなく、`google.type.Decimal` (文字列) を使う — [Google common protos](https://docs.cloud.google.com/java/docs/reference/proto-google-common-protos/latest/com.google.type.Decimal)
- ストリーミングの対応範囲
  - Connect: プロトコル仕様上は server / client streaming が HTTP/1.1 でも動き、双方向は HTTP/2 が必要。ただしこれはプロトコルの性質であり、ブラウザ (connect-web) で client streaming が使えるかは未確認。ブラウザの fetch は一般にリクエストボディをストリームできないので、gRPC-Web と同じ制約がかかる可能性が高い — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/)
  - gRPC-Web: ブラウザからは server streaming のみ — [Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/grpc/grpcweb)

### Inferences
**値型の対応表 (推論)**

| ドメイン型 | 現行 Zod / OpenAPI | protobuf / ProtoJSON |
|---|---|---|
| Decimal | pattern 付き string | `google.type.Decimal` (string)。手で import が必要 |
| Instant | `string` + `format: date-time` | `google.protobuf.Timestamp` (RFC 3339)。ワイヤー上はほぼ同じ |
| ブランド型 ID | 名前付き string コンポーネント | `string` か、ラッパーメッセージ (`message OrderId { string value = 1; }`)。ユーザー定義のラッパーメッセージは JSON で必ず `{"value": ...}` になり、これは避けられない (特別な JSON 表現を持つのは well-known types だけ) |
| 判別共用体イベント | `oneOf` + `discriminator` (`type` タグ) | `oneof`。JSON 上はタグフィールドではなくキー名で区別するので、形が変わる |
| int64 / 金額の整数 | number | JSON では string になるため、TS 側の型が変わる |

**エラーモデル (推論)**
- 生成器が持つドメインエラーコードを、1 つの表から 3 つの表現へ出し分けるのがよい。表の列は [ドメインコード, Connect code, HTTP status, problem+json `type` URI]。
- 公開 HTTP では RFC 9457 の problem+json を返し、`code` を拡張メンバーとして入れる。Connect では details に型付きのドメインエラーメッセージを入れる。

**ストリーミング (推論)**
- 現行機能 (CRUD + 無限スクロール) はストリーミングを必要としない。将来ドメインイベントの push が要っても、ブラウザ向けなら SSE で足りる。Connect の server streaming は代替手段の一つにすぎない。

**DX (推論)**
- Connect を採ると、buf のツールチェーン (protoc-gen-es / connect-query / py プラグイン) とそのバージョン管理が増える。生成器自身が .proto を出力しない限り、ドメインモデルが二重管理になる。
- 逆に、生成器が DDD モデルから .proto も出力するなら第二のスキーマ源にはならず、単なる追加の出力ターゲットになる。
- TypeSpec も同じ構図になる。生成器の DDD モデルがすでに唯一の正なので、TypeSpec を source of truth にするとスキーマ源が 3 つ目になる。生成器が TypeSpec を出力する場合に限って意味がある (推論)。
- Connect 側の型は protobuf-es が生成するメッセージで、Zod スキーマではない。既存の Zod 検証は Connect 経路に引き継がれず、検証は protovalidate などへ移ることになる (推論)。

### Gaps
- Zod の discriminatedUnion と protobuf の oneof の対応を、実際に出力して検証してはいない。
- protovalidate (Buf の検証ルール) で Zod の制約 (min / max / regex) をどこまで写せるかは未調査。

## Q5. 推奨と CI で回す互換性チェック

### Takeaway
推奨は 3 点。
1. **公開契約は OpenAPI 3.1 にする**。TS ターゲットは既存の Zod 契約から生成し、Python ターゲットは FastAPI の出力を使う。CI で `oasdiff breaking` を回す。
2. **既存の独自 JSON 契約、自前クライアント、TanStack Query ファクトリは維持する**。第三者生成器のキー形式は既存方式と互換がないため、OpenAPI は外部利用者向けにとどめる。
3. **ConnectRPC は条件付きでオプション扱いにする**。条件は、サービス間の内部通信やストリーミングが必要で、かつ生成器が DDD モデルから .proto を出力する場合 (第二のスキーマ源を作らない)。その場合は CI で `buf breaking --against '.git#branch=main'` (WIRE_JSON 以上) を回す。素の gRPC はブラウザ用途に使わない。

### Cited Findings
- OpenAPI 3.1 の生成経路: Zod 4 の `z.toJSONSchema` (Draft 2020-12 が既定) / zod-openapi (3.1.x 対応) / FastAPI (3.1.0) — [zod.dev](https://zod.dev/json-schema), [zod-openapi](https://github.com/samchungy/zod-openapi), [FastAPI release notes](https://github.com/fastapi/fastapi/blob/master/docs/en/docs/release-notes.md)
- oasdiff の `breaking` と GitHub Action — [GitHub oasdiff](https://github.com/oasdiff/oasdiff)
- buf の WIRE_JSON 推奨と `--against '.git#branch=main'`、`bufbuild/buf-action` — [buf rules](https://buf.build/docs/breaking/rules/), [buf breaking](https://buf.build/docs/breaking/)
- Connect はブラウザから HTTP/1.1 + JSON で、プロキシなしで呼べる。gRPC / gRPC-Web も話せる — [connectrpc.com/docs/protocol](https://connectrpc.com/docs/protocol/), [connect-python README](https://github.com/connectrpc/connect-python)
- 1.0 前・preview のもの
  - connect-python 0.12.1 — [releases](https://github.com/connectrpc/connect-py/releases)
  - @hey-api/openapi-ts 0.99.0 — [npm](https://www.npmjs.com/package/@hey-api/openapi-ts)
  - openapi-react-query 0.5.4 / openapi-fetch 0.17.0 — [releases](https://github.com/openapi-ts/openapi-typescript/releases)
  - TypeSpec の Rest / Streams などは preview — [typespec.io](https://typespec.io/docs/emitters/openapi3/reference/emitter/)
  - oasdiff 1.33.1 は rc — [releases](https://github.com/oasdiff/oasdiff/releases)
- Schemathesis (リンクのみ): https://github.com/schemathesis/schemathesis

### Inferences
**CI で回すチェック案 (推論)**
1. 生成物の golden チェック: 既存の golden 出力に `openapi.json` を加える。
2. 仕様の妥当性検証: 汎用の OpenAPI 3.1 validator でスキーマを検証する (oasdiff の `checks` はルール一覧のコマンドで、仕様の検証器として使えるかは未確認)。
3. 破壊的変更の検出: main にコミットされた仕様と比べて `oasdiff breaking base.json head.json` を実行し、ERROR レベルで失敗させる (終了コードのフラグは要確認)。
4. TS と Python の契約一致: 同じ DDD モデルから出た 2 つの OpenAPI を、コンポーネント名を正規化したうえで `oasdiff diff` し、差分ゼロを確認する。
5. 実装と仕様の整合: 生成したサーバーに対して Schemathesis でプロパティベースのテストを回す (任意、nightly でもよい)。
6. Connect を出す場合: `buf lint` と `buf breaking --against '.git#branch=main'` (`WIRE_JSON` 以上)。加えて、Zod 契約と .proto の両方を同じモデルから再生成した結果が golden と一致することを確認する。

**採用判断の分岐 (推論)**
- 外部公開 API と第三者 SDK が要る → OpenAPI 3.1。最優先で、低コスト。
- 内部のマイクロサービス間通信、多言語、ストリーミング → Connect。ただし Python 側は 0.x のリスクを受け入れる必要がある。
- ブラウザ専用のアプリ → 現行の独自契約で十分。OpenAPI はドキュメントと外部連携のための派生物として追加する。

### Gaps
- oasdiff の `--fail-on` などの終了コード制御は未確認。
- OpenAPI から Connect / .proto への変換、あるいはその逆を行うツール (例: protoc-gen-connect-openapi) の成熟度は未調査。
- 本リポジトリの既存の HTTP 契約のパス設計 (REST 風か RPC 風か) を確認していないため、OpenAPI paths への写像がどれだけ素直かは未評価。
