import { describe, expect, test } from "bun:test";
import { checkExpression, complete, deriveViolations, hover, makeEnv, T, validateModelText, type ContextAnalysis, type ContextIR, type ModelIR, type Type } from "@ddd/core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan, generate, generatePython, generateTypeScript, renderManifest, sha256 } from "../src/index.ts";
import { TsImports, wrapLongLines } from "../src/typescript/code.ts";
import { emitExpr, type ExprContext } from "../src/typescript/expr.ts";
import { TS_DEPENDENCIES } from "../src/typescript/index.ts";
import { TsLayout } from "../src/typescript/layout.ts";

const ROOT = join(import.meta.dir, "../../..");
const EXAMPLE = join(ROOT, "examples/cleaning-platform-ts");
const MODEL = readFileSync(join(EXAMPLE, "model.ddd.yaml"), "utf8");
const PY_MODEL = readFileSync(join(ROOT, "examples/cleaning-platform/model.ddd.yaml"), "utf8");
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const KITCHEN_SINK = fixture("kitchen-sink.ddd.yaml");
const CONTEXT_MAP = fixture("context-map.ddd.yaml");
const ORDERING = fixture("ordering.ddd.yaml");
const LONG_RULES = fixture("long-rules.ddd.yaml");

/** The model with `generation.target: typescript` (and optionally the bun test runner). */
function asTypeScript(text: string, runner?: "bun"): string {
  if (/^ {2}target: typescript/m.test(text)) return runner ? text.replace(/test_runner: vitest/, "test_runner: bun") : text;
  const settings = `  target: typescript\n${runner ? "  typescript: { test_runner: bun }\n" : ""}`;
  return /^generation:\n/m.test(text) ? text.replace(/^generation:\n/m, `generation:\n${settings}`) : text.replace(/^contexts:/m, `generation:\n${settings}\ncontexts:`);
}

function analyze(text: string) {
  const r = validateModelText(text);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"), null, 2));
  return r.analysis!;
}

const gen = (text = MODEL) => generateTypeScript(analyze(text), text);

describe("TypeScript target: selection", () => {
  test("generation.target defaults to python; typescript and the test runner are read from the model", () => {
    expect(analyze(PY_MODEL).model.generation).toMatchObject({ target: "python", typescript: { testRunner: "vitest" } });
    expect(analyze(MODEL).model.generation).toMatchObject({ target: "typescript", typescript: { testRunner: "vitest" } });
    expect(analyze(asTypeScript(MODEL, "bun")).model.generation.typescript.testRunner).toBe("bun");
  });

  test("generate() follows the model's target unless overridden", () => {
    const ts = analyze(MODEL);
    expect(generate(ts, MODEL).files.some((f) => f.path.endsWith("aggregates.ts"))).toBe(true);
    expect(generate(ts, MODEL, "python").files.some((f) => f.path.endsWith("aggregates.py"))).toBe(true);
    const py = analyze(PY_MODEL);
    expect(JSON.stringify(generate(py, PY_MODEL))).toBe(JSON.stringify(generatePython(py, PY_MODEL)));
  });

  test("unknown targets and runners are diagnostics", () => {
    const bad = validateModelText(MODEL.replace("target: typescript", "target: rust").replace("test_runner: vitest", "test_runner: jest"));
    expect(bad.diagnostics.filter((d) => d.code === "invalid-value").map((d) => d.path.join("."))).toEqual(["generation.target", "generation.typescript.test_runner"]);
  });

  test("completion and hover offer the generation keys and their values", () => {
    const noTarget = PY_MODEL.replace("  src_dir: src\n", "  src_dir: src\n  \n");
    const at = noTarget.indexOf("  \n", noTarget.indexOf("src_dir")) + 2;
    expect(complete(noTarget, at).items.map((i) => i.label)).toEqual(expect.arrayContaining(["target", "typescript"]));
    const valueAt = MODEL.indexOf("target: typescript") + "target: ".length;
    expect(complete(MODEL, valueAt).items.map((i) => i.label)).toEqual(["python", "typescript"]);
    const runnerAt = MODEL.indexOf("test_runner: vitest") + "test_runner: ".length;
    expect(complete(MODEL, runnerAt).items.map((i) => i.label)).toEqual(["vitest", "bun"]);
    expect(hover(MODEL, MODEL.indexOf("test_runner") + 2)?.markdown).toContain("vitest");
  });

  test("names the generated TypeScript would clash with are rejected for the typescript target only", () => {
    const clash = MODEL.replace("name: EmailAddress\n", "name: Map\n").replace(/type: EmailAddress/g, "type: Map");
    expect(validateModelText(clash).diagnostics.find((d) => d.code === "reserved-name")?.message).toContain('"Map" cannot name a value object');
    expect(validateModelText(clash.replace("target: typescript", "target: python")).ok).toBe(true);
    const companion = MODEL.replace("- name: InvitationNotFound\n", "- name: EmailAddressInput\n").replace(/not_found: InvitationNotFound/g, "not_found: EmailAddressInput").replace(/raises: InvitationNotFound/g, "raises: EmailAddressInput");
    expect(validateModelText(companion).diagnostics.find((d) => d.code === "reserved-name")?.message).toContain("the input type of EmailAddress");
    const ctor = MODEL.replace("{ name: accepted_at, type: DateTime, required: false }", "{ name: constructor, type: String, required: false }");
    expect(validateModelText(ctor).diagnostics.some((d) => d.code === "reserved-name" && d.message.includes('"constructor"'))).toBe(true);
  });
});

