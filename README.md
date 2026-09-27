# DDD Presenter

DDDの知識を実装の散在した条件分岐にせず、ドメインモデルを中心に設計・検証し、実行可能なコードへ変換するサービスの要件定義。

> **文書の状態:** 初期仮説。顧客ヒアリングと技術プロトタイプで検証する前提。  
> **最終更新:** 2026-09-27  
> **プロダクト名:** DDD Presenter（仮称）

## 目指す状態

開発者とドメイン知識を持つ人が、Entity / Value Object / Aggregate、不変条件、状態ガード、ユースケースの順序と期待結果をひとつのモデルに記述する。サービスはモデルを検証し、型・ドメイン層・アプリケーション層の骨格・テストを生成する。生成物は通常のリポジトリに置き、チームが所有・レビュー・実行できる。

「モデルを書いたら任意の業務ロジックが推測される」ことは目標にしない。曖昧な業務判断は人が規則や受け入れ条件として明記する。AIは将来、明記された意図に沿う実装案を作る補助者として追加する。

## 文書一覧

| 文書 | 内容 |
|---|---|
| [01-product-brief.md](docs/01-product-brief.md) | 課題、価値提案、対象顧客、成功指標、対象外 |
| [02-personas-and-journeys.md](docs/02-personas-and-journeys.md) | 利用者、Jobs-to-be-Done、主要な利用シナリオ |
| [03-functional-requirements.md](docs/03-functional-requirements.md) | 機能要件、優先度、受け入れ条件 |
| [04-domain-model-and-dsl.md](docs/04-domain-model-and-dsl.md) | プロダクト自身のドメイン、モデル形式、DSL意味論、例 |
| [05-generation-and-architecture.md](docs/05-generation-and-architecture.md) | 生成契約、Python出力、生成コードと手書きコードの境界 |
| [06-nonfunctional-requirements.md](docs/06-nonfunctional-requirements.md) | セキュリティ、プライバシー、信頼性、アクセシビリティ |
| [07-business-and-validation.md](docs/07-business-and-validation.md) | 顧客仮説、競合、価格仮説、検証計画 |
| [08-roadmap-risks-and-decisions.md](docs/08-roadmap-risks-and-decisions.md) | 開発段階、リスク、未決事項、意思決定ログ |

## いま置いている仮定

1. 最初の利用者はPythonで業務アプリケーションを作る小〜中規模の開発チーム。
2. 最初の価値は、任意のアプリ全体生成ではなく、名前の付いたルールと型の一元管理、ドメイン層の生成、生成後も壊れにくい再生成。
3. モデルは顧客のGitリポジトリに保存でき、生成コードも顧客が所有する。独自ランタイムへの依存を必須にしない。
4. Webエディタは学習と共同設計を支援し、ローカルCLIはCIと再現可能な生成を担う。
5. 最初の出力はPython。言語非依存IRを設計し、需要を確認してから他言語を追加する。

## 用語

- **Invariant:** オブジェクトが常に満たす必要がある条件。生成された構築・状態変更の境界で検証する。
- **StateGuard:** 特定の操作時点で確認する条件。`checks()`相当の真偽値確認と、`assert_holds()`相当の例外確認を提供する。Pythonでは`assert`が予約語なので、API名にそのまま使わない。
- **Model:** ドメイン、ルール、ユースケース、シナリオを表すバージョン管理可能な定義。
- **Generated code:** モデルから再現可能に作られ、手で直接編集しないコード。
- **Extension code:** 顧客が所有する実装。再生成で上書きしない。
