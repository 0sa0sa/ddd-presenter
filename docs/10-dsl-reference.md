# 10. Model DSL Reference (schema_version 1)

モデルは `*.ddd.yaml` に書く。構造は [JSON Schema](../packages/core/schema/model.schema.json) で公開し、意味（参照・型・Rule式・シナリオの完全性）は `ddd validate` が検査する。完全な例は [examples/cleaning-platform/model.ddd.yaml](../examples/cleaning-platform/model.ddd.yaml)。

## 1. ファイルの骨格

```yaml
schema_version: 1
project: cleaning-platform          # モデルID（マニフェストに記録）
generation:
  package: cleaning_platform        # 生成するパッケージ名（TypeScript では src の下のディレクトリ名）
  src_dir: src                      # 既定 src
  tests_dir: tests                  # 既定 tests
  target: python                    # python（既定）| typescript（§1.1）
  typescript:                       # target: typescript のときの設定
    test_runner: vitest             # vitest（既定）| bun
    api: { base_path: /api }        # 任意。HTTP API と TanStack Query のクライアントを生成する（§1.2）
security: { roles: [...], ... }     # 任意。認証・認可・レート制限（§10）。書くと Use case / Aggregate に authorize が必要
contexts:
  - name: CleaningStaff             # Bounded context（PascalCase）
    description: ...
    subdomain: core                 # 任意。core（競争力の源）| supporting（支援）| generic（汎用・既製品で済む）
    glossary: [{ term, definition }]
    errors: [...]
    enums: [...]
    value_objects: [...]
    aggregates: [...]
    extension_points: [...]
    use_cases: [...]
    policies: [...]                 # イベント → Use case の反応（§8）
    queries: [...]                  # 読み取り: 一覧・検索・ページング（§10）。PostgreSQL の永続化も生成する
relationships: [...]                # コンテキストマップ（§9）
```

### 1.1 生成の対象（`generation.target`）

| target | 生成物 | テスト |
|---|---|---|
| `python`（既定） | Python 3.11+ / Pydantic v2（`mypy --strict` を通る） | pytest |
| `typescript` | TypeScript（strict・ESM）/ Zod v4 / decimal.js（`tsc --noEmit` を strict・`exactOptionalPropertyTypes` で通る） | `typescript.test_runner`: `vitest`（既定）か `bun`（`bun:test`） |

`ddd generate --target typescript`（`diff` も同じ）はモデルの `target` を一時的に上書きする。`ddd init --target typescript` は TypeScript 用のサンプルを作る。target を切り替えると生成するファイルがすべて変わるので、元の target の生成物は stale になる（生成したままのテストは削除され、ソースは `--prune` で消す）。

TypeScript のとき、生成物は `src/<package>/generated/` に、初回だけ `package.json`・`tsconfig.json`・`.prettierrc.json`・`src/<package>/index.ts` を作る（以後は顧客所有）。型の対応:

| モデル | TypeScript | 備考 |
|---|---|---|
| `String` / `Integer` / `Boolean` | `string` / `number`（`z.number().int()`）/ `boolean` | |
| `Decimal` | `Decimal`（decimal.js。28桁・偶数丸め） | 入力は文字列・数値・Decimal。JSON では文字列 |
| `UUID` | `UUID`（ブランド付き文字列、小文字に正規化） | Aggregate / Entity の UUID の識別子は `Id<"Order">` |
| `Ref[Order]` | `Id<"Order">` | 別の Aggregate の ID と混ぜると型エラー |
| `DateTime` | `Instant`（UTC に正規化した `"2026-01-08T10:00:00.000Z"` のブランド付き文字列） | 入力はオフセット付きの ISO 8601 文字列か `Date`。`===` / `<` でそのまま比べられ、JSON でもそのまま。年は 0001〜9999。`Date` が要るところは `toDate(i)` |
| `Date` | `LocalDate`（`"2026-01-31"` のブランド付き文字列） | |
| Enum | 文字列リテラルの union と `as const` のオブジェクト（`InvitationStatus.pending`） | |
| Value Object / コマンド / イベント | Zod スキーマと推論型（凍結したオブジェクト。`EmailAddress.create(...)`） | |
| Entity / Aggregate | 不変のクラス（`X.from(...)` で検証して作る） | |
| `List[T]` | `ReadonlyArray<T>` | |
| `required: false` | `T \| null`（既定 null） | |
| Duration（式の中だけ） | ミリ秒の `number`（`days/hours/minutes`） | |

フィールド・引数・操作の名前は camelCase になる（`accepted_at` → `acceptedAt`。`_` の後が数字なら `_` を残す）。Rule・エラーの `code`・`details.rule` はモデルの名前のまま。TypeScript のときだけ、生成コードが同じ名前で使う型名（`Map` `Promise` `Error` `Record` などの JavaScript の組み込み、`Id` `Instant` `LocalDate` `Entity` などのランタイム、`OrderInput` `EmailAddressSchema` `OrderingEvent` などの生成物）をモデルの型名にするとエラー `reserved-name` になる。フィールド名 `constructor` も使えない。`Omit` `ErrorOptions` と、イベントのスキーマ（`<Event>Schema`、`<Context>EventSchema`）と同じ名前の型、`type` という名前のイベントフィールド（イベントの種類 `"<Context>.<Event>"` を入れるため）も同じエラーになる。

命名: 型（Context / Aggregate / Entity / Value Object / Enum / Error / Event / Command）は PascalCase、それ以外（フィールド・ルール・操作・Use case・シナリオ・ポリシー）は snake_case。Pythonの予約語、`model_` で始まる名前、生成器が使う名前（`identity`, `events` など）は使えない。イベントのフィールド名 `event_type`（生成するイベントが必ず持つタグ）と型名 `AnyEvent`（コンテキストのイベントの共用体）も予約されている。

### 1.2 HTTP API と TanStack Query のクライアント（`generation.typescript.api`）

TypeScript target だけのオプトイン。書かなければ何も変わらない（生成物はバイト単位で同じ）。Python target では無視する。

```yaml
generation:
  target: typescript
  typescript:
    api:
      base_path: /api               # 既定 /api。/ で始め、末尾に / を付けない（/api/v1 など）。接頭辞なしは ""
      client: tanstack-query        # 既定・唯一の値（@tanstack/react-query v5.102 以上）
```

| キー | 値 | 検査 |
|---|---|---|
| `base_path` | `/` で始まり末尾に `/` のないパス（`/api`, `/api/v1`）か `""` | 形が違えば `invalid-value` |
| `client` | `tanstack-query` | ほかの値は `invalid-value` |

生成するもの（詳細と規約は docs/05 §8、設計の理由は docs/09 §18）:

