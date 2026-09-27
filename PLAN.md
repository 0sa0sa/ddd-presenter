# Implementation Plan

決定事項は docs/09-implementation-decisions.md。各マイルストーンは検証してからコミットする。

- [x] M1 Scaffold: bun workspace (packages/core, generator, cli, server, web), tsconfig, git
- [x] M2 core: YAML → IR、構造検証、参照・重複・予約語・Aggregate境界・循環、診断（位置付き）
- [x] M3 core: Rule式 lexer/parser/typechecker、Python式への変換
- [x] M4 generator: Pydantic v2 domain package（errors/enums/VO/entities/aggregates/events/commands/ports/use cases/extension protocols）
- [x] M5 generator: シナリオ→pytest、testing fakes、manifest
- [x] M6 cli: validate / generate / diff / version / migrate、lock、手編集検知、原子的書き込み。examples/cleaning-platform で pytest + mypy 実行、golden test
- [ ] M7 server: Hono + bun:sqlite、簡易ログイン、Workspace/Member/Role、Project、Model版・楽観排他、layout、validate/preview API、import/export、監査、テナント分離テスト
- [ ] M8 web: React+Vite、プロジェクト一覧、YAML/フォーム/図(React Flow)編集、診断、ルール利用箇所、シナリオ、生成プレビュー、履歴diff、メンバー管理
- [ ] M9 README更新、E2E確認