describe("TypeScript target: golden output", () => {
  test("regenerating the example reproduces the committed files byte for byte", () => {
    const out = gen();
    for (const f of out.files) {
      if (f.ownership !== "generated") continue;
      const committed = readFileSync(join(EXAMPLE, f.path), "utf8");
      expect({ path: f.path, content: f.content }).toEqual({ path: f.path, content: committed });
    }
    expect(renderManifest(out.manifest)).toBe(readFileSync(join(EXAMPLE, out.manifestPath), "utf8"));
  });

  test("generation is deterministic", () => {
    expect(JSON.stringify(gen())).toBe(JSON.stringify(gen()));
  });

  test("layout: runtime once, a directory per context, customer-owned scaffolds, tests under tests/generated", () => {
    const out = gen();
    const byPath = new Map(out.files.map((f) => [f.path, f.ownership]));
    for (const p of [
      "src/cleaning_platform/generated/runtime.ts",
      "src/cleaning_platform/generated/index.ts",
      "src/cleaning_platform/generated/cleaning-staff/domain/aggregates.ts",
      "src/cleaning_platform/generated/cleaning-staff/application/use-cases.ts",
      "src/cleaning_platform/generated/staffing/application/policies.ts",
      "tests/generated/cleaning-staff-invariants.test.ts",
      "tests/generated/staffing-policies.test.ts",
    ]) {
      expect({ p, o: byPath.get(p) }).toEqual({ p, o: "generated" });
    }
    for (const p of ["package.json", "tsconfig.json", "src/cleaning_platform/index.ts", "src/cleaning_platform/extensions/cleaning-staff/extensions.ts"]) {
      expect({ p, o: byPath.get(p) }).toEqual({ p, o: "scaffold" });
    }
    expect(out.manifest.model_sha256).toBe(sha256(MODEL));
    expect(out.manifestPath).toBe("src/cleaning_platform/generated/model_manifest.json");
    expect(out.files.filter((f) => f.ownership === "generated").every((f) => f.path.endsWith(".md") || f.content.startsWith("// Generated by DDD Presenter"))).toBe(true);
    const pkg = JSON.parse(out.files.find((f) => f.path === "package.json")!.content);
    expect(pkg.dependencies).toEqual({ "decimal.js": TS_DEPENDENCIES["decimal.js"], zod: TS_DEPENDENCIES.zod });
    expect(pkg.scripts).toEqual({ test: "vitest run", typecheck: "tsc --noEmit" });
    const tsconfig = JSON.parse(out.files.find((f) => f.path === "tsconfig.json")!.content);
    expect(tsconfig.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, module: "NodeNext" });
    const bun = gen(asTypeScript(MODEL, "bun"));
    expect(JSON.parse(bun.files.find((f) => f.path === "package.json")!.content).scripts.test).toBe("bun test");
    expect(bun.files.find((f) => f.path.endsWith("invariants.test.ts"))!.content).toContain('from "bun:test"');
  });
});