- `src/<package>/generated/api/`（共有）: `contract.ts`（全エンドポイント）、`server.ts`（`createApiHandler`、Web 標準の `Request` → `Response`）、`client.ts`（`createApiClient`）、`queries.ts`（`createApiQueries` / `createApiMutations`: 全コンテキストのクエリファクトリと mutationOptions）、`runtime.ts`（モデルに依存しない部分）、`register.ts`（TanStack Query の `Register` に error の型を登録）。
- `src/<package>/generated/<context>/api/`（コンテキストの隣、縦の配置）: `contract.ts`（JSON 形とエンドポイント）、`queries.ts`（`create<Context>Queries` / `create<Context>Mutations`）。カスタムフックと React の Context は生成しない。
- エンドポイント: Use case ごとに `POST <base_path>/<context>/<use-case>`（入力はコマンドのスキーマ、出力は Use case の戻り値。戻り値がなければ 204）、Aggregate ごとに `GET <base_path>/<context>/<aggregate>/:id`（Aggregate の JSON 形）、クエリ（§10）ごとに `GET <base_path>/<context>/queries/<query>?…`（1ページ分の `{ items, nextCursor }`）。パスの名前は kebab-case（`/api/cleaning-staff/accept-invitation`）。クエリは `generated/api/query-runtime.ts` と、Aggregate のクエリファクトリの `infiniteQueryOptions`（キーは `lists()` の下）になる。
- テスト `tests/generated/<context>-api.test.ts`（ネットワークも DOM も使わず、クライアントの `fetch` を生成したハンドラにつなぐ）。
- 依存: 新しく作る `package.json` には `@tanstack/react-query`・`react`（dependencies）と `@types/react`（devDependencies）が入る。既存のプロジェクトの `package.json` は顧客所有なので書き換えない。手で足す（docs/05 §8 の移行メモ）。

## 2. 型

| 型 | Python | 備考 |
|---|---|---|
| `String` / `Integer` / `Decimal` / `Boolean` | `str` / `int` / `Decimal` / `bool` | |
| `UUID` | `uuid.UUID` | |
| `DateTime` | `pydantic.AwareDatetime` | タイムゾーン必須 |
| `Date` | `datetime.date` | |
| Enum / Value Object / Entity の名前 | 生成クラス | Entityは所属Aggregateの中でのみ使える |
| `List[T]` | `tuple[T, ...]` | 不変 |
| `Ref[Aggregate]` | `UUID` | 別Aggregateは直接保持せずIDで参照 |

`required: false` で省略可能（`T | None`, 既定 `None`）。`{ ... }` の中で `List[X]` を書くときは `type: "List[X]"` と引用符で囲む（囲まないと YAML はリストの始まりと読む。診断はその位置と、引用符で囲んだ書き方を示す）。

YAML のアンカーとエイリアス（`&name` / `*name`）は使えるが、展開が合計50回を超えるとエラー `yaml-aliases` になる（巨大な展開でツールを止めないため）。モデルではふつう必要ない。

制約 (`constraints`): `min_length` `max_length` `pattern`（String）、`min` `max`（数値）、`max_digits` `decimal_places`（Decimal）、`min_items` `max_items`（List）。違反は `ConstraintViolation` になる。

## 3. 要素

```yaml
errors:
  - { name: InvitationNotDeliverable, code: invitation_not_deliverable, message: 表示用メッセージ }
enums:
  - { name: InvitationStatus, values: [pending, accepted, revoked] }   # Python: InvitationStatus.PENDING
value_objects:
  - name: EmailAddress
    fields: [{ name: value, type: String, constraints: { max_length: 254 } }]
    normalize: { value: [strip, lower] }     # 制約より先に適用
    invariants: [...]
aggregates:
  - name: CleaningStaffInvitation
    identity: id                              # UUID / String / Integer
    fields: [...]
    entities: [{ name, identity, fields, invariants }]   # 内部Entity
    invariants: [...]
    state_guards: [...]
    factories: [...]
    operations: [...]
    scenarios: [...]
```

### Invariant

```yaml
- name: expiry_after_creation
  expression: expires_at > created_at
  error: InvalidInvitationWindow
  check_on: [construct, transition]          # 既定は両方
```

`construct` を含むInvariantはすべてのインスタンス化（状態遷移の候補状態を含む）で評価される。`transition` だけのものは操作の候補状態に対して評価される。

違反時のエラーには `details["rule"]` にInvariant名が入る。`construct` を含むInvariantについては、シナリオの値（`given` のAggregate、成功する `construct`、Use caseの入力など）を少しだけ変えて「そのルールだけが最初に破れる」値を探し、見つかれば `tests/generated/test_<context>_invariants.py` にそのオブジェクトを作るテストを生成する（エラーの型と `details["rule"]` の両方を確かめる）。見つからないとき（引数を使う式、Value Objectどうしの比較、制約上破れない式など）はテストを作らず、`ddd rules` では未検証のまま表示する。

### State guard

```yaml
- name: pending_until_expiry
  parameters: [{ name: at, type: DateTime }]
  expression: status == pending and at < expires_at
  error: InvitationNotDeliverable
```

生成コード: `invitation.pending_until_expiry(at).checks() -> bool` と `.assert_holds()`（違反時に `error` を送出）。TypeScript では `invitation.pendingUntilExpiry(at).checks()` と `.assertHolds()`。

### Factory / Operation

```yaml
factories:
  - name: issue
    parameters: [...]
    fields: { id: id, status: pending, created_at: at, ... }   # 必須フィールドをすべて設定
    emits: [{ name: InvitationIssued, fields: [id, email] }]
operations:
  - name: accept
    parameters: [{ name: at, type: DateTime }]   # 内部Entity型の引数は警告（下記）
    require: [pending_until_expiry(at)]      # 操作が自動で assert_holds する
    changes: { status: accepted, accepted_at: at }   # 変更前の状態で評価
    emits:
      - name: InvitationAccepted
        fields: [id, at]                     # 名前: 引数 → 変更後フィールドの順に解決
        # fields: [{ name: x, value: <式> }] で計算値、 when: <式> で条件付き発生
```

操作は `Transition[Aggregate]`（新しいAggregateと発生イベント）を返す。元のインスタンスは変わらない。TypeScript では引数をオブジェクトで渡す（`invitation.accept({ at })`、ファクトリは `CleaningStaffInvitation.issue({ ... })`）。

内部Entity型（`OrderLine`、`List[OrderLine]` など）の引数を持つFactory / Operationは警告 `entity-parameter` になる。Commandの入力は値だけを運び、式でEntityを作ることもできないため、Use caseが渡せるのは読み込んだAggregateがすでに持つEntity（`order.lines` など）だけである。呼び出し側が新しい項目を渡すなら、その値（単純なフィールドかValue Object）を引数にする。そうでなければその操作は手書きコードからだけ呼ぶ。

## 4. Rule式

