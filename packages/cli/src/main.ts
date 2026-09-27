#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { cmdDiff, cmdGenerate, cmdInit, cmdMigrate, cmdRules, cmdValidate, cmdVersion, EXIT, type Io } from "./commands.ts";

const HELP = `ddd — DDD Presenter CLI (model-driven Python domain code)

Usage:
  ddd validate [model] [--strict] [--format json]   Check the model; non-zero exit on errors
  ddd diff     [model] [--patch] [--check]          Show what generate would change (--check: fail if out of date)
  ddd generate [model] [--dry-run] [--force] [--prune] [--update-lock]
  ddd rules    [model] [--format json]              Where each named rule is applied and tested
  ddd migrate  [model] [--write]                    Upgrade an older schema_version
  ddd init     [dir]                                Create a sample model.ddd.yaml
  ddd version  [--format json]

Options:
  --out <dir>     Project root for generated files (default: the model's directory)
  --format <f>    text (default) or json
  --no-color      Disable colors

The model defaults to ./model.ddd.yaml. Nothing is sent over the network.`;

export function run(argv: string[], io: Io): number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return command ? EXIT.ok : EXIT.usage;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        format: { type: "string", default: "text" },
        strict: { type: "boolean", default: false },
        patch: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        prune: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "update-lock": { type: "boolean", default: false },
        write: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return EXIT.usage;
  }
  const v = parsed.values;
  if (v.format !== "text" && v.format !== "json") {
    io.err(`--format must be text or json`);
    return EXIT.usage;
  }
  if (v["no-color"]) io.color = false;
  const common = { model: parsed.positionals[0] ?? "model.ddd.yaml", out: v.out, format: v.format as "text" | "json" };
  switch (command) {
    case "validate":
      return cmdValidate(io, { ...common, strict: v.strict! });
    case "diff":
      return cmdDiff(io, { ...common, patch: v.patch!, check: v.check! });
    case "generate":
      return cmdGenerate(io, { ...common, force: v.force!, prune: v.prune!, dryRun: v["dry-run"]!, updateLock: v["update-lock"]! });
    case "rules":
      return cmdRules(io, common);
    case "migrate":
      return cmdMigrate(io, { ...common, write: v.write! });
    case "init":
      return cmdInit(io, parsed.positionals[0] ?? ".");
    case "version":
      return cmdVersion(io, common.format);
    default:
      io.err(`Unknown command "${command}"\n\n${HELP}`);
      return EXIT.usage;
  }
}

if (import.meta.main) {
  const io: Io = { out: (s) => console.log(s), err: (s) => console.error(s), color: !!process.stdout.isTTY && !process.env.NO_COLOR };
  try {
    process.exit(run(process.argv.slice(2), io));
  } catch (e) {
    console.error(`ddd: internal error: ${(e as Error).stack ?? e}`);
    process.exit(3);
  }
}
