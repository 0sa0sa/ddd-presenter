#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { cmdChanges, cmdDiff, cmdGenerate, cmdInit, cmdMigrate, cmdReview, cmdRules, cmdValidate, cmdVerify, cmdVersion, EXIT, type Io } from "./commands.ts";

const HELP = `ddd — DDD Presenter CLI (model-driven Python / TypeScript domain code)

Usage:
  ddd validate [model] [--strict] [--format json]   Check the model; non-zero exit on errors
                                                   (--strict: warnings fail too, plus untested rules,
                                                   unused errors and unused extension points)
  ddd diff     [model] [--patch] [--check]          Show what generate would change (--check: fail if out of date)
  ddd generate [model] [--dry-run] [--force] [--prune] [--update-lock] [--target python|typescript]
  ddd rules    [model] [--format json]              Where each named rule is applied and tested
  ddd review   [model] [--key] [--template] [--answers file] [--format json]
                                                   Yes/no questions for a product manager (Markdown):
                                                   the sheet (default, without the model's answers),
                                                   --key with them, --template an answers file to fill in,
                                                   --answers: the answers that differ from the model (exit 1)
  ddd review   [model] --flows [--format json]      Flow diagrams for a review (Markdown with Mermaid): the event
                                                   chain and a sequence per use case and query
  ddd review   [model] --proofs [...]               The questions plus one per counterexample of ddd verify
  ddd verify   [model] [--smt2 dir] [--depth n] [--strict] [--format json]
                                                   Proofs with Z3: can each check (invariant, constraint) reject a
                                                   factory or operation once its guards hold? A proof, or a
                                                   counterexample with the steps that reach it (--depth: operations
                                                   to search, default 2). --smt2 writes every query as SMT-LIB.
                                                   Exit 1 when an operation can never succeed (--strict: also on
                                                   counterexamples)
  ddd verify   [model] --lean dir [--prove] [--lean-cmd "lean"]
                                                   Also write the results Z3 checked only up to a list bound as
                                                   Lean 4 theorems; --prove has Claude Code write the proofs and
                                                   Lean check them (only Lean's standard axioms are accepted)
  ddd changes  <before> [model] [--check] [--format json]
                                                   What changes in behaviour from another version of the model:
                                                   flipped review answers, transitions, and (marked ▲) checks
                                                   that loosen: removed invariants, guards, scenarios, wider
                                                   access. --check: exit 1 when a check loosens
  ddd migrate  [model] [--write]                    Upgrade an older schema_version
  ddd migrate  [model] --split [--out dir] [--force] Convert a YAML model to the multi-file format
                                                   (ddd.yaml + .proto / .domain / .flow / .scenarios.yaml)
  ddd init     [dir] [--target python|typescript] [--split]
                                                   Create a sample model.ddd.yaml (--split: the multi-file format)
  ddd version  [--format json]

Options:
  --out <dir>     Project root for generated files (default: the model's directory)
  --format <f>    text (default) or json
  --target <t>    python or typescript; overrides generation.target of the model (diff, generate)
  --no-color      Disable colors

The model defaults to ./model.ddd.yaml, else ./ddd.yaml. A model is a YAML file, or a directory holding
ddd.yaml and the .proto / .domain / .flow / .scenarios.yaml sources (docs/10 §12).
Nothing is sent over the network (ddd verify runs Z3 in-process).`;

export function run(argv: string[], io: Io): number | Promise<number> {
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
        split: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
        target: { type: "string" },
        key: { type: "boolean", default: false },
        template: { type: "boolean", default: false },
        answers: { type: "string" },
        flows: { type: "boolean", default: false },
        proofs: { type: "boolean", default: false },
        smt2: { type: "string" },
        lean: { type: "string" },
        prove: { type: "boolean", default: false },
        "lean-cmd": { type: "string" },
        depth: { type: "string" },
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
  if (v.target !== undefined && v.target !== "python" && v.target !== "typescript") {
    io.err(`--target must be python or typescript`);
    return EXIT.usage;
  }
  if (v["no-color"]) io.color = false;
  const target = v.target as "python" | "typescript" | undefined;
  const common = { model: parsed.positionals[0] ?? "model.ddd.yaml", out: v.out, format: v.format as "text" | "json", ...(target ? { target } : {}) };
  switch (command) {
    case "validate":
      return cmdValidate(io, { ...common, strict: v.strict! });
    case "diff":
      return cmdDiff(io, { ...common, patch: v.patch!, check: v.check! });
    case "generate":
      return cmdGenerate(io, { ...common, force: v.force!, prune: v.prune!, dryRun: v["dry-run"]!, updateLock: v["update-lock"]! });
    case "rules":
      return cmdRules(io, common);
    case "review":
      return cmdReview(io, { ...common, key: v.key!, template: v.template!, flows: v.flows!, proofs: v.proofs!, ...(v.answers !== undefined ? { answers: v.answers } : {}) });
    case "changes": {
      const [before, model] = parsed.positionals;
      if (!before) {
        io.err("ddd changes needs the model to compare with: ddd changes <before> [model]");
        return EXIT.usage;
      }
      return cmdChanges(io, { ...common, model: model ?? "model.ddd.yaml", before, check: v.check! });
    }
    case "verify": {
      const depth = v.depth === undefined ? undefined : Number(v.depth);
      if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0 && depth <= 4)) {
        io.err("--depth must be an integer from 0 to 4");
        return EXIT.usage;
      }
      if (v.prove && !v.lean) {
        io.err("--prove needs --lean <dir> (where the Lean project is written)");
        return EXIT.usage;
      }
      return cmdVerify(io, {
        ...common,
        strict: v.strict!,
        prove: v.prove!,
        ...(v.smt2 !== undefined ? { smt2: v.smt2 } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(v.lean !== undefined ? { lean: v.lean } : {}),
        ...(v["lean-cmd"] !== undefined ? { leanCmd: v["lean-cmd"] } : {}),
      });
    }
    case "migrate":
      return cmdMigrate(io, { ...common, write: v.write!, split: v.split!, force: v.force! });
    case "init":
      return cmdInit(io, parsed.positionals[0] ?? ".", target, v.split!);
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
    process.exit(await run(process.argv.slice(2), io));
  } catch (e) {
    // Problems in the user's input are diagnostics with exit code 1; reaching this point is a bug in ddd itself.
    // The stack trace is for whoever fixes it, so it is shown only on request.
    const err = e as Error;
    console.error(`ddd: internal error: ${err.message ?? e}`);
    if (process.env.DDD_DEBUG) console.error(err.stack ?? "");
    else console.error("Please report this. Set DDD_DEBUG=1 to print the stack trace.");
    process.exit(3);
  }
}
