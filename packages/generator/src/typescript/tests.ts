import { deriveViolations, derivedTestName, makePrincipal, otherRoles, scenarioPrincipal, type ResolvedPrincipal, type SecurityIR, type AggregateIR, type AggregateScenarioIR, type ScenarioThenIR, type Type, type UseCaseIR, type UseCaseScenarioIR } from "@ddd/core";
import { depParams, repoName, useCaseAuthorization, useCaseClass, useCaseDeps } from "./application.ts";
import { assemble, Code, header, relativeSpecifier, TsImports, tsString } from "./code.ts";
import { file, type TsFile } from "./domain.ts";
import type { TsLayout } from "./layout.ts";
import { prop } from "./names.ts";
import { inMemoryReaders } from "./queries.ts";
import { tsType } from "./types.ts";
import { expectEqual, record, typedValue } from "./values.ts";

// ---------------------------------------------------------------------------
// testing.ts — in-memory adapters for the ports of one context
// ---------------------------------------------------------------------------

export function testingFile(L: TsLayout): TsFile {
  const mod = L.contextTesting;
  const imp = new TsImports(mod);
  const c = new Code();
  c.line();
  c.comment("Shared test doubles (unit of work, clock, ids, event publisher, assertions).");
  c.line(`export * from "${relativeSpecifier(mod, L.testing)}";`);
  for (const ag of L.ca.ir.aggregates) {
    imp.value(L.testing, "InMemoryRepository");
    imp.type(L.testing, "FakeUnitOfWork");
    imp.type(L.ports, `${ag.name}Repository`);
    imp.type(L.mod("aggregates"), ag.name);
    const idType = tsType(L.tsFieldType(ag.name, ag.identity)!, imp, L);
    c.line();
    c.doc(`In-memory ${ag.name}Repository. Writes are staged until the unit of work commits.`);
    c.line(`export class InMemory${ag.name}Repository`);
    c.indent(() => {
      c.line(`extends InMemoryRepository<${ag.name}, ${idType}>`);
      c.line(`implements ${ag.name}Repository`);
    });
    c.line("{");
    c.indent(() => {
      c.block("constructor(unitOfWork?: FakeUnitOfWork)", () => c.line(`super((aggregate) => aggregate.${prop(ag.identity)}, unitOfWork);`));
    });
    c.line("}");
  }
  // In-memory readers of the context's queries (none without queries: the file stays as before).
  inMemoryReaders(L, c, imp);
  const exts = L.ca.ir.extensionPoints;
  if (!exts.length) {
    return file(L, mod, `In-memory test doubles for the ports of the ${L.ca.ir.name} context.`, imp, c.toString());
  }
  imp.type(L.ports, "Extensions");
  c.line();
  c.doc("Test double for the Extensions interface; each extension returns a fixed value.");
  c.block("export class StubExtensions implements Extensions", () => {
    const types = exts.map((x) => ({ x, t: tsType(L.resolve(x.returns), imp, L) }));
    for (const { x, t } of types) c.line(`readonly #${prop(x.name)}: ${t}${x.testDefault === undefined ? " | undefined" : ""};`);
    c.line();
    c.block(`constructor(stubs: { ${types.map(({ x, t }) => `readonly ${prop(x.name)}?: ${t}`).join("; ")} } = {})`, () => {
      for (const x of exts) {
        const fallback = x.testDefault === undefined ? "" : ` ?? ${typedValue(x.testDefault, L.resolve(x.returns), imp, L)}`;
        c.line(`this.#${prop(x.name)} = stubs.${prop(x.name)}${fallback};`);
      }
    });
    for (const { x, t } of types) {
      c.line();
      // The stub ignores the arguments, so its method takes none (still assignable to the interface).
      c.block(`${prop(x.name)}(): ${t}`, () => {
        if (x.testDefault === undefined) {
          c.line(`if (this.#${prop(x.name)} === undefined) throw new Error(${tsString(`extension ${x.name} is not stubbed in this scenario`)});`);
        }
        c.line(`return this.#${prop(x.name)};`);
      });
    }
  });
  return file(L, mod, `In-memory test doubles for the ports of the ${L.ca.ir.name} context.`, imp, c.toString());
}

