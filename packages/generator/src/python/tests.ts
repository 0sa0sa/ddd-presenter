import { claimType, deriveViolations, derivedTestName, makePrincipal, otherRoles, scenarioPrincipal, type ResolvedPrincipal, type AggregateIR, type AggregateScenarioIR, type ScenarioThenIR, type Type, type UseCaseIR, type UseCaseScenarioIR } from "@ddd/core";
import { depParams, repoAttr, resolveReturn, useCaseAuthorization, useCaseDeps } from "./application.ts";
import { securityModule } from "./security.ts";
import { paramTypes, type PyFile } from "./domain.ts";
import { assemble, ModuleImports, type Layout } from "./layout.ts";
import { pyInMemoryReaders } from "./queries.ts";
import { assertEquals, Code, Imports, pascal, pyString, pyType, pyValue, type ValueContext } from "./support.ts";

// ---------------------------------------------------------------------------
// testing.py — in-memory adapters for the generated ports
// ---------------------------------------------------------------------------

export function testingFile(L: Layout): PyFile {
  const mod = L.testing;
  const imp = new ModuleImports(mod);
  imp.from("collections.abc", "Sequence");
  imp.from("datetime", "datetime");
  imp.from("uuid", "UUID");
  imp.from("typing", "Protocol");
  imp.from(L.runtime, "DomainEvent");
  const c = new Code();

  c.line().line();
  c.line("class _Transactional(Protocol):");
  c.indent(() => {
    c.line("def _commit(self) -> None: ...");
    c.line();
    c.line("def _rollback(self) -> None: ...");
  });
  c.line().line();
  c.line("class FakeUnitOfWork:");
  c.indent(() => {
    c.docstring("Unit of work for tests: repositories enlisted here only apply writes on commit.");
    c.line();
    c.line("def __init__(self) -> None:");
    c.indent(() => {
      c.line("self.committed = False");
      c.line("self.rolled_back = False");
      c.line("self._participants: list[_Transactional] = []");
    });
    c.line();
    c.line("def enlist(self, participant: _Transactional) -> None:");
    c.indent(() => c.line("self._participants.append(participant)"));
    c.line();
    c.line("def commit(self) -> None:");
    c.indent(() => {
      c.line("for p in self._participants:");
      c.indent(() => c.line("p._commit()"));
      c.line("self.committed = True");
    });
    c.line();
    c.line("def rollback(self) -> None:");
    c.indent(() => {
      c.line("for p in self._participants:");
      c.indent(() => c.line("p._rollback()"));
      c.line("self.rolled_back = True");
    });
  });

  for (const ag of L.ca.ir.aggregates) {
    imp.from(L.mod("aggregates"), ag.name);
    const idType = pyType(L.fieldTypes(ag.name).get(ag.identity)!, imp, L.typeModule, { field: false });
    c.line().line();
    c.line(`class InMemory${ag.name}Repository:`);
    c.indent(() => {
      c.docstring(`In-memory ${ag.name}Repository. Writes are staged until the unit of work commits.`);
      c.line();
      c.line("def __init__(self, unit_of_work: FakeUnitOfWork | None = None) -> None:");
      c.indent(() => {
        c.line(`self._committed: dict[${idType}, ${ag.name}] = {}`);
        c.line(`self._pending: dict[${idType}, ${ag.name}] = {}`);
        c.line("self._unit_of_work = unit_of_work");
        c.line("if unit_of_work is not None:");
        c.indent(() => c.line("unit_of_work.enlist(self)"));
      });
      c.line();
      c.line(`def seed(self, *aggregates: ${ag.name}) -> None:`);
      c.indent(() => {
        c.line("for aggregate in aggregates:");
        c.indent(() => c.line(`self._committed[aggregate.${ag.identity}] = aggregate`));
      });
      c.line();
      c.line(`def get(self, ${ag.identity}: ${idType}) -> ${ag.name} | None:`);
      c.indent(() => c.line(`return self._pending.get(${ag.identity}, self._committed.get(${ag.identity}))`));
      c.line();
      c.line(`def save(self, aggregate: ${ag.name}) -> None:`);
      c.indent(() => {
        c.line("if self._unit_of_work is None:");
        c.indent(() => c.line(`self._committed[aggregate.${ag.identity}] = aggregate`));
        c.line("else:");
        c.indent(() => c.line(`self._pending[aggregate.${ag.identity}] = aggregate`));
      });
      c.line();
      c.line(`def all(self) -> list[${ag.name}]:`);
      c.indent(() => c.line("return list(self._committed.values())"));
      c.line();
      c.line("def _commit(self) -> None:");
      c.indent(() => {
        c.line("self._committed.update(self._pending)");
        c.line("self._pending.clear()");
      });
      c.line();
      c.line("def _rollback(self) -> None:");
      c.indent(() => c.line("self._pending.clear()"));
    });
  }

  // In-memory readers of the context's queries (none without queries: the file stays as before).
  pyInMemoryReaders(L, c, imp);

  if (L.ca.ir.useCases.some((u) => u.idempotencyKey)) {
    imp.from(L.ports, "RecordedResult");
    c.line().line();
    c.line("class InMemoryIdempotencyStore:");
    c.indent(() => {
      c.docstring("In-memory IdempotencyStore. Records are staged until the unit of work commits, like the repositories.");
      c.line();
      c.line("def __init__(self, unit_of_work: FakeUnitOfWork | None = None) -> None:");
      c.indent(() => {
        c.line("self._committed: dict[tuple[str, str], RecordedResult] = {}");
        c.line("self._pending: dict[tuple[str, str], RecordedResult] = {}");
        c.line("self._unit_of_work = unit_of_work");
        c.line("if unit_of_work is not None:");
        c.indent(() => c.line("unit_of_work.enlist(self)"));
      });
      c.line();
      c.line("def get(self, use_case: str, key: str) -> RecordedResult | None:");
      c.indent(() => c.line("return self._pending.get((use_case, key), self._committed.get((use_case, key)))"));
      c.line();
      c.line("def record(self, use_case: str, key: str, result: RecordedResult) -> None:");
      c.indent(() => {
        c.line("if self._unit_of_work is None:");
        c.indent(() => c.line("self._committed[(use_case, key)] = result"));
        c.line("else:");
        c.indent(() => c.line("self._pending[(use_case, key)] = result"));
      });
      c.line();
      c.line("def _commit(self) -> None:");
      c.indent(() => {
        c.line("self._committed.update(self._pending)");
        c.line("self._pending.clear()");
      });
      c.line();
      c.line("def _rollback(self) -> None:");
      c.indent(() => c.line("self._pending.clear()"));
    });
  }

  c.line().line();
  c.line("class FixedClock:");
  c.indent(() => {
    c.line("def __init__(self, now: datetime) -> None:");
    c.indent(() => c.line("self._now = now"));
    c.line();
    c.line("def now(self) -> datetime:");
    c.indent(() => c.line("return self._now"));
  });
  c.line().line();
  c.line("class SequentialIds:");
  c.indent(() => {
    c.line("def __init__(self, ids: Sequence[UUID]) -> None:");
    c.indent(() => c.line("self._ids = list(ids)"));
    c.line();
    c.line("def new_id(self) -> UUID:");
    c.indent(() => {
      c.line("if not self._ids:");
      c.indent(() => c.line('raise AssertionError("SequentialIds ran out of ids; add more to given.ids")'));
      c.line("return self._ids.pop(0)");
    });
  });
  c.line().line();
  c.line("class CapturingEventPublisher:");
  c.indent(() => {
    c.line("def __init__(self) -> None:");
    c.indent(() => c.line("self.published: list[DomainEvent] = []"));
    c.line();
    c.line("def publish(self, events: Sequence[DomainEvent]) -> None:");
    c.indent(() => c.line("self.published.extend(events)"));
  });

  const vctx: ValueContext = { imports: imp, typeModule: L.typeModule, fieldTypes: L.ca.fieldTypes };
  c.line().line();
  c.line("class StubExtensions:");
  c.indent(() => {
    c.docstring("Test double for the Extensions protocol; each extension returns a fixed value.");
    const exts = L.ca.ir.extensionPoints;
    if (!exts.length) return;
    c.line();
    const sig = exts.map((x) => {
      const rt = resolveReturn(L, x.returns);
      const ann = pyType(rt, imp, L.typeModule, { field: false });
      return x.testDefault !== undefined ? `${x.name}: ${ann} = ${pyValue(x.testDefault, rt, vctx)}` : `${x.name}: ${ann} | None = None`;
    });
    c.line(`def __init__(self, *, ${sig.join(", ")}) -> None:`);
    c.indent(() => {
      for (const x of exts) c.line(`self._${x.name} = ${x.name}`);
    });
    for (const x of exts) {
      const pt = paramTypes(L, undefined, x.parameters);
      const params = x.parameters.map((p) => `${p.name}: ${pyType(pt.get(p.name)!, imp, L.typeModule, { field: false })}`).join(", ");
      const rt = pyType(resolveReturn(L, x.returns), imp, L.typeModule, { field: false });
      c.line();
      c.line(`def ${x.name}(self${params ? `, ${params}` : ""}) -> ${rt}:`);
      c.indent(() => {
        if (x.testDefault === undefined) {
          c.line(`if self._${x.name} is None:`);
          c.indent(() => c.line(`raise AssertionError(${pyString(`extension ${x.name} is not stubbed in this scenario`)})`));
        }
        c.line(`return self._${x.name}`);
      });
    }
  });
  return { path: L.path(mod), content: assemble(L.model, `In-memory test doubles for the ports of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

// ---------------------------------------------------------------------------
// pytest files
// ---------------------------------------------------------------------------

function describeThen(t: ScenarioThenIR): string[] {
  const out: string[] = [];
  if (t.raises) out.push(`raises ${t.raises}`);
  if (t.hasReturns) out.push(`returns ${spacedJson(t.returns)}`);
  if (t.state) out.push(`state ${spacedJson(t.state)}`);
  if (t.emits) out.push(t.emits.length ? `emits ${t.emits.map((e) => e.event).join(", ")}` : "emits nothing");
  return out;
}

/** JSON with spaces after separators (so long docstring lines can wrap); `path` bookkeeping keys are dropped. */
function spacedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spacedJson).join(", ")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([k, x]) => k !== "path" && x !== undefined);
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${spacedJson(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v ?? null);
}

function eventAsserts(L: Layout, c: Code, events: string, then: ScenarioThenIR, imp: Imports, vctx: ValueContext): void {
  if (!then.emits) return;
  c.line(`assert [type(event).__name__ for event in ${events}] == [${then.emits.map((e) => pyString(e.event)).join(", ")}]`);
  if (then.emits.length) {
    imp.from(L.mod("events"), "parse_event");
    c.line("# The serialized events come back as the same classes (`event_type` tells them apart).");
    c.line(`assert [parse_event(event.model_dump(mode="json")) for event in ${events}] == list(${events})`);
  }
  then.emits.forEach((e, i) => {
    const entries = Object.entries(e.fields);
    if (!entries.length) return;
    const info = L.ca.events.get(e.event)!;
    imp.from(L.mod("events"), e.event);
    c.line(`event_${i} = ${events}[${i}]`);
    c.line(`assert isinstance(event_${i}, ${e.event})`);
    for (const [k, v] of entries) {
      const t = info.fields.find((f) => f.name === k)!.type;
      c.line(assertEquals(`event_${i}.${k}`, pyValue(v, t, vctx)));
    }
  });
}

function recordAsserts(c: Code, target: string, rec: Record<string, unknown>, types: Map<string, Type>, vctx: ValueContext): void {
  for (const [k, v] of Object.entries(rec)) {
    const t = types.get(k)!;
    const expected = pyValue(v, t, vctx);
    c.line(assertEquals(`${target}.${k}`, expected));
  }
}

function construct(name: string, rec: Record<string, unknown>, types: Map<string, Type>, vctx: ValueContext): string {
  const args = [...types.entries()].filter(([k]) => k in rec).map(([k, t]) => `${k}=${pyValue(rec[k], t, vctx)}`);
  return `${name}(${args.join(", ")})`;
}

function scenarioDoc(sc: { description?: string }, lines: string[]): string {
  return [sc.description ?? "Scenario generated from the model.", "", ...lines].join("\n");
}

export function aggregateTestFile(L: Layout, ag: AggregateIR): PyFile | undefined {
  if (!ag.scenarios.length) return undefined;
  const imp = new Imports();
  imp.from("__future__", "annotations");
  imp.from(L.mod("aggregates"), ag.name);
  const vctx: ValueContext = { imports: imp, typeModule: L.typeModule, fieldTypes: L.ca.fieldTypes };
  const c = new Code();
  const types = L.fieldTypes(ag.name);
  for (const sc of ag.scenarios) aggregateScenario(L, c, ag, sc, types, imp, vctx);
  return {
    path: L.testPath(ag.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()),
    content: assemble(L.model, `Scenarios of aggregate ${ag.name} (${L.ca.ir.name}).`, imp, c.toString(), { exports: false }),
  };
}

function importError(L: Layout, imp: Imports, name: string): void {
  if (name === "ConstraintViolation" || name === "AggregateNotFound") imp.from(L.runtime, name);
  else if (name === "NotAuthorized" || name === "Unauthenticated") imp.from(securityModule(L.model), name);
  else imp.from(L.mod("errors"), name);
}

function aggregateScenario(L: Layout, c: Code, ag: AggregateIR, sc: AggregateScenarioIR, types: Map<string, Type>, imp: Imports, vctx: ValueContext): void {
  const w = sc.when;
  const then = sc.then;
  const whenText =
    w.kind === "construct" ? `construct ${ag.name}` : w.kind === "operation" ? `${ag.name}.${w.operation}(...)` : `${ag.name}.${w.factory}(...)`;
  c.line().line();
  c.line(`def test_${sc.name}() -> None:`);
  c.indent(() => {
    c.docstring(scenarioDoc(sc, [...(sc.given ? ["Given: an existing aggregate"] : []), `When: ${whenText}`, `Then: ${describeThen(then).join("; ")}`]));
    if (sc.given) c.line(`aggregate = ${construct(ag.name, sc.given.aggregate, types, vctx)}`);
    let call: string;
    if (w.kind === "construct") call = construct(ag.name, w.fields, types, vctx);
    else {
      const member = w.kind === "operation" ? ag.operations.find((o) => o.name === w.operation)! : ag.factories.find((f) => f.name === w.factory)!;
      const pt = paramTypes(L, ag, member.parameters);
      const args = member.parameters.filter((p) => p.name in w.args).map((p) => `${p.name}=${pyValue(w.args[p.name], pt.get(p.name)!, vctx)}`);
      call = w.kind === "operation" ? `aggregate.${w.operation}(${args.join(", ")})` : `${ag.name}.${w.factory}(${args.join(", ")})`;
    }
    if (then.raises) {
      imp.import("pytest");
      importError(L, imp, then.raises);
      c.line(`with pytest.raises(${then.raises}):`);
      c.indent(() => c.line(call));
      return;
    }
    if (w.kind === "construct") {
      c.line(`result = ${call}`);
      if (then.state && !Array.isArray(then.state)) recordAsserts(c, "result", then.state, types, vctx);
      return;
    }
    c.line(`transition = ${call}`);
    if (then.state && !Array.isArray(then.state)) recordAsserts(c, "transition.aggregate", then.state, types, vctx);
    eventAsserts(L, c, "transition.events", then, imp, vctx);
  });
}

/**
 * One test per invariant for which a violating object could be derived from the scenarios' values (see
 * core/rulecheck.ts). Each test asserts the error class and that exactly this rule raised it (`details["rule"]`),
 * so a rule that is silently not enforced, or enforced under another name, fails here.
 */
export function invariantTestFile(L: Layout): PyFile | undefined {
  const derived = deriveViolations(L.ca);
  if (!derived.length) return undefined;
  const imp = new Imports();
  imp.from("__future__", "annotations");
  imp.import("pytest");
  const vctx: ValueContext = { imports: imp, typeModule: L.typeModule, fieldTypes: L.ca.fieldTypes };
  const c = new Code();
  for (const d of derived) {
    const inv = [...L.ca.ir.valueObjects, ...L.ca.ir.aggregates.flatMap((a) => [a, ...a.entities])].find((o) => o.name === d.owner)!.invariants.find((i) => i.name === d.rule)!;
    imp.from(L.typeModule(d.ownerKind, d.owner), d.owner);
    importError(L, imp, d.error);
    c.line().line();
    c.line(`def ${derivedTestName(d.owner, d.rule)}() -> None:`);
    c.indent(() => {
      c.docstring(
        [
          `Invariant \`${d.rule}\` of ${d.owner}: ${inv.expression}`,
          "",
          `Derived from the values of scenario \`${d.from}\` with ${d.changed.join(" and ")} changed so that this rule is the first construct-time invariant that fails.`,
        ].join("\n"),
      );
      c.line(`with pytest.raises(${d.error}) as raised:`);
      c.indent(() => c.line(construct(d.owner, d.record, L.fieldTypes(d.owner), vctx)));
      c.line(`assert raised.value.details["rule"] == ${pyString(d.rule)}`);
    });
  }
  return {
    path: L.testPath("invariants"),
    content: assemble(L.model, `Invariants of the ${L.ca.ir.name} context, each violated on purpose (values derived from the scenarios).`, imp, c.toString(), { exports: false }),
  };
}