describe("TypeScript target: plan", () => {
  const out = gen();
  const disk = () => new Map(out.files.map((f) => [f.path, f.content]));

  test("hand edits are conflicts; scaffolds are never touched", () => {
    const d = disk();
    const agg = "src/cleaning_platform/generated/cleaning-staff/domain/aggregates.ts";
    d.set(agg, d.get(agg) + "\n// edited\n");
    d.set("package.json", "{}\n");
    const plan = computePlan(out, out.manifest, (p) => d.get(p));
    expect(plan.conflicts.map((c) => c.path)).toEqual([agg]);
    expect(plan.entries.find((e) => e.path === "package.json")?.action).toBe("keep");
  });

  test("a stale generated test is deleted when untouched (it would import removed code)", () => {
    const text = MODEL.slice(0, MODEL.indexOf("      - name: revoke_invitation")) + MODEL.slice(MODEL.indexOf("\n  - name: Staffing") + 1);
    const next = gen(text);
    const plan = computePlan(next, out.manifest, (p) => disk().get(p));
    expect(plan.stale.map((s) => [s.path, s.autoPrune])).toEqual([["tests/generated/cleaning-staff-revoke-invitation.test.ts", true]]);
  });
});

// ---------------------------------------------------------------------------
// Expression emission
// ---------------------------------------------------------------------------