// ---------------------------------------------------------------------------
// generated tests
// ---------------------------------------------------------------------------

function runner(L: TsLayout): string {
  return L.model.generation.typescript.testRunner === "bun" ? "bun:test" : "vitest";
}

/** Test file: the runner's `describe` / `test` / `expect` are imported only when used. */
export function testFile(L: TsLayout, module: string, doc: string, imp: TsImports, body: string): TsFile {
  const used = ["describe", "expect", "test"].filter((n) => new RegExp(`(^|[^\\w.])${n}\\(`).test(body));
  imp.value(runner(L), ...used);
  return { path: L.file(module), content: assemble(header(L.model), doc, imp, body) };
}

function describeThen(t: ScenarioThenIR): string[] {
  const out: string[] = [];
  if (t.raises) out.push(`raises ${t.raises}`);
  if (t.hasReturns) out.push(`returns ${spacedJson(t.returns)}`);
  if (t.state) out.push(`state ${spacedJson(t.state)}`);
  if (t.emits) out.push(t.emits.length ? `emits ${t.emits.map((e) => e.event).join(", ")}` : "emits nothing");
  return out;
}

/** JSON with spaces after separators (so long doc lines can wrap); `path` bookkeeping keys are dropped. */
function spacedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spacedJson).join(", ")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([k, x]) => k !== "path" && x !== undefined);
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${spacedJson(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v ?? null);
}

function scenarioDoc(sc: { description?: string }, lines: string[]): string {
  return [sc.description ?? "Scenario generated from the model.", "", ...lines].join("\n");
}

export function importError(L: TsLayout, imp: TsImports, name: string): void {
  if (name === "ConstraintViolation" || name === "AggregateNotFound") imp.value(L.runtime, name);
  else if (name === "NotAuthorized" || name === "Unauthenticated") imp.value(L.security, name);
  else imp.value(L.mod("errors"), name);
}

/** Whether values of `t` survive JSON (entities are class instances, which a schema accepts only as instances). */
function jsonSerializable(L: TsLayout, t: Type, seen = new Set<string>()): boolean {
  switch (t.k) {
    case "optional":
      return jsonSerializable(L, t.inner, seen);
    case "list":
      return jsonSerializable(L, t.item, seen);
    case "entity":
    case "aggregate":
      return false;
    case "vo":
      if (seen.has(t.name)) return true;
      seen.add(t.name);
      return [...L.fieldTypes(t.name).values()].every((f) => jsonSerializable(L, f, seen));
    default:
      return true;
  }
}

function eventAsserts(L: TsLayout, c: Code, events: string, then: ScenarioThenIR, imp: TsImports): void {
  if (!then.emits) return;
  c.line(`expect(${events}.map((event) => event.type)).toEqual([${then.emits.map((e) => tsString(`${L.ca.ir.name}.${e.event}`)).join(", ")}]);`);
  const serializable = [...L.ca.events.values()].every((ev) => ev.fields.every((f) => jsonSerializable(L, f.type)));
  if (then.emits.length && serializable) {
    imp.value(L.contextTesting, "viaJson", "plain");
    imp.value(L.mod("events"), `parse${L.ca.ir.name}Event`);
    c.comment("Every event survives JSON (e.g. an outbox): parsing its JSON gives an equal event.");
    c.line(`expect(viaJson(${events}, parse${L.ca.ir.name}Event)).toEqual(${events}.map(plain));`);
  }
  then.emits.forEach((e, i) => {
    const entries = Object.entries(e.fields);
    if (!entries.length) return;
    const info = L.ca.events.get(e.event)!;
    imp.value(L.mod("events"), e.event);
    imp.value(L.contextTesting, "expectEvent");
    c.line(`const event${i} = expectEvent(${events}, ${i}, ${e.event});`);
    for (const [k, v] of entries) {
      const t = info.fields.find((f) => f.name === k)!.type;
      c.line(expectEqual(`event${i}.${prop(k)}`, v, t, imp, L));
    }
  });
}