| 要素 | 例 |
|---|---|
| フィールド・引数・Value Objectのフィールド | `expires_at`, `at`, `email.value` |
| リテラル | `1`, `-1`, `1.5`, `"text"`, `true`, `null`, `[]`, `[1, 2]` |
| Enum値 | `status == pending`（比較相手がEnumなら裸の名前で可）、`InvitationStatus.pending`（常にEnum値を指す） |
| 比較 | `==` `!=` `<` `<=` `>` `>=`（連鎖比較は不可） |
| 算術 | `+` `-` `*` `/`、単項 `-`、括弧（→ 4.1） |
| 論理 | `and` `or` `not`、括弧 |
| null | `accepted_at != null and accepted_at > at`（null確認のあとは非nullとして扱う） |
| 時間 | `placed_at + hours(24)`, `at - placed_at < days(7)`（→ 4.2） |
| コレクション | `sum(lines, item.quantity)`, `any(lines, item.line_id == line_id)`（→ 4.3） |
| 値の組み立て | `Money(amount=total, currency="JPY")`, `with(item, quantity=q)`（→ 4.4） |
| 関数 | `is_empty(x)` `length(x)` `contains(list_or_string, item)` `round(x, 桁)` `min(a, b)` `max(a, b)` |

優先順位（弱い順）: `or` < `and` < `not` < 比較 < `+ -` < `* /` < 単項 `-` < `.`・呼び出し。

使えないもの: 代入、Pythonコード、import、ラムダ、隠れた時計（`now`）、DB・HTTP・ファイル・環境変数。時刻は引数で渡す。

裸の名前はフィールド・引数・入力が優先される。Enum値と同じ名前のフィールドがあると（`status == authorized` で、`authorized: Money` というフィールドもある）、`authorized` はフィールドを指し、型の不一致として報告される。このとき診断はその名前がフィールドに解決されたことを示すので、Enum値は `PaymentStatus.authorized` と書く（フィールド名を変えてもよい）。

Use case の中だけで使えるもの: `clock.now`、`ids.new`、読み込んだAggregateのガード（`invitation.is_open`, `invitation.pending_until_expiry(clock.now)`）、Extension point の呼び出し。

**YAML の書き方の注意**: `{ ... }`（フロー形式）の中では `,` が区切りになるため、引数が2つ以上ある呼び出し（`sum(lines, item.quantity)` など）を含む式はブロック形式で書く（`changes:` の下に `lines: remove_where(...)` と改行して書く）か、全体を引用符で囲む。名前付き引数は `:` ではなく `=` で書く（`Money(amount=1, ...)`。`: ` は YAML の区切りと衝突する）。

### 4.1 算術

| 左 | 演算子 | 右 | 結果 |
|---|---|---|---|
| Integer | `+ - *` | Integer | Integer |
| Integer / Decimal | `+ - *` | Decimal / Integer | Decimal |
| Integer・Decimal | `/` | Integer・Decimal | **常に Decimal**（`7 / 2` は `3.5`。Python では `Decimal(7) / 2` を生成し、float は使わない） |
| Integer・Decimal・Duration | 単項 `-` | | 同じ型 |

- 結果は比較にも、`changes`・ファクトリの `fields`・イベントの `value`・Use case の引数・条件・`let`・`return` にも使える。
- `round(x, 2)` は小数点以下2桁に**四捨五入**（`ROUND_HALF_UP`）した Decimal。桁数は整数のリテラル（0〜28）。金額の端数処理に使う（`decimal_places` の制約があるフィールドに入れる前に丸める）。
- `min(a, b)` / `max(a, b)`: 数値どうし（Integer と Decimal が混ざれば Decimal）、または DateTime・Date・Duration どうし。
- 0 で割ると実行時に Python の `decimal.DivisionByZero` などの例外（Domain Error ではない）になる。0 になりうる値で割る前に、Invariant やガードで防ぐ。
- Value Object や String には使えない。`"+" is not defined for Money and Integer` のようなエラーになり、ヒントで数値のフィールド（`price.amount`）と組み立て方（`Money(amount=..., currency=...)`）を示す。
- Use case の `return` が Integer と Decimal の両方を返すときは Decimal として扱う。

### 4.2 時間（Duration）

`days(n)` `hours(n)` `minutes(n)`（n は Integer）で長さ（Duration）を作る。生成コードは `datetime.timedelta`。

| 式 | 結果 |
|---|---|
| `DateTime + Duration`、`Duration + DateTime`、`DateTime - Duration` | DateTime |
| `DateTime - DateTime` | Duration |
| `Date + days(n)`、`Date - days(n)` | Date（Date には `days(...)` を直接書いたときだけ足し引きできる。時間・分は DateTime で） |
| `Date - Date` | Duration |
| `Duration + Duration`、`Duration - Duration`、`Duration * Integer` | Duration |

Duration どうし・結果の DateTime どうしは比較できる（`at - placed_at < hours(24)`, `at <= delivered_at + days(7)`）。

Duration は式の中だけの型で、フィールド・引数・入力の型には書けない。イベントのペイロードと Use case の戻り値にもできない（締め切りの DateTime を渡す）。

### 4.3 コレクション

リストは不変（Python の `tuple`）。変更する関数は新しいリストを返す。2番目以降の引数が「要素ごとの式」になる関数では、`item` が今の要素を指す（ラムダの代わり）。

| 関数 | 結果 | 例 |
|---|---|---|
| `count(list)` / `count(list, 条件)` | Integer | `count(lines) <= 50`, `count(lines, item.line_id == id) == 0` |
| `sum(list)` / `sum(list, 要素の数値)` | Integer / Decimal（/ Duration） | `sum(lines, item.unit_price.amount * item.quantity)` |
| `any(list, 条件)` / `all(list, 条件)` | Boolean | `any(lines, item.line_id == line_id)`（ID で探す） |
| `append(list, 要素)` | 同じリスト型 | `append(lines, OrderLine(...))` |
| `remove(list, 要素)` | 同じリスト型 | 等しい要素を除く（Entity は識別子で比べる） |
| `remove_where(list, 条件)` | 同じリスト型 | `remove_where(lines, item.line_id == line_id)` |
| `replace_where(list, 条件, 新しい要素)` | 同じリスト型 | `replace_where(lines, item.line_id == line_id, with(item, quantity=quantity))` |

- `[]` は空のリスト。型は置き場所から決まる（`List[OrderLine]` のフィールドの `fields`・`changes`、引数、`append([], x)`）。YAML の `lines: []` はそのまま空リストの式として読む。`[a, b]` も書ける（要素は式）。
- `is_empty` `length` `contains` はこれまでどおり使える。
- 入れ子にすると `item` はいちばん内側の要素を指す。同じ名前の引数・変数・フィールド `item` があるところで要素関数を使うとエラー（どちらの意味か曖昧になるため、外側の名前を変える）。
- 生成コードはリスト内包（`any([item_.line_id == line_id for item_ in self.lines])`、`(*self.lines, line)`、`tuple([...])`）。`len` `sum` `min` `max` `any` `all` `tuple` `item_` は Python の名前を隠すので、引数・Use case の変数には使えない。

### 4.4 値の組み立て（Value Object・Entity）

