import { describe, expect, test } from "bun:test";
import { boardToModel, checkExpression, makeEnv, proposeLocally, sampleBoard, T, validateModelText, type ContextIR, type Type } from "@ddd/core";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan, generatePython, renderManifest, sha256, unifiedDiff } from "../src/index.ts";
import { wrapLongLines } from "../src/python/layout.ts";
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

  test("model changes: removed symbols are reported; an untouched stale generated test is deleted, an edited one blocks", () => {
    const text = MODEL.slice(0, MODEL.indexOf("      - name: revoke_invitation")) + MODEL.slice(MODEL.indexOf("\n  - name: Staffing") + 1);
    const next = generate(text);
    const d = disk();
    const plan = computePlan(next, out.manifest, (p) => d.get(p));
    const test = "tests/generated/test_cleaning_staff_revoke_invitation.py";
    expect(plan.stale.map((s) => s.path)).toEqual([test]);
    expect(plan.breaking.map((b) => b.symbol)).toEqual(["RevokeInvitationUseCase", "RevokeInvitationUseCase.execute", "RevokeInvitation"]);
    // It imports RevokeInvitationUseCase, which no longer exists: keeping it would only produce an ImportError.
    expect(plan.stale[0]).toMatchObject({ generatedTest: true, autoPrune: true, modified: false });
    expect(plan.staleEditedTests).toEqual([]);
    const manifestEntry = plan.entries.find((e) => e.path === next.manifestPath)!;
    expect(JSON.parse(manifestEntry.after!).stale).toBeUndefined();

    d.set(test, d.get(test) + "\n# my extra assertion\n");
    const edited = computePlan(next, out.manifest, (p) => d.get(p));
    expect(edited.stale[0]).toMatchObject({ generatedTest: true, autoPrune: false, modified: true });
    expect(edited.staleEditedTests.map((e) => e.path)).toEqual([test]);
    expect(JSON.parse(edited.entries.find((e) => e.path === next.manifestPath)!.after!).stale.map((s: { path: string }) => s.path)).toEqual([test]);
    const forced = computePlan(next, out.manifest, (p) => d.get(p), { prune: true, force: true });
    expect(forced.staleEditedTests).toEqual([]);
    expect(JSON.parse(forced.entries.find((e) => e.path === next.manifestPath)!.after!).stale).toBeUndefined();
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

/** Python script: report every condition (if/while/assert/return/StateGuard holds=) that parses as a tuple. */
const NO_TUPLE_CONDITIONS = `
import ast, pathlib, sys
for path in sorted(pathlib.Path(sys.argv[1]).rglob("*.py")):
    for node in ast.walk(ast.parse(path.read_text(), str(path))):
        conditions = []
        if isinstance(node, (ast.If, ast.While, ast.Assert, ast.IfExp)):
            conditions.append(node.test)
        if isinstance(node, ast.Return) and node.value is not None:
            conditions.append(node.value)
        if isinstance(node, ast.keyword) and node.arg == "holds":
            conditions.append(node.value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            conditions.append(node.operand)
        for c in conditions:
            if isinstance(c, ast.Tuple):
                print(f"{path}:{c.lineno}: condition is a tuple (always true)")
        if isinstance(node, ast.Tuple) and len(node.elts) == 1 and isinstance(node.elts[0], (ast.BoolOp, ast.Compare, ast.UnaryOp)):
            print(f"{path}:{node.lineno}: one-element tuple around a condition")
`;

const KITCHEN_SINK = readFileSync(join(import.meta.dir, "fixtures/kitchen-sink.ddd.yaml"), "utf8");
const CONTEXT_MAP = readFileSync(join(import.meta.dir, "fixtures/context-map.ddd.yaml"), "utf8");
const LONG_RULES = readFileSync(join(import.meta.dir, "fixtures/long-rules.ddd.yaml"), "utf8");
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
    ["the long-rules model (wrapped invariants, guards, emits conditions and use-case conditions must still fire)", LONG_RULES],
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
      // Independent of the TypeScript wrapper: Python's own parser must not see a tuple where a condition belongs.
      const ast = Bun.spawnSync([VENV, "-c", NO_TUPLE_CONDITIONS, dir]);
      expect(ast.stdout.toString() + ast.stderr.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
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

  test("removing every policy leaves the old module as stale instead of deleting it (its generated test goes)", () => {
    const withoutPayrollPolicy = CONTEXT_MAP.replace(/    policies:\n      - name: open_account_for_new_staff[\s\S]*?opened_at: clock.now \}\n/, "").replace(/  - upstream: Staffing[\s\S]*$/, "");
    const next = generate(withoutPayrollPolicy);
    const disk = new Map(out.files.map((f) => [f.path, f.content]));
    const plan = computePlan(next, out.manifest, (p) => disk.get(p));
    expect(plan.stale.map((s) => s.path)).toEqual(["src/context_map/generated/payroll/application/policies.py", "tests/generated/test_payroll_policies.py"]);
    expect(plan.stale.map((s) => !!s.autoPrune)).toEqual([false, true]);
    // The customer-owned translator is not a generated file, so it is never reported or removed.
    expect(plan.entries.find((e) => e.path.endsWith("payroll/translators.py"))).toBeUndefined();
  });
});