/**
 * The stored aggregate survives JSON: rebuilt from its JSON with `from`, it has the same JSON. Only for aggregates
 * without entity fields (an entity field accepts instances only, see `jsonSerializable`).
 */
function aggregateJsonAssert(L: TsLayout, c: Code, target: string, aggregate: string, imp: TsImports): void {
  if (![...L.fieldTypes(aggregate).values()].every((t) => jsonSerializable(L, t))) return;
  imp.value(L.contextTesting, "aggregateViaJson", "jsonOf");
  imp.value(L.mod("aggregates"), aggregate);
  imp.type(L.mod("aggregates"), `${aggregate}Input`);
  c.comment("The aggregate survives JSON (e.g. a document store): rebuilt from its JSON, it is the same.");
  c.line(`expect(aggregateViaJson(${target}, (input: ${aggregate}Input) => ${aggregate}.from(input))).toEqual(jsonOf(${target}));`);
}

function recordAsserts(L: TsLayout, c: Code, target: string, owner: string, rec: Record<string, unknown>, imp: TsImports): void {
  for (const [k, v] of Object.entries(rec)) {
    const t = L.tsFieldType(owner, k)!;
    c.line(expectEqual(`${target}.${prop(k)}`, v, t, imp, L));
  }
}

export function build(L: TsLayout, owner: string, kind: "vo" | "entity" | "aggregate", rec: Record<string, unknown>, imp: TsImports): string {
  imp.value(L.typeModule(kind), owner);
  return `${owner}.${kind === "vo" ? "create" : "from"}(${record(owner, rec, imp, L)})`;
}

export function aggregateTestFile(L: TsLayout, ag: AggregateIR): TsFile | undefined {
  if (!ag.scenarios.length) return undefined;
  const module = L.testModule(ag.name);
  const imp = new TsImports(module);
  const c = new Code();
  c.line();
  c.block(`describe(${tsString(ag.name)}, () =>`, () => {
    ag.scenarios.forEach((sc, i) => {
      if (i) c.line();
      aggregateScenario(L, c, ag, sc, imp);
    });
  }, ");");
  return testFile(L, module, `Scenarios of aggregate ${ag.name} (${L.ca.ir.name}).`, imp, c.toString());
}

function aggregateScenario(L: TsLayout, c: Code, ag: AggregateIR, sc: AggregateScenarioIR, imp: TsImports): void {
  const w = sc.when;
  const then = sc.then;
  const whenText = w.kind === "construct" ? `construct ${ag.name}` : w.kind === "operation" ? `${ag.name}.${w.operation}(...)` : `${ag.name}.${w.factory}(...)`;
  c.doc(scenarioDoc(sc, [...(sc.given ? ["Given: an existing aggregate"] : []), `When: ${whenText}`, `Then: ${describeThen(then).join("; ")}`]));
  c.block(`test(${tsString(sc.name)}, () =>`, () => {
    if (sc.given) c.line(`const aggregate = ${build(L, ag.name, "aggregate", sc.given.aggregate, imp)};`);
    let call: string;
    if (w.kind === "construct") call = build(L, ag.name, "aggregate", w.fields, imp);
    else {
      const member = w.kind === "operation" ? ag.operations.find((o) => o.name === w.operation)! : ag.factories.find((f) => f.name === w.factory)!;
      const types = L.paramTypes(ag, member.parameters);
      const set = member.parameters.filter((p) => p.name in w.args);
      const args = set.length ? `{ ${set.map((p) => `${prop(p.name)}: ${typedValue(w.args[p.name], types.get(p.name)!, imp, L)}`).join(", ")} }` : "";
      if (w.kind === "factory") imp.value(L.mod("aggregates"), ag.name);
      call = w.kind === "operation" ? `aggregate.${prop(w.operation)}(${args})` : `${ag.name}.${prop(w.factory)}(${args})`;
    }
    if (then.raises) {
      importError(L, imp, then.raises);
      imp.value(L.contextTesting, "expectThrows");
      c.line(`expectThrows(() => ${call}, ${then.raises});`);
      return;
    }
    if (w.kind === "construct") {
      const state = then.state && !Array.isArray(then.state) ? then.state : undefined;
      if (!state || !Object.keys(state).length) {
        c.line(`expect(${call}).toBeInstanceOf(${ag.name});`);
        return;
      }
      c.line(`const result = ${call};`);
      recordAsserts(L, c, "result", ag.name, state, imp);
      return;
    }
    const state = then.state && !Array.isArray(then.state) ? then.state : undefined;
    if (!then.emits && (!state || !Object.keys(state).length)) {
      c.line(`expect(${call}.aggregate).toBeInstanceOf(${ag.name});`);
      imp.value(L.mod("aggregates"), ag.name);
      return;
    }
    c.line(`const transition = ${call};`);
    if (state) recordAsserts(L, c, "transition.aggregate", ag.name, state, imp);
    eventAsserts(L, c, "transition.events", then, imp);
  }, ");");
}

