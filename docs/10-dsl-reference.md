# 10. Model DSL Reference (schema_version 1)

モデルは `*.ddd.yaml` に書く。構造は [JSON Schema](../packages/core/schema/model.schema.json) で公開し、意味（参照・型・Rule式・シナリオの完全性）は `ddd validate` が検査する。完全な例は [examples/cleaning-platform/model.ddd.yaml](../examples/cleaning-platform/model.ddd.yaml)。

## 1. ファイルの骨格

```yaml
schema_version: 1
project: cleaning-platform          # モデルID（マニフェストに記録）
generation:
  package: cleaning_platform        # 生成するPythonパッケージ名
  src_dir: src                      # 既定 src
  tests_dir: tests                  # 既定 tests
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
relationships: [...]                # コンテキストマップ（§9）
```

命名: 型（Context / Aggregate / Entity / Value Object / Enum / Error / Event / Command）は PascalCase、それ以外（フィールド・ルール・操作・Use case・シナリオ・ポリシー）は snake_case。Pythonの予約語、`model_` で始まる名前、生成器が使う名前（`identity`, `events` など）は使えない。

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

生成コード: `invitation.pending_until_expiry(at).checks() -> bool` と `.assert_holds()`（違反時に `error` を送出）。

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

操作は `Transition[Aggregate]`（新しいAggregateと発生イベント）を返す。元のインスタンスは変わらない。

内部Entity型（`OrderLine`、`List[OrderLine]` など）の引数を持つFactory / Operationは警告 `entity-parameter` になる。Commandの入力は値だけを運び、式でEntityを作ることもできないため、Use caseが渡せるのは読み込んだAggregateがすでに持つEntity（`order.lines` など）だけである。呼び出し側が新しい項目を渡すなら、その値（単純なフィールドかValue Object）を引数にする。そうでなければその操作は手書きコードからだけ呼ぶ。

## 4. Rule式

| 要素 | 例 |
|---|---|
| フィールド・引数・Value Objectのフィールド | `expires_at`, `at`, `email.value` |
| リテラル | `1`, `1.5`, `"text"`, `true`, `null` |
| Enum値 | `status == pending`（比較相手がEnumなら裸の名前で可）、`InvitationStatus.pending`（常にEnum値を指す） |
| 比較 | `==` `!=` `<` `<=` `>` `>=`（連鎖比較は不可） |
| 論理 | `and` `or` `not`、括弧 |
| null | `accepted_at != null and accepted_at > at`（null確認のあとは非nullとして扱う） |
| 関数 | `is_empty(x)` `length(x)` `contains(list_or_string, item)` |

使えないもの: 代入、Pythonコード、import、隠れた時計（`now`）、DB・HTTP・ファイル・環境変数。時刻は引数で渡す。

裸の名前はフィールド・引数・入力が優先される。Enum値と同じ名前のフィールドがあると（`status == authorized` で、`authorized: Money` というフィールドもある）、`authorized` はフィールドを指し、型の不一致として報告される。このとき診断はその名前がフィールドに解決されたことを示すので、Enum値は `PaymentStatus.authorized` と書く（フィールド名を変えてもよい）。

Use case の中だけで使えるもの: `clock.now`、`ids.new`、読み込んだAggregateのガード（`invitation.is_open`, `invitation.pending_until_expiry(clock.now)`）、Extension point の呼び出し。

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
    - return: invitation.id
```

検査: 未定義の変数、保存されない変更、先に発生していないイベントの公開、到達できない手順、すべての経路で `return` しているか、複数Aggregateを1トランザクションで変更していないか（数えるのは型ではなく変数。同じ型の2つのインスタンスを変更しても警告 `multi-aggregate-transaction` になる）。

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
