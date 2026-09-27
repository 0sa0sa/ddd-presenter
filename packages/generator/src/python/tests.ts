import type { AggregateIR, AggregateScenarioIR, ScenarioThenIR, Type, UseCaseIR, UseCaseScenarioIR } from "@ddd/core";
import { depParams, repoAttr, resolveReturn, useCaseDeps } from "./application.ts";
import { paramTypes, type PyFile } from "./domain.ts";
import { assemble, ModuleImports, type Layout } from "./layout.ts";
import { Code, Imports, pascal, pyString, pyType, pyValue, type ValueContext } from "./support.ts";

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
    if (!exts.length) {
      c.line();
      c.line("pass");
      return;
    }
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
  if (t.hasReturns) out.push(`returns ${JSON.stringify(t.returns)}`);
  if (t.state) out.push(`state ${JSON.stringify(t.state, (k, v) => (k === "path" ? undefined : v))}`);
  if (t.emits) out.push(t.emits.length ? `emits ${t.emits.map((e) => e.event).join(", ")}` : "emits nothing");
  return out;
}

function eventAsserts(L: Layout, c: Code, events: string, then: ScenarioThenIR, imp: Imports, vctx: ValueContext): void {
  if (!then.emits) return;
  c.line(`assert [type(event).__name__ for event in ${events}] == [${then.emits.map((e) => pyString(e.event)).join(", ")}]`);
  then.emits.forEach((e, i) => {
    const entries = Object.entries(e.fields);
    if (!entries.length) return;
    const info = L.ca.events.get(e.event)!;
    imp.from(L.mod("events"), e.event);
    c.line(`event_${i} = ${events}[${i}]`);
    c.line(`assert isinstance(event_${i}, ${e.event})`);
    for (const [k, v] of entries) {
      const t = info.fields.find((f) => f.name === k)!.type;
      c.line(`assert event_${i}.${k} == ${pyValue(v, t, vctx)}`);
    }
  });
}

function recordAsserts(c: Code, target: string, rec: Record<string, unknown>, types: Map<string, Type>, vctx: ValueContext): void {
  for (const [k, v] of Object.entries(rec)) {
    const t = types.get(k)!;
    const expected = pyValue(v, t, vctx);
    c.line(expected === "None" ? `assert ${target}.${k} is None` : `assert ${target}.${k} == ${expected}`);
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
    content: assemble(L.model, `Scenarios of aggregate ${ag.name} (${L.ca.ir.name}).`, imp, c.toString()),
  };
}

function importError(L: Layout, imp: Imports, name: string): void {
  if (name === "ConstraintViolation" || name === "AggregateNotFound") imp.from(L.runtime, name);
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

export function useCaseTestFile(L: Layout, uc: UseCaseIR): PyFile | undefined {
  if (!uc.scenarios.length) return undefined;
  const imp = new Imports();
  imp.from("__future__", "annotations");
  const vctx: ValueContext = { imports: imp, typeModule: L.typeModule, fieldTypes: L.ca.fieldTypes };
  const c = new Code();
  for (const sc of uc.scenarios) useCaseScenario(L, c, uc, sc, imp, vctx);
  return { path: L.testPath(uc.name), content: assemble(L.model, `Scenarios of use case ${uc.name} (${L.ca.ir.name}).`, imp, c.toString()) };
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
    const params = depParams(deps);
    c.line(`use_case = ${cls}(${params.map((p) => `${p.name}=${p.name}`).join(", ")})`);
    const cmd = construct(uc.command, sc.when.input, L.fieldTypes(uc.command), vctx);
    c.line(`command = ${cmd}`);
    if (then.raises) {
      imp.import("pytest");
      importError(L, imp, then.raises);
      c.line(`with pytest.raises(${then.raises}):`);
      c.indent(() => c.line("use_case.execute(command)"));
      if (deps.uow) {
        c.line("assert not unit_of_work.committed");
        c.line("assert unit_of_work.rolled_back");
      }
    } else if (info.returnType) {
      c.line("result = use_case.execute(command)");
      if (then.hasReturns) c.line(`assert result == ${pyValue(then.returns, info.returnType, vctx)}`);
      if (deps.uow) c.line("assert unit_of_work.committed");
    } else {
      c.line("use_case.execute(command)");
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
  });
}