describe("TypeScript target: expression emission", () => {
  const ctx: ContextIR = {
    name: "X",
    glossary: [],
    errors: [],
    enums: [{ name: "Status", values: ["draft", "placed"], path: [] }],
    valueObjects: [{ name: "Money", fields: [{ name: "amount", type: "Decimal", required: true, constraints: {}, path: [] }], normalize: {}, invariants: [], path: [] }],
    aggregates: [
      {
        name: "Order",
        identity: "id",
        fields: [
          { name: "id", type: "UUID", required: true, constraints: {}, path: [] },
          { name: "customer_id", type: "Ref[Customer]", required: true, constraints: {}, path: [] },
        ],
        entities: [{ name: "Line", identity: "line_id", fields: [{ name: "line_id", type: "Integer", required: true, constraints: {}, path: [] }], invariants: [], path: [] }],
        invariants: [],
        stateGuards: [],
        factories: [],
        operations: [],
        scenarios: [],
        path: [],
      },
      { name: "Customer", identity: "id", fields: [{ name: "id", type: "UUID", required: true, constraints: {}, path: [] }], entities: [], invariants: [], stateGuards: [], factories: [], operations: [], scenarios: [], path: [] },
    ],
    extensionPoints: [],
    useCases: [],
    policies: [],
    path: [],
  };
  const fields = new Map<string, Type>([
    ["id", T.UUID],
    ["customer_id", { k: "ref", target: "Customer" }],
    ["status", { k: "enum", name: "Status" }],
    ["total", T.Integer],
    ["price", T.Decimal],
    ["discount", { k: "optional", inner: T.Decimal }],
    ["note", { k: "optional", inner: T.String }],
    ["name", T.String],
    ["limit", { k: "optional", inner: T.Integer }],
    ["tags", { k: "list", item: T.String }],
    ["lines", { k: "list", item: { k: "entity", name: "Line", aggregate: "Order" } }],
    ["placed_at", T.DateTime],
    ["due", T.Date],
    ["other", { k: "aggregate", name: "Customer" }],
  ]);
  const ca = {
    ir: ctx,
    fieldTypes: new Map([
      ["Order", fields],
      ["Line", new Map<string, Type>([["line_id", T.Integer]])],
      ["Customer", new Map<string, Type>([["id", T.UUID]])],
      ["Money", new Map<string, Type>([["amount", T.Decimal]])],
    ]),
    exprs: new Map(),
    events: new Map(),
    useCases: new Map(),
    policies: new Map(),
  } as unknown as ContextAnalysis;
  const model = { project: "x", generation: { package: "x", srcDir: "src", testsDir: "tests", target: "typescript", typescript: { testRunner: "vitest" } } } as unknown as ModelIR;
  const L = new TsLayout(model, ca);
  const env = makeEnv(ctx, { self: { name: "Order", fields, aggregate: ctx.aggregates[0] }, params: new Map<string, Type>([["at", T.DateTime], ["other_id", T.UUID], ["line", { k: "entity", name: "Line", aggregate: "Order" }]]) });
  const ts = (src: string, expected: Type = T.Boolean) => {
    const r = checkExpression(src, env, expected);
    if (!r.expr) throw new Error(JSON.stringify(r.errors));
    const c: ExprContext = { L, imports: new TsImports("m"), self: "this", selfOwner: "Order" };
    return emitExpr(r.expr, c);
  };

  test("operators, enums, null checks and negation (JavaScript `!` binds tighter than comparisons)", () => {
    expect(ts("status == placed and total >= 1")).toBe("this.status === Status.placed && this.total >= 1");
    expect(ts("note == null or length(note) < 3")).toBe("this.note === null || this.note.length < 3");
    expect(ts("not (status == draft or total > 1)")).toBe("!(this.status === Status.draft || this.total > 1)");
    expect(ts("not total > 1")).toBe("!(this.total > 1)");
    expect(ts("(total > 1 or total < 0) and not is_empty(tags)")).toBe("(this.total > 1 || this.total < 0) && !(this.tags.length === 0)");
    expect(ts("contains(name, 'x') and not is_empty(name) and contains(tags, name)")).toBe('this.name.includes("x") && !(this.name.length === 0) && contains(this.tags, this.name)');
  });

  test("Decimal arithmetic and comparisons are exact decimal.js calls; Integer / Integer is Decimal", () => {
    expect(ts("price * total > 1.5")).toBe('this.price.times(this.total).gt(new Decimal("1.5"))');
    expect(ts("1 < price")).toBe("this.price.gt(1)");
    expect(ts("total / 3 > 1")).toBe("new Decimal(this.total).div(3).gt(1)");
    expect(ts("round(total * 1.08, 0) > max(total, 2.5)")).toBe('new Decimal(this.total).times(new Decimal("1.08")).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).gt(Decimal.max(this.total, new Decimal("2.5")))');
    expect(ts("-(-total) == total and -price < price")).toBe("-(-this.total) === this.total && this.price.neg().lt(this.price)");
    expect(ts("price == 0 and discount != null and discount == price")).toBe("this.price.eq(0) && this.discount !== null && this.discount.eq(this.price)");
  });

  test("date-times compare by getTime(); durations are milliseconds; calendar dates are ISO strings", () => {
    expect(ts("at - placed_at < hours(24) and at <= placed_at + days(7)")).toBe("durationBetween(at, this.placedAt) < hours(24) && at.getTime() <= plusDuration(this.placedAt, days(7)).getTime()");
    expect(ts("due + days(14) >= due and due - due > days(0)")).toBe("plusDays(this.due, days(14)) >= this.due && daysBetween(this.due, this.due) > days(0)");
    expect(ts("min(at, placed_at) == max(at, placed_at)")).toBe("earliest(at, this.placedAt).getTime() === latest(at, this.placedAt).getTime()");
  });

  test("collections: callbacks with `item`, entity removal by identity, nested element functions", () => {
    expect(ts("any(tags, item == 'vip') and all(tags, length(item) < 10)")).toBe('this.tags.some((item) => item === "vip") && this.tags.every((item) => item.length < 10)');
    expect(ts("count(tags, item != 'x') == count(tags)")).toBe('this.tags.filter((item) => item !== "x").length === this.tags.length');
    expect(ts("sum(lines, item.line_id) > 0 and length(remove_where(tags, item == 'a' or item == 'b')) > 0")).toBe(
      'sumOf(this.lines, (item) => item.lineId) > 0 && this.tags.filter((item) => !(item === "a" || item === "b")).length > 0',
    );
    expect(ts("length(remove(lines, line)) < length(append(lines, line))")).toBe("without(this.lines, line).length < [...this.lines, line].length");
    expect(ts("any(lines, any(tags, item == 'x'))")).toBe('this.lines.some((item) => this.tags.some((item) => item === "x"))');
  });

  test("a narrowed optional field used inside a callback gets a non-null assertion", () => {
    expect(ts("limit != null and all(lines, item.line_id < limit)")).toBe("this.limit !== null && this.lines.every((item) => item.lineId < this.limit!)");
  });

  test("ids of different aggregates compare with equals(); the identity carries its owner's brand", () => {
    expect(ts("customer_id == other_id")).toBe("this.customerId === otherId");
    expect(ts("customer_id == other.id")).toBe("this.customerId === this.other.id");
    expect(ts("id == customer_id")).toBe("equals(this.id, this.customerId)");
  });
});

