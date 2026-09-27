# Implementation Milestones (all completed)

決定事項は docs/09-implementation-decisions.md。各マイルストーンは検証してからコミットする。

- [x] M1 Scaffold: bun workspace (packages/core, generator, cli, server, web), tsconfig, git
- [x] M2 core: YAML → IR、構造検証、参照・重複・予約語・Aggregate境界・循環、診断（位置付き）
- [x] M3 core: Rule式 lexer/parser/typechecker、Python式への変換
- [x] M4 generator: Pydantic v2 domain package（errors/enums/VO/entities/aggregates/events/commands/ports/use cases/extension protocols）
- [x] M5 generator: シナリオ→pytest、testing fakes、manifest
- [x] M6 cli: validate / generate / diff / version / migrate、lock、手編集検知、原子的書き込み。examples/cleaning-platform で pytest + mypy 実行、golden test
- [x] M7 server: Hono + bun:sqlite、簡易ログイン、Workspace/Member/Role、Project、Model版・楽観排他、layout、validate/preview API、import/export、監査、テナント分離テスト
- [x] M8 web: React+Vite、プロジェクト一覧、YAML/フォーム/図(React Flow)編集、診断、ルール利用箇所、シナリオ、生成プレビュー、履歴diff、メンバー管理
- [x] M9 README更新、E2E確認

## Phase 2.5 — 書きやすさとディスカバリー（2026-09-27 追加）

- [x] L1 core: 言語サービス（補完・ホバー・定義ジャンプ・名前変更）。YAMLのキー／参照／Rule式の文脈を判定
- [x] L2 web: CodeMirrorに補完・ホバー・Ctrl/Cmd+クリックで定義へ・F2で名前変更
- [x] L3 lsp + vscode: Language Server（stdio）と VS Code 拡張（*.ddd.yaml）。JSON-RPCの結合テスト
- [x] D1 core: ディスカバリーボードの型、整理の補助（ヒューリスティック診断・集約候補・コンテキスト連携）、モデル骨格の生成
- [x] D2 server: ボードの保存API（楽観排他・プロジェクト単位・モデルとは別保存）
- [ ] D3 web: Miro風の自由キャンバス（付箋・フレーム・矢印・パン/ズーム・複数選択・Undo）、補助パネル、モデルへの反映（差分確認つき）
- [ ] D4 docs/README、ブラウザでの動作確認