- `Money(amount=total, currency="JPY")`: 型名に名前付き引数（`フィールド=式`）で値を作る。必須フィールドはすべて書く（省略可能なフィールドは省ける）。構築時の制約・Invariant が検査される。Value Object はどこでも作れる。
- Entity は**所属する Aggregate の中**（ファクトリ・操作・ガード・Invariant・イベント）でだけ作れる。Use case からは作れない。「明細を追加する」は、操作が明細のフィールドを引数で受け取り、`changes` で組み立てる:

```yaml
operations:
  - name: add_line
    parameters: [{ name: line_id, type: Integer }, { name: sku, type: String }, { name: quantity, type: Integer }, { name: unit_price, type: Money }]
    require: [is_open, lacks_line(line_id)]
    changes:
      lines: append(lines, OrderLine(line_id=line_id, sku=sku, quantity=quantity, unit_price=unit_price))
```

  Use case は `unit_price: Money(amount=unit_price, currency=order.currency)` のように Value Object を組み立てて渡せる。Use case の式で Entity を組み立てようとすると、この形を勧めるエラーになる。
- `with(entity, field=式, ...)`: 一部のフィールドを変えた Entity のコピー（不変条件を検査する。Python は `_replace(...)`）。識別子のフィールドは変えられない。Value Object には使えない（新しく組み立てる）。Aggregate は作れず（ファクトリを使う）、`with` でも変えられない（操作を使う）。

## 5. Extension point

```yaml
extension_points:
  - name: is_blocked_email
    parameters: [{ name: email, type: EmailAddress }]
    returns: Boolean
    test_default: false          # 生成テストで使うスタブの既定値
```

`Extensions` Protocol が生成され、実装の雛形 `src/<pkg>/extensions/<context>/extensions.py` は初回だけ作られる（以後は上書きしない）。Domain Rule式からは呼べない。

## 6. Use case

```yaml
- name: accept_invitation
  actor: スタッフ候補
  command: AcceptInvitation
  transaction: required            # required | none
  idempotency_key: request_id      # 同じキーの2回目は記録した結果を返す（下記）
  retry: true                      # 呼び出し側が同じコマンドを再送しうる（idempotency_key が必須）
  authorize: { roles: [candidate], allow_if: principal.email == invitation.email.value }   # security を書いたら必須（§10）
  rate_limit: { requests: 5, per: minute, by: principal }                                  # 任意（§10）
  input: [{ name: invitation_id, type: UUID }]
  steps:
    - load: { aggregate: CleaningStaffInvitation, by: invitation_id, as: invitation, not_found: InvitationNotFound }
    - create: { aggregate: X, factory: issue, as: x, args: { id: ids.new, at: clock.now } }
    - invoke: { target: invitation, operation: accept, args: { at: clock.now } }
    - save: invitation
    - publish: SomethingHappened             # すぐに公開
    - publish_after_commit: InvitationAccepted   # コミット成功後に公開
    - if: { condition: invitation.is_open, then: [...], else: [...] }
    - fail: InvitationNotDeliverable
    - let:                                    # 計算した値に名前を付ける（後の手順で使える）
        name: total
        value: sum(order.lines, item.unit_price.amount * item.quantity) - order.discount
    - return: invitation.id
```

`let` の名前は Use case の中で一意（`as` と同じ。別の if の枝どうしでも重ねない）。`if` の枝の中で付けた名前はその枝の中だけで使える。Aggregate には付けられない（`load` / `create` の `as` を使う）。生成コードは型注釈付きの変数（`total: Decimal = ...`）。`command` `emitted` `after_commit` `self` は生成コードが使うので変数名にできない。

検査: 未定義の変数（枝の外からの `let` の参照を含む）、保存されない変更、先に発生していないイベントの公開、到達できない手順、すべての経路で `return` しているか、複数Aggregateを1トランザクションで変更していないか（数えるのは型ではなく変数。同じ型の2つのインスタンスを変更しても警告 `multi-aggregate-transaction` になる）。

**冪等性（`idempotency_key`）:** 入力フィールド（必須の `String` / `UUID` / `Integer` / `Ref[...]`）を指定すると、生成されるUse caseは `IdempotencyStore` Port を受け取る。

- 実行の最初に `str(command.<key>)` で記録を探し、あれば手順を実行せず（保存も公開もせず）記録した結果を返す。
- 成功した実行の結果だけを記録する。`transaction: required` ではコミットの直前、同じトランザクションの中で記録するので、ロールバックされた実行は記録を残さない。失敗した実行は記録されないので、同じキーで再試行すると手順がもう一度動く。
- Adapterは記録をAggregateと同じトランザクションに保存し、`(use_case, key)` を一意にする（同じキーの同時実行の片方がコミットに失敗するように）。テスト用には `testing.py` の `InMemoryIdempotencyStore` がある。
- 生成テストは、成功するシナリオで同じコマンドをもう一度実行し、同じ結果が返り、イベントが増えないことを確かめる。失敗するシナリオでは記録がないことを確かめる。

**`retry: true`:** 呼び出し側（キューの再配信、HTTPクライアントの再送など）が同じコマンドを送り直しうるという宣言。生成コードは再試行のループを持たない。再試行を安全にするのは `idempotency_key` なので、`retry: true` で `idempotency_key` がないとエラー `missing-idempotency-key` になる。

## 7. シナリオ（生成テスト）

Aggregate:

```yaml
scenarios:
  - name: revoked_invitation_cannot_be_revoked_again
    given: { aggregate: { id: "...", status: revoked, ... } }   # 必須フィールドはすべて書く
    when: { operation: revoke, args: {} }       # または construct: {...} / factory: issue, args: {...}
    then: { raises: InvitationAlreadyClosed }  # state: {...} / emits: [...]
```

Use case:

```yaml
scenarios:
  - name: pending_invitation_is_accepted
    given:
      clock: "2026-01-02T10:00:00+00:00"
      ids: ["..."]                               # ids.new が返す値
      aggregates: [{ type: CleaningStaffInvitation, fields: {...} }]
      extensions: { is_blocked_email: true }
      principal: { id: candidate-1, roles: [candidate], claims: { email: staff@example.com } }   # security のとき（§10）。null で未認証
    when: { input: { invitation_id: "..." } }
    then:
      returns: ...
      raises: ...
      state: [{ aggregate: CleaningStaffInvitation, id: "...", fields: { status: accepted } }]
      emits: [{ event: InvitationAccepted, fields: { id: "..." } }]   # 公開されたイベントを順番通りに比較
```

`then` が空のシナリオはエラー（期待結果が曖昧なものを成功扱いしない）。値はフィールドの型で検査される（UUID形式、タイムゾーン付き日時、Enum値など）。