describe("TypeScript target: line wrapping", () => {
  test("a long boolean return is parenthesized on the same line (never `return` alone: ASI)", () => {
    const out = wrapLongLines("    return command.allowOrdersThatAreCurrentlyOnHold || (purchaseOrder.status === PurchaseOrderStatus.placed);");
    expect(out.split("\n")).toEqual([
      "    return (",
      "      command.allowOrdersThatAreCurrentlyOnHold",
      "      || (purchaseOrder.status === PurchaseOrderStatus.placed)",
      "    );",
    ]);
  });

  test("a single object argument hugs the parentheses; argument lists get trailing commas", () => {
    const out = wrapLongLines("    const aggregate = CleaningStaffInvitation.from({ id: id, email, status: InvitationStatus.pending, createdAt: at });");
    expect(out.split("\n")[0]).toBe("    const aggregate = CleaningStaffInvitation.from({");
    expect(out.split("\n").at(-1)).toBe("    });");
    expect(out).toContain("      createdAt: at,\n");
  });

  test("a long boolean argument splits before its operators; grouping parentheses never get a comma", () => {
    const out = wrapLongLines("      this.status === OrderStatus.delivered && this.deliveredAt !== null && at.getTime() <= this.deliveredAt.getTime(),");
    expect(out.split("\n")).toEqual([
      "      this.status === OrderStatus.delivered",
      "        && this.deliveredAt !== null",
      "        && at.getTime() <= this.deliveredAt.getTime(),",
    ]);
    const cond = wrapLongLines("    if (!(this.refunded === null || (this.captured !== null && this.refunded.amount.lte(this.captured.amount)))) {");
    expect(cond).not.toMatch(/,\s*\n\s*\)/);
  });

  test.each([
    ["the sample model", MODEL],
    ["the kitchen-sink model", asTypeScript(KITCHEN_SINK)],
    ["the context-map model", asTypeScript(CONTEXT_MAP)],
    ["the ordering model", asTypeScript(ORDERING)],
    ["the long-rules model", asTypeScript(LONG_RULES)],
  ])("%s: lines stay within 100 characters (imports aside); no line starts with `=>` or ends after return/throw", (_label, text) => {
    for (const f of gen(text).files) {
      if (!f.path.endsWith(".ts")) continue;
      const lines = f.content.split("\n");
      expect({ path: f.path, long: lines.filter((l) => l.length > 100 && !/^(import|export) /.test(l)) }).toEqual({ path: f.path, long: [] });
      expect({ path: f.path, bad: lines.filter((l) => /^\s*=>/.test(l) || /^\s*(return|throw)\s*$/.test(l)) }).toEqual({ path: f.path, bad: [] });
    }
  });

  test("the long invariant is emitted as one real condition", () => {
    const src = gen(asTypeScript(LONG_RULES)).files.find((f) => f.path.endsWith("billing/domain/aggregates.ts"))!.content;
    expect(src).toContain(
      [
        "    if (",
        "      !(",
        "        this.refunded === null",
        "        || (this.captured !== null && this.refunded.amount.lte(this.captured.amount))",
        "      )",
        "    ) {",
        '      throw new RefundExceedsCapture({ rule: "refund_not_more_than_captured_amount", id: this.id });',
      ].join("\n"),
    );
  });
});

