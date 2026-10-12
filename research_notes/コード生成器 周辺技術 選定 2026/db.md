# DB ツール選定: sqlc / sqldef(psqldef) / Atlas ほか — DDD Presenter（PostgreSQL 永続化を Python・TypeScript 向けに生成）, 2026-10 時点

前提（ローカルの事実）: 生成器は `sql/<context>.sql` に「望ましいスキーマ」を出す。中身は `CREATE … IF NOT EXISTS` だけの冪等な文で、マイグレーションは生成しない。差分ツールとして migra・Atlas・pgschema の名前を挙げている（docs/05-generation-and-architecture.md:620）。実際の出力（examples/cleaning-platform/sql/cleaning_staff.sql:11-48）には `CREATE EXTENSION IF NOT EXISTS pg_trgm`、`CREATE SCHEMA IF NOT EXISTS`、`ENABLE` / `FORCE ROW LEVEL SECURITY`、**`DROP POLICY IF EXISTS … ; CREATE POLICY …`**、`USING gin (lower(email_value) gin_trgm_ops)` がある。生成されるアクセスコードの契約は TS が node-postgres の Pool / PGlite（`query(text, values)`）、Python が psycopg 3 の同期 `Connection`（docs/05:613、README.md:218,232）。

## 1. sqlc: Python / TypeScript 対応、プラグイン、生成器の SQL への適合性

### Takeaway
sqlc 本体は活発に開発されている（v1.31.1, 2026-04）。ただし公式の Python プラグインと TypeScript プラグインは事実上停滞している（Python は 2025-01 以降コミットなし、TS は 2024-01 以降リリースなし）。しかも Python プラグインが出すのは SQLAlchemy のコードで、psycopg 3 ではない。動きがあるのはコミュニティの sqlc-gen-better-python（asyncpg / psycopg 対応）くらいだ。生成器はすでに型付きアクセスコードを出しているので、sqlc に置き換える利点は小さい。使うとしても「CI で SQL を検証する」役（`sqlc vet` / `db-prepare`）にとどまる。

