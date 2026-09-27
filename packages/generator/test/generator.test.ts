import { describe, expect, test } from "bun:test";
import { checkExpression, makeEnv, T, validateModelText, type ContextIR, type Type } from "@ddd/core";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan, generatePython, renderManifest, sha256, unifiedDiff } from "../src/index.ts";
import { emitExpr, Imports } from "../src/python/support.ts";

const EXAMPLE = join(import.meta.dir, "../../../examples/cleaning-platform");
const MODEL = readFileSync(join(EXAMPLE, "model.ddd.yaml"), "utf8");

function generate(text = MODEL) {
  const r = validateModelText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return generatePython(r.analysis!, text);
}

describe("golden output", () => {
  test("regenerating the example reproduces the committed files byte for byte", () => {
    const out = generate();
    for (const f of out.files) {
      if (f.ownership !== "generated") continue;
      const committed = readFileSync(join(EXAMPLE, f.path), "utf8");
      expect({ path: f.path, content: f.content }).toEqual({ path: f.path, content: committed });
    }
    expect(renderManifest(out.manifest)).toBe(readFileSync(join(EXAMPLE, out.manifestPath), "utf8"));
  });

  test("generation is deterministic", () => {
    expect(JSON.stringify(generate())).toBe(JSON.stringify(generate()));
  });

  test("manifest records model hash, versions and every generated file", () => {
    const out = generate();
    expect(out.manifest.model_sha256).toBe(sha256(MODEL));
    expect(out.manifest.generator_version).toBe("0.1.0");
    expect(out.manifest.files.map((f) => f.path)).toEqual(out.files.filter((f) => f.ownership === "generated").map((f) => f.path));
    expect(out.manifest.scaffold).toContain("src/cleaning_platform/extensions/cleaning_staff/extensions.py");
    expect(JSON.stringify(out.manifest)).not.toMatch(/20\d\d-\d\d-\d\dT/); // no timestamps
  });

  test("refuses to generate from an invalid model", () => {
    const r = validateModelText(MODEL.replace("error: InvalidInvitationWindow", "error: Nope"));
    expect(r.ok).toBe(false);
  });
});

describe("plan", () => {
  const out = generate();
  const disk = () => new Map(out.files.map((f) => [f.path, f.content]));

  test("fresh project: everything is created", () => {
    const plan = computePlan(out, undefined, () => undefined);
    expect(plan.entries.every((e) => e.action === "create")).toBe(true);
    expect(plan.changed).toBe(true);
  });

  test("up to date: nothing changes and scaffolds are kept", () => {
    const d = disk();
    d.set(out.manifestPath, renderManifest(out.manifest));
    const plan = computePlan(out, out.manifest, (p) => d.get(p));
    expect(plan.changed).toBe(false);
    expect(plan.entries.filter((e) => e.ownership === "scaffold").every((e) => e.action === "keep")).toBe(true);
  });

  test("hand edits and foreign files are conflicts", () => {
    const d = disk();
    const agg = out.files.find((f) => f.path.endsWith("aggregates.py"))!.path;
    d.set(agg, d.get(agg) + "\n# edited\n");
    const plan = computePlan(out, out.manifest, (p) => d.get(p));
    expect(plan.conflicts.map((c) => c.path)).toEqual([agg]);
    const noManifest = computePlan(out, undefined, (p) => d.get(p));
    expect(noManifest.conflicts.find((c) => c.path === agg)?.reason).toContain("not created by the generator");
  });

  test("customer edits to scaffolds are never touched", () => {
    const d = disk();
    const ext = "src/cleaning_platform/extensions/cleaning_staff/extensions.py";
    d.set(ext, "# my implementation\n");
    const plan = computePlan(out, out.manifest, (p) => d.get(p));
    expect(plan.entries.find((e) => e.path === ext)?.action).toBe("keep");
    expect(plan.conflicts).toEqual([]);
  });

  test("model changes: stale files and removed symbols are reported, never deleted silently", () => {
    const text = MODEL.slice(0, MODEL.indexOf("      - name: revoke_invitation"));
    const next = generate(text);
    const d = disk();
    const plan = computePlan(next, out.manifest, (p) => d.get(p));
    expect(plan.stale.map((s) => s.path)).toEqual(["tests/generated/test_cleaning_staff_revoke_invitation.py"]);
    expect(plan.breaking.map((b) => b.symbol)).toEqual(["RevokeInvitationUseCase", "RevokeInvitationUseCase.execute", "RevokeInvitation"]);
    const manifestEntry = plan.entries.find((e) => e.path === next.manifestPath)!;
    expect(JSON.parse(manifestEntry.after!).stale.map((s: { path: string }) => s.path)).toEqual(["tests/generated/test_cleaning_staff_revoke_invitation.py"]);
    const pruned = computePlan(next, out.manifest, (p) => d.get(p), { prune: true });
    expect(JSON.parse(pruned.entries.find((e) => e.path === next.manifestPath)!.after!).stale).toBeUndefined();
  });
});

