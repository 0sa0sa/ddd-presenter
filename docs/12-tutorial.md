# 12. チュートリアル：DDD とこのツールの使い方

清掃会社がスタッフ候補を招待し、候補が受諾する——この小さな業務を題材に、DDD の考え方を学び、このツールでモデルを作って Python のコードとテストを生成するまでを体験する。

アプリにも同じ内容がある（右上の「使い方」）。アプリ版は確認クイズつきで、手を動かす部分は画面右下のガイドが進捗を自動で判定する。

- 第1部 DDD の基本（約15分）
- 第2部 画面で作る（約30分）
- 第3部 CLI で生成してテストを実行する（約10分）

---

## 第1部 DDD の基本

### 1. ドメインとユビキタス言語

**ドメイン**は、ソフトウェアが扱う業務の領域。DDD（ドメイン駆動設計）は、業務の専門家（ドメインエキスパート）と開発者が**同じ言葉**で話すところから始まる。会議・図・コードで同じ意味で使う言葉を**ユビキタス言語**と呼ぶ。「招待」を会議では「オファー」、コードでは `Request` と呼ぶと、ずれが生まれる。

このツールでは、付箋のラベル（日本語）とコードの名前（`Invitation`）の対応がモデルの用語集に残る。

### 2. ドメインイベント・コマンド・アクター

業務を理解する近道は、**起きる出来事**から考えること。これを**ドメインイベント**と呼び、過去形で書く（「招待が受諾された」）。出来事を起こす操作が**コマンド**（「招待を受諾する」）、実行する人が**アクター**（「スタッフ候補」）。付箋を並べてこれらを見つける手法が **EventStorming** で、「ディスカバリー」タブはその道具。

```
[スタッフ候補] → [招待を受諾する] → [招待が受諾された]
   アクター         コマンド           ドメインイベント
```

### 3. Entity と Value Object

- **Entity**: 識別子で「同じもの」かを判断する。招待は内容が変わっても招待IDが同じなら同じ招待。状態は時間とともに変わる（保留中 → 受諾済み）。
- **Value Object**: 値そのもので判断する。メールアドレス `staff@example.com` はどこに現れても同じ値。変更せず、別の値に置き換える。「形式が正しいメールアドレスしか存在しない」のように、値のルールを型に閉じ込められる。

### 4. 集約（Aggregate）と整合性の境界

**集約**は、コマンドを受けて**一度の変更で必ず守るべきルール**を守るまとまり。外からは入口（Aggregate Root）を通してだけ変更し、保存も集約の単位で行う。

集約を決めるときの問い:

- 一度の操作で、必ず同時に正しくなければならないものは何か（真の不変条件）
- それ以外は、イベントで少し遅れて伝われば十分ではないか（結果整合性）
- 集約は小さく保ち、他の集約はIDで参照しているか

例:「受諾されたら歓迎メールを送る」を招待の集約の中で同時に行う必要はない。メール送信が失敗しても受諾は有効にしたいはず。受諾だけを確定し、歓迎メールは「招待が受諾された」イベントを受けて別に行う。

### 5. Invariant と State guard

- **Invariant（不変条件）**: いつでも成り立つ条件。「有効期限は作成日時より後」「受諾済みなら受諾日時を持つ」。このツールの生成コードは、作るときと状態が変わるたびに自動で確かめる。
- **State guard（状態ガード）**: 特定の操作の時点で確かめる条件。「受諾するときは、保留中かつ期限前であること」。生成コードでは `checks()`（真偽を返す）と `assert_holds()`（違反ならエラー）になる。操作の `require:` に書くと、その操作の前に自動で確かめる。

```yaml
invariants:
  - name: expiry_after_creation
    expression: expires_at > created_at
    error: InvalidInvitationWindow
state_guards:
  - name: pending_until_expiry
    parameters: [{ name: at, type: DateTime }]
    expression: status == pending and at < expires_at
    error: InvitationNotDeliverable
operations:
  - name: accept
    parameters: [{ name: at, type: DateTime }]
    require: [pending_until_expiry(at)]
    changes: { status: accepted, accepted_at: at }
```

### 6. Bounded context

同じ言葉が場所によって違う意味になることがある。「スタッフ」は採用では「候補者」、シフト管理では「勤務者」かもしれない。**Bounded context** は、言葉が一つの意味で通じる範囲。境界の目安は、言葉の意味が変わる所・担当チームが変わる所・ポリシー（「〜されたら〜する」）でつながる所。コンテキスト同士はイベントで連携する。画面の分け方は手がかりにならない。

### 7. Use case とシナリオ

- **Use case**: アクターの操作に対応する手順。「招待を読み込む → 受諾する → 保存する → コミット後にイベントを公開する」のように、順序とトランザクションの境界を表す。
- **シナリオ**: Given（前提）/ When（操作）/ Then（期待する結果）で書く具体例。このツールではシナリオがそのまま pytest のテストになる。Then に「うまく動く」のようなあいまいな期待を書くとエラーになる。

---

## 第2部 画面で作る

準備: `bun install` のあと `bun run dev:server` と `bun run dev:web` を起動し、http://localhost:5173 を開いてログインする（ユーザー名だけでよい）。右上の「使い方」→「チュートリアル用のプロジェクトを作って始める」を押すと、空のプロジェクトとガイドが開く。

