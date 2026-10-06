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

/** The model without its revoke_invitation use case (the last use case of CleaningStaff, before its queries). */
function withoutRevoke(text: string): string {
  const start = text.indexOf("      - name: revoke_invitation");
  const ends = ["\n    # 読み取り", "\n    queries:", "\n  - name: Staffing"].map((m) => text.indexOf(m, start)).filter((i) => i > start);
  return text.slice(0, start) + text.slice(Math.min(...ends) + 1);
}

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
    const text = withoutRevoke(MODEL);
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
    queries: [],
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
    expect(py("(total > 1 or total < 0) and not is_empty(tags)")).toBe("(self.total > 1 or self.total < 0) and len(self.tags) != 0");
    expect(py("contains(tags, 'vip')")).toBe('"vip" in self.tags');
  });

  test("negation takes its simplest readable form (ruff SIM201 / SIM202 / SIM208 / E714)", () => {
    expect(py("not (status == draft)")).toBe("self.status != Status.DRAFT");
    expect(py("not (status != draft)")).toBe("self.status == Status.DRAFT");
    expect(py("not (note == null)")).toBe("self.note is not None");
    expect(py("not (not is_empty(tags))")).toBe("len(self.tags) == 0");
    expect(py("not (total <= 3)")).toBe("not (self.total <= 3)");
  });

  test("arithmetic keeps the source grouping and divides integers exactly", () => {
    expect(py("total + 1 > 2 * total")).toBe("self.total + 1 > 2 * self.total");
    expect(py("(total + 1) * 2 > total - (1 - total)")).toBe("(self.total + 1) * 2 > self.total - (1 - self.total)");
    expect(py("total / 3 > 1.5")).toBe('Decimal(self.total) / 3 > Decimal("1.5")');
    expect(py("-total < -1 and -(total + 1) < 0")).toBe("-self.total < -1 and -(self.total + 1) < 0");
    expect(py("round(total * 1.08, 0) > min(total, 2.5)")).toBe('(self.total * Decimal("1.08")).quantize(Decimal("1"), rounding=ROUND_HALF_UP) > min(Decimal(self.total), Decimal("2.5"))');
  });

  test("collection functions become comprehensions over tuples (any / all short-circuit on a generator)", () => {
    expect(py("any(tags, item == 'vip') and all(tags, length(item) < 10)")).toBe('any(item_ == "vip" for item_ in self.tags) and all(len(item_) < 10 for item_ in self.tags)');
    expect(py("count(tags, item != 'x') == count(tags)")).toBe('len([item_ for item_ in self.tags if item_ != "x"]) == len(self.tags)');
    expect(py("length(append(tags, 'a')) > length(remove(tags, 'b'))")).toBe('len((*self.tags, "a")) > len(tuple([item_ for item_ in self.tags if item_ != "b"]))');
    expect(py("is_empty(remove_where(tags, item == 'a' or item == 'b'))")).toBe('len(tuple([item_ for item_ in self.tags if not (item_ == "a" or item_ == "b")])) == 0');
    expect(py("length(replace_where(tags, item == 'a', 'b')) == 0")).toBe('len(tuple(["b" if item_ == "a" else item_ for item_ in self.tags])) == 0');
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
const ORDERING = readFileSync(join(import.meta.dir, "fixtures/ordering.ddd.yaml"), "utf8");
const LONG_RULES = readFileSync(join(import.meta.dir, "fixtures/long-rules.ddd.yaml"), "utf8");
/** Roles, a typed principal with claims, bearer JWT, rate limits; public, internal and role / rule protected use cases. */
const SECURITY = readFileSync(join(import.meta.dir, "fixtures/security.ddd.yaml"), "utf8");

/** Queries (read side) and the PostgreSQL adapters (their SQL is exercised on PGlite by queries.test.ts). */
const QUERIES = readFileSync(join(import.meta.dir, "fixtures/queries.ddd.yaml"), "utf8");
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
    ["the ordering model (arithmetic, durations, collection functions, constructors, let)", ORDERING],
    ["the long-rules model (wrapped invariants, guards, emits conditions and use-case conditions must still fire)", LONG_RULES],
    ["the security model (roles, allow_if, public / internal use cases, PyJWT authenticator, rate limiter)", SECURITY],

    ["the queries model (trigram / prefix / exact search, keyset paging, cursors, PostgreSQL mapping without a database)", QUERIES],
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

/** ruff from the example venv, the PATH or `uvx` (whichever answers `--version`); undefined skips the lint test. */
const RUFF: string[] | undefined = (() => {
  const candidates = [[join(EXAMPLE, ".venv/bin/ruff")], ["ruff"], ["uvx", "ruff"]];
  for (const cmd of candidates) {
    if (cmd[0]!.includes("/") ? !existsSync(cmd[0]!) : !Bun.which(cmd[0]!)) continue;
    try {
      if (Bun.spawnSync([...cmd, "--version"]).exitCode === 0) return cmd;
    } catch {
      // not runnable: try the next one
    }
  }
  return undefined;
})();

describe.skipIf(!RUFF)("generated Python is ruff-clean (lint rules and format of the example's pyproject.toml)", () => {
  test.each([
    ["the sample model", MODEL],
    ["the kitchen-sink model", KITCHEN_SINK],
    ["the context-map model", CONTEXT_MAP],
    ["the ordering model", ORDERING],
    ["the long-rules model", LONG_RULES],
    ["the security model", SECURITY],

    ["the queries model", QUERIES],
    ["a model reflected from the discovery board", FROM_BOARD],
  ])("ruff check and ruff format --check pass for %s", (_label, modelText) => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-ruff-"));
    try {
      for (const f of generate(modelText).files) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), f.content);
      }
      writeFileSync(join(dir, "pyproject.toml"), readFileSync(join(EXAMPLE, "pyproject.toml")));
      const check = Bun.spawnSync([...RUFF!, "check", "--no-cache", "--output-format", "concise", "."], { cwd: dir });
      expect(check.stdout.toString() + check.stderr.toString()).toContain("All checks passed");
      const format = Bun.spawnSync([...RUFF!, "format", "--no-cache", "--diff", "."], { cwd: dir });
      expect({ exit: format.exitCode, diff: format.stdout.toString() }).toEqual({ exit: 0, diff: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
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
    expect(py).toContain("event_type: ClassVar[type[hiring_events.CandidateAccepted]] = hiring_events.CandidateAccepted");
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
    const ret = wrapLongLines("        return command.allow_orders_that_are_currently_on_hold or purchase_order.status == PurchaseOrderStatus.PLACED");
    expect(ret.startsWith("        return (\n")).toBe(true);
    expect(tupleConditions(ret)).toEqual([]);
    // As in ruff format: a single operator whose last operand is bracketed splits that bracket instead.
    const last = wrapLongLines("        return command.allow_orders_that_are_currently_on_hold or (purchase_order.status == PurchaseOrderStatus.PLACED)");
    expect(last.split("\n")).toEqual([
      "        return command.allow_orders_that_are_currently_on_hold or (",
      "            purchase_order.status == PurchaseOrderStatus.PLACED",
      "        )",
    ]);
    expect(tupleConditions(last)).toEqual([]);
  });

  test("statement values follow ruff format: optional parentheses, operator levels, comprehensions", () => {
    // Two operators of the loosest level: parenthesize, split before each, tighter operators stay together.
    expect(wrapLongLines("        total: Decimal = sum([item_.unit_price.amount * item_.quantity for item_ in order.lines], Decimal(\"0\")) - order.discount - order.refunded").split("\n")).toEqual([
      "        total: Decimal = (",
      '            sum([item_.unit_price.amount * item_.quantity for item_ in order.lines], Decimal("0"))',
      "            - order.discount",
      "            - order.refunded",
      "        )",
    ]);
    // An assignment never splits its annotation; a plain value goes into parentheses.
    expect(wrapLongLines("    event_type: ClassVar[type[cleaning_staff_events.InvitationAccepted]] = cleaning_staff_events.InvitationAccepted").split("\n")).toEqual([
      "    event_type: ClassVar[type[cleaning_staff_events.InvitationAccepted]] = (",
      "        cleaning_staff_events.InvitationAccepted",
      "    )",
    ]);
    // A comprehension splits before its clauses, not inside its element.
    expect(wrapLongLines("            lines=tuple([item_._replace(quantity=quantity) if item_.line_id == line_id else item_ for item_ in self.lines]),")).toBe(
      [
        "            lines=tuple(",
        "                [",
        "                    item_._replace(quantity=quantity) if item_.line_id == line_id else item_",
        "                    for item_ in self.lines",
        "                ]",
        "            ),",
      ].join("\n"),
    );
    // A signature splits its parameters, never its return annotation.
    expect(wrapLongLines("    def issue(cls, id: UUID, email: EmailAddress, at: datetime, expires_at: datetime) -> Transition[CleaningStaffInvitation]:").split("\n")[0]).toBe("    def issue(");
  });

  test("a trailing comment moves above the code instead of into the wrapped brackets", () => {
    const out = wrapLongLines("    assert len(use_case_0.commands) == number_of_samples_for_this_event_type or strict_mode_is_on_for_this_run  # samples and retries or replays reach it");
    expect(out).toBe(
      [
        "    # samples and retries or replays reach it",
        "    assert (",
        "        len(use_case_0.commands) == number_of_samples_for_this_event_type",
        "        or strict_mode_is_on_for_this_run",
        "    )",
      ].join("\n"),
    );
  });

  test.skipIf(!existsSync(VENV))("the Python ast check reports a tuple condition (it is not a no-op)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-ast-"));
    try {
      writeFileSync(join(dir, "bad.py"), "def f(a: object, b: object) -> None:\n    if not (\n        a is None or b,\n    ):\n        raise ValueError()\n");
      const r = Bun.spawnSync([VENV, "-c", NO_TUPLE_CONDITIONS, dir]);
      expect(r.stdout.toString()).toContain("bad.py:2: condition is a tuple (always true)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("idempotency_key", () => {
  const out = generate(KITCHEN_SINK);
  const file = (suffix: string) => out.files.find((f) => f.path.endsWith(suffix))!.content;

  test("the use case returns the recorded result for a known key and records successful runs before commit", () => {
    const py = file("ordering/application/use_cases.py");
    const body = py.slice(py.indexOf("class RegisterCustomerUseCase"), py.indexOf("def _run", py.indexOf("class RegisterCustomerUseCase")));
    expect(body).toContain("idempotency_store: IdempotencyStore,");
    expect(body).toContain('        key = str(command.request_id)\n        recorded = self._idempotency_store.get("register_customer", key)\n        if recorded is not None:\n            return cast(UUID, recorded.value)');
    expect(body.indexOf("self._idempotency_store.record(")).toBeLessThan(body.indexOf("self._unit_of_work.commit()"));
    expect(body.indexOf("self._idempotency_store.record(")).toBeGreaterThan(body.indexOf("result = self._run(command, after_commit)"));
  });

  test("ports, test doubles and generated tests exist only where a use case is idempotent", () => {
    expect(file("ordering/application/ports.py")).toContain("class IdempotencyStore(Protocol):");
    expect(file("ordering/testing.py")).toContain("class InMemoryIdempotencyStore:");
    const t = file("tests/generated/test_ordering_register_customer.py");
    expect(t).toContain("assert use_case.execute(command) == result");
    expect(t).toContain('assert idempotency_store.get("register_customer", str(command.request_id)) is None');
    const sample = generate();
    expect(sample.files.some((f) => f.content.includes("IdempotencyStore"))).toBe(false);
  });
});

describe("authentication, authorization and rate limiting (Python)", () => {
  const out = generate(SECURITY);
  const file = (p: string) => out.files.find((f) => f.path === `src/secure_hiring/generated/${p}`)?.content ?? "";
  const useCases = file("hiring/application/use_cases.py");
  const cls = (name: string) => useCases.slice(useCases.indexOf(`class ${name}`), useCases.indexOf("\n\n\nclass ", useCases.indexOf(`class ${name}`) + 1));

  test("files: security.py, rate_limit.py, the PyJWT authenticator, read access and the security tests", () => {
    const paths = out.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([
      "src/secure_hiring/generated/security.py",
      "src/secure_hiring/generated/rate_limit.py",
      "src/secure_hiring/generated/authentication.py",
      "src/secure_hiring/generated/hiring/application/read_access.py",
      "tests/generated/test_security.py",
    ]));
    expect(file("security.py")).toContain('Role = Literal["admin", "staff", "candidate"]');
    expect(file("security.py")).toContain("company_id: UUID | None = None");
    expect(file("security.py")).toContain('"company_id": claims.get("https://example.com/company_id"),');
    expect(file("security.py")).toContain('"post_job": RateLimit("post_job", 5, 60, "principal"),');
    expect(file("security.py")).not.toContain('"record_audit"');
    expect(file("authentication.py")).toContain('options={"require": ["exp", "sub", "iss", "aud"]},');
    expect(file("authentication.py")).toContain("from secure_hiring.generated.security import (");
    // Without security nothing of this is generated.
    expect(generate(CONTEXT_MAP).files.filter((f) => /security|rate_limit|authentication|read_access/.test(f.path))).toEqual([]);
  });

  test("execute(command, principal): the role check comes first, allow_if after the leading loads it reads", () => {
    const post = cls("PostJobUseCase");
    expect(post).toContain("def execute(self, command: PostJob, principal: Principal | None) -> UUID:");
    const body = post.slice(post.indexOf("def execute("));
    expect(body.indexOf('principal = authorize(principal, "post_job", ("admin", "staff"))')).toBeLessThan(body.indexOf("self._idempotency_store.get("));
    expect(body.indexOf("allow_if(")).toBeLessThan(body.indexOf("self._idempotency_store.get("));
    expect(body).toContain('key = f"{principal.id}:{command.request_id}"');
    const close = cls("CloseJobUseCase");
    expect(close.indexOf("self._job_repository.get(")).toBeLessThan(close.indexOf("allow_if("));
    expect(close.indexOf("allow_if(")).toBeLessThan(close.indexOf("= job.close("));
    expect(close).toContain('"admin" in principal.roles');
    expect(cls("CheckJobOpenUseCase")).toContain("def execute(self, command: CheckJobOpen) -> bool:");
    expect(cls("RecordAuditUseCase")).toContain("def execute(self, command: RecordAudit) -> UUID:");
  });

  test("generated tests: scenario principals and derived authorization tests with untouched repositories", () => {
    const t = out.files.find((f) => f.path === "tests/generated/test_hiring_close_job.py")!.content;
    expect(t).toContain("class _UntouchedJobRepository:");
    expect(t).toContain("def test_authorization_missing_role_is_refused() -> None:");
    expect(t).toContain('assert raised.value.details == {"action": "close_job", "required_roles": ["admin", "staff"]}');
    const sec = out.files.find((f) => f.path === "tests/generated/test_security.py")!.content;
    expect(sec).toContain("def test_alg_none_and_hmac_signed_with_the_public_key_are_rejected() -> None:");
    expect(sec).toContain("def test_the_bucket_empties_refuses_and_refills() -> None:");
  });
});