/**
 * One test per invariant for which a violating object could be derived from the scenarios' values (see
 * core/rulecheck.ts). Each test asserts the error class and that exactly this rule raised it (`details.rule`),
 * so a rule that is silently not enforced, or enforced under another name, fails here.
 */
export function invariantTestFile(L: TsLayout): TsFile | undefined {
  const derived = deriveViolations(L.ca);
  if (!derived.length) return undefined;
  const module = L.testModule("invariants");
  const imp = new TsImports(module);
  imp.value(L.contextTesting, "expectThrows");
  const c = new Code();
  c.line();
  c.block(`describe(${tsString(`${L.ca.ir.name} invariants`)}, () =>`, () => {
    derived.forEach((d, i) => {
      const inv = [...L.ca.ir.valueObjects, ...L.ca.ir.aggregates.flatMap((a) => [a, ...a.entities])].find((o) => o.name === d.owner)!.invariants.find((x) => x.name === d.rule)!;
      importError(L, imp, d.error);
      if (i) c.line();
      c.doc(
        [
          `Invariant \`${d.rule}\` of ${d.owner}: ${inv.expression}`,
          "",
          `Derived from the values of scenario \`${d.from}\` with ${d.changed.join(" and ")} changed so that this rule is the first construct-time invariant that fails.`,
        ].join("\n"),
      );
      c.block(`test(${tsString(derivedTestName(d.owner, d.rule).replace(/^test_/, ""))}, () =>`, () => {
        c.line(`const error = expectThrows(() => ${build(L, d.owner, d.ownerKind, d.record, imp)}, ${d.error});`);
        c.line(`expect(error.details.rule).toBe(${tsString(d.rule)});`);
      }, ");");
    });
  }, ");");
  return testFile(L, module, `Invariants of the ${L.ca.ir.name} context, each violated on purpose (values derived from the scenarios).`, imp, c.toString());
}

export function useCaseTestFile(L: TsLayout, uc: UseCaseIR): TsFile | undefined {
  if (!uc.scenarios.length) return undefined;
  const module = L.testModule(uc.name);
  const imp = new TsImports(module);
  const c = new Code();
  c.line();
  c.block(`describe(${tsString(uc.name)}, () =>`, () => {
    uc.scenarios.forEach((sc, i) => {
      if (i) c.line();
      useCaseScenario(L, c, uc, sc, imp);
    });
    authorizationTests(L, c, uc, imp);
  }, ");");
  return testFile(L, module, `Scenarios of use case ${uc.name} (${L.ca.ir.name}).`, imp, c.toString());
}

/**
 * Test doubles of one scenario (unit of work, repositories with the given aggregates, clock, ids, extensions,
 * publisher, idempotency store) and `const useCase = new XUseCase({...})`. Returns the repository variables.
 */
