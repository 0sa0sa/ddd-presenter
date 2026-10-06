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

function project() {
  const dir = mkdtempSync(join(tmpdir(), "ddd-cli-"));
  expect(cli(["init", dir]).code).toBe(0);
  return { dir, model: join(dir, "model.ddd.yaml") };
}

/** The sample without its revoke_invitation use case (the last use case of CleaningStaff, before its queries). */
function withoutRevoke(text: string): string {
  const start = text.indexOf("      - name: revoke_invitation");
  const ends = ["\n    # 読み取り", "\n    queries:", "\n  - name: Staffing"].map((m) => text.indexOf(m, start)).filter((i) => i > start);
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
