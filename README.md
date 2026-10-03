# DDD Presenter

DDDの知識を実装の散在した条件分岐にせず、ドメインモデルを中心に設計・検証し、実行可能なコードへ変換するサービス。

Entity / Value Object / Aggregate、名前付きの不変条件（Invariant）と状態ガード（StateGuard）、ユースケースの手順、イベントに反応するポリシーとコンテキストマップ、Given-When-Thenシナリオをひとつの YAML モデルに書くと、次のことができる。

- **検証**: 参照、型、Rule式、Aggregate境界、循環、シナリオの完全性、コンテキストをまたぐ連携のイベント契約（ポリシーとコンテキストマップ）を、位置と修正案つきで診断する。
- **生成**: Python（Pydantic v2）または TypeScript（Zod v4）のドメイン層・アプリケーション層とテスト（pytest / vitest・bun test）を決定的に生成する。生成物は `mypy --strict` / `tsc --strict` を通る。
- **安全な再生成**: 手編集を検知して停止する。削除されたファイルは stale として報告し（生成したままの古い生成テストだけは削除する）、顧客所有の拡張コードは上書きしない。
- **ディスカバリー**: Miro のように自由に付箋を置ける EventStorming のボードで、イベント・コマンド・集約・コンテキストの境界を探る。抜けの指摘、集約とコンテキスト連携の候補を示し、決めた内容を差分を確認してからモデルに反映する（候補は提案のみで、決めるのはチーム）。
- **書きやすさ**: YAML でも、キー・型・エラー・イベント・操作・変数・Rule 式のフィールドや Enum 値を補完し、説明の表示・定義へ移動・名前の一括変更ができる（Web のエディタと VS Code 拡張で同じ言語サービス）。
- **Web**: モデルを編集・レビューする（YAML、フォーム、図、ルール追跡、シナリオ、生成プレビュー、履歴、メンバーと権限）。

> **はじめての方へ:** DDD の考え方とこのツールの使い方は [チュートリアル（docs/12）](docs/12-tutorial.md) にまとめています。アプリでは右上の「使い方」から、確認クイズつきの説明と、手順ガイドつきのハンズオンを始められます。

> 実装状況: 要件の Phase 1（ローカル CLI の MVP）と Phase 2（Web 編集・チームレビュー）に加え、ディスカバリーボードと言語サービス（Web・VS Code）。決定事項は [docs/09](docs/09-implementation-decisions.md)、DSL は [docs/10](docs/10-dsl-reference.md) を参照。

## クイックスタート