export function useCaseSetup(L: TsLayout, c: Code, uc: UseCaseIR, sc: UseCaseScenarioIR, imp: TsImports): string[] {
  const deps = useCaseDeps(L, uc);
  const then = sc.then;
  const cls = useCaseClass(uc);
  imp.value(L.useCases, cls);
  const g = sc.given;
  const T = (p: string) => imp.value(L.contextTesting, p);
  if (deps.uow) {
    T("FakeUnitOfWork");
    c.line("const unitOfWork = new FakeUnitOfWork();");
  }
  const repos = new Set([...deps.repos, ...g.aggregates.map((a) => a.type), ...(Array.isArray(then.state) ? then.state.map((s) => s.aggregate) : [])]);
  for (const r of [...repos].sort()) {
    T(`InMemory${r}Repository`);
    c.line(`const ${repoName(r)} = new InMemory${r}Repository(${deps.uow ? "unitOfWork" : ""});`);
  }
  for (const a of g.aggregates) c.line(`${repoName(a.type)}.seed(${build(L, a.type, "aggregate", a.fields, imp)});`);
  if (deps.clock) {
    T("FixedClock");
    c.line(`const clock = new FixedClock(${tsString(g.clock ?? "1970-01-01T00:00:00+00:00")});`);
  }
  if (deps.ids) {
    T("SequentialIds");
    c.line(`const ids = new SequentialIds([${g.ids.map((id) => tsString(id)).join(", ")}]);`);
  }
  if (deps.extensions) {
    T("StubExtensions");
    const stubs = Object.entries(g.extensions).map(([k, v]) => {
      const x = L.ca.ir.extensionPoints.find((e) => e.name === k)!;
      return `${prop(k)}: ${typedValue(v, L.resolve(x.returns), imp, L)}`;
    });
    c.line(`const extensions = new StubExtensions(${stubs.length ? `{ ${stubs.join(", ")} }` : ""});`);
  }
  if (deps.publisher) {
    T("CapturingEventPublisher");
    c.line("const eventPublisher = new CapturingEventPublisher();");
  }
  if (deps.idempotency) {
    T("InMemoryIdempotencyStore");
    c.line(`const idempotencyStore = new InMemoryIdempotencyStore(${deps.uow ? "unitOfWork" : ""});`);
  }
  const params = depParams(deps);
  c.line(`const useCase = new ${cls}(${params.length ? `{ ${params.map((p) => p.name).join(", ")} }` : ""});`);
  return [...repos].sort();
}

