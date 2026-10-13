import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const module = context.asAbsolutePath(path.join("dist", "server.cjs"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "ddd-yaml" },
      { scheme: "untitled", language: "ddd-yaml" },
      // Multi-file models (docs/10 §12): the server validates them when a ddd.yaml is above them.
      { scheme: "file", language: "ddd-domain" },
      { scheme: "file", language: "ddd-flow" },
      { scheme: "file", pattern: "**/*.proto" },
      { scheme: "file", pattern: "**/ddd.yaml" },
      { scheme: "file", pattern: "**/*.scenarios.yaml" },
    ],
  };
  client = new LanguageClient("dddPresenter", "DDD Presenter", serverOptions, clientOptions);
  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