describe("TypeScript target: policies, context map and idempotency", () => {
  const out = gen(asTypeScript(CONTEXT_MAP));
  const file = (p: string) => out.files.find((f) => f.path === p);

  test("downstream imports the upstream's events; an anticorruption layer gets a translator seam and a scaffold", () => {
    const staffing = file("src/context_map/generated/staffing/application/policies.ts")!.content;
    expect(staffing).toContain('import * as hiringEvents from "../../hiring/domain/events.js";');
    expect(staffing).toContain("static readonly eventType = hiringEvents.CandidateAccepted.type;");
    expect(staffing).toMatch(/RegisterStaff\.create\(\{\s*candidateId: event\.id,\s*email: event\.email\.value,\s*joinedAt: event\.at,\s*source: Source\.hiring,?\s*\}\)/);
    expect(staffing).toContain("[hiringEvents.CandidateAccepted.type, [policies.registerAcceptedCandidate.onEvent]],");
    const payroll = file("src/context_map/generated/payroll/application/policies.ts")!.content;
    expect(payroll).toContain("export interface StaffingTranslator {");
    expect(payroll).toContain("const command = await this.#translator.openAccountForNewStaff(");
    expect(file("src/context_map/extensions/payroll/translators.ts")).toMatchObject({ ownership: "scaffold" });
    expect(file("src/context_map/extensions/payroll/translators.ts")!.content).toContain("export class FromStaffing implements StaffingTranslator {");
    expect(file("src/context_map/generated/hiring/application/policies.ts")).toBeUndefined();
  });

  test("an idempotent use case returns the recorded result and records before commit", () => {
    const src = gen(asTypeScript(KITCHEN_SINK)).files.find((f) => f.path.endsWith("ordering/application/use-cases.ts"))!.content;
    const body = src.slice(src.indexOf("export class RegisterCustomerUseCase"), src.indexOf("async #run", src.indexOf("export class RegisterCustomerUseCase")));
    expect(body).toContain('const key = String(command.requestId);\n    const recorded = await this.#idempotencyStore.get("register_customer", key);\n    if (recorded !== null) return recorded.value as UUID;');
    expect(body.indexOf("await this.#idempotencyStore.record(")).toBeLessThan(body.indexOf("await this.#unitOfWork.commit();"));
    expect(gen().files.some((f) => f.content.includes("IdempotencyStore,") || f.content.includes("#idempotencyStore"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Generated TypeScript actually runs
// ---------------------------------------------------------------------------

/**
 * Installs zod, decimal.js, typescript, vitest and the type packages once into a cache directory keyed by the
 * dependency versions; every generated project links its node_modules there.
 */
function installDependencies(): { dir?: string; reason?: string } {
  const deps = { ...TS_DEPENDENCIES };
  const dir = join(tmpdir(), `ddd-ts-deps-${createHash("sha256").update(JSON.stringify(deps)).digest("hex").slice(0, 12)}`);
  const ready = join(dir, "node_modules/.ddd-ready");
  if (existsSync(ready)) return { dir };
  mkdirSync(dir, { recursive: true });
  const { zod, "decimal.js": decimal, ...dev } = deps;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ddd-ts-deps", private: true, type: "module", dependencies: { zod, "decimal.js": decimal }, devDependencies: dev }, null, 2));
  try {
    const r = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
    if (r.exitCode !== 0 || !existsSync(join(dir, "node_modules/.bin/tsc"))) {
      return { reason: `bun install failed (exit ${r.exitCode}): ${r.stderr.toString().trim().split("\n").slice(-3).join(" ")}` };
    }
  } catch (e) {
    return { reason: `bun install could not run: ${(e as Error).message}` };
  }
  writeFileSync(ready, "");
  return { dir };
}

const DEPS = process.env.DDD_SKIP_TS_RUN ? { reason: "DDD_SKIP_TS_RUN is set" } : installDependencies();
if (!DEPS.dir) console.warn(`skipping "generated TypeScript actually runs": ${DEPS.reason} (needs network once to install zod, decimal.js, typescript and vitest)`);

function writeProject(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ddd-ts-gen-"));
  const out = generateTypeScript(analyze(text), text);
  for (const f of out.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  symlinkSync(join(DEPS.dir!, "node_modules"), join(dir, "node_modules"));
  return dir;
}

const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

describe.skipIf(!DEPS.dir)("generated TypeScript actually runs", () => {
  test("the example model: tsc --strict and vitest", () => {
    const dir = writeProject(MODEL);
    try {
      const tsc = run(["node_modules/.bin/tsc", "-p", "tsconfig.json"], dir);
      expect(tsc.out).toBe("");
      expect(tsc.code).toBe(0);
      const vitest = run(["node_modules/.bin/vitest", "run"], dir);
      expect(vitest.out).toMatch(/Tests\s+16 passed/);
      expect(vitest.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test.each([
    ["the sample model", MODEL],
    ["the kitchen-sink model (lists, decimals, dates, refs, entities, conditional events, no-transaction use cases)", KITCHEN_SINK],
    ["the context-map model (policies within and across contexts, anticorruption layer, subscriptions)", CONTEXT_MAP],
    ["the ordering model (arithmetic, durations, collection functions, constructors, with, let)", ORDERING],
    ["the long-rules model (wrapped invariants, guards, emits conditions and use-case conditions must still fire)", LONG_RULES],
  ])("tsc --strict and bun test pass for %s; every derived violation test fails without the checks", (_label, source) => {
    const text = asTypeScript(source, "bun");
    const dir = writeProject(text);
    try {
      const tsc = run(["node_modules/.bin/tsc", "-p", "tsconfig.json"], dir);
      expect(tsc.out).toBe("");
      expect(tsc.code).toBe(0);
      const tests = run(["bun", "test"], dir);
      if (existsSync(join(dir, "tests/generated"))) {
        expect(tests.out).toMatch(/\b0 fail/);
        expect(tests.out).toMatch(/[1-9]\d* pass/);
        expect(tests.code).toBe(0);
      }
      // Mutation check: with every invariant's throw disabled, each derived violation test must fail.
      const analysis = analyze(text);
      for (const ca of analysis.contexts.values()) {
        const derived = deriveViolations(ca).length;
        if (!derived) continue;
        const L = new TsLayout(analysis.model, ca);
        for (const m of ["value-objects", "entities", "aggregates"] as const) {
          const path = join(dir, L.file(L.mod(m)));
          writeFileSync(path, readFileSync(path, "utf8").replace(/throw (new \w+\(\{\s*rule: )/g, "void $1"));
        }
        const mutated = run(["bun", "test", L.file(L.testModule("invariants"))], dir);
        expect({ context: ca.ir.name, fail: /(\d+) fail/.exec(mutated.out)?.[1] }).toEqual({ context: ca.ir.name, fail: String(derived) });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
