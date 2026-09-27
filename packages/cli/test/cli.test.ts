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

  test("migrate is a no-op on the current schema", () => {
    const { model } = project();
    expect(cli(["migrate", model]).out).toContain("nothing to migrate");
  });
});