**どのルールを検証したことになるか（`ddd rules`）:** シナリオが書くのは期待するエラーの型だけなので、そのシナリオの経路でそのエラー型を送出しうるものが**そのルールただ一つ**のときだけ、そのルールのテストとして数える。経路とは、`construct` ならそのクラスと中に持てるValue Object / EntityのInvariant、Operation / Factoryなら `require` のガード・Aggregate自身のInvariant・引数のValue ObjectのInvariant、Use caseならすべての `create` / `invoke` の分に加えて `fail` 手順と `load` の `not_found`（指定がなければ `AggregateNotFound`）である。同じエラーを送出しうるものがほかにもあるシナリオは「not counted」として、競合するものと一緒に表示する（通っても、どのルールが働いたのかを示さないため）。ルールごとに専用のエラーを宣言すると、シナリオがそのまま検証として数えられる。これに加えて、上のInvariantの節で述べた導出テストもそのルールのテストとして数える。

`ddd validate --strict` は警告を失敗として扱うのに加えて、どのテストも検証していないルール（`untested-rule`）、何も送出しないエラー（`unused-error`）、どのUse caseからも呼ばれないExtension point（`unused-extension-point`）を警告する（エディタでは表示しない）。

## 8. ポリシー（イベント → Use case）

「〜されたら〜する」という自動の反応。イベントが起きたら、**そのコンテキストの** Use case を実行する。

```yaml
contexts:
  - name: Staffing
    policies:
      - name: register_staff_on_acceptance        # snake_case
        description: 招待が受諾されたらスタッフとして登録する
        when: CleaningStaff.InvitationAccepted     # 同じコンテキストのイベントは裸の名前、別のコンテキストは Context.Event
        run: register_staff                        # このコンテキストの Use case
        args: { invitation_id: event.id, joined_at: event.at }
```

`args` は Use case の入力名 → 値。書けるもの:

| 値 | 例 | 備考 |
|---|---|---|
| イベントのフィールド | `event.id`、`event.email.value` | Value Object のフィールドはたどれる。省略可能なフィールドは省略可能な入力にだけ渡せる |
| 時計・ID | `clock.now`、`ids.new` | 生成されるハンドラが Clock / IdGenerator を受け取る |
| 値 | `"text"`、`1`、`true`、`pending`（入力が Enum のとき） | |

イベントのフィールドを使った計算（`event.total * 2` など）は書けない。計算は Use case の手順（`let`）に書く。イベントを使わない式（`clock.now + days(7)` など）は書ける。

検査:

- `when` のイベント・コンテキスト、`run` の Use case が存在するか（候補つき）。
- 別のコンテキストのイベントを受けるには、`relationships` に `upstream: <イベントのコンテキスト>`、`downstream: <ポリシーのコンテキスト>` の関係があり、その `events` にイベントが載っていること（FR-002）。ないときは追加する YAML をヒントに出す。
- `args` が Use case の必須入力をすべて埋め、存在しない入力・イベントのフィールドを指さず、型が合うこと。
- コンテキストをまたいで渡せるのは値（String / Integer / UUID / DateTime …）だけ。上流の Value Object・Enum はそのまま渡せない（`event.email.value` のようにフィールドを選ぶ）。
- ポリシーの連鎖がループになる（Use case が、自分を起動したイベントを直接または他のポリシー経由で再び公開する）と警告。

生成物（ポリシーがあるコンテキストだけ）:

- `application/policies.py` — ポリシーごとのハンドラ `<Name>Policy`（`handle(event)` がイベントのフィールドから Command を作って Use case を実行する）、Use case に求める最小の Protocol `<UseCase>Runner`、イベント型 → ハンドラの対応 `subscriptions(...)`。イベントバスへの登録に使う。プロセス内なら `_runtime.dispatch(subscriptions(...), events)` で配送できる。
- 下流は上流が生成したイベントクラスをそのまま import する（published language）。
- `tests/generated/test_<context>_policies.py` — ポリシーごとに、Use case の代わりに入力を記録するテストダブルで対応付けを確かめる。`subscriptions()` 経由の配送も確かめる。

## 9. コンテキストマップ（relationships）

トップレベルに、コンテキスト同士の関係とイベント契約を書く。

```yaml
relationships:
  - upstream: CleaningStaff          # イベントを公開する側
    downstream: Staffing             # 受けて反応する側
    pattern: customer_supplier       # 既定 customer_supplier
    events: [InvitationAccepted]     # 下流が受け取ってよい上流のイベント（イベント契約）
    description: 招待の受諾をきっかけに Staffing がスタッフを登録する
```

| pattern | 意味 |
|---|---|
| `customer_supplier` | 上流が下流の要望を聞いてイベント契約を提供する |
| `conformist` | 下流が上流のモデルを翻訳せずに受け入れる |
| `anticorruption_layer` | 下流が翻訳層を置く。生成物: `policies.py` の `<Upstream>Translator` Protocol と、初回だけ作る `extensions/<context>/translators.py`（顧客所有）。ハンドラは args から作った Command を翻訳層に渡し、返った Command で Use case を実行する |
| `open_host_service` | 上流が公開の連携口を提供する |
| `published_language` | 文書化された共有の形で連携する |
| `shared_kernel` | モデルの一部を共有し、合意して変更する |
| `partnership` | 2つのチームが協調して変更・リリースする |
| `separate_ways` | 連携しない。`events` を書くとエラー |

検査: コンテキストとイベントが存在するか、自分自身への関係、同じ上流・下流の組の重複、`separate_ways` にイベント契約。契約に載っているのにどのポリシーも受けていないイベントは情報として示す。生成される各コンテキストの README には、ポリシーの一覧と Mermaid のコンテキストマップが入る。

## 10. クエリ（読み取り: 一覧・trigram 検索・ページング）

Aggregate を1つ読み、絞り込み・検索・並べ替えをして、1ページずつ返す読み取り（CQRS の Query）。書き込み（Use case）とは別に、コンテキストの `queries:` に書く。決定と出典は docs/09 §19、生成物と SQL の契約は docs/05 §9。

```yaml
queries:
  - name: search_invitations                   # snake_case（生成: SearchInvitationsQuery / …Reader / …Item / …Input）
    description: 招待をメールアドレスで探す
    from: CleaningStaffInvitation               # 読む Aggregate
    authorize: { roles: [admin] }               # security を宣言したら必須（§10.5）。public / authenticated / { roles }
    rate_limit: { requests: 30, per: minute }   # 省略で security.rate_limits.default、none で制限なし
    params:                                     # 型付きのパラメータ。required: true でなければ省略可能
      - { name: status, type: InvitationStatus }
      - { name: created_after, type: DateTime }
    where:                                      # フィルタ。省略可能なパラメータが無いとき、そのフィルタは効かない
      - { field: status, op: eq, param: status }
      - { field: created_at, op: gt, param: created_after }
      - { field: status, op: ne, value: revoked }   # リテラルと比べる（いつも効く）
    search: { param: q, fields: [email.value], mode: trigram, min_similarity: 0.3 }
    order_by:
      - relevance                               # 検索のスコア順（trigram の検索中だけ。いつも desc）
      - { field: created_at, direction: desc }  # 識別子（id）は最後の決め手として自動で付く
    page: { size: 20, max_size: 100 }           # 既定 20 / 100。limit は max_size に切り詰める
    returns: [id, email, status, created_at]    # 射影（トップレベルのフィールド）。省略するとすべて
    scenarios: [...]                            # §10.4
```