/** Conditions (`if`/`elif`/`while`/`return`/`holds=`) in Python source that are parenthesized tuples. */
function tupleConditions(src: string): string[] {
  const logical: string[] = [];
  let buf = "";
  let depth = 0;
  for (const line of src.split("\n")) {
    buf = buf ? `${buf} ${line.trim()}` : line.trim();
    for (const ch of line.replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) {
      logical.push(buf);
      buf = "";
      depth = 0;
    }
  }
  const bad: string[] = [];
  for (const l of logical) {
    const m = /^(?:if|elif|while|return|holds=)\s*(?:not\s+)?(\(.*\))\s*[:,]?$/.exec(l);
    if (!m) continue;
    const group = m[1]!;
    // The condition is one parenthesized group only if its first "(" closes at the very end.
    let d = 0;
    let closesAtEnd = true;
    let topComma = false;
    for (let i = 0; i < group.length; i++) {
      const ch = group[i]!;
      if ("([{".includes(ch)) d++;
      else if (")]}".includes(ch)) {
        d--;
        if (d === 0 && i < group.length - 1) closesAtEnd = false;
      } else if (ch === "," && d === 1) topComma = true;
    }
    if (closesAtEnd && topComma) bad.push(l);
  }
  return bad;
}

describe("line wrapping (regression: a grouping parenthesis must never become a tuple)", () => {
  test("the checker itself recognizes the old bug", () => {
    expect(tupleConditions("        if not (\n            self.a is None or self.b,\n        ):")).toHaveLength(1);
  });

  test("a long negated condition is split before its operators, without a trailing comma", () => {
    const src = "        if not (self.refunded is None or (self.captured is not None and self.refunded.amount <= self.captured.amount)):";
    expect(wrapLongLines(src)).toBe(
      [
        "        if not (",
        "            self.refunded is None",
        "            or (self.captured is not None and self.refunded.amount <= self.captured.amount)",
        "        ):",
      ].join("\n"),
    );
  });

  test("a bare boolean value of if/return/keyword lines is parenthesized, not tupled", () => {
    const out = wrapLongLines("            holds=self.captured is not None and self.refunded is None and requested_refund_amount > 0 and self.ok,");
    expect(out.split("\n")[0]).toBe("            holds=(");
    expect(out.split("\n").at(-1)).toBe("            ),");
    expect(tupleConditions(out)).toEqual([]);
    const ret = wrapLongLines("        return command.allow_orders_that_are_currently_on_hold or (purchase_order.status == PurchaseOrderStatus.PLACED)");
    expect(ret.startsWith("        return (\n")).toBe(true);
    expect(tupleConditions(ret)).toEqual([]);
  });

  test("a single generator-expression argument gets no trailing comma (that would be a SyntaxError)", () => {
    const out = wrapLongLines("        self._event_publisher.publish(tuple(event for event in emitted if isinstance(event, SomeRatherLongEventName)))");
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out).not.toMatch(/,\s*\n\s*\)/);
  });

  test("argument lists get one argument per line with trailing commas; one-element tuples keep their comma", () => {
    const call = wrapLongLines("        aggregate = cls(id=id, email=email, status=InvitationStatus.PENDING, created_at=at, expires_at=expires_at)");
    expect(call).toContain("            expires_at=expires_at,\n        )");
    const tuple = wrapLongLines("    ALL_ERRORS: tuple[type[DomainError], ...] = (SomeVeryLongDomainErrorNameThatIsReallyQuiteLongIndeed_____________,)");
    expect(tuple).toContain("SomeVeryLongDomainErrorNameThatIsReallyQuiteLongIndeed_____________,");
  });

  test.each([
    ["the sample model", MODEL],
    ["the kitchen-sink model", KITCHEN_SINK],
    ["the context-map model", CONTEXT_MAP],
    ["the long-rules model", LONG_RULES],
  ])("%s: no generated condition is a tuple and no line exceeds 100 characters", (_label, text) => {
    for (const f of generate(text).files) {
      if (!f.path.endsWith(".py")) continue;
      expect({ path: f.path, tuples: tupleConditions(f.content) }).toEqual({ path: f.path, tuples: [] });
      const long = f.content.split("\n").filter((l) => l.length > 100);
      expect({ path: f.path, long }).toEqual({ path: f.path, long: [] });
    }
  });

  test("the long invariant is emitted as a real condition", () => {
    const py = generate(LONG_RULES).files.find((f) => f.path.endsWith("billing/domain/aggregates.py"))!.content;
    expect(py).toContain(
      "        if not (\n            self.refunded is None\n            or (self.captured is not None and self.refunded.amount <= self.captured.amount)\n        ):",
    );
  });
});
