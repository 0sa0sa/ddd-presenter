import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/commands.ts";
import { run } from "../src/main.ts";

function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), color: false };
  const code = run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function cliAsync(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), color: false };
  const code = await run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), "ddd-cli-"));
  expect(cli(["init", dir]).code).toBe(0);
  return { dir, model: join(dir, "model.ddd.yaml") };
}

/** The sample without its revoke_invitation use case (the last use case of CleaningStaff, before its queries). */
function withoutRevoke(text: string): string {
  const start = text.indexOf("      - name: revoke_invitation");
  const ends = ["\n      - name: inspect_invitation", "\n    # 読み取り", "\n    queries:", "\n  - name: Staffing"].map((m) => text.indexOf(m, start)).filter((i) => i > start);
  return text.slice(0, start) + text.slice(Math.min(...ends) + 1);
}

describe("ddd CLI", () => {
  test("help and unknown commands", () => {
    expect(cli([]).code).toBe(2);
    expect(cli(["--help"]).out).toContain("ddd validate");
    expect(cli(["frobnicate"]).code).toBe(2);
  });

  test("version", () => {
    const r = cli(["version", "--format", "json"]);
    expect(JSON.parse(r.out)).toMatchObject({ generator_version: "0.1.0", schema_version: 1 });
  });

  test("validate: exit codes and JSON output", () => {
    const { model } = project();
    expect(cli(["validate", model]).code).toBe(0);
    writeFileSync(model, readFileSync(model, "utf8").replace("error: InvalidInvitationWindow", "error: Missing"));
    const r = cli(["validate", model, "--format", "json"]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.out);
    expect(json.ok).toBe(false);
    expect(json.diagnostics[0]).toMatchObject({ severity: "error", code: "unknown-error" });
    expect(json.diagnostics[0].line).toBeGreaterThan(0);
    expect(cli(["validate", join(model, "nope.yaml")]).code).toBe(2);
  });

  test("generate → up to date → hand edit is refused → --force", () => {
    const { dir, model } = project();
    const g = cli(["generate", model]);
    expect(g.code).toBe(0);
    expect(existsSync(join(dir, "src/cleaning_platform/generated/cleaning_staff/domain/aggregates.py"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "ddd.lock"), "utf8")).generator_version).toBe("0.1.0");

    expect(cli(["diff", model, "--check"]).code).toBe(0);

    const agg = join(dir, "src/cleaning_platform/generated/cleaning_staff/domain/aggregates.py");
    appendFileSync(agg, "\n# hand edit\n");
    const refused = cli(["generate", model]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("edited by hand");
    expect(readFileSync(agg, "utf8")).toContain("# hand edit"); // nothing was written
    expect(cli(["diff", model, "--check"]).code).toBe(1);

    expect(cli(["generate", model, "--force"]).code).toBe(0);
    expect(readFileSync(agg, "utf8")).not.toContain("# hand edit");
  });

  test("init --target typescript scaffolds a TypeScript model; generate follows the model's target", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-cli-ts-"));
    expect(cli(["init", dir, "--target", "typescript"]).code).toBe(0);
    const model = join(dir, "model.ddd.yaml");
    expect(readFileSync(model, "utf8")).toContain("target: typescript");
    const g = cli(["generate", model]);
    expect(g.code).toBe(0);
    expect(existsSync(join(dir, "src/cleaning_platform/generated/cleaning-staff/domain/aggregates.ts"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "tests/generated/cleaning-staff-accept-invitation.test.ts"))).toBe(true);
    // The untouched scaffold still throws: the TypeScript scaffold is checked like the Python one.
    expect(g.err).toContain('extension is_blocked_email still throws "not implemented yet"');
    expect(cli(["diff", model, "--check"]).code).toBe(0);
    expect(cli(["generate", model, "--target", "rust"]).code).toBe(2);
  });

  test("--target overrides the model's target", () => {
    const { dir, model } = project();
    expect(cli(["generate", model, "--target", "typescript"]).code).toBe(0);
    expect(existsSync(join(dir, "src/cleaning_platform/generated/runtime.ts"))).toBe(true);
    expect(existsSync(join(dir, "src/cleaning_platform/generated/_runtime.py"))).toBe(false);
    expect(cli(["diff", model, "--check", "--target", "typescript"]).code).toBe(0);
  });

  test("scaffolded extension code survives regeneration", () => {
    const { dir, model } = project();
    cli(["generate", model]);
    const ext = join(dir, "src/cleaning_platform/extensions/cleaning_staff/extensions.py");
    writeFileSync(ext, "# customer code\n");
    writeFileSync(model, readFileSync(model, "utf8").replace("description: 招待を受諾する\n        command", "description: 招待を受諾します\n        command"));
    expect(cli(["generate", model]).code).toBe(0);
    expect(readFileSync(ext, "utf8")).toBe("# customer code\n");
  });

  test("diff --patch prints unified diffs; --dry-run writes nothing", () => {
    const { dir, model } = project();
    const d = cli(["diff", model, "--patch"]);
    expect(d.out).toContain("+++ b/src/cleaning_platform/generated/_runtime.py");
    expect(cli(["generate", model, "--dry-run"]).code).toBe(0);
    expect(existsSync(join(dir, "src"))).toBe(false);
  });

  test("a mismatched ddd.lock blocks generation until --update-lock", () => {
    const { dir, model } = project();
    writeFileSync(join(dir, "ddd.lock"), JSON.stringify({ generator_version: "0.0.9", schema_version: 1 }));
    const r = cli(["generate", model]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("0.0.9");
    expect(cli(["generate", model, "--update-lock"]).code).toBe(0);
  });

  test("invalid model stops generation", () => {
    const { dir, model } = project();
    writeFileSync(model, readFileSync(model, "utf8").replace("type: InvitationStatus", "type: Statuz"));
    const r = cli(["generate", model]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown-type");
    expect(existsSync(join(dir, "src"))).toBe(false);
  });

  test("rules shows traceability", () => {
    const { model } = project();
    const r = cli(["rules", model]);
    expect(r.out).toContain("pending_until_expiry");
    expect(r.out).toContain("test_expired_invitation_is_rejected");
  });

  test("review: the sheet hides the model's answers, --key shows them, answers that differ fail", () => {
    const { dir, model } = project();
    const sheet = cli(["review", model]);
    expect(sheet.code).toBe(0);
    expect(sheet.out).toContain("ある組織のユーザーは、別の組織のスタッフ候補への招待（CleaningStaffInvitation）を見られる。 | ☐ | ☐ |");
    expect(sheet.out).not.toContain("いまのモデル");
    expect(sheet.out).not.toContain("組織ごとに保存され");
    const key = cli(["review", model, "--key"]);
    expect(key.out).toContain("| ある組織のユーザーは、別の組織のスタッフ候補への招待（CleaningStaffInvitation）を見られる。 | いいえ |");

    const template = cli(["review", model, "--template"]);
    expect(template.out).toContain('"tenancy:parent-reads-children": \n');
    const answers = join(dir, "answers.yaml");
    writeFileSync(answers, template.out.replace('"tenancy:parent-reads-children": ', '"tenancy:parent-reads-children": はい').replace('"tenancy:read-other:CleaningStaff.CleaningStaffInvitation": ', '"tenancy:read-other:CleaningStaff.CleaningStaffInvitation": no'));
    const r = cli(["review", model, "--answers", answers]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("モデルを直す必要があるもの: 1 件");
    expect(r.out).toContain("**上位の組織の管理者は、配下の組織のメンバーやデータをすべて見られる。** → 回答: はい（モデル: いいえ）");
    // The template keeps the answers given so far.
    expect(cli(["review", model, "--answers", answers, "--template"]).out).toContain('"tenancy:parent-reads-children": yes');
    const json = JSON.parse(cli(["review", model, "--answers", answers, "--format", "json"]).out);
    expect(json.findings.map((f: { question: { id: string } }) => f.question.id)).toEqual(["tenancy:parent-reads-children"]);

    writeFileSync(answers, '"tenancy:read-other:CleaningStaff.CleaningStaffInvitation": no\n"nope": yes\n"tenancy:hierarchy": maybe\n');
    const ok = cli(["review", model, "--answers", answers]);
    expect(ok.code).toBe(0);
    expect(ok.err).toContain('Unknown question "nope"');
    expect(ok.err).toContain('"tenancy:hierarchy": answer yes or no, not "maybe"');
    expect(cli(["review", model, "--answers", join(dir, "missing.yaml")]).code).toBe(2);
  });

  test("review --flows: the diagrams as Markdown with Mermaid, or as JSON", () => {
    const { model } = project();
    const md = cli(["review", model, "--flows"]);
    expect(md.code).toBe(0);
    expect(md.out).toContain("## イベントのつながり\n\n```mermaid\nflowchart LR");
    expect(md.out).toContain("### CleaningStaff › 招待を受諾する（accept_invitation）\n\n```mermaid\nsequenceDiagram");
    const json = JSON.parse(cli(["review", model, "--flows", "--format", "json"]).out);
    expect(json.useCases.map((d: { id: string }) => d.id)).toContain("CleaningStaff.accept_invitation");
    expect(json.events.edges.length).toBeGreaterThan(0);
  });

  test("verify: proofs and counterexamples with Z3, SMT-LIB scripts on request; review --proofs asks about the counterexamples", async () => {
    const { model, dir } = project();
    const md = await cliAsync(["verify", model, "--smt2", join(dir, "smt")]);
    expect(md.code).toBe(0);
    expect(md.out).toContain("## 前提");
    expect(md.out).toMatch(/証明 \d+・反例 \d+・不明 0/);
    expect(md.err).toMatch(/\d+ SMT-LIB scripts in /);
    const json = JSON.parse((await cliAsync(["verify", model, "--format", "json", "--depth", "0"])).out);
    expect(json.results.length).toBeGreaterThan(0);
    expect(json.results.every((r: { path?: unknown }) => r.path === undefined)).toBe(true);
    const review = await cliAsync(["review", model, "--proofs", "--key"]);
    expect(review.out).toContain("## 断られる場合（Z3 の反例）");
    expect((await cliAsync(["verify", model, "--depth", "9"])).code).toBe(2);
  }, 60_000);

  test("changes: behaviour differences from another version; --check fails when a check loosens", () => {
    const { model, dir } = project();
    const before = join(dir, "before.ddd.yaml");
    writeFileSync(before, readFileSync(model, "utf8"));
    expect(cli(["changes", before, model]).out).toBe("振る舞いの変化はありません。");
    // Revoking no longer requires the invitation to be open.
    const text = readFileSync(model, "utf8");
    const loosened = text.replace(/(- name: revoke\n(?:.*\n)*?\s+require: )\[is_open\]/, "$1[]");
    expect(loosened).not.toBe(text);
    writeFileSync(model, loosened);
    const r = cli(["changes", before, model, "--check"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("▲ CleaningStaffInvitation.revoke の require から is_open がなくなる");
    expect(cli(["changes", before, model]).code).toBe(0);
    expect(JSON.parse(cli(["changes", before, model, "--format", "json"]).out)[0]).toMatchObject({ kind: "guard", weakens: true });
    expect(cli(["changes"]).code).toBe(2);
  });

  test("review of an invalid model reports the errors instead", () => {
    const { model } = project();
    appendFileSync(model, "\nbogus: 1\n");
    const r = cli(["review", model]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Fix the errors first");
  });

  test("YAML with excessive aliases is an ordinary diagnostic (exit 1), never an internal error with a stack trace", () => {
    const { model } = project();
    writeFileSync(model, "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n");
    const r = cli(["validate", model]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("model.ddd.yaml:2:8: error [yaml-aliases]");
    // The real process: same exit code, no "internal error", no stack frames.
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), "validate", model], { env: { ...process.env, NO_COLOR: "1", DDD_DEBUG: "" } });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).not.toContain("internal error");
    expect(p.stderr.toString()).not.toMatch(/at .*\.(ts|js):\d+/);
  });

  test("removing a use case: its untouched generated test is deleted; diff --check advice matches what fixes it", () => {
    const { dir, model } = project();
    expect(cli(["generate", model]).code).toBe(0);
    const text = readFileSync(model, "utf8");
    const test = join(dir, "tests/generated/test_cleaning_staff_revoke_invitation.py");
    expect(existsSync(test)).toBe(true);
    // Drop the revoke_invitation use case (up to the next context).
    writeFileSync(model, withoutRevoke(text));
    const check = cli(["diff", model, "--check"]);
    expect(check.code).toBe(1);
    expect(check.err).toContain("Run `ddd generate`.");
    const g = cli(["generate", model]);
    expect(g.code).toBe(0);
    expect(g.out).toContain("Deleted 1 generated test file(s)");
    expect(existsSync(test)).toBe(false); // it imported RevokeInvitationUseCase and would fail with ImportError
    expect(cli(["diff", model, "--check"]).code).toBe(0);
  });

  test("a hand-edited stale generated test blocks generate; the advice is --prune --force", () => {
    const { dir, model } = project();
    cli(["generate", model]);
    const text = readFileSync(model, "utf8");
    const test = join(dir, "tests/generated/test_cleaning_staff_revoke_invitation.py");
    appendFileSync(test, "\n# my extra assertion\n");
    writeFileSync(model, withoutRevoke(text));
    const check = cli(["diff", model, "--check"]);
    expect(check.code).toBe(1);
    expect(check.err).toContain("`ddd generate --prune --force`");
    expect(check.err).not.toContain("Run `ddd generate`.");
    const refused = cli(["generate", model]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("stale generated test(s) were edited by hand; nothing was written");
    expect(existsSync(test)).toBe(true);
    expect(cli(["generate", model, "--prune", "--force"]).code).toBe(0);
    expect(existsSync(test)).toBe(false);
    expect(cli(["diff", model, "--check"]).code).toBe(0);
  });

  test("diff --check advice: conflicts need --force, stale modules need --prune", () => {
    const { dir, model } = project();
    cli(["generate", model]);
    const agg = join(dir, "src/cleaning_platform/generated/cleaning_staff/domain/aggregates.py");
    appendFileSync(agg, "\n# hand edit\n");
    const conflict = cli(["diff", model, "--check"]);
    expect(conflict.err).toContain("`ddd generate --force`");
    expect(conflict.err).not.toContain("Run `ddd generate`.");
    expect(cli(["generate", model, "--force"]).code).toBe(0);

    // Removing the only policy leaves policies.py stale; plain generate keeps it, so the advice must be --prune.
    const text = readFileSync(model, "utf8");
    writeFileSync(model, text.replace(/    policies:\n      - name: register_staff_on_acceptance[\s\S]*?args: \{[^}]*\}\n/, ""));
    expect(cli(["generate", model]).code).toBe(0);
    expect(existsSync(join(dir, "src/cleaning_platform/generated/staffing/application/policies.py"))).toBe(true);
    expect(existsSync(join(dir, "tests/generated/test_staffing_policies.py"))).toBe(false);
    const stale = cli(["diff", model, "--check"]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("`ddd generate --prune`");
    expect(stale.err).not.toContain("Run `ddd generate`.");
    expect(cli(["generate", model, "--prune"]).code).toBe(0);
    expect(cli(["diff", model, "--check"]).code).toBe(0);
  });

  test("validate --strict also reports untested rules, unused errors and unused extension points", () => {
    const { model } = project();
    expect(cli(["validate", model, "--strict"]).code).toBe(0);
    const text = readFileSync(model, "utf8");
    // A second guard with an error nothing else raises and no scenario: untested; an extra error nobody raises: unused.
    writeFileSync(
      model,
      text
        .replace("      - name: EmailBlocked\n", "      - name: NeverRaised\n        code: never_raised\n        message: never\n      - name: EmailBlocked\n")
        .replace(
          "          - name: is_open\n",
          "          - name: is_pending\n            expression: status == pending\n            error: InvitationAlreadyClosed\n          - name: is_open\n",
        ),
    );
    expect(cli(["validate", model]).code).toBe(0); // not part of the normal check
    const r = cli(["validate", model, "--strict"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("[unused-error]");
    expect(r.err).toContain("[untested-rule] (CleaningStaff › CleaningStaffInvitation › is_pending)");
  });

  test("rules: shared errors are 'not counted', derived violating tests are listed", () => {
    const { model } = project();
    const r = cli(["rules", model]);
    expect(r.out).toContain("derived:   test_invariant_cleaning_staff_invitation_expiry_after_creation");
    expect(r.out).toContain("not counted: invitation_window_must_be_positive expects InvalidInvitationWindow, which invariant accepted_invitation_has_accepted_at can also raise");
  });

  test("migrate is a no-op on the current schema", () => {
    const { model } = project();
    expect(cli(["migrate", model]).out).toContain("nothing to migrate");
  });
});

describe("pruning removes directories it leaves empty", () => {
  test("empty parents go, directories that still hold files and the root stay", async () => {
    const { atomicApply } = await import("../src/fsops.ts");
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "ddd-prune-"));
    try {
      mkdirSync(join(root, "src/gen/api/ordering"), { recursive: true });
      writeFileSync(join(root, "src/gen/api/ordering/hooks.ts"), "x");
      writeFileSync(join(root, "src/gen/api/client.ts"), "x");
      atomicApply(root, [{ path: "src/gen/api/ordering/hooks.ts", remove: true }]);
      expect(existsSync(join(root, "src/gen/api/ordering"))).toBe(false);
      expect(existsSync(join(root, "src/gen/api/client.ts"))).toBe(true);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ddd CLI: multi-file models (docs/10 §12)", () => {
  test("migrate --split → validate → generate leaves the generated code as it was", () => {
    const { dir, model } = project();
    expect(cli(["generate", model]).code).toBe(0);
    const split = cli(["migrate", model, "--split"]);
    expect(split.code).toBe(0);
    for (const f of ["ddd.yaml", "cleaning_staff/v1/cleaning_staff.proto", "cleaning_staff.domain", "cleaning_staff.flow", "cleaning_staff.scenarios.yaml", "ddd/v1/options.proto", "buf.yaml"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    // A second run refuses to overwrite.
    expect(cli(["migrate", model, "--split"]).code).toBe(1);

    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(model);
    expect(cli(["validate", dir]).code).toBe(0);
    expect(cli(["validate", join(dir, "ddd.yaml")]).code).toBe(0);
    // Same model, so only the model hash of the generated manifest changes.
    const d = cli(["diff", dir]);
    expect(d.out).toContain("0 to create, 1 to update");
    expect(d.out).toContain("model_manifest.json");
    expect(cli(["generate", dir]).code).toBe(0);
    expect(cli(["diff", dir, "--check"]).code).toBe(0);
    expect(cli(["validate", dir, "--strict"]).code).toBe(0);
  });

  test("diagnostics name the source file and line", () => {
    const { dir, model } = project();
    expect(cli(["migrate", model, "--split"]).code).toBe(0);
    const flow = join(dir, "cleaning_staff.flow");
    writeFileSync(flow, readFileSync(flow, "utf8").replace("fail EmailBlocked", "fail EmailBlockd"));
    const r = cli(["validate", join(dir, "ddd.yaml"), "--format", "json"]);
    expect(r.code).toBe(1);
    const [d] = JSON.parse(r.out).diagnostics;
    expect(d).toMatchObject({ code: "unknown-error", file: "cleaning_staff.flow", line: 4 });
    const text = cli(["validate", join(dir, "ddd.yaml")]);
    expect(text.err).toContain(`${join(require("node:path").relative(process.cwd(), dir), "cleaning_staff.flow")}:4:`);

    // A syntax error does not cascade into "missing flow" errors for everything in the file.
    writeFileSync(flow, readFileSync(flow, "utf8").replace("save invitation\n", "save invitation extra\n"));
    const s = JSON.parse(cli(["validate", dir, "--format", "json"]).out);
    expect(s.diagnostics.map((x: { code: string }) => x.code)).toEqual(["syntax"]);
  });
});

describe("ddd init --split", () => {
  test("scaffolds the sample as a multi-file model that validates and generates", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-cli-split-"));
    const r = cli(["init", dir, "--split"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "ddd.yaml"))).toBe(true);
    expect(existsSync(join(dir, "model.ddd.yaml"))).toBe(false);
    expect(cli(["validate", dir]).code).toBe(0);
    expect(cli(["generate", dir]).code).toBe(0);
    expect(existsSync(join(dir, "src/cleaning_platform/generated/cleaning_staff/domain/aggregates.py"))).toBe(true);
    expect(cli(["init", dir, "--split"]).code).toBe(1);
  });
});

describe("ddd CLI: other .proto files next to a multi-file model", () => {
  test("a vendored proto2 file neither breaks validation nor changes the model hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-cli-vendor-"));
    expect(cli(["init", dir, "--split"]).code).toBe(0);
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "third_party"));
    const vendored = join(dir, "third_party/vendor.proto");
    writeFileSync(vendored, 'syntax = "proto2";\npackage vendor;\nmessage Thing { map<string, int32> counts = 1; oneof k { string a = 2; } }\n');
    expect(cli(["validate", dir]).code).toBe(0);
    expect(cli(["generate", dir]).code).toBe(0);
    writeFileSync(vendored, readFileSync(vendored, "utf8") + "// edited\n");
    expect(cli(["diff", dir, "--check"]).code).toBe(0);
  });
});
