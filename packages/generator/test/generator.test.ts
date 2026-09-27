import { describe, expect, test } from "bun:test";
import { boardToModel, checkExpression, makeEnv, proposeLocally, sampleBoard, T, validateModelText, type ContextIR, type Type } from "@ddd/core";
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
    const text = MODEL.slice(0, MODEL.indexOf("      - name: revoke_invitation")) + MODEL.slice(MODEL.indexOf("\n  - name: Staffing") + 1);
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
    policies: [],
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

const KITCHEN_SINK = readFileSync(join(import.meta.dir, "fixtures/kitchen-sink.ddd.yaml"), "utf8");
const CONTEXT_MAP = readFileSync(join(import.meta.dir, "fixtures/context-map.ddd.yaml"), "utf8");
/** The model a team gets by reflecting the sample discovery board into an empty project. */
const FROM_BOARD = boardToModel(
  sampleBoard(),
  "schema_version: 1\nproject: staff\ngeneration:\n  package: staff_from_board\n\ncontexts:\n  - name: Core\n    errors: []\n    aggregates: []\n    use_cases: []\n",
).yaml!;

describe.skipIf(!existsSync(VENV))("generated Python actually runs", () => {
  test.each([
    ["the sample model", MODEL],
    ["the kitchen-sink model (lists, decimals, dates, refs, entities, conditional events, no-transaction use cases)", KITCHEN_SINK],
    ["the context-map model (policies within and across contexts, anticorruption layer, subscriptions)", CONTEXT_MAP],
    ["a model reflected from the discovery board", FROM_BOARD],
    ["the sample with locally proposed scenarios added", proposeLocally(MODEL, "CleaningStaff", "CleaningStaffInvitation", "scenarios")!.yaml],
  ])("pytest and mypy --strict pass for %s", (_label, modelText) => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-gen-"));
    try {
      const out = generate(modelText);
      for (const f of out.files) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), f.content);
      }
      // The untouched scaffold raises NotImplementedError; the generated tests use stubs, so they must pass anyway.
      writeFileSync(join(dir, "pyproject.toml"), readFileSync(join(EXAMPLE, "pyproject.toml")));
      const pytest = Bun.spawnSync([VENV, "-m", "pytest", "-q", "-p", "no:cacheprovider"], { cwd: dir });
      // A model without scenarios has no generated tests (pytest exit code 5 = "no tests collected").
      if (modelText !== FROM_BOARD) {
        expect(pytest.stdout.toString()).toMatch(/\d+ passed/);
        expect(pytest.exitCode).toBe(0);
      } else {
        expect([0, 5]).toContain(pytest.exitCode);
        const imp = Bun.spawnSync([VENV, "-c", "import staff_from_board.generated.staff_invitation.application.use_cases, staff_from_board.generated.notification.domain.aggregates"], { cwd: join(dir, "src") });
        expect(imp.stderr.toString()).toBe("");
      }
      const mypy = Bun.spawnSync([VENV, "-m", "mypy", "src", ...(existsSync(join(dir, "tests")) ? ["tests"] : [])], { cwd: dir });
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

describe("policies and the context map", () => {
  const out = generate(CONTEXT_MAP);
  const file = (p: string) => out.files.find((f) => f.path === p);

  test("a context with policies gets policies.py, generated tests and (for an anticorruption layer) a translator scaffold", () => {
    expect(file("src/context_map/generated/staffing/application/policies.py")?.ownership).toBe("generated");
    expect(file("tests/generated/test_staffing_policies.py")?.ownership).toBe("generated");
    expect(file("src/context_map/generated/hiring/application/policies.py")).toBeUndefined();
    expect(file("src/context_map/extensions/payroll/translators.py")?.ownership).toBe("scaffold");
    expect(out.manifest.scaffold).toContain("src/context_map/extensions/payroll/translators.py");
    expect(out.manifest.files.map((f) => f.path)).toContain("src/context_map/generated/payroll/application/policies.py");
  });

  test("the downstream imports the upstream's event class (published language) and maps event fields into the command", () => {
    const py = file("src/context_map/generated/staffing/application/policies.py")!.content;
    expect(py).toContain("from context_map.generated.hiring.domain import events as hiring_events");
    expect(py).toContain("event_type = hiring_events.CandidateAccepted");
    expect(py).toMatch(/RegisterStaff\(\s*candidate_id=event\.id,\s*email=event\.email\.value,\s*joined_at=event\.at,\s*source=Source\.HIRING,?\s*\)/);
    expect(py).toContain("hiring_events.CandidateAccepted: (register_accepted_candidate,),");
    expect(py).toContain("StaffRegistered: (welcome_registered_staff,),");
  });

  test("an anticorruption layer routes the command through the translator seam", () => {
    const py = file("src/context_map/generated/payroll/application/policies.py")!.content;
    expect(py).toContain("class StaffingTranslator(Protocol):");
    expect(py).toContain("command = self._translator.open_account_for_new_staff(event, command)");
    expect(file("src/context_map/extensions/payroll/translators.py")!.content).toContain("_conforms_staffing: StaffingTranslator = FromStaffing()");
  });

  test("the context README lists the policies and draws the context map", () => {
    const md = file("src/context_map/generated/staffing/README.md")!.content;
    expect(md).toContain("## Policies");
    expect(md).toContain("| `register_accepted_candidate` (`RegisterAcceptedCandidatePolicy`) — Accepted candidates join the staff | Hiring.CandidateAccepted | `register_staff` |");
    expect(md).toContain('  Hiring -->|"customer_supplier: CandidateAccepted"| Staffing');
    expect(md).toContain("| Hiring | Staffing | customer_supplier | CandidateAccepted | `Staffing.register_accepted_candidate` |");
    expect(md).toContain('  Staffing -->|"anticorruption_layer: StaffRegistered"| Payroll');
  });

  test("removing every policy leaves the old files as stale instead of deleting them", () => {
    const withoutPayrollPolicy = CONTEXT_MAP.replace(/    policies:\n      - name: open_account_for_new_staff[\s\S]*?opened_at: clock.now \}\n/, "").replace(/  - upstream: Staffing[\s\S]*$/, "");
    const next = generate(withoutPayrollPolicy);
    const disk = new Map(out.files.map((f) => [f.path, f.content]));
    const plan = computePlan(next, out.manifest, (p) => disk.get(p));
    expect(plan.stale.map((s) => s.path)).toEqual(["src/context_map/generated/payroll/application/policies.py", "tests/generated/test_payroll_policies.py"]);
    // The customer-owned translator is not a generated file, so it is never reported or removed.
    expect(plan.entries.find((e) => e.path.endsWith("payroll/translators.py"))).toBeUndefined();
  });
});