function useCaseScenario(L: TsLayout, c: Code, uc: UseCaseIR, sc: UseCaseScenarioIR, imp: TsImports): void {
  const deps = useCaseDeps(L, uc);
  const info = L.ca.useCases.get(uc.name)!;
  const then = sc.then;
  const cls = useCaseClass(uc);
  imp.value(L.useCases, cls);
  imp.value(L.mod("commands"), uc.command);
  const g = sc.given;
  const givenText = [
    ...(g.clock ? [`now is ${g.clock}`] : []),
    ...g.aggregates.map((a) => `a stored ${a.type}`),
    ...Object.entries(g.extensions).map(([k, v]) => `${k} returns ${JSON.stringify(v)}`),
  ];
  const T = (p: string) => imp.value(L.contextTesting, p);
  c.doc(scenarioDoc(sc, [`Given: ${givenText.join("; ") || "nothing"}`, `When: ${uc.name}`, `Then: ${describeThen(then).join("; ")}`]));
  c.block(`test(${tsString(sc.name)}, async () =>`, () => {
    useCaseSetup(L, c, uc, sc, imp);
    c.line(`const command = ${uc.command}.create(${record(uc.command, sc.when.input, imp, L)});`);
    const caller = principalArg(L, c, uc, sc, imp);
    const call = `useCase.execute(command${caller})`;
    const needsResult = !!info.returnType && (then.hasReturns || (!!uc.idempotencyKey && !then.raises));
    if (then.raises) {
      importError(L, imp, then.raises);
      T("expectRejects");
      c.line(`await expectRejects(() => ${call}, ${then.raises});`);
      if (deps.uow) {
        c.line("expect(unitOfWork.committed).toBe(false);");
        // Authorization may refuse before the transaction starts (nothing to roll back).
        if (then.raises !== "NotAuthorized" && then.raises !== "Unauthenticated") c.line("expect(unitOfWork.rolledBack).toBe(true);");
      }
    } else {
      c.line(needsResult ? `const result = await ${call};` : `await ${call};`);
      if (then.hasReturns && info.returnType) c.line(expectEqual("result", then.returns, info.returnType, imp, L));
      if (deps.uow) c.line("expect(unitOfWork.committed).toBe(true);");
    }
    if (Array.isArray(then.state)) {
      then.state.forEach((s, i) => {
        const ag = L.aggregate(s.aggregate)!;
        T("expectPresent");
        const key = typedValue(s.id, L.tsFieldType(ag.name, ag.identity)!, imp, L);
        c.line(`const stored${i} = expectPresent(${repoName(ag.name)}.get(${key}), ${tsString(`stored ${ag.name}`)});`);
        recordAsserts(L, c, `stored${i}`, ag.name, s.fields, imp);
        aggregateJsonAssert(L, c, `stored${i}`, ag.name, imp);
      });
    }
    if (then.emits) {
      if (deps.publisher) eventAsserts(L, c, "eventPublisher.published", then, imp);
      else c.comment(`${uc.name} publishes no events`);
    }
    if (uc.idempotencyKey && caller !== ", null") {
      const key = `String(command.${prop(uc.idempotencyKey)})`;
      // Keys of a use case that needs a principal are kept per principal.
      if (caller) c.line(`const key = \`\${principal.id}:\${${key}}\`;`);
      const recorded = `idempotencyStore.get(${tsString(uc.name)}, ${caller ? "key" : key})`;
      if (then.raises) {
        c.comment("A failed run is not recorded, so a retry with the same key runs again.");
        c.line(`expect(${recorded}).toBeNull();`);
      } else {
        c.comment("Idempotency: the same command again returns the recorded result and runs no step.");
        c.line(`expect(${recorded}).not.toBeNull();`);
        if (deps.publisher) c.line("const published = eventPublisher.published.length;");
        c.line(info.returnType ? `expect(await ${call}).toBe(result);` : `await ${call};`);
        if (deps.publisher) c.line("expect(eventPublisher.published.length).toBe(published);");
      }
    }
  }, ");");
}

// ---------------------------------------------------------------------------
// Authorization (docs/09 §20)
// ---------------------------------------------------------------------------

/** `Principal.create({ ... })` of a resolved principal (claims that are null are left to their default). */
export function principalLiteral(L: TsLayout, p: ResolvedPrincipal, imp: TsImports): string {
  const sec = L.model.security!;
  imp.value(L.security, "Principal");
  const value = (v: unknown): string => (Array.isArray(v) ? `[${v.map(value).join(", ")}]` : typeof v === "string" ? tsString(v) : String(v));
  const parts = [`id: ${tsString(p.id)}`, `roles: [${p.roles.map(tsString).join(", ")}]`];
  for (const c of sec.principal.claims) {
    const v = p.claims[c.name];
    if (v !== null && v !== undefined) parts.push(`${prop(c.name)}: ${value(v)}`);
  }
  return `Principal.create({ ${parts.join(", ")} })`;
}

/** Declares `principal` for a scenario of a use case that needs one; returns the extra execute argument. */
function principalArg(L: TsLayout, c: Code, uc: UseCaseIR, sc: UseCaseScenarioIR, imp: TsImports): string {
  const sec = L.model.security;
  if (!sec || !useCaseAuthorization(L, uc)) return "";
  const p = scenarioPrincipal(sec, uc, sc);
  if (p.anonymous) return ", null";
  c.line(`const principal = ${principalLiteral(L, p, imp)};`);
  return ", principal";
}