| キー | 値 | 検査（エラーのコード） |
|---|---|---|
| `name` | snake_case | 重複・Use case / Aggregate と同じ名前（テストのファイル名が重なる）・`policies` `invariants` `api` `persistence` `queries` `testing` `rows` `postgres`（`duplicate-name` / `reserved-name`）。生成するクラス名（`<Name>Query` `Reader` `Item` `Input` `Page` `Params` `ItemSchema` `InputSchema` `ItemJson` `PageJson`）が既存の型と重なると `duplicate-name` |
| `from` | このコンテキストの Aggregate | `unknown-aggregate`（候補つき） |
| `params` | フィールドと同じ形（`name` `type` `required` `constraints`）。型はプリミティブ・Enum・`Ref[...]` | 他の型は `invalid-type`。`cursor` / `limit`（HTTP で使う）と検索パラメータの名前は使えない（`reserved-name` / `duplicate-name`）。どのフィルタにも使われないと警告 `unused-parameter` |
| `where[].field` | フィールドのパス（`status`、`email.value`） | 無いフィールド `unknown-field`。jsonb の列（省略可能な Value Object・List・Entity の中）は `unqueryable-field` |
| `where[].op` | `eq`（既定）`ne` `lt` `lte` `gt` `gte` | 大小比較は String / Integer / Decimal / DateTime / Date だけ（`invalid-operator`） |
| `where[].param` / `value` / `principal` | パラメータ名 / リテラル / principal のメンバー（`id` か宣言したクレーム。§10.5）のどれか1つ | 無いパラメータ `unknown-parameter`、型の不一致 `type-mismatch`（Integer → Decimal は可）、リテラルはシナリオの値と同じ検査。2つ以上は `invalid-shape`、どれもないと `missing-key` |
| `authorize` | `public` / `authenticated` / `{ roles: [...] }`（§10.5） | `security` を宣言したら必須（`missing-authorize`）、宣言していなければ書けない（`security-not-declared`）。`internal` と `allow_if` は `invalid-authorize`、宣言していないロールは `unknown-role` |
| `rate_limit` | `{ requests, per, by }` / `none`（§11 と同じ） | `public` のクエリで `by: principal` は `rate-limit-without-principal` |
| `search.param` | 検索テキストのパラメータ名（既定 `q`。省略可能な String、200 文字まで） | |
| `search.fields` | String のフィールドのパス（Value Object の String のフィールドも可。1つ以上） | String でない・Value Object そのもの `invalid-type`、jsonb の中 `unqueryable-field` |
| `search.mode` | `trigram`（既定。pg_trgm の類似度）`prefix`（大文字小文字を無視した前方一致）`exact`（大文字小文字を無視した一致） | |
| `search.min_similarity` | 0 < x ≤ 1（trigram だけ。既定 0.3） | 範囲外 `invalid-value`。0.3（pg_trgm の既定の `similarity_threshold`）未満は警告 `trigram-threshold-below-default`（`%` と GIN インデックスを使えず全行で similarity を計算する） |
| `order_by[]` | `{ field, direction }`（`asc` 既定 / `desc`）か、フィールド名だけ。`relevance` | 省略可能なフィールド・並べられない型 `invalid-order`（NULL はキーセットに置けない）、jsonb の中 `unqueryable-field`、重複、`relevance` は trigram の検索があるときだけで desc だけ（`invalid-order`）。識別子のあとのキーは警告 `redundant-order` |
| `page` | `size` ≥ 1、`size` ≤ `max_size` ≤ 1000 | `invalid-value` |
| `returns` | トップレベルのフィールド名（重複なし） | `unknown-field` |

**パラメータの意味**: 省略可能なパラメータを渡さない（`null`）と、それを使うフィルタは効かない（「すべて」）。NULL のフィールドはどのフィルタにも一致しない（SQL と同じ）。検索テキストは前後の空白を除き、空なら検索しない（`relevance` も効かず、残りのキーで並ぶ）。

**並び順**: 宣言したキーのあとに識別子が付く（向きは最後のキーと同じ）。文字列は `COLLATE "C"`（コードポイント順）で並べる（インメモリのリーダーと同じ順になる）。

### 10.1 ページングとカーソル

ページングはキーセット方式（OFFSET を使わない）: 前のページの最後の行の並び順のキーより後ろを読む。1ページは `{ items, nextCursor }` で、`nextCursor` は最後のページで null。

- 入力は `{ ...params, q?, cursor?, limit? }`。`limit` の既定は `page.size`、`max_size` より大きければ切り詰める（エラーにしない）。1 未満は `ConstraintViolation`。
- カーソルは不透明な URL セーフの文字列（`base64url(JSON) + "." + base64url(HMAC-SHA256)`）。中身はキーと、クエリ名・並び順・検索テキスト・パラメータの指紋。別のパラメータ（検索テキスト）で使う、改ざんする、期限切れ、退役した秘密で署名した — どれも `InvalidCursor`（HTTP 400 `invalid_cursor`）。`limit` は指紋に入らない（ページの大きさは途中で変えてよい）。
- 秘密は `HmacCursorCodec({ secrets: [...] })`（Python は `HmacCursorCodec([...])`）で渡す。32 文字以上。先頭の秘密で署名し、どれでも受け付ける（ローテーション）。`ttlSeconds`（`ttl_seconds`）で有効期限を付けられる（既定は無期限）。
- カーソルは発行した実装（TypeScript か Python）の中でだけ有効。

### 10.2 永続化（PostgreSQL）

クエリを宣言したコンテキストは、すべての Aggregate について PostgreSQL のテーブル・リポジトリを生成する（クエリがないコンテキスト・モデルは何も変わらない）。

| モデル | 列 |
|---|---|
| String / Integer / Decimal / Boolean / UUID / DateTime / Date | `text` / `bigint` / `numeric` / `boolean` / `uuid` / `timestamptz` / `date` |
| Enum | `text` と `CHECK (列 IN (...))` |
| `Ref[X]` | X の識別子の型 |
| 必須の Value Object | フィールドごとの列に展開（`email.value` → `email_value`、入れ子も同様） |
| 省略可能な Value Object・List・Entity | `jsonb`（モデルのフィールド名の JSON） |
| `required: false` | NULL を許す |

テーブルは `<context>.<aggregate>`（PostgreSQL のスキーマがコンテキスト）、主キーは識別子、楽観ロック用の `version bigint`。展開した列名が重なる（`email_value` というフィールドと `email.value`）と `column-clash`、`version` に当たるフィールドは `reserved-name`、63 文字を超える列名は `invalid-name`。

### 10.3 検索のモード