describe("unified diff", () => {
  test("shows removed and added lines with hunk headers", () => {
    const d = unifiedDiff("a.py", "a\nb\nc\n", "a\nB\nc\n");
    expect(d).toContain("--- a/a.py");
    expect(d).toContain("@@ -1,3 +1,3 @@");
    expect(d).toContain("-b\n+B");
  });
  test("identical content has no diff", () => {
    expect(unifiedDiff("a", "x\n", "x\n")).toBe("");
  });
});

describe("expression emission", () => {
  const ctx: ContextIR = {
    name: "X",
    glossary: [],
    errors: [],
    enums: [{ name: "Status", values: ["draft", "placed"], path: [] }],
    valueObjects: [],
    aggregates: [],
    extensionPoints: [],
    useCases: [],
    path: [],
  };
  const env = makeEnv(ctx, {
    self: {
      name: "Order",
      fields: new Map<string, Type>([
        ["status", { k: "enum", name: "Status" }],
        ["total", T.Integer],
        ["note", { k: "optional", inner: T.String }],
        ["tags", { k: "list", item: T.String }],
      ]),
    },
  });
  const py = (src: string) => {
    const r = checkExpression(src, env, T.Boolean);
    if (!r.expr) throw new Error(JSON.stringify(r.errors));
    return emitExpr(r.expr, { self: "self", imports: new Imports(), typeModule: () => "m" });
  };

  test("operators, enums and null checks", () => {
    expect(py("status == placed and total >= 1")).toBe("self.status == Status.PLACED and self.total >= 1");
    expect(py("note == null or length(note) < 3")).toBe("self.note is None or len(self.note) < 3");
    expect(py("not (status == draft or total > 1.5)")).toBe('not (self.status == Status.DRAFT or self.total > Decimal("1.5"))');
    expect(py("(total > 1 or total < 0) and not is_empty(tags)")).toBe("(self.total > 1 or self.total < 0) and not len(self.tags) == 0");
    expect(py("contains(tags, 'vip')")).toBe('"vip" in self.tags');
  });
});

const VENV = join(EXAMPLE, ".venv/bin/python");

describe.skipIf(!existsSync(VENV))("generated Python actually runs", () => {
  test("pytest and mypy --strict pass on a fresh generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-gen-"));
    try {
      const out = generate();
      for (const f of out.files) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), f.content);
      }
      // The untouched scaffold raises NotImplementedError; the generated tests use stubs, so they must pass anyway.
      writeFileSync(join(dir, "pyproject.toml"), readFileSync(join(EXAMPLE, "pyproject.toml")));
      const pytest = Bun.spawnSync([VENV, "-m", "pytest", "-q", "-p", "no:cacheprovider"], { cwd: dir });
      expect(pytest.stdout.toString()).toMatch(/\d+ passed/);
      expect(pytest.exitCode).toBe(0);
      const mypy = Bun.spawnSync([VENV, "-m", "mypy", "src", "tests"], { cwd: dir });
      expect(mypy.stdout.toString()).toContain("Success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("multiple bounded contexts", () => {
  const TWO = `schema_version: 1
project: shop
contexts:
  - name: Sales
    errors: [{ name: Invalid, code: invalid, message: invalid }]
    aggregates:
      - name: Order
        identity: id
        fields: [{ name: id, type: UUID }, { name: total, type: Integer }]
        invariants: [{ name: positive, expression: total > 0, error: Invalid }]
    extension_points:
      - { name: allowed, parameters: [{ name: total, type: Integer }], returns: Boolean, test_default: true }
  - name: Billing
    errors: [{ name: Invalid, code: invalid, message: invalid }]
    aggregates:
      - name: Invoice
        identity: id
        fields: [{ name: id, type: UUID }, { name: order_id, type: UUID }]
    extension_points:
      - { name: allowed, parameters: [], returns: Boolean, test_default: true }
`;

  test("shared runtime is emitted once, contexts get separate packages and scaffolds", () => {
    const out = generate(TWO);
    const paths = out.files.map((f) => f.path);
    expect(paths.filter((p) => p.endsWith("_runtime.py"))).toEqual(["src/shop/generated/_runtime.py"]);
    expect(paths.filter((p) => p === "src/shop/extensions/__init__.py").length).toBe(1);
    expect(paths).toContain("src/shop/generated/sales/domain/aggregates.py");
    expect(paths).toContain("src/shop/generated/billing/domain/aggregates.py");
    expect(paths).toContain("src/shop/extensions/billing/extensions.py");
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("a type from another context cannot be referenced directly", () => {
    const r = validateModelText(TWO.replace("{ name: order_id, type: UUID }", "{ name: order, type: Order }"));
    expect(r.diagnostics.find((d) => d.severity === "error")?.code).toBe("unknown-type");
  });
});
