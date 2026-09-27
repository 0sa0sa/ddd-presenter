# DDD Presenter for VS Code

`*.ddd.yaml` のモデルファイルで次の機能を提供します（CLI・Webと同じ解析器を使います）。

- 補完: キー、型、Domain error、イベント、Aggregate、操作、変数、Rule式のフィールド・引数・Enum値・ガード・関数
- ホバー: 要素の説明（エラーのコードとメッセージ、ガードの条件、フィールドの型など）
- 定義へ移動（F12 / ⌘クリック）
- 名前の一括変更（F2。型と State guard）
- 診断（`ddd validate` と同じ結果）

## 使い方

```sh
cd packages/vscode
bun run build                       # dist/extension.cjs と dist/server.cjs を作る
bunx @vscode/vsce package --no-dependencies   # ddd-presenter-0.1.0.vsix を作る
code --install-extension ddd-presenter-0.1.0.vsix
```

開発中は VS Code でこのフォルダを開き、F5（Extension Development Host）でも試せます。