| mode | SQL | インデックス | 並び |
|---|---|---|---|
| `trigram` | `lower(列) % lower(q)`（GIN で絞る）かつ `similarity(lower(列), lower(q)) >= min_similarity`。複数の列は最大の類似度 | `USING gin (lower(列) gin_trgm_ops)` | `relevance` で類似度の高い順 |
| `prefix` | `lower(列) LIKE <q をエスケープ> || '%'` | `(lower(列) text_pattern_ops)` | 宣言した順 |
| `exact` | `lower(列) = lower(q)` | `(lower(列))` | 宣言した順 |

### 10.4 シナリオ（生成テスト）

```yaml
scenarios:
  - name: newest_first_across_pages
    given:
      principal: { roles: [admin] }         # 保護されたクエリを実行する principal（§10.5。省略で authorize.roles を持つ既定の principal）
      aggregates:                           # 保存済みの Aggregate（type は省略時 from）。必須フィールドはすべて
        - fields: { id: "...", email: { value: staff@example.com }, status: pending, created_at: ..., expires_at: ... }
    when: { params: { status: pending, q: staff }, limit: 2, pages: 2 }   # すべて省略可（pages 既定 1）
    then:
      items: ["...", "..."]                 # 読んだ全ページの items を順番通り: 識別子、または一部のフィールド { status: pending }
      next_cursor: absent                   # 最後に読んだページの nextCursor: present | absent
```

`then` には `items` か `next_cursor` の少なくとも一方が要る（`ambiguous-scenario`）。値はフィールドの型で検査する。`returns` に識別子がなければ、items は一部のフィールドで書く。クエリのシナリオは結果を確かめるもので、エラーは書けない（認可のエラーのテストは生成される。§10.5）。

生成されるテスト（`tests/generated/<context>-<query>.test.ts` / `test_<context>_<query>.py`）: シナリオごとのテスト（インメモリのリーダー）、`limit` の切り詰め、2件以上を返すシナリオのデータでのページングの性質（1件ずつのページの連結が1回で読んだ結果と同じ順・重複なし・欠けなし）、改ざんしたカーソルと別のパラメータで使ったカーソルの拒否、保護されたクエリでは認可のテスト（§10.5）。コンテキストごとに `persistence` のテスト（行との往復、楽観ロック、カーソルの署名・ローテーション・期限、trigram の類似度が pg_trgm と同じ）も生成する。

### 10.5 クエリの認可（`security` があるとき）

`security`（§11）を宣言したモデルでは、Use case・Aggregate と同じく**すべてのクエリに `authorize` が要る**（既定は拒否。書かないと `missing-authorize`）。決定の理由は docs/09 §21。

```yaml
security:
  roles: [admin, staff, candidate]
  principal:
    id: UUID
    claims:
      - { name: company_id, type: UUID, required: false }

queries:
  - name: company_jobs
    from: Job
    authorize: { roles: [admin, staff] }        # ロールの確認は何かを読むより前
    where:
      - { field: company_id, op: eq, principal: company_id }   # 行を呼び出し元の会社に絞る（SQL でもインメモリでも同じ条件）
      - { field: status, op: eq, param: status }
    order_by: [{ field: posted_at, direction: desc }]
    scenarios:
      - name: own_company_only
        given:
          principal: { roles: [staff], claims: { company_id: "00000000-0000-4000-8000-0000000000c1" } }
          aggregates: [...]
        then: { items: [...] }
  - name: my_applications
    from: Application
    authorize: authenticated
    where: [{ field: candidate_id, op: eq, principal: id }]      # principal.id（JWT の sub）で絞る
  - name: open_jobs
    from: Job
    authorize: public                           # principal なし
    rate_limit: { requests: 30, per: minute, by: ip }
```

| `authorize` | 意味 | 生成される `execute` |
|---|---|---|
| `public` | 誰でも | `execute(input)`（今までどおり） |
| `authenticated` | 認証済みなら誰でも | `execute(input, principal)` |
| `{ roles: [...] }` | いずれかのロールを持つ principal | `execute(input, principal)` |

- `internal` は書けない（クエリは読み取りのエンドポイント。プロセス内の処理はリーダーを直接使う）。`allow_if` も書けない（`invalid-authorize`）: 1行ずつの条件はページを切ったあとの行を落とし、キーセットのページングを壊す。行は `where` の `principal:` で絞る。
- **`where: { field, op, principal }`**: `principal` は `id` か宣言したクレーム（`List[String]` と `roles` は不可）。型はフィールドと同じでなければならない（`Ref[X]` は X の識別子の型と比べる。違えば `type-mismatch`、無いメンバーは `unknown-field`）。省略可能なパラメータと違い**いつも効く**（SQL は `列 = $n` で `IS NULL OR` を付けない）。`required: false` のクレームを持たない principal は、何も読む前に `NotAuthorized`（`details: { action, missingClaim }`）。`security` がない・`authorize: public` のクエリでは書けない（`security-not-declared` / `invalid-principal-filter`）。
- **順序**: `authorize(principal, …)`（なければ `Unauthenticated`、ロールがなければ `NotAuthorized`）→ 絞り込みに使うクレームの確認 → 入力の検証 → カーソルの検証 → 読み込み。
- **カーソル**: 保護されたクエリのカーソルの指紋には principal の id と絞り込みの値が入る。別の principal（同じロール・同じ会社でも）が使うと `InvalidCursor`。
- **HTTP**（TypeScript の `typescript.api`）: 契約の `auth` / `rateLimit` と `errors` の `unauthenticated: 401` / `not_authorized: 403`。ハンドラが資格情報のない要求に 401（`WWW-Authenticate: Bearer`）、使い切った制限に 429（`Retry-After`・`RateLimit`）を返し、principal をクエリに渡す。レート制限のポリシー名はクエリ名（`read_<aggregate>` と同じ名前のクエリは `duplicate-name`）。クライアントと `infiniteQueryOptions` の形は変わらない（トークンは `getToken`）。
- **シナリオ**: `given.principal`（`{ id, roles, claims }`）で実行する。省略すると `authorize.roles` を持ち、クレームが既定値（省略可能なものは null）の principal。必要なロールを持たない principal、`null`（未認証）、絞り込みに使うクレームのない principal はエラー（`invalid-scenario`。それらのエラーは生成テストが確かめる）。`public` のクエリの `given.principal` は警告 `unused-principal`。
- **生成テスト**: 未認証で `Unauthenticated`、ロールのない principal で `NotAuthorized`（必要なロール）、絞り込みのクレームのない principal で `NotAuthorized`（`missingClaim`）— どれも読み込むと失敗するリーダーで、何も読む前に拒否されることを確かめる。カーソルを別の principal で使うと `InvalidCursor`。HTTP では 401（challenge 付き）・403・429。

## 11. 認証・認可・レート制限（`security`）

トップレベルの `security` を書くと、Principal（呼び出し元）の型、Use case・Aggregate の読み取り・クエリ（§10.5）の認可、HTTP API の認証とレート制限を生成する（決定の理由と出典は docs/09 §20、生成物とエラーの対応は docs/05 §8）。書かなければ生成物は以前とバイト単位で同じ。