### Cited Findings
- **本体の状況**: v1.31.1（2026-04-22）と v1.31.0（2026-04-20）。v1.31.0 では PostgreSQL 向けに DB だけで解析する `analyzerv2` 実験、`SELECT *` / `RETURNING *` の star expander、`parse` サブコマンド（AST JSON）、`SQLCEXPERIMENT` 環境変数が入り、ドキュメントからコミュニティの Python プラグインへリンクされた。v1.30.0 は 2025-09-01、v1.29.0（2025-04-17）ではプロセスプラグインが JSON 出力に対応した — [sqlc releases](https://github.com/sqlc-dev/sqlc/releases)
- リポジトリは MIT・約 1.8 万スター・最終 push は 2026-10-10 — [github.com/sqlc-dev/sqlc](https://github.com/sqlc-dev/sqlc)
- **公式の対応表**: Python（sqlc-gen-python）と TypeScript（sqlc-gen-typescript）はどちらも PostgreSQL / MySQL で「Beta」。コミュニティ欄には rayakame/sqlc-gen-better-python（PostgreSQL は Stable）と fdietze/sqlc-gen-from-template（Stable）が載っている — [sqlc language support](https://docs.sqlc.dev/en/latest/reference/language-support.html)
- **sqlc-gen-python**: 最新は v1.3.0（2025-01-22）。その前の v1.2.0 は 2023-11。最終コミットは 2025-01-23（「bump README to 1.3.0」）。設定項目は `emit_sync_querier` / `emit_async_querier` / `emit_pydantic_models` / `emit_str_enum` — [sqlc-gen-python](https://github.com/sqlc-dev/sqlc-gen-python), [releases](https://github.com/sqlc-dev/sqlc-gen-python/releases)
  - 2026-01 に「Maintained?」という issue が立ち、「2025-08 から PR が放置されている」とコメントされている — [issue #94](https://github.com/sqlc-dev/sqlc-gen-python/issues/94)
  - 未解決の不具合の例: async の `:many` で DML + RETURNING が壊れる（#101, 2026-05）、`sum` の型が誤る（#85）、2 次元配列が 1 次元として型付けされる（#84）— [issues](https://github.com/sqlc-dev/sqlc-gen-python/issues)
  - 生成コードは SQLAlchemy に依存する。`sqlalchemy.engine.Connection` / `sqlalchemy.ext.asyncio.AsyncConnection` / `sqlalchemy.text` を使い、`:` をエスケープする — [internal/gen.go](https://github.com/sqlc-dev/sqlc-gen-python/blob/main/internal/gen.go)（L357-387, L761, L799）。SQLAlchemy なしで生成したいという要望もある — [issue #72](https://github.com/sqlc-dev/sqlc-gen-python/issues/72)
  - 型の対応: `numeric` / `money` → `decimal.Decimal`、`json` / `jsonb` → `Any`、`uuid` → `uuid.UUID`、`timestamptz` → `datetime.datetime`、enum は `models.<Enum>`、未知の型は `Any` — [internal/postgresql_type.go](https://github.com/sqlc-dev/sqlc-gen-python/blob/main/internal/postgresql_type.go)
  - 公式の対応表（「Beta」と掲載）と実際の保守状況（コミット停止、#94 に回答なし）は**食い違っている**。
- **sqlc-gen-better-python**（コミュニティ）: v0.9.0（2026-08-16）、v0.8.0（2026-07-31）。最終コミットは 2026-10-10。MIT。ドライバは asyncpg / psycopg_async / psycopg_sync / aiosqlite / sqlite3 / asyncmy / pymysql / turso（turso は実験的）。モデルは dataclass / attrs / msgspec / pydantic。生成コードは Python 3.12 以上が前提 — [sqlc-gen-better-python](https://github.com/rayakame/sqlc-gen-better-python)
- **sqlc-gen-typescript**: README に「This plugin is still in early access. Expect breaking changes, missing functionality, and sub-optimal output.」とある。ドライバは `pg`、`postgres`（postgres.js）、mysql2、better-sqlite3。PGlite には言及がない — [sqlc-gen-typescript](https://github.com/sqlc-dev/sqlc-gen-typescript)
  - 最新リリースは v0.1.3（2024-01-02）、最終コミットは 2024-11-26 — [releases](https://github.com/sqlc-dev/sqlc-gen-typescript/releases)
  - LICENSE ファイルがない（package.json だけが ISC）— [issue #52](https://github.com/sqlc-dev/sqlc-gen-typescript/issues/52)
  - 未対応の要望: Bun SQL（#68）、型だけの生成（#71）、`sqlc.slice()`（#47）— [issues](https://github.com/sqlc-dev/sqlc-gen-typescript/issues)
  - pg ドライバでの型の対応: `int8` と `uuid` は string（コメント `// string`）、`json` / `jsonb` は `any`、`timestamptz` / `date` は `Date`。`numeric` と enum には専用の case が見当たらない。クエリには `rowMode` を指定して呼んでいる — [src/drivers/pg.ts](https://github.com/sqlc-dev/sqlc-gen-typescript/blob/main/src/drivers/pg.ts)
- **プラグインの仕組み**: プラグインは WASM（例: `sqlc-gen-python_1.3.0.wasm` を sha256 付きで取得）かプロセスプラグイン（JSON 出力に対応, v1.29.0）。v1.29.0 で `wazero` は v1.9.0 になった — [sqlc-gen-python README](https://github.com/sqlc-dev/sqlc-gen-python), [sqlc releases](https://github.com/sqlc-dev/sqlc/releases)
- **DB を使う解析**: `database: managed: true` か `uri` を指定すると、スキーマから使い捨ての DB を作って解析に使う（v1.22.0 から）。ドキュメントには「for more advanced queries sqlc might not have enough information to produce good code」とある。`sqlc vet` の組み込みルール `sqlc/db-prepare` は各クエリを DB で PREPARE して検証する — [managed databases](https://docs.sqlc.dev/en/latest/howto/managed-databases.html)
- **pg_trgm**: sqlc は拡張ごとの関数カタログを同梱している。pg_trgm では `similarity`、`word_similarity`、`similarity_op`、`set_limit`、`show_trgm` などが型付きで入っている。`CREATE EXTENSION` されると読み込まれ、知らない拡張は「何も足さない」扱いになる — [dialect/extensions/pg_trgm/functions.jsonl](https://github.com/sqlc-dev/sqlc/tree/main/internal/engine/postgresql/dialect/extensions/pg_trgm), [extension.go](https://github.com/sqlc-dev/sqlc/blob/main/internal/engine/postgresql/extension.go)
- **行値比較（keyset）**: `WHERE (created_at, id) < (@created_at, @id)` で、2 つ目のパラメータにも 1 つ目の列の型が付く不具合が報告された。closed / not planned で、回避策は `@id::text` のように明示的にキャストすること — [issue #1549](https://github.com/sqlc-dev/sqlc/issues/1549)
- **SET / SET LOCAL**: `SET LOCAL app.x = @p::text` などは構文エラーになる（v1.30.0 で報告、open）— [issue #4186](https://github.com/sqlc-dev/sqlc/issues/4186), [issue #712](https://github.com/sqlc-dev/sqlc/issues/712)。これは `SET` 文の話で、`SELECT set_config(...)` のことではない。
- **動的な絞り込み**: sqlc は動的 SQL を生成しない。`sqlc.narg()`（nullable 名前付きパラメータ）と `@p IS NULL OR col = @p` の静的クエリで代用するのが定番。議論の中では、この書き方は性能面で最悪の部類だという指摘もある — [discussion #364](https://github.com/sqlc-dev/sqlc/discussions/364), [named parameters](https://docs.sqlc.dev/en/latest/howto/named_parameters.html)

### Inferences
- `SELECT set_config('app.tenant_id', $1, true)` は普通の関数呼び出しの SELECT なので、`set_config(text, text, bool)` は pg_catalog から型が付いて通るはず（未検証）。`SET LOCAL` を使わない今の生成器の方針は sqlc と相性がよい。
- `%` 演算子はカタログでは `similarity_op` に当たる。オペランドが text なので、`$1` は text、結果は bool になると思われる（未検証）。`similarity(col, $1) AS score` で並べる書き方は関数カタログで型が付く見込み。
- 生成器はもともと型を知っている（DSL → DDL → 文）ので、#1549 のような型推論のずれは**生成器が常に `$n::type` を付ける**ことで避けられる。逆に言えば、sqlc に推論させる意味は薄い。
- Python 側で公式プラグインを採ると、契約が「psycopg 3 の同期 `Connection`」（docs/05:613）から SQLAlchemy に変わり、依存も増える。better-python は psycopg に対応しているが、スター約 40、v0.x の個人プロジェクトなのでバスファクターが高い。
- TS 側は early access のまま 2 年近く止まっていて、ライセンスも不明確（LICENSE なし）。生成物に組み込む依存としてはリスクが高い。PGlite は `query(text, params, opts)` の形でスキーマ上は近いが、プラグインが渡す `rowMode` 設定で動くかどうかは未検証。
- 「生成器が SQL を出し、sqlc がまた型付きコードを出す」のはコード生成の二重化になる。型の一次情報（DSL）と sqlc の推論結果が食い違うと、どちらを正とするかの問題が出る。sqlc の現実的な役割は「生成された SQL の検証器」（`sqlc vet` + `db-prepare`、または `sqlc compile`）。

### Gaps
- `SELECT set_config(...)`、`%` 演算子、`(a,b) < ($1,$2)`（キャストあり）、`jsonb` を sqlc で実際に通した結果は確認していない（実機で試していない）。
- sqlc-gen-better-python の機能マトリクス（どのドライバでどのクエリコマンドが使えるか）は README の外にあり、見ていない。
- TS プラグインで `numeric` と enum が既定で string になるかはコードの断片から推測しただけで、確定ではない。

## 2. sqldef（psqldef）: 宣言的差分、対応機能、破壊的変更、保守状況

### Takeaway
psqldef は、望ましいスキーマを「素の SQL」で受け取って差分 DDL を出すツールで、2026 年も活発にリリースが続いている（v3.11.26, 2026-10-01）。拡張、RLS（ENABLE / FORCE）、`CREATE POLICY`、演算子クラス付きの式インデックス、CHECK、スキーマ、CONCURRENTLY に対応する。DROP は既定で行わない（safe mode）。`--check` を CI のドリフト検出に使える。生成器の DDL の形に最も合うが、**式インデックスの opclass は v3.11.18（2026-07）以降**が必要。また、出力にある `DROP POLICY IF EXISTS` との相性は確認していない。

### Cited Findings
- **仕組み**: 望ましいスキーマを素の SQL で与えると「compares desired against current schema and generates the appropriate DDLs」。流れは export → 編集 → `--dry-run` → `--apply` で、再実行すると差分なし（冪等）。リネームは `-- @renamed from=old_name` 注釈で表す（テーブル・列・インデックス・ENUM 値）— [sqldef README](https://github.com/sqldef/sqldef)
- **フラグ**:
  - `--dry-run`、`--check`（「Like --dry-run, but exit with code 2 when DDL would be applied (useful as a CI gate to detect schema drift)」）、`--apply`（現在は既定だが、将来は必須になる）、`--export`
  - `--enable-drop`、`--skip-view` / `--skip-extension` / `--skip-partition`、`--disable-ddl-transaction`、`--before-apply=SQL`、`--config` / `--config-inline`
  - [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- **対応機能**:
  - 列の ADD / ALTER / DROP / rename / IDENTITY
  - 制約: PK、FK、CHECK、UNIQUE、EXCLUDE、NULLS NOT DISTINCT
  - インデックス: CONCURRENTLY、INCLUDE、WHERE、COLLATE、operator classes、ASC/DESC、NULLS FIRST/LAST
  - ビュー / マテビュー、CREATE SCHEMA、CREATE/DROP EXTENSION、ENUM と `ALTER TYPE ADD VALUE`
  - GRANT / REVOKE（`managed_roles` が必要）
  - [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- **RLS**: 「Remove the line to DROP POLICY」。`AS` / `FOR` / `TO` を省くと PostgreSQL の既定とみなす。`ENABLE` / `FORCE` の行で管理し、「Remove the `ENABLE ROW LEVEL SECURITY` line to DISABLE ROW LEVEL SECURITY」— [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- **拡張**: 既定では「psqldef manages every extension in the database」。`manage.extension` の正規表現ルールで対象を絞れ、その `drop` の既定は false。`--skip-extension` は現在と望ましいの両方から拡張を外す — [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- **破壊的変更**: 「By default, DROP operations are skipped (safe mode)」。止めた DROP は `-- Skipped: ...` としてコメントで出す。`manage.function` / `manage.privilege` には `drop` が別にある — [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- **インデックスの照合**: 名前のないインデックスと制約は定義で照合する。`create_index_concurrently` を使うと文はトランザクションの外で走り、「A run that creates an index concurrently is therefore not atomic」— [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- **2026 年のリリース（抜粋）**: [sqldef releases](https://github.com/sqldef/sqldef/releases)
  - v3.11.18（07-30）: 式インデックス列の operator class に対応（#1286）、destructive DDL を先頭キーワードで分類（#1297）
  - v3.11.19（08-06）: operator class の変更を検出（#1287）、`manage.function`
  - v3.11.20（08-19）: 関数は CREATE OR REPLACE で更新、ENUM のリネーム、名前のない CHECK を定義で管理
  - v3.11.23（09-17）: opclass を ASC/DESC の前に出力（#1288）
  - v3.11.24（09-25）: `--skip-extension` を全入力に適用（#1338）
  - v3.11.25（09-29）: CONCURRENTLY の対応付け（#1393）、`enable_drop` の誤判定を修正（#1389）
  - v3.11.26（10-01）: `manage.owner`
- 最終コミットは 2026-10-07（「psqldef: detect argument-only changes to a function」）。psqldef のメンテナは @hokaccha と @gfx — [sqldef](https://github.com/sqldef/sqldef), [releases](https://github.com/sqldef/sqldef/releases)
- **ライセンス**: GitHub 上は NOASSERTION。LICENSE ファイルは「For everything except parser: The MIT License (MIT) Copyright (c) 2018 Takashi Kokubun」で始まり、パーサ部分は別ライセンス — [LICENSE](https://github.com/sqldef/sqldef/blob/master/LICENSE)

### Inferences
- 生成器が出す `lower(email_value) gin_trgm_ops` は、v3.11.18 より前の psqldef では差分が正しく出なかった可能性が高い。**最低でも v3.11.19 以降**（opclass の変更検出が入った版）を前提にするのが安全。
- 宣言的な差分ツールにとって、望ましいスキーマの中の `DROP POLICY IF EXISTS` は「状態」ではなく「手続き」なので、パースエラーになるか無視されるかのどちらかになり得る。生成器は「差分ツール向けの純粋な状態ファイル（DROP や DO ブロックのない版）」を別モードで出すのがよい。ポリシーの再作成は差分ツールに任せればよい。
- `--check`（exit 2）は、生成された DDL と稼働中の DB のドリフト検出にそのまま使える。
- 拡張を「全部管理」する既定は、マネージド PG（RDS など）でプロバイダが入れた拡張と衝突しうる。`manage.extension` の target を `pg_trgm` に絞るのが妥当。

### Gaps
- psqldef が `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `DROP POLICY IF EXISTS` を含む入力をどう扱うかは、ドキュメントにもリリースノートにも見つからなかった（実機で往復を試していない）。
- policy / extension 関連の issue を `gh search` で探したが 0 件だった。検索の失敗の可能性が高く、「既知の問題なし」とは言えない。
- パーサ部分のライセンス（LICENSE の後半）は読んでいない。
- カラム型の変更（rewrite を伴う ALTER）を psqldef が警告するかどうかは不明。

## 3. Atlas（ariga）: 宣言的と versioned、lint、RLS 対応とライセンス

### Takeaway
Atlas は宣言的（`schema apply`）、versioned（`migrate diff` / `migrate apply`）、その中間の「versioned authoring」に対応し、desired state は素の SQL ファイルでもよい。ただし配布は **3 層**（Apache-2.0 の Community Edition / MSA の無償バイナリ / Pro 月 9 ドル・席）に分かれる。**RLS ポリシー、拡張、関数、トリガ、ドリフト検出、PG のロック系 lint（PG1xx / PG3xx）は Pro**。この生成器の DDL（pg_trgm と CREATE POLICY）を扱うなら、実質的に Pro が前提になる。

### Cited Findings
- **ワークフロー**: 宣言的では「the desired state of the database schema is given as input to the migration engine」。versioned では変更をファイルに書く。versioned authoring では Atlas が計画した差分をファイルに書き出し、人がレビューできる。`schema apply` は既定で承認を求め、review policy と lint 診断を組み合わせられる。desired state は「HCL schema files, SQL schema files, another database」や ORM プロバイダ — [declarative vs versioned](https://atlasgo.io/concepts/declarative-vs-versioned)
- **dev database**: 「a temporary, isolated database instance that Atlas uses as a sandbox」。`--dev-url "docker://postgres/15/dev?search_path=public"` の形で指定し、望ましいスキーマを同じエンジンで正規化して、不要な差分を防ぐ — [dev database](https://atlasgo.io/concepts/dev-database)
- **lint の analyzer**: [lint analyzers](https://atlasgo.io/lint/analyzers)
  - Pro 表示なし: DS101-103（schema / table / column の drop）、BC101-104（rename / drop）、MF101-104（unique 追加、NOT NULL 化など）
  - Atlas Pro: PG101-109（非 CONCURRENT のインデックス作成・削除、`atlas:txmode none` がない、PK / UNIQUE / EXCLUDE の追加）と PG301-312（rewrite を伴う型変更、NOT VALID のない CHECK / FK、volatile DEFAULT など）
- **ライセンス層**:
  - 機能表では、RLS / policies・拡張・関数・トリガ・ドリフト検出・PG のロック系 lint が Pro。基本の lint ルール（destructive / backward-incompatible / data-dependent）は Open。コアは Apache 2.0。Pro は月 9 ドル・席、30 日の試用あり — [Atlas features](https://atlasgo.io/features)
  - Community Edition は「built directly from the Atlas GitHub repository and is licensed under the Apache 2.0 license」。標準の配布物は「free to download and use under the terms of the Atlas MSA」。CE には `migrate lint`、`schema lint` / `plan`、承認ポリシー、ドリフト検出、views / triggers / functions / RLS / extensions / sequences などが**ない** — [community edition](https://atlasgo.io/community-edition)
  - 機能表で「基本 lint は Open」とあるのは「無償の公式バイナリ（MSA）では使える、CE（Apache ビルド）にはない」という意味だと読むと、両ページの記述は矛盾しない。
- **HCL**: `row_security { enabled = true / enforced = true }`（FORCE）は Pro 表示なし。`policy` ブロック（`on` / `for` / `to` / `using` / `check` / `as`、`for_each` で複数テーブルに適用）と `extension` ブロックは「[Atlas Pro Feature]」で、`atlas login` が必要 — [Atlas HCL](https://atlasgo.io/atlas-schema/hcl)
- **リリース**: v1.3.0（2026-08-02）、v1.2.0（2026-04-10）。最終コミットは 2026-10-11 — [ariga/atlas releases](https://github.com/ariga/atlas/releases)

### Inferences
- 無償の範囲で生成器の SQL を desired state にすると、`CREATE EXTENSION` と `CREATE POLICY` は扱えない。それらが計画から黙って落ちるのか、エラーになるのかは検証が必要（推測）。RLS 前提のテナント分離では、ポリシーが落ちることは安全性の問題になる。
- Atlas の強みは、versioned authoring と `migrate lint`（PG1xx / PG3xx を含む）、CI の承認フロー。「ロックを伴う変更を CI で止める」ことを重視するなら、Pro の費用に見合う。
- sqldef との比較: sqldef は無償で RLS / extension / opclass を扱え、`--check` でドリフトも検出できる。その代わり lint（ロックの危険度の分類）や承認ワークフローは持たない。Atlas は Pro で両方そろう。

### Gaps
- Pro でない状態で policy 入りの SQL を desired state にしたときの挙動（エラーか無視か）は確認していない。
- Atlas の SQL パーサが `DROP POLICY IF EXISTS` や `IF NOT EXISTS` を desired state として受け付けるかは確認していない（dev DB で実行して正規化するので通る可能性はある。推測）。

## 4. 代替候補: Drizzle / Kysely、SQLAlchemy + Alembic、pgschema、migra、pgroll / reshape、Flyway / Liquibase

### Takeaway
TS / Python の ORM 系ツール（drizzle-kit、Alembic autogenerate）は「スキーマの一次情報を ORM のコードに置く」設計で、生成器が DDL の一次情報を持つ今の方針と競合する。PostgreSQL 専用の宣言的差分ツールとしては、pgschema（Apache-2.0、FORCE RLS と CONCURRENTLY に対応）が sqldef の対抗馬になる。docs/05 が挙げている migra は **DEPRECATED** だ。ゼロダウンタイムの expand / contract には pgroll（活発）と reshape（2026-09 にリリース再開）があるが、FORCE RLS とは注意が必要な組み合わせになる。Liquibase は 2025 年以降 **FSL**（非 OSS）になっている。

### Cited Findings
- **Drizzle**:
  - `pgPolicy`（`as` / `to` / `for` / `using` / `withCheck`）と `pgTable.withRLS()` に対応する。ドキュメントには FORCE ROW LEVEL SECURITY の記載がない。drizzle-kit はロールを既定では管理しない（`entities.roles`）— [Drizzle RLS](https://orm.drizzle.team/docs/rls)
  - インデックスは `.using('btree', …, sql\`lower(...)\`, col.op('text_ops'))` と `.concurrently()`、CHECK は `check(name, sql…)` で書く — [Drizzle indexes](https://orm.drizzle.team/docs/indexes-constraints)
  - 0.45.4 が 2026-10-08、Apache-2.0 — [drizzle-orm releases](https://github.com/drizzle-team/drizzle-orm/releases)
- **Kysely**: 型は kysely-codegen（稼働中の DB を読む。PostgreSQL / MySQL / SQLite / MSSQL、PGlite はプログラムから使う形）、kanel-kysely（PostgreSQL 専用で DB を読む）、prisma-kysely から生成する — [Kysely generating types](https://kysely.dev/docs/generating-types)。v0.29.6 が 2026-09-16、v0.30.0-beta.2 も出ている — [kysely releases](https://github.com/kysely-org/kysely/releases)
- **Alembic autogenerate**: [Alembic autogenerate](https://alembic.sqlalchemy.org/en/latest/autogenerate.html)
  - 検出できない: テーブル名・列名の変更（drop + add になる）、匿名の制約
  - 名前付き CHECK の検出はオプションで、式の変更は検出しない
  - PK / EXCLUDE の単独追加、シーケンスは未対応
  - 関数 / ビュー / トリガは alembic-utils（サードパーティ）に頼る
- **pgschema**: [pgschema](https://github.com/pgplex/pgschema)
  - 「Terraform-style, declarative Postgres schema migration」。v1.13.1（2026-09-20）、Apache-2.0
  - dump → 編集 → plan → apply（並行変更の検出、lock timeout 制御）
  - PG 14-18。RLS は PERMISSIVE / RESTRICTIVE と ENABLE / DISABLE / FORCE に対応、インデックスは CONCURRENTLY に対応
  - README の対応オブジェクトに拡張は載っておらず、`--schema` 単位で動く
- **migra**: リポジトリの説明が「DEPRECATED: Like diff but for PostgreSQL schemas」 — [djrobstep/migra](https://github.com/djrobstep/migra)
- **pgroll**: [pgroll](https://github.com/xataio/pgroll), [releases](https://github.com/xataio/pgroll/releases)
  - 物理テーブルの上にビューで仮想スキーマを作り、expand / contract する
  - 破壊的な列変更は「新しい列 + backfill + トリガで同期」で行い、クライアントは `search_path` で版を選ぶ
  - PG 14 以上、Apache-2.0。v0.16.3 が 2026-09-08
  - raw SQL 操作は「escape hatch」で、既定では他の操作と同じマイグレーションに入れられない。`onComplete: true` で complete フェーズに実行できるが、`down` と併用できない — [pgroll raw SQL](https://github.com/xataio/pgroll/blob/main/docs/operations/raw_sql.mdx)
  - PG 15 以上ではバージョン付きビューを `WITH (security_invoker = true)` で作り、「any row level security permissions on the underlying table are respected」。PG 14 以下では security_invoker を使えない — [pkg/roll/execute.go](https://github.com/xataio/pgroll/blob/main/pkg/roll/execute.go)
- **reshape**: 「Designed for Postgres 12 and later」。v0.11.2（2026-09-09）で、README は Specific（コーディングエージェント向けクラウド）の宣伝を掲げている。MIT — [reshape](https://github.com/fabianlindfors/reshape), [releases](https://github.com/fabianlindfors/reshape/releases)
- **Flyway / Liquibase**:
  - Flyway のリポジトリは Apache-2.0 — [flyway/flyway](https://github.com/flyway/flyway)
  - Liquibase の LICENSE は「Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2)」 — [liquibase LICENSE.txt](https://github.com/liquibase/liquibase/blob/master/LICENSE.txt)
  - どちらも versioned（手書きの SQL / changelog を順番に適用する）方式。

### Inferences
- Drizzle / Alembic を採ると、スキーマの一次情報が「DSL → 生成器」と「ORM のスキーマ定義」の二重になる。生成器が Drizzle のスキーマや SQLAlchemy のモデルを出す設計に変えるなら別だが、今の「SQL が一次情報」とは合わない。Drizzle は FORCE RLS の記述がない点も弱い。
- Kysely + kysely-codegen は「DB から型を作る」方式なので、生成器が型を持っている状況では冗長になる。
- pgschema はスキーマ単位で動き、拡張は対象外なので、`CREATE EXTENSION pg_trgm` は別の手順（初期化 SQL や `--before-apply` 相当）に出す必要がある。生成器はスキーマ（`cleaning_staff`）ごとに DDL を出しているので、スキーマ単位の動きとは合う。
- docs/05:620 の「migra」は deprecated なので、記述を pgschema / psqldef / Atlas に差し替えるべき。
- reshape は 2026-09 にリリースが再開したが、商用プラットフォームの宣伝と並んでいて継続性は読みにくい。pgroll のほうが無難。

### Gaps
- drizzle-kit が `gin` + `gin_trgm_ops` + 式を往復できるかは、ドキュメントに明記がない（btree の例だけ）。
- pgschema の「Unsupported」ページは読んでいない（拡張や `IF NOT EXISTS` 入力の扱いは不明）。
- Flyway の Community / Teams の機能差（2025-2026）は調べていない。
- reshape の RLS 対応（ビューの security_invoker）は確認していない。

## 5. 分担案「生成器が SQL を出す → sqlc / 差分ツール / pgroll」は妥当か、トレードオフ

### Takeaway
妥当なのは「**生成器は DDL もクエリも型付きアクセスコードも出し続ける（sqlc には置き換えない）**」+「**宣言的差分ツール（psqldef 第一候補、pgschema 次点、予算があれば Atlas Pro）が、生成された desired DDL から計画・適用・ドリフト検出を行う**」+「**pgroll は大きなテーブルで破壊的変更をするときだけ、必要に応じて使う**」の 3 層。sqlc は採るとしても CI の検証器（`vet` / `db-prepare`）止まり。

### Cited Findings
- 生成器は型付きのリポジトリ / リーダーを TS（node-postgres / PGlite）と Python（psycopg 3 同期）向けに出しており、SQL の契約は `query(text, values)` / `execute(query, params)` — docs/05-generation-and-architecture.md:566-613（ローカル）
- 公式の sqlc の Python / TS プラグインは保守が停滞し、Python は SQLAlchemy に依存する — [sqlc-gen-python #94](https://github.com/sqlc-dev/sqlc-gen-python/issues/94), [gen.go](https://github.com/sqlc-dev/sqlc-gen-python/blob/main/internal/gen.go), [sqlc-gen-typescript](https://github.com/sqlc-dev/sqlc-gen-typescript)
- `sqlc vet` + `sqlc/db-prepare` は、DB に PREPARE してクエリを検証する — [managed databases](https://docs.sqlc.dev/en/latest/howto/managed-databases.html)
- psqldef の `--check` は、DDL が適用される状態なら exit 2 を返す（CI のドリフト検出）。DROP は既定でスキップする — [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- Atlas の `migrate lint` と承認ポリシー、ドリフト検出は CE にはなく、PG のロック系 lint は Pro — [community edition](https://atlasgo.io/community-edition), [lint analyzers](https://atlasgo.io/lint/analyzers)
- pgroll は raw SQL 操作の安全性を保証しない — [raw SQL](https://github.com/xataio/pgroll/blob/main/docs/operations/raw_sql.mdx)

### Inferences
- **推奨する分担**:
  1. **生成器**: DSL → (a) 純粋な状態の DDL（差分ツール向け。`IF NOT EXISTS` や `DROP POLICY IF EXISTS` を含まない別モード）と、(b) 今の冪等な bootstrap DDL（新しい DB や PGlite のテスト用）を出す。クエリと型付きアクセスコードもこれまでどおり出す。パラメータには常に `$n::type` のキャストを付ける。
  2. **差分ツール**: psqldef（無償で RLS・FORCE・policy・opclass の式インデックス・拡張に対応。v3.11.19 以上）を第一候補にする。CI で `psqldef --check` を回し、本番では `--dry-run` の結果をレビューしてから `--apply` する。DROP は `--enable-drop` を明示したときだけ行う。拡張は `manage.extension` で pg_trgm に絞る。
  3. **lint / ロック対策**: 無償で済ませるなら、生成器か CI のスクリプトで「`CREATE INDEX` は既存テーブルなら CONCURRENTLY」「CHECK / FK は NOT VALID → VALIDATE」を強制する。予算があるなら Atlas Pro の versioned authoring + `migrate lint`（PG1xx / PG3xx）に乗り換える。
  4. **pgroll**: 列の型変更やリネームを止めずに行う必要があるときだけ使う。PG 15 以上が前提（security_invoker）。backfill と FORCE RLS の相互作用に注意（次の節）。
- **トレードオフ**:
  - sqlc を入れると、型の一次情報が二重になる（生成器の DSL と sqlc の推論）。プラグインの保守リスクも抱え込む。利点は、手書きのクエリを足すときに型を自動で付けられること。
  - 差分ツールに任せると、生成器はマイグレーションを書かずに済む。その代わり、リネーム（`@renamed` 注釈）や段階的な変更（expand / contract）の意図は DDL に乗らない。生成器が DSL のリネーム情報から `-- @renamed from=` を出すと、両者の利点を組み合わせられる。
  - ドリフト検出（psqldef `--check` / Atlas Pro）を CI に入れると、生成物と DB の食い違いを機械的に検出できる。

### Gaps
- 生成器が出す DDL を psqldef / pgschema / Atlas に実際に通し、往復（apply → 再 plan で差分なし）を確認した結果はない。採用前に最小限の検証が必要。

## 6. 注意すべき失敗パターン: RLS ポリシーの差分、拡張の所有者、インデックスのロック、トランザクション DDL

### Takeaway
最大のリスクは、FORCE RLS のせいで、マイグレーションやデータ移行（pgroll の backfill を含む）をテーブル所有者として実行したときに `app.tenant_id` が未設定で 0 行になること（BYPASSRLS を持つロール以外）。次に、非 CONCURRENT のインデックス作成で書き込みが止まること、CONCURRENTLY はトランザクションに入れられず失敗すると INVALID のインデックスが残ること、そして差分ツールが拡張とポリシーを扱えなかったり範囲外にしたりすること。

### Cited Findings
- 「Table owners normally bypass row security as well, though a table owner can choose to be subject to row security with ALTER TABLE ... FORCE ROW LEVEL SECURITY.」「Superusers and roles with the BYPASSRLS attribute always bypass the row security system」「If no policy exists for the table, a default-deny policy is used」 — [PostgreSQL: Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- pg_trgm は「This module is considered "trusted", that is, it can be installed by non-superusers who have CREATE privilege on the current database.」 — [PostgreSQL pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)
- 通常の `CREATE INDEX` は書き込みをブロックする（「if they try to insert, update, or delete rows in the table they will block until the index build is finished」）。`CREATE INDEX CONCURRENTLY` はトランザクションブロックの中では実行できず、失敗すると「invalid」なインデックスが残り、更新のオーバーヘッドだけがかかる。直すには DROP INDEX CONCURRENTLY して作り直すか、REINDEX CONCURRENTLY する — [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)
- psqldef で CONCURRENTLY を使うと、実行は非原子的になる（前の文は commit 済みのまま残る）— [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- Atlas の lint: PG101（非 CONCURRENT のインデックス作成は SHARE ロック）、PG103（`atlas:txmode none` がない）、PG305 / PG306（NOT VALID のない CHECK / FK）、PG301（rewrite を伴う型変更）。いずれも Pro — [lint analyzers](https://atlasgo.io/lint/analyzers)
- psqldef は既定で DB 内のすべての拡張を管理し、ポリシーは「行を消すと DROP POLICY」になる — [cmd-psqldef.md](https://github.com/sqldef/sqldef/blob/master/cmd-psqldef.md)
- Atlas の policy / extension は Pro で、CE は RLS / extensions を持たない — [Atlas HCL](https://atlasgo.io/atlas-schema/hcl), [community edition](https://atlasgo.io/community-edition)
- pgroll のビューが RLS を尊重するのは PG 15 以上（security_invoker）だけ — [execute.go](https://github.com/xataio/pgroll/blob/main/pkg/roll/execute.go)
- 生成器の DDL は `DROP POLICY IF EXISTS` → `CREATE POLICY` で冪等にしている — examples/cleaning-platform/sql/cleaning_staff.sql:36-37（ローカル）

### Inferences
- FORCE RLS のテーブルでは、データ移行や backfill のトリガ（pgroll）を所有者ロールで実行すると、`current_setting('app.tenant_id', true)` が NULL になり、ポリシーの条件が偽になって行が見えない、または更新されない。対策は、マイグレーション専用の BYPASSRLS ロールを用意するか、移行の SQL でテナントごとに `set_config` するか、ポリシーに移行用の例外を入れる（推測）。
- `DROP POLICY IF EXISTS` → `CREATE POLICY` を本番に流すと、その間はポリシーが存在しない。FORCE RLS でポリシーが 0 本なら default deny なのでデータは漏れない（RLS は有効なまま）。ただし同じトランザクションで流さないと、一瞬すべて拒否になる。差分ツールが `ALTER POLICY` / 再作成をどう出すかも確認が必要。
- 拡張の所有者: pg_trgm は trusted なので、データベースの CREATE 権限があれば非スーパーユーザーでも入る（上の出典）。ただし、作ったロールが拡張の所有者になる。差分ツールが DB 内の拡張を「全部管理」すると、プロバイダが入れた拡張（所有者が別）に DROP や ALTER を試みて失敗しうる。`manage.extension` で絞るか、拡張は初期化の手順に分けるのが安全（推測）。
- トランザクション DDL: PostgreSQL の DDL はほとんどトランザクションに入れられるので、psqldef の既定（トランザクション内）は安全。CONCURRENTLY を混ぜると、その部分だけトランザクションの外になり、非原子的になる。インデックス追加は別のデプロイ段階に分けるのが無難。

### Gaps
- RDS / Cloud SQL での拡張所有者の制約は、一次資料で確認していない。
- 各差分ツールがポリシー本文の変更（USING 式の変更）を `ALTER POLICY` で出すのか、DROP + CREATE で出すのかは確認していない。
