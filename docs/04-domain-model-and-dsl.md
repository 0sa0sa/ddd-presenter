# 04. Domain Model and DSL

## 1. プロダクト自身の主要ドメイン

| 概念 | 説明 |
|---|---|
| Workspace | 組織・チームの境界。メンバー、課金、監査を所有する。 |
| Project | 一つのソフトウェアシステムの設計単位。モデル版、生成設定を持つ。 |
| BoundedContext | 用語とモデルの境界。Aggregate、Command、Event、Use Caseをまとめる。 |
| ModelElement | Entity、Value Object、Rule、Use Caseなど、識別子と名前を持つ定義。 |
| DomainRule | Invariant、StateGuard、Policyを表す型付き条件と違反時の扱い。 |
| Scenario | Given-When-Thenの業務例。モデルと生成テストをつなぐ。 |
| GenerationRun | モデル版とジェネレータ版から生成した結果・差分・診断の記録。 |
| ExtensionPoint | 顧客が所有する手書き実装を生成物から呼び出す契約。 |

## 2. モデルファイル方針

- ファイル形式は初期版でバージョン付きYAMLとする。
- YAMLは交換・レビューの形式であり、実行コードではない。
- Webフォーム、図、テキスト編集は同じ正規化IRへ変換する。
- CLIとWebは同じパーサ、型解決、規則評価意味論を共有する。
- 表示位置、色、折りたたみ状態などは意味モデルと分離して保存する。
- YAML仕様をJSON Schemaと文書で公開し、ベンダー外でも読み取れるようにする。
- 互換性を壊す変更には明示的なschema version更新とmigrationを必須にする。

## 3. 要素の意味

### Entity

- 必須: 名前、識別子フィールド、属性定義。
- 同一性: 識別子に基づく。
- 外部からの属性直接変更を生成しない。
- 状態変更は名前付きOperationに集約し、前提Guard・更新・Eventを一まとまりにする。

### Value Object

- 必須: 名前、属性、制約。
- 値による等価性を持ち、既定で不変。
- 正規化ルールと検証制約の適用順を明示する。
- 任意の外部I/OやDB参照を持たない。

### Aggregate

- Rootを一つ持ち、一貫性境界を表す。
- InvariantはAggregateの作成後および状態遷移後に検証する。
- Aggregateを越える参照はIDとイベントの契約として表す。

### Invariant

- 常に成立する条件。名前、式、対象、評価タイミング、Domain Errorを持つ。
- コンストラクタや状態遷移が不正状態をコミットする前に評価する。
- 評価に必要な外部値（日時等）は引数または依存Portとして明示し、隠れたグローバル時計を使わない。

### StateGuard

- 特定の操作時点における条件。
- 生成コードに`checks() -> bool`相当と`assert_holds()`相当を持たせる。Pythonの`assert`は予約語なのでメソッド名に使わない。
- 自動Invariant収集の対象に含めない。
- Use Case分岐、操作前提、条件付き副作用などに利用する。

### Use Case

- Actor、入力、出力、手順、分岐、トランザクション、発生イベント、シナリオを持つ。
- 手順の意味を宣言し、具体的なRepository・DB・HTTP・Broker実装はPort Adapterへ委譲する。
- ステップ順とトランザクション境界を同じ図で確認できる。

## 4. Rule式

式は小さな型付き式言語とし、任意コードの実行を許可しない。

初期に許可する式要素:

- フィールド、操作引数、定数、Enum値への参照。
- `==`、`!=`、`<`、`<=`、`>`、`>=`。
- `and`、`or`、`not`。
- `is_empty`、`contains`など、型ごとに定義した純粋関数。
- Null / Optionalの明示的比較。

初期に許可しないもの:

- Pythonコード、import、eval、動的関数呼び出し。
- DB、HTTP、ファイル、環境変数、時計の暗黙アクセス。
- 無制限ループや再帰。
- 外部サービスのレスポンスに依存する条件。

複雑な計算は型付きExtensionPointとして宣言し、顧客コード側の関数と明示的に紐付ける。DSL内の式と拡張コードを自動で同じ信頼レベルとみなさない。

## 5. サンプルモデル

以下は構文案であり、MVPで受け入れる最終仕様ではない。CleaningStaffInvitationの業務例を表す。

```yaml
schema_version: 1
project: cleaning-platform
contexts:
  - name: CleaningStaff
    aggregates:
      - name: CleaningStaffInvitation
        identity: id
        fields:
          - { name: id, type: UUID, required: true }
          - { name: status, type: InvitationStatus, required: true }
          - { name: created_at, type: DateTime, required: true }
          - { name: expires_at, type: DateTime, required: true }
        enums:
          - name: InvitationStatus
            values: [pending, accepted, revoked]
        invariants:
          - name: expiry_after_creation
            expression: expires_at > created_at
            error: InvalidInvitationWindow
            check_on: [construct, transition]
        state_guards:
          - name: pending_until_expiry
            parameters:
              - { name: at, type: DateTime }
            expression: status == pending and at < expires_at
            error: InvitationNotDeliverable
        operations:
          - name: accept
            parameters:
              - { name: at, type: DateTime }
            require: pending_until_expiry(at)
            changes:
              status: accepted
            emits:
              - name: InvitationAccepted
                fields: [id, at]
    use_cases:
      - name: accept_invitation
        command: AcceptInvitation
        input:
          - { name: invitation_id, type: UUID }
        steps:
          - load: CleaningStaffInvitation by invitation_id
          - invoke: CleaningStaffInvitation.accept(at: clock.now)
          - save: CleaningStaffInvitation
          - publish_after_commit: InvitationAccepted
        scenarios:
          - name: pending_invitation_is_accepted
            given: ["status is pending", "now is before expires_at"]
            when: accept_invitation
            then: ["status becomes accepted", "InvitationAccepted is emitted"]
          - name: expired_invitation_is_rejected
            given: ["status is pending", "now is at or after expires_at"]
            when: accept_invitation
            then: ["InvitationNotDeliverable is raised", "no event is emitted"]
```

### サンプルで確認する生成結果

- `expiry_after_creation()`は自動Invariantとして構築時と遷移後に検証される。
- `pending_until_expiry(at)`はStateGuardとして明示操作から評価する。
- `accept()`はGuardを評価した後、新しい状態を構成・検証し、Eventを返す。
- `accept_invitation`はRepository操作とDomain操作の順番を示す。
- `publish_after_commit`は永続化成功後にEventを通知する意図を示す。初期生成で信頼できる配信を保証するにはOutbox等が必要であり、その保証範囲を別途選択・説明する。
- Given-When-Thenから正常系・期限切れのテストを生成する。

## 6. 互換性とバージョニング

- YAML schema versionとgenerator versionは別々に持つ。
- Generatorは破壊的変更を避け、必要ならmigration previewを出す。
- 生成物のヘッダまたはマニフェストに使用したモデルID、モデルhash、generator versionを記録する。
- 拡張契約を変更する場合、既存顧客の手書きコードに与える破壊的影響を報告する。