```yaml
security:
  roles: [admin, staff, candidate]          # 宣言したロールだけを authorize.roles / has_role で使える
  principal:
    id: UUID                                # principal.id の型: String（既定。JWT の sub）/ UUID
    claims:                                 # allow_if で principal.<name> として読める
      - { name: company_id, type: UUID, required: false, claim: "https://example.com/company_id" }
      - { name: email, type: String, required: false }
  authentication:
    scheme: bearer_jwt                      # bearer_jwt（既定）| custom（Authenticator を自分で書く）
    issuer: https://auth.example.com/       # 期待する iss（実行時に上書きできる）
    audience: hiring-api                    # 期待する aud（実行時に上書きできる）
    algorithms: [RS256]                     # 既定 [RS256]。none は不可。HS* と公開鍵方式は混ぜない
    roles_claim: roles                      # ロールを読むクレーム（リストか空白区切りの文字列）
    clock_tolerance: 30                     # exp / nbf の許容するずれ（秒。0〜300、既定 30）
  rate_limits:
    default: { requests: 60, per: minute, by: principal }   # rate_limit のないエンドポイントの制限

contexts:
  - name: Hiring
    aggregates:
      - name: Job
        authorize:                          # 識別子で読む（生成する読み取り・GET）ことを許す相手
          roles: [admin, staff]
          allow_if: has_role(principal, admin) or (principal.company_id != null and principal.company_id == company_id)
        rate_limit: none                    # 既定の制限を使わない
    use_cases:
      - name: close_job
        authorize:
          roles: [admin, staff]             # どれか1つを持てばよい（any-of）。省略で認証済みなら誰でも
          allow_if: has_role(principal, admin) or (principal.company_id != null and principal.company_id == job.company_id)
        rate_limit: { requests: 5, per: minute, by: principal }
        input: [{ name: job_id, type: UUID }]
        steps:
          - load: { aggregate: Job, by: job_id, as: job, not_found: JobNotFound }
          - invoke: { target: job, operation: close, args: { at: clock.now } }
          - save: job
      - name: check_job_open
        authorize: public                   # principal なしで誰でも
      - name: record_audit
        authorize: internal                 # ポリシーなど内部からだけ。HTTP に出さない
```

**`authorize` の形**

| 値 | 意味 | 生成される `execute` |
|---|---|---|
| `public` | 誰でも（principal を使わない） | `execute(command)` |
| `internal` | プロセス内（ポリシー・ジョブ）からだけ。HTTP のエンドポイントを作らない。Use case だけ | `execute(command)` |
| `authenticated` | 認証済みの principal なら誰でも | `execute(command, principal)` |
| `{ roles: [...], allow_if: <式> }` | いずれかのロールを持ち（any-of。省略で誰でも）、`allow_if` が成り立つ principal | `execute(command, principal)` |

**既定は拒否**: `security` を書いたら、すべての Use case・Aggregate・クエリ（§10.5）に `authorize` が要る。書かないとエラー `missing-authorize`（実行時にいつも拒否するコードを作るより、誰に許すかをモデルに書かせる）。公開するものは `authorize: public` と明示する。ポリシーが動かす Use case は principal なしで動くので、`authorize: internal`（または `public`）でなければエラー `policy-needs-principal`。

**`allow_if`**: 認可のルール。型付きの式（§4）で、次を読める。

- `principal.id`（`principal.id` の型）、`principal.roles`（`List[String]`）、宣言したクレーム（`required: false` は Optional なので `principal.company_id != null and …` と確かめてから比べる）。
- `has_role(principal, admin)`（`has_role(principal, "admin")` でもよい）。宣言していないロールはエラー。
- Use case では入力と、**先頭に並んだ `load` の変数**（`job.company_id`、ガードの `job.is_open`）。生成コードはロールの確認を最初に（何も読み込む前に）行い、`allow_if` はそれが使う最後の `load` の直後、最初の変更の前に評価する。後の手順（`create`・`let`・`if` の枝・変更の後の `load`）の変数を使うとエラー `authorize-too-late`。
- Aggregate の `allow_if` は、その Aggregate のフィールドを名前だけで読む（Invariant と同じ）。

**`rate_limit`**: `{ requests, per, by }`。`per` は `second` / `minute` / `hour` / `day`、`by` は `principal`（既定）/ `ip` / `global`。トークンバケット（容量 `requests`、`per` の間に均等に補充）で、エンドポイントごと・数える単位ごとに1つ。`none` で既定を使わない。`public` のエンドポイントは principal がないので、既定の `by: principal` は IP ごとに数える（明示的な `by: principal` はエラー）。`internal` の `rate_limit` は効かない（警告）。

**予約語**: `security` を書いたモデルでは、入力と変数の `principal`、Extension point の `has_role`、型名 `Principal` `PrincipalInput` `Role` `NotAuthorized` `Unauthenticated` `RateLimit` `RateLimiter` は使えない。

**シナリオ**: Use case のシナリオの `given.principal` が実行する principal（`{ id, roles, claims }`。`null` で未認証）。省略すると、その Use case の `authorize.roles` をすべて持ち、宣言したクレームが既定値（省略可能なものは null）の principal で動く（`allow_if` がクレームを読むなら `given.principal` を書く）。`then.raises` に `NotAuthorized`（ロールがない・`allow_if` が成り立たない）と `Unauthenticated`（`principal: null` のときだけ）を書ける。

```yaml
scenarios:
  - name: staff_of_another_company_cannot_close
    given:
      principal: { id: "00000000-0000-4000-8000-000000000011", roles: [staff], claims: { company_id: "00000000-0000-4000-8000-0000000000c2" } }
      aggregates: [{ type: Job, fields: { ... } }]
    when: { input: { job_id: "..." } }
    then: { raises: NotAuthorized, state: [{ aggregate: Job, id: "...", fields: { status: open } }] }
  - name: anonymous_caller_is_unauthenticated
    given: { principal: null }
    when: { input: { job_id: "..." } }
    then: { raises: Unauthenticated }
```

生成テストは、principal が要る Use case ごとに2つのテストを足す（シナリオが1つ以上あるとき。入力は最初のシナリオのもの）: principal なしで `Unauthenticated`、必要なロールのどれも持たない principal で `NotAuthorized`（`details` に必要なロール）。どちらもリポジトリに触れると失敗するテストダブルを渡し、認可が何よりも先に行われることを確かめる。

検査: 宣言していないロール、`allow_if` の型と使える変数、クレームの型（`String` / `UUID` / `Integer` / `Boolean` / `List[String]`）と名前（`id` / `roles` は組み込み）、`none` の署名アルゴリズム（`insecure-algorithm`）、HS* と公開鍵方式の混在（`mixed-algorithms`）、`clock_tolerance` の範囲、レート制限の単位と数える単位、シナリオの principal の値。