/** Test doubles of a use case whose repositories fail the test when touched (authorization must come first). */
function untouchedSetup(L: TsLayout, c: Code, uc: UseCaseIR, imp: TsImports): void {
  const deps = useCaseDeps(L, uc);
  const T = (p: string) => imp.value(L.contextTesting, p);
  if (deps.repos.length) {
    c.comment("Repositories that fail the test when the use case touches them: authorization comes first.");
    c.block("const untouched =", () => {
      c.block("get: (): never =>", () => c.line('throw new Error("loaded before authorization");'), ",");
      c.block("save: (): never =>", () => c.line('throw new Error("saved before authorization");'), ",");
    }, ";");
  }
  if (deps.uow) {
    T("FakeUnitOfWork");
    c.line("const unitOfWork = new FakeUnitOfWork();");
  }
  if (deps.publisher) {
    T("CapturingEventPublisher");
    c.line("const eventPublisher = new CapturingEventPublisher();");
  }
  const params = depParams(deps).map((p) => {
    if (p.type.endsWith("Repository")) return `${p.name}: untouched`;
    switch (p.name) {
      case "clock":
        T("FixedClock");
        return 'clock: new FixedClock("1970-01-01T00:00:00+00:00")';
      case "ids":
        T("SequentialIds");
        return "ids: new SequentialIds([])";
      case "extensions":
        T("StubExtensions");
        return "extensions: new StubExtensions()";
      case "idempotencyStore":
        T("InMemoryIdempotencyStore");
        return "idempotencyStore: new InMemoryIdempotencyStore()";
      default:
        return p.name;
    }
  });
  c.line(`const useCase = new ${useCaseClass(uc)}({ ${params.join(", ")} });`);
}

/**
 * Derived authorization tests of a use case that needs a principal: without a principal it raises Unauthenticated,
 * and (when it requires roles) a principal holding none of them raises NotAuthorized — both before any repository is
 * touched, nothing committed, nothing published.
 */
function authorizationTests(L: TsLayout, c: Code, uc: UseCaseIR, imp: TsImports): void {
  const sec: SecurityIR | undefined = L.model.security;
  const auth = useCaseAuthorization(L, uc);
  const sc = uc.scenarios[0];
  if (!sec || !auth || !sc) return;
  const deps = useCaseDeps(L, uc);
  imp.value(L.contextTesting, "expectRejects");
  const cases: { name: string; doc: string; principal: string; error: string; details: string }[] = [];
  if (!uc.scenarios.some((s) => s.given.principal?.anonymous)) {
    cases.push({ name: "authorization: an anonymous caller is refused before any load", doc: `Without a principal ${uc.name} raises Unauthenticated before it touches a repository.`, principal: "null", error: "Unauthenticated", details: `{ action: ${tsString(uc.name)} }` });
  }
  if (auth.roles.length) {
    const roles = otherRoles(sec, uc.authorize!);
    const p = makePrincipal(sec, { roles, claims: {} });
    cases.push({
      name: "authorization: a missing role is refused before any load",
      doc: `A principal with ${roles.length ? `only the other roles (${roles.join(", ")})` : "no role"} lacks ${auth.roles.join(" / ")}: ${uc.name} raises NotAuthorized naming the required roles, before it touches a repository.`,
      principal: principalLiteral(L, p, imp),
      error: "NotAuthorized",
      details: `{ action: ${tsString(uc.name)}, requiredRoles: [${auth.roles.map(tsString).join(", ")}] }`,
    });
  }
  for (const k of cases) {
    importError(L, imp, k.error);
    imp.value(L.mod("commands"), uc.command);
    c.line();
    c.doc(k.doc);
    c.block(`test(${tsString(k.name)}, async () =>`, () => {
      untouchedSetup(L, c, uc, imp);
      c.line(`const command = ${uc.command}.create(${record(uc.command, sc.when.input, imp, L)});`);
      if (k.principal !== "null") c.line(`const principal = ${k.principal};`);
      c.line(`const error = await expectRejects(() => useCase.execute(command, ${k.principal === "null" ? "null" : "principal"}), ${k.error});`);
      c.line(`expect(error.details).toEqual(${k.details});`);
      if (deps.uow) c.line("expect(unitOfWork.committed).toBe(false);");
      if (deps.publisher) c.line("expect(eventPublisher.published).toEqual([]);");
    }, ");");
  }
}