| # | やること | 画面 | できたかどうかの判定 |
|---|---|---|---|
| 1 | 起きる出来事を3つ以上並べる（例: 招待が送られた／招待が受諾された／招待が取り消された） | ディスカバリー | イベントの付箋が3枚以上 |
| 2 | 出来事を起こすコマンドを置き、コマンドからイベントへ矢印を引く | ディスカバリー | コマンド → イベントの矢印がある |
| 3 | コマンドを実行するアクターをつなぐ | ディスカバリー | アクター → コマンドの矢印がある |
| 4 | コマンドを受け止める集約を置き、コマンドから矢印を引く（右パネル「集約の候補」も使える） | ディスカバリー | コマンドがつながった集約がある |
| 5 | 集約が守るルールをルール付箋で書く（例: 期限切れの招待は受諾できない） | ディスカバリー | 集約の近く（または矢印の先）にルールがある |
| 6 | 付箋を範囲選択し「コンテキストで囲む」、フレームに名前を付ける | ディスカバリー | 集約がフレームの中にある |
| 7 | 「モデルに反映…」で英字名を付け、差分を確認して反映・保存 | ディスカバリー → モデル | モデルに集約がある |
| 8 | 集約にフィールドを足す（例: `status: InvitationStatus`, `expires_at: DateTime`） | モデル (YAML) | 識別子以外のフィールドがある |
| 9 | ルールを Invariant か State guard として書く | モデル (YAML) | `true` 以外の条件がある |
| 10 | シナリオ（Given / When / Then）を書く | モデル → シナリオ | シナリオがある |
| 11 | 検証 OK の状態で保存する | モデル (YAML) | 保存済みの版がエラーなし |
| 12 | 生成されるコードとテストを見る | 生成プレビュー | タブを開いた |
| 13 | 手元で生成してテストを実行する（第3部） | — | 「できた」にチェック |

うまく進まないとき:

- **付箋を置けない**: ツールバーの種類を押すと画面中央に置ける。キャンバスのダブルクリックでも置ける。
- **矢印が引けない**: 付箋にマウスを乗せると端に丸が出る。丸からドラッグする。
- **集約が分からない**: 右パネル「集約の候補」を開く。矢印でつながったコマンドとイベントのまとまりと、名前の案が出る。
- **モデルに反映できない**: ダイアログで、赤枠の付箋に英字名を入れる（イベント・集約・コンテキストは `PascalCase`、コマンドは `snake_case`）。
- **YAML の書き方が分からない**: Ctrl+Space で、その場所に書けるキーや値の候補と説明が出る。エラーは下の一覧をクリックすると該当行へ移動し、直し方のヒントが出る。
- **完成形を見たい**: 「サンプルボードを読み込む」、またはサンプルモデルから新しいプロジェクトを作る。

ステップ 8〜10 の書き足しの例（反映後の `Invitation` に追加する）:

```yaml
    errors:
      - { name: InvitationNotDeliverable, code: invitation_not_deliverable, message: この招待は受諾できません }
    enums:
      - { name: InvitationStatus, values: [pending, accepted, revoked] }
    aggregates:
      - name: Invitation
        identity: id
        fields:
          - { name: id, type: UUID }
          - { name: status, type: InvitationStatus }
          - { name: expires_at, type: DateTime }
        state_guards:
          - name: pending_until_expiry
            parameters: [{ name: at, type: DateTime }]
            expression: status == pending and at < expires_at
            error: InvitationNotDeliverable
        operations:
          - name: accept_invitation
            parameters: [{ name: at, type: DateTime }]
            require: [pending_until_expiry(at)]
            changes: { status: accepted }
            emits:
              - { name: InvitationAccepted, fields: [id] }
        scenarios:
          - name: expired_invitation_cannot_be_accepted
            given:
              aggregate: { id: "00000000-0000-0000-0000-000000000001", status: pending, expires_at: "2026-01-08T10:00:00+00:00" }
            when:
              operation: accept_invitation
              args: { at: "2026-01-08T10:00:00+00:00" }
            then: { raises: InvitationNotDeliverable }
```

操作に引数（`at`）を足したら、その操作を呼ぶ Use case の手順にも引数を渡す（`args: { at: clock.now }`）。検証がどこを直せばよいかを教えてくれる。

---

## 第3部 CLI で生成してテストを実行する

1. 画面右上の「YAMLをエクスポート」で `model.ddd.yaml` を保存し、自分のリポジトリ（例: `~/work/staff`）に置く。
2. 検証して生成する。

   ```sh
   cd path/to/ddd-presenter
   bun run ddd validate ~/work/staff/model.ddd.yaml
   bun run ddd diff ~/work/staff/model.ddd.yaml        # 何が作られるかを確認
   bun run ddd generate ~/work/staff/model.ddd.yaml
   ```

3. Python の環境を作ってテストと型検査を実行する。

   ```sh
   cd ~/work/staff
   uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python "pydantic>=2.6,<3" pytest mypy
   cat > pyproject.toml <<'EOF'
   [tool.pytest.ini_options]
   pythonpath = ["src"]
   [tool.mypy]
   strict = true
   mypy_path = "src"
   EOF
   .venv/bin/python -m pytest -q
   .venv/bin/mypy src tests
   ```

4. 生成物を読む。
   - `src/<package>/generated/<context>/domain/aggregates.py` — ルールが `_invariant_…` や State guard のメソッドとして確かめられている
   - `src/<package>/generated/<context>/README.md` — ルールがどの操作で使われ、どのテストで確かめられているかの表
   - `tests/generated/` — シナリオから生成されたテスト
5. モデルを変えて `ddd diff` → `ddd generate` を繰り返す。生成ファイルを手で直すと次の生成が止まり差分が表示される。独自の処理は `extensions/` に書く（上書きされない）。CI では `ddd diff --check` で生成物が最新かを確かめられる。

## 次に読むもの

- [docs/10 DSL リファレンス](10-dsl-reference.md) — モデルに書けることの一覧
- [docs/11 ディスカバリーボードと編集支援](11-discovery-and-editing.md) — 操作の詳細
- [examples/cleaning-platform](../examples/cleaning-platform) — 完成したモデル・生成コード・拡張コードの例