export function useCaseTestFile(L: Layout, uc: UseCaseIR): PyFile | undefined {
  if (!uc.scenarios.length) return undefined;
  const imp = new Imports();
  imp.from("__future__", "annotations");
  const vctx: ValueContext = { imports: imp, typeModule: L.typeModule, fieldTypes: L.ca.fieldTypes };
  const c = new Code();
  for (const sc of uc.scenarios) useCaseScenario(L, c, uc, sc, imp, vctx);
  authorizationTests(L, c, uc, imp, vctx);
  return { path: L.testPath(uc.name), content: assemble(L.model, `Scenarios of use case ${uc.name} (${L.ca.ir.name}).`, imp, c.toString(), { exports: false }) };
}

function useCaseScenario(L: Layout, c: Code, uc: UseCaseIR, sc: UseCaseScenarioIR, imp: Imports, vctx: ValueContext): void {
  const deps = useCaseDeps(L, uc);
  const info = L.ca.useCases.get(uc.name)!;
  const then = sc.then;
  const cls = `${pascal(uc.name)}UseCase`;
  imp.from(L.useCases, cls);
  imp.from(L.mod("commands"), uc.command);
  const g = sc.given;
  const givenText = [
    ...(g.clock ? [`now is ${g.clock}`] : []),
    ...g.aggregates.map((a) => `a stored ${a.type}`),
    ...Object.entries(g.extensions).map(([k, v]) => `${k} returns ${JSON.stringify(v)}`),
  ];
  c.line().line();
  c.line(`def test_${sc.name}() -> None:`);
  c.indent(() => {
    c.docstring(scenarioDoc(sc, [`Given: ${givenText.join("; ") || "nothing"}`, `When: ${uc.name}`, `Then: ${describeThen(then).join("; ")}`]));
    if (deps.uow) {
      imp.from(L.testing, "FakeUnitOfWork");
      c.line("unit_of_work = FakeUnitOfWork()");
    }
    const repos = new Set([...deps.repos, ...g.aggregates.map((a) => a.type), ...(Array.isArray(then.state) ? then.state.map((s) => s.aggregate) : [])]);
    for (const r of [...repos].sort()) {
      imp.from(L.testing, `InMemory${r}Repository`);
      c.line(`${repoAttr(r)} = InMemory${r}Repository(${deps.uow ? "unit_of_work" : ""})`);
    }
    for (const a of g.aggregates) {
      imp.from(L.mod("aggregates"), a.type);
      c.line(`${repoAttr(a.type)}.seed(${construct(a.type, a.fields, L.fieldTypes(a.type), vctx)})`);
    }
    if (deps.clock) {
      imp.from(L.testing, "FixedClock");
      c.line(`clock = FixedClock(${pyValue(g.clock ?? "1970-01-01T00:00:00+00:00", { k: "primitive", name: "DateTime" }, vctx)})`);
    }
    if (deps.ids) {
      imp.from(L.testing, "SequentialIds");
      c.line(`ids = SequentialIds([${g.ids.map((id) => pyValue(id, { k: "primitive", name: "UUID" }, vctx)).join(", ")}])`);
    }
    if (deps.extensions) {
      imp.from(L.testing, "StubExtensions");
      const args = Object.entries(g.extensions).map(([k, v]) => {
        const x = L.ca.ir.extensionPoints.find((e) => e.name === k)!;
        return `${k}=${pyValue(v, resolveReturn(L, x.returns), vctx)}`;
      });
      c.line(`extensions = StubExtensions(${args.join(", ")})`);
    }
    if (deps.publisher) {
      imp.from(L.testing, "CapturingEventPublisher");
      c.line("event_publisher = CapturingEventPublisher()");
    }
    if (deps.idempotency) {
      imp.from(L.testing, "InMemoryIdempotencyStore");
      c.line(`idempotency_store = InMemoryIdempotencyStore(${deps.uow ? "unit_of_work" : ""})`);
    }
    const params = depParams(deps);
    c.line(`use_case = ${cls}(${params.map((p) => `${p.name}=${p.name}`).join(", ")})`);
    const cmd = construct(uc.command, sc.when.input, L.fieldTypes(uc.command), vctx);
    c.line(`command = ${cmd}`);
    const caller = principalArg(L, c, uc, sc, imp);
    const call = `use_case.execute(command${caller})`;
    if (then.raises) {
      imp.import("pytest");
      importError(L, imp, then.raises);
      c.line(`with pytest.raises(${then.raises}):`);
      c.indent(() => c.line(call));
      if (deps.uow) {
        c.line("assert not unit_of_work.committed");
        // Authorization may refuse before the transaction starts (nothing to roll back).
        if (then.raises !== "NotAuthorized" && then.raises !== "Unauthenticated") c.line("assert unit_of_work.rolled_back");
      }
    } else if (info.returnType) {
      c.line(`result = ${call}`);
      if (then.hasReturns) c.line(assertEquals("result", pyValue(then.returns, info.returnType, vctx)));
      if (deps.uow) c.line("assert unit_of_work.committed");
    } else {
      c.line(call);
      if (deps.uow) c.line("assert unit_of_work.committed");
    }
    if (Array.isArray(then.state)) {
      then.state.forEach((s, i) => {
        const ag = L.ca.ir.aggregates.find((a) => a.name === s.aggregate)!;
        const types = L.fieldTypes(ag.name);
        c.line(`stored_${i} = ${repoAttr(ag.name)}.get(${pyValue(s.id, types.get(ag.identity)!, vctx)})`);
        c.line(`assert stored_${i} is not None`);
        recordAsserts(c, `stored_${i}`, s.fields, types, vctx);
      });
    }
    if (then.emits) {
      if (deps.publisher) eventAsserts(L, c, "event_publisher.published", then, imp, vctx);
      else c.line(`# ${uc.name} publishes no events`);
    }
    if (uc.idempotencyKey && caller !== ", None") {
      // Keys of a use case that needs a principal are kept per principal.
      const key = caller ? `f"{principal.id}:{command.${uc.idempotencyKey}}"` : `str(command.${uc.idempotencyKey})`;
      const recorded = `idempotency_store.get(${pyString(uc.name)}, ${key})`;
      if (then.raises) {
        c.line("# A failed run is not recorded, so a retry with the same key runs again.");
        c.line(`assert ${recorded} is None`);
      } else {
        c.line("# Idempotency: the same command again returns the recorded result and runs no step.");
        c.line(`assert ${recorded} is not None`);
        if (deps.publisher) c.line("published = len(event_publisher.published)");
        c.line(info.returnType ? `assert ${call} == result` : call);
        if (deps.publisher) c.line("assert len(event_publisher.published) == published");
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Authorization (docs/09 §20)
// ---------------------------------------------------------------------------

/** `Principal(id=..., roles=(...), claim=...)` of a resolved principal (claims that are None are left out). */
export function principalPy(L: Layout, p: ResolvedPrincipal, imp: Imports): string {
  const sec = L.model.security!;
  imp.from(securityModule(L.model), "Principal");
  const value = (v: unknown, type: string): string => {
    const t = claimType(type);
    if (Array.isArray(v)) return `(${v.map((x) => pyString(String(x))).join(", ")}${v.length === 1 ? "," : ""})`;
    if (t?.k === "primitive" && t.name === "UUID") {
      imp.from("uuid", "UUID");
      return `UUID(${pyString(String(v))})`;
    }
    if (typeof v === "boolean") return v ? "True" : "False";
    return typeof v === "string" ? pyString(v) : String(v);
  };
  const parts = [`id=${value(p.id, sec.principal.idType)}`, `roles=(${p.roles.map(pyString).join(", ")}${p.roles.length === 1 ? "," : ""})`];
  for (const c of sec.principal.claims) {
    const v = p.claims[c.name];
    if (v !== null && v !== undefined) parts.push(`${c.name}=${value(v, c.type)}`);
  }
  return `Principal(${parts.join(", ")})`;
}

/** Declares `principal` for a scenario of a use case that needs one; returns the extra execute argument. */
function principalArg(L: Layout, c: Code, uc: UseCaseIR, sc: UseCaseScenarioIR, imp: Imports): string {
  const sec = L.model.security;
  if (!sec || !useCaseAuthorization(L, uc)) return "";
  const p = scenarioPrincipal(sec, uc, sc);
  if (p.anonymous) return ", None";
  c.line(`principal = ${principalPy(L, p, imp)}`);
  return ", principal";
}

/** A repository class per aggregate that fails the test when the use case touches it before authorization. */
function untouchedRepository(L: Layout, c: Code, aggregate: string, imp: Imports, done: Set<string>): string {
  const cls = `_Untouched${aggregate}Repository`;
  if (done.has(cls)) return cls;
  done.add(cls);
  const ag = L.ca.ir.aggregates.find((a) => a.name === aggregate)!;
  imp.from("typing", "NoReturn");
  imp.from(L.mod("aggregates"), aggregate);
  const idType = pyType(L.fieldTypes(ag.name).get(ag.identity)!, imp, L.typeModule, { field: false });
  c.line().line();
  c.line(`class ${cls}:`);
  c.indent(() => {
    c.docstring(`A ${aggregate}Repository that fails the test when it is used: authorization comes first.`);
    c.line();
    c.line(`def get(self, ${ag.identity}: ${idType}) -> NoReturn:`);
    c.indent(() => c.line('raise AssertionError("loaded before authorization")'));
    c.line();
    c.line(`def save(self, aggregate: ${aggregate}) -> NoReturn:`);
    c.indent(() => c.line('raise AssertionError("saved before authorization")'));
  });
  return cls;
}

/**
 * Derived authorization tests: an anonymous caller raises Unauthenticated, and (with required roles) a principal holding
 * none of them raises NotAuthorized naming the roles, both before any repository is touched.
 */
function authorizationTests(L: Layout, c: Code, uc: UseCaseIR, imp: Imports, vctx: ValueContext): void {
  const sec = L.model.security;
  const auth = useCaseAuthorization(L, uc);
  const sc = uc.scenarios[0];
  if (!sec || !auth || !sc) return;
  const deps = useCaseDeps(L, uc);
  const cases: { name: string; doc: string; principal: string; error: string; details: string }[] = [];
  if (!uc.scenarios.some((s) => s.given.principal?.anonymous)) {
    cases.push({ name: "authorization_anonymous_is_unauthenticated", doc: `Without a principal ${uc.name} raises Unauthenticated before it touches a repository.`, principal: "None", error: "Unauthenticated", details: `{"action": ${pyString(uc.name)}}` });
  }
  if (auth.roles.length) {
    const roles = otherRoles(sec, uc.authorize!);
    cases.push({
      name: "authorization_missing_role_is_refused",
      doc: `A principal with ${roles.length ? `only the other roles (${roles.join(", ")})` : "no role"} lacks ${auth.roles.join(" / ")}: ${uc.name} raises NotAuthorized naming the required roles, before it touches a repository.`,
      principal: principalPy(L, makePrincipal(sec, { roles, claims: {} }), imp),
      error: "NotAuthorized",
      details: `{"action": ${pyString(uc.name)}, "required_roles": [${auth.roles.map(pyString).join(", ")}]}`,
    });
  }
  const done = new Set<string>();
  for (const k of cases) {
    importError(L, imp, k.error);
    imp.import("pytest");
    const repos = new Map(deps.repos.map((r) => [r, untouchedRepository(L, c, r, imp, done)]));
    c.line().line();
    c.line(`def test_${k.name}() -> None:`);
    c.indent(() => {
      c.docstring(k.doc);
      if (deps.uow) {
        imp.from(L.testing, "FakeUnitOfWork");
        c.line("unit_of_work = FakeUnitOfWork()");
      }
      if (deps.publisher) {
        imp.from(L.testing, "CapturingEventPublisher");
        c.line("event_publisher = CapturingEventPublisher()");
      }
      const args = depParams(deps).map((p) => {
        const r = deps.repos.find((x) => repoAttr(x) === p.name);
        if (r) return `${p.name}=${repos.get(r)}()`;
        switch (p.name) {
          case "clock":
            imp.from(L.testing, "FixedClock");
            return `clock=FixedClock(${pyValue("1970-01-01T00:00:00+00:00", { k: "primitive", name: "DateTime" }, vctx)})`;
          case "ids":
            imp.from(L.testing, "SequentialIds");
            return "ids=SequentialIds([])";
          case "extensions":
            imp.from(L.testing, "StubExtensions");
            return "extensions=StubExtensions()";
          case "idempotency_store":
            imp.from(L.testing, "InMemoryIdempotencyStore");
            return "idempotency_store=InMemoryIdempotencyStore()";
          default:
            return `${p.name}=${p.name}`;
        }
      });
      c.line(`use_case = ${pascal(uc.name)}UseCase(${args.join(", ")})`);
      c.line(`command = ${construct(uc.command, sc.when.input, L.fieldTypes(uc.command), vctx)}`);
      if (k.principal !== "None") c.line(`principal = ${k.principal}`);
      c.line(`with pytest.raises(${k.error}) as raised:`);
      c.indent(() => c.line(`use_case.execute(command, ${k.principal === "None" ? "None" : "principal"})`));
      c.line(`assert raised.value.details == ${k.details}`);
      if (deps.uow) c.line("assert not unit_of_work.committed");
      if (deps.publisher) c.line("assert event_publisher.published == []");
    });
  }
}