必要なもの: [Bun](https://bun.sh) 1.1 以上。生成した Python を動かすには Python 3.11 以上と [uv](https://docs.astral.sh/uv/)（または pip）。生成した TypeScript を動かすには Node.js 20 以上（vitest）または Bun。

```sh
bun install
bun test                 # 全テスト（生成したPythonの pytest / mypy 実行を含む。venvがなければその1件はskip）
                         # 生成した TypeScript の tsc / テスト実行も含む（依存は初回だけ一時ディレクトリに入れる。
                         # ネットワークがなければ理由を表示して skip。DDD_SKIP_TS_RUN=1 で明示的に skip）
```

### CLI

```sh
bun run ddd init my-project                    # サンプルモデル my-project/model.ddd.yaml を作る（--target typescript で TS 用）
bun run ddd validate my-project/model.ddd.yaml # 検証（エラーがあれば終了コード 1）
bun run ddd diff my-project/model.ddd.yaml --patch   # 生成したら何が変わるか
bun run ddd generate my-project/model.ddd.yaml       # 生成（ddd.lock を作る）
bun run ddd rules my-project/model.ddd.yaml          # ルールの適用箇所とテスト
```

| コマンド | 主なオプション |
|---|---|
| `validate [model]` | `--strict`（警告も失敗扱い。未検証のルール・使われないエラー・呼ばれない Extension point も警告）、`--format json` |
| `diff [model]` | `--patch`（unified diff）、`--check`（生成物が古ければ終了コード 1。CI用） |
| `generate [model]` | `--dry-run`、`--force`（手編集を破棄）、`--prune`（staleファイルを削除）、`--update-lock`、`--target python\|typescript`（モデルの `generation.target` を上書き。`diff` も同じ） |
| `rules [model]` | `--format json` |
| `migrate [model]` | schema_version の移行（現行は 1 のみ） |
| `init [dir]` / `version` | `init --target typescript`（TypeScript 用のサンプル） |

終了コード: 0 = 成功、1 = 検証エラー・衝突・`--check` の差分あり、2 = 使い方の誤り・lock の不一致。CLI はネットワークに接続しない。

### サンプルプロジェクトで生成物を動かす

```sh
cd examples/cleaning-platform
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python "pydantic>=2.6,<3" pytest mypy
cd ../.. && bun run verify:example   # diff --check → pytest → mypy --strict
```

TypeScript 版（同じドメインを `generation.target: typescript` で生成したもの）:

```sh
bun run verify:example:ts            # diff --check → bun install → tsc --noEmit → vitest
```

`examples/cleaning-platform` には、生成済みのコード（招待を扱う `CleaningStaff` と、招待の受諾をポリシーで受けてスタッフを登録する下流の `Staffing`）と、顧客が書く拡張（`src/cleaning_platform/extensions/`）と手書きテスト（`tests/custom/`）が入っている。golden test は、このディレクトリの生成物がバイト単位で再現されることを確認する。`examples/cleaning-platform-ts` は同じ構成の TypeScript 版（拡張は `src/cleaning_platform/extensions/cleaning-staff/extensions.ts`、手書きテストは `tests/custom/`）。

### TypeScript で生成する

モデルの `generation` に `target: typescript` を書く（`ddd generate --target typescript` でも一時的に切り替えられる）。

```yaml
generation:
  target: typescript          # python（既定）| typescript
  package: cleaning_platform  # src/<package>/ の下に生成する
  typescript:
    test_runner: vitest       # vitest（既定）| bun
```

```sh
bun run ddd generate model.ddd.yaml   # 初回は package.json・tsconfig.json・.prettierrc.json も作る（以後は顧客所有）
npm install && npm run typecheck && npm test   # または bun install && bun run typecheck && bun run test
```

Value Object・コマンド・イベントは Zod スキーマと推論型、Entity・Aggregate は不変のクラス（`X.from(...)` で検証して作る）、操作は `Transition<T>`（新しい状態と発生イベント）を返す。Decimal は decimal.js、UUID は `Id<"Order">` のようなブランド型。詳しい対応は [docs/05 §8](docs/05-generation-and-architecture.md) と [docs/09 §14](docs/09-implementation-decisions.md)。

### VS Code 拡張

```sh
bun run build:vscode
code --install-extension packages/vscode/ddd-presenter-0.1.0.vsix
```

`*.ddd.yaml` で補完・ホバー・定義へ移動（F12）・名前の一括変更（F2）・診断が使える。使い方は [docs/11](docs/11-discovery-and-editing.md)。

### Web

```sh
# 開発: API（:4870）と Vite（:5173）を別々に起動する
# ポートを変える場合は PORT=4900 bun run dev:server と DDD_PORT=4900 bun run dev:web
bun run dev:server
bun run dev:web          # http://localhost:5173

# ビルドして1プロセスで配信
bun run build:web && bun run start   # http://localhost:4870
```

AI の予測・提案を使うには、サーバーのマシンで Claude Code（`claude`）か Codex CLI（`codex`）にログインしておくか、`ANTHROPIC_API_KEY=... bun run dev:server` で起動し、ワークスペースの「設定」タブで使う AI を選んで有効にする（既定はオフ。オフでもローカルの予測は使える。docs/11 §3）。

ログインはユーザー名とパスワード。サーバーは既定で `127.0.0.1` だけで待ち受け、パスワードを持つアカウントがまだない間は、ユーザー名だけで入れる「開発用の簡易ログイン」も使える（最初のパスワード付きアカウントができると自動で無効になる）。アカウントを作ると個人ワークスペースができる。データは `packages/server/data/ddd.sqlite`（`DDD_DB` で変更可）。

### セキュアに動かす

**ひとりで使う（既定）**: そのまま `bun run start`。`127.0.0.1` だけで待ち受けるので、ほかのマシンからは接続できない。初回は簡易ログインで入れる。右上のメニューからパスワードを設定すると簡易ログインは無効になり、以後はパスワードでログインする。

**チームで使う**: HTTPS の終端（リバースプロキシ）の裏で動かす。

```sh
# DDD_HOST:          プロキシと同じマシンなら loopback のまま。別マシンなら 0.0.0.0 など
# DDD_ALLOWED_HOSTS: 利用者がブラウザで開くホスト名（DNS リバインディング対策の許可リスト）
# DDD_SECURE_COOKIES: Cookie に Secure を付ける（HTTPS 必須）
# DDD_AI_ADMINS:     AI をオンにできる人（サーバーの API キー・CLI 契約を使うため）
DDD_HOST=127.0.0.1 DDD_ALLOWED_HOSTS=ddd.example.com DDD_SECURE_COOKIES=1 DDD_AI_ADMINS=alice bun run start
```

- 各自が画面の「アカウントを作る」から登録する。登録を止めるときは `DDD_REGISTRATION=closed` にして、管理者が `bun run admin set-password <ユーザー名>`（パスワードは標準入力）でアカウントを作る。パスワードを忘れた人も同じコマンドで再設定できる。
- 会社の SSO（OIDC）を使うときは oauth2-proxy などの認証プロキシを前に置き、`DDD_TRUSTED_USER_HEADER=X-Forwarded-User` を設定する。このヘッダーの値をユーザー名として信頼するので、**サーバーに届くのがプロキシ経由の要求だけ**であること、プロキシがクライアントから来た同名のヘッダーを消すことを必ず確認する。
- プロキシは `Host` をそのまま渡す（nginx なら `proxy_set_header Host $host;`）。書き換えると Origin の照合で更新系の要求が 403 になる。

| 環境変数 | 既定 | 意味 |
| --- | --- | --- |
| `DDD_HOST`（`HOST`） | `127.0.0.1` | 待ち受けるアドレス。loopback 以外なら起動時に警告を出す |
| `PORT` / `DDD_PORT` | `4870` | ポート |
| `DDD_ALLOWED_HOSTS` | （なし） | `localhost`・`127.0.0.1`・`[::1]` のほかに受け付けるホスト名（カンマ区切り）。`DDD_HOST` に具体的なアドレスを指定したときはそれも許可。`*` はすべて許可（非推奨）。ほかのホスト名は 421 |
| `DDD_DEV_LOGIN` | （自動） | `1` で簡易ログインを常に有効（ネットワークに公開しないこと）、`0` で常に無効。未設定なら「このマシンだけから届く（loopback で待ち受け、`DDD_ALLOWED_HOSTS` に外向きの名前がなく、プロキシのヘッダーを信頼していない。`X-Forwarded-For` などが付いた要求は除く）」かつ「パスワード付きアカウントがない」ときだけ有効 |
| `DDD_REGISTRATION` | `open` | `closed` で画面からの登録を止める |
| `DDD_TRUSTED_USER_HEADER` | （なし） | 認証プロキシが付けるユーザー名のヘッダー（例 `X-Forwarded-User`）。設定したときだけ使う |
| `DDD_SECURE_COOKIES` | （なし） | `1` で Cookie に Secure を付ける |
| `DDD_AI_ADMINS` | （下記） | AI をオンにできるユーザー名（カンマ区切り）。未設定なら、このマシンだけから届くときは最初に作られたユーザー、それ以外では誰も（`DDD_AI_WORKSPACES` も未設定のとき） |
| `DDD_AI_WORKSPACES` | （なし） | オーナーなら誰でも AI をオンにできるワークスペース ID（カンマ区切り、`*` はすべて） |
| `DDD_AI_RATE_PER_MIN` / `DDD_AI_BURST` | `30` / `10` | 1人あたりの AI 呼び出しの上限（毎分の補充数・まとめて使える数）。超えると 429 |
| `DDD_AI_QUEUE` | `8` | ローカル CLI の待ち行列の長さ（同時実行は 2）。あふれた要求は 429 |
| `DDD_AI_PASS_ENV` | （なし） | ローカル CLI に追加で渡す環境変数名（カンマ区切り）。既定では PATH・HOME・ロケール・プロキシ設定と、その CLI の認証情報だけを渡す |
| `DDD_CODEX_USER_CONFIG` | （なし） | `1` で Codex の `~/.codex/config.toml`（MCP サーバーなど）を読む。既定は読まない（認証は `~/.codex` のまま） |
| `DDD_SERVE_SOURCEMAPS` | （なし） | `1` で `bun run start` でもソースマップを配信する |

セッションは 14 日で切れ、期限切れは 1 時間ごとに消す。右上のメニューの「すべての端末からログアウト」で自分のセッションをすべて終了できる。要求の本文は 4 MB まで（モデルは 1 MB、ボードは 2 MB・付箋 3000 枚まで）。詳しい決定は docs/09 §11。

## 生成されるもの

```text
src/<package>/
  generated/                       # 生成器が所有。手で編集しない（編集すると次回の generate が止まる）
    _runtime.py                    # DomainError / ValueObject / Entity / AggregateRoot / Transition / StateGuard / dispatch
    adapters.py                    # SystemClock（aware UTC）/ RandomIds
    <context>/domain/{errors,enums,value_objects,entities,aggregates,events,commands,rules}.py
    <context>/application/{ports,use_cases}.py
    <context>/application/policies.py   # ポリシーのハンドラと subscriptions()（ポリシーがあるコンテキストだけ）
    <context>/testing.py           # In-memory の Repository / Clock / Publisher / UnitOfWork
    <context>/README.md            # ルール・適用箇所・テストの対応表
    model_manifest.json            # モデルhash・生成器版・各ファイルのsha256
  extensions/<context>/extensions.py   # 初回のみ作成。以後はあなたのコード
  extensions/<context>/translators.py  # anticorruption_layer の翻訳層。初回のみ作成
tests/generated/test_<context>_<name>.py
tests/generated/test_<context>_policies.py
```

`target: typescript` のとき:

```text
package.json, tsconfig.json        # 初回のみ作成（zod / decimal.js、strict + exactOptionalPropertyTypes + NodeNext）
.prettierrc.json                   # 初回のみ作成（printWidth 100。生成物は Prettier と typescript-eslint strict-type-checked でそのまま通る）
src/<package>/
  index.ts                         # 初回のみ作成（generated/index.js を再エクスポート）
  generated/
    runtime.ts                     # DomainError / Entity / AggregateRoot / Transition / StateGuard / Decimal / Id / ポート / dispatch
    adapters.ts, testing.ts        # SystemClock / RandomIds、In-memory のテストダブルとアサーション
    index.ts                       # runtime と、コンテキストごとの名前空間
    <context>/domain/{errors,enums,value-objects,entities,aggregates,events,commands,rules}.ts
    <context>/application/{ports,use-cases,policies}.ts
    <context>/testing.ts, index.ts, README.md
    model_manifest.json
  extensions/<context>/extensions.ts   # 初回のみ作成。以後はあなたのコード
  extensions/<context>/translators.ts  # anticorruption_layer の翻訳層。初回のみ作成
tests/generated/<context>-<name>.test.ts
```

生成コードの例（サンプルの `accept`）:

```python
def accept(self, at: datetime) -> Transition[CleaningStaffInvitation]:
    self.pending_until_expiry(at).assert_holds()          # require: 自動で確認
    aggregate = self._replace(status=InvitationStatus.ACCEPTED, accepted_at=at)  # 候補状態でInvariantを評価
    aggregate._check_transition_invariants()
    events: list[DomainEvent] = []
    events.append(InvitationAccepted(id=aggregate.id, at=at))
    return Transition(aggregate=aggregate, events=tuple(events))
```

同じ操作の TypeScript:

```ts
accept(args: { readonly at: Date }): Transition<CleaningStaffInvitation> {
  const { at } = args;
  this.pendingUntilExpiry(at).assertHolds();                                   // require: 自動で確認
  const aggregate = this.#with({ status: InvitationStatus.accepted, acceptedAt: at });  // 候補状態でInvariantを評価
  const events: DomainEvent[] = [];
  events.push(InvitationAccepted.create({ id: aggregate.id, at }));
  return transition(aggregate, events);
}
```

## リポジトリ構成

| パッケージ | 役割 |
|---|---|
| `packages/core` | YAML → IR、Rule式の parser / 型検査、意味検証、ルール追跡、構造編集、言語サービス（補完など）、ディスカバリーボードの整理とモデル化、diff、[JSON Schema](packages/core/schema/model.schema.json)。ブラウザでも動く |
| `packages/generator` | Python / pytest と TypeScript（Zod）/ vitest・bun test の生成、マニフェスト、差分プラン、破壊的変更の検出 |
| `packages/cli` | `ddd` コマンド。原子的な書き込み、lock、手編集の検知 |
| `packages/server` | Hono + bun:sqlite。Workspace / 権限 / テナント分離 / モデル版（楽観排他）/ プレビュー / 監査ログ |
| `packages/web` | React + Vite。ディスカバリーボード、YAML エディタ（補完つき）、アウトライン、インスペクタ、図（React Flow）、ルール、シナリオ、プレビュー、履歴 |
| `packages/lsp` | Language Server（stdio / IPC）。core の言語サービスと検証を LSP で提供 |
| `packages/vscode` | VS Code 拡張（`*.ddd.yaml`） |

同じ `validateModelText` を CLI・サーバー・ブラウザが使う。一致はテストで確認している（FR-030 / FR-034）。

## 文書

| 文書 | 内容 |
|---|---|
| [01-product-brief.md](docs/01-product-brief.md) | 課題、価値提案、対象顧客、成功指標、対象外 |
| [02-personas-and-journeys.md](docs/02-personas-and-journeys.md) | 利用者、Jobs-to-be-Done、主要な利用シナリオ |
| [03-functional-requirements.md](docs/03-functional-requirements.md) | 機能要件、優先度、受け入れ条件 |
| [04-domain-model-and-dsl.md](docs/04-domain-model-and-dsl.md) | プロダクト自身のドメイン、モデル形式、DSL意味論 |
| [05-generation-and-architecture.md](docs/05-generation-and-architecture.md) | 生成契約、Python・TypeScript出力、生成コードと手書きコードの境界 |
| [06-nonfunctional-requirements.md](docs/06-nonfunctional-requirements.md) | セキュリティ、プライバシー、信頼性、アクセシビリティ |
| [07-business-and-validation.md](docs/07-business-and-validation.md) | 顧客仮説、競合、価格仮説、検証計画 |
| [08-roadmap-risks-and-decisions.md](docs/08-roadmap-risks-and-decisions.md) | 開発段階、リスク、未決事項、意思決定ログ |
| [09-implementation-decisions.md](docs/09-implementation-decisions.md) | 実装で確定した技術・DSL・生成契約の決定 |
| [10-dsl-reference.md](docs/10-dsl-reference.md) | モデルDSLのリファレンス |
| [11-discovery-and-editing.md](docs/11-discovery-and-editing.md) | ディスカバリーボード（draw.io の読み込み・書き出しを含む）、ワークショップの進行、ボードとモデルの同期、エディタ補完、Tab で確定する予測と AI の提案 |
| [12-tutorial.md](docs/12-tutorial.md) | チュートリアル：DDD の基本から、画面での作成、CLI での生成・テストまで |

## 用語

- **Invariant:** オブジェクトが常に満たす条件。生成された構築・状態変更の境界で検証する。
- **StateGuard:** 特定の操作時点で確認する条件。`checks()` と `assert_holds()`（TypeScript では `assertHolds()`）を提供する（Python の `assert` は予約語なので API 名に使わない）。
- **Model:** ドメイン、ルール、ユースケース、シナリオを表すバージョン管理可能な定義。
- **Generated code:** モデルから再現可能に作られ、手で直接編集しないコード。
- **Extension code:** 顧客が所有する実装。再生成で上書きしない。

## 対象外・既知の制限

- 認証はパスワード（argon2id）か認証プロキシのヘッダー。多要素認証・パスワードの再設定メールはない（SSO が必要なら認証プロキシを前に置く）。インターネットに公開するときは HTTPS と `DDD_SECURE_COOKIES=1` が必要。
- 課金（FR-042）、Git 連携（FR-041）、AI 補助（FR-035）、シミュレーション（FR-022）は Phase 3 以降として未実装。
- 生成対象は Python（Pydantic v2）と TypeScript（Zod v4）。TypeScript 版の違い（Date の精度、文字列の長さの数え方など）は docs/09 §14。Outbox などの確実なイベント配信は EventPublisher アダプタ側の責務。
- Web のフォーム編集は主要な操作（追加・名前変更・式・エラー・削除）に限る。細かい編集は同じ画面の YAML で行う（どちらも同じモデルを編集する）。
- 診断メッセージは英語（CLI と共通）。UI は日本語。
