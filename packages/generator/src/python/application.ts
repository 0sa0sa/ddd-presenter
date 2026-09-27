import { formatPath, resolveType, type StepIR, type Type, type UseCaseIR } from "@ddd/core";
import { paramTypes, type PyFile } from "./domain.ts";
import { assemble, ModuleImports, type Layout } from "./layout.ts";
import { Code, emitExpr, pascal, pyType, toSnake, type ExprContext, type Imports } from "./support.ts";

export function repoAttr(aggregate: string): string {
  return `${toSnake(aggregate)}_repository`;
}

export function portsFile(L: Layout): PyFile {
  const mod = L.ports;
  const imp = new ModuleImports(mod);
  imp.from("typing", "Protocol");
  const c = new Code();
  for (const ag of L.ca.ir.aggregates) {
    imp.from(L.mod("aggregates"), ag.name);
    const idType = pyType(L.fieldTypes(ag.name).get(ag.identity)!, imp, L.typeModule, { field: false });
    c.line().line();
    c.line(`class ${ag.name}Repository(Protocol):`);
    c.indent(() => {
      c.docstring(`Loads and stores ${ag.name} aggregates. Implemented by an adapter outside the domain.`);
      c.line();
      c.line(`def get(self, ${ag.identity}: ${idType}) -> ${ag.name} | None: ...`);
      c.line();
      c.line(`def save(self, aggregate: ${ag.name}) -> None: ...`);
    });
  }
  imp.from("datetime", "datetime");
  imp.from("uuid", "UUID");
  imp.from("collections.abc", "Sequence");
  imp.from(L.runtime, "DomainEvent");
  c.line().line();
  c.line("class Clock(Protocol):");
  c.indent(() => {
    c.docstring("Source of the current time. Rules never read a hidden global clock.");
    c.line();
    c.line("def now(self) -> datetime: ...");
  });
  c.line().line();
  c.line("class IdGenerator(Protocol):");
  c.indent(() => {
    c.docstring("Source of new identities.");
    c.line();
    c.line("def new_id(self) -> UUID: ...");
  });
  c.line().line();
  c.line("class EventPublisher(Protocol):");
  c.indent(() => {
    c.docstring("Delivers domain events. Reliable delivery (e.g. an outbox) is the adapter's responsibility.");
    c.line();
    c.line("def publish(self, events: Sequence[DomainEvent]) -> None: ...");
  });
  c.line().line();
  c.line("class UnitOfWork(Protocol):");
  c.indent(() => {
    c.docstring("Transaction boundary of a use case.");
    c.line();
    c.line("def commit(self) -> None: ...");
    c.line();
    c.line("def rollback(self) -> None: ...");
  });
  const exts = L.ca.ir.extensionPoints;
  c.line().line();
  c.line("class Extensions(Protocol):");
  c.indent(() => {
    c.docstring(
      exts.length
        ? `Customer-owned extension points of ${L.ca.ir.name}.\n\nImplement this protocol in the extensions package; the generator never overwrites it.`
        : "This context declares no extension points.",
    );
    for (const x of exts) {
      const pt = paramTypes(L, undefined, x.parameters);
      const sig = x.parameters.map((p) => `${p.name}: ${pyType(pt.get(p.name)!, imp, L.typeModule, { field: false })}`).join(", ");
      const rt = pyType(resolveReturn(L, x.returns), imp, L.typeModule, { field: false });
      c.line();
      c.line(`def ${x.name}(self${sig ? `, ${sig}` : ""}) -> ${rt}:`);
      c.indent(() => {
        c.docstring(x.description ?? `Extension point ${x.name}.`);
        c.line("...");
      });
    }
  });
  return { path: L.path(mod), content: assemble(L.model, `Ports (interfaces to the outside world) of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

export function resolveReturn(L: Layout, src: string): Type {
  const r = resolveType(src, { context: L.ca.ir });
  if (!r.ok) throw new Error(`unresolved type ${src}`);
  return r.type;
}

interface Deps {
  repos: string[];
  clock: boolean;
  ids: boolean;
  extensions: boolean;
  publisher: boolean;
  uow: boolean;
}

export function useCaseDeps(L: Layout, uc: UseCaseIR): Deps {
  const info = L.ca.useCases.get(uc.name)!;
  return {
    repos: info.repositories,
    clock: info.usesClock,
    ids: info.usesIds,
    extensions: info.extensions.length > 0,
    publisher: info.publishes.length > 0,
    uow: uc.transaction === "required",
  };
}

/** Constructor keyword names, in a stable order (shared with the test generator). */
export function depParams(d: Deps): { name: string; type: string }[] {
  const out = d.repos.map((r) => ({ name: repoAttr(r), type: `${r}Repository` }));
  if (d.clock) out.push({ name: "clock", type: "Clock" });
  if (d.ids) out.push({ name: "ids", type: "IdGenerator" });
  if (d.extensions) out.push({ name: "extensions", type: "Extensions" });
  if (d.publisher) out.push({ name: "event_publisher", type: "EventPublisher" });
  if (d.uow) out.push({ name: "unit_of_work", type: "UnitOfWork" });
  return out;
}

export function useCasesFile(L: Layout): PyFile {
  const mod = L.useCases;
  const imp = new ModuleImports(mod);
  const c = new Code();
  for (const uc of L.ca.ir.useCases) useCase(L, c, uc, imp);
  if (!L.ca.ir.useCases.length) c.line("# This context declares no use cases.");
  return { path: L.path(mod), content: assemble(L.model, `Use cases (application services) of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

function describeSteps(steps: StepIR[], indent = "    ", counter = { n: 0 }): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const n = ++counter.n;
    const p = `${indent}${n}. `;
    switch (s.kind) {
      case "load":
        out.push(`${p}load ${s.aggregate} by ${s.by} as ${s.as}${s.notFound ? ` (not found: ${s.notFound})` : ""}`);
        break;
      case "create":
        out.push(`${p}create ${s.aggregate} via ${s.factory}(${Object.entries(s.args).map(([k, v]) => `${k}=${v}`).join(", ")}) as ${s.as}`);
        break;
      case "invoke":
        out.push(`${p}${s.target}.${s.operation}(${Object.entries(s.args).map(([k, v]) => `${k}=${v}`).join(", ")})`);
        break;
      case "save":
        out.push(`${p}save ${s.target}`);
        break;
      case "publish":
        out.push(`${p}publish ${s.event}${s.afterCommit ? " after commit" : " immediately"}`);
        break;
      case "fail":
        out.push(`${p}fail with ${s.error}`);
        break;
      case "return":
        out.push(`${p}return ${s.value}`);
        break;
      case "if":
        out.push(`${p}if ${s.condition}:`);
        out.push(...describeSteps(s.then, indent + "    ", counter));
        if (s.else.length) {
          out.push(`${indent}   else:`);
          out.push(...describeSteps(s.else, indent + "    ", counter));
        }
        break;
    }
  }
  return out;
}

function useCase(L: Layout, c: Code, uc: UseCaseIR, imp: Imports): void {
  const info = L.ca.useCases.get(uc.name)!;
  const deps = useCaseDeps(L, uc);
  const params = depParams(deps);
  for (const p of params) imp.from(L.ports, p.type);
  imp.from(L.mod("commands"), uc.command);
  imp.from(L.runtime, "DomainEvent");
  const ret = info.returnType ? pyType(info.returnType, imp, L.typeModule, { field: false }) : "None";
  const cls = `${pascal(uc.name)}UseCase`;
  const inputs = new Set(uc.input.map((f) => f.name));
  const ectx = (): ExprContext =>
    L.exprCtx(imp, "self", { inputs, ports: { clock: "self._clock", ids: "self._ids", extensions: "self._extensions" } });

  c.line().line();
  c.line(`class ${cls}:`);
  c.indent(() => {
    const d = [uc.description ?? `Use case ${uc.name}.`, ""];
    if (uc.actor) d.push(`Actor: ${uc.actor}`);
    d.push(`Transaction: ${uc.transaction}`);
    if (uc.idempotencyKey) d.push(`Idempotency key: ${uc.idempotencyKey}`);
    d.push("", "Steps:", ...describeSteps(uc.steps));
    c.docstring(d.join("\n"));
    c.line();
    c.line(`def __init__(self${params.length ? ", *" : ""}${params.map((p) => `, ${p.name}: ${p.type}`).join("")}) -> None:`);
    c.indent(() => {
      if (!params.length) c.line("pass");
      for (const p of params) c.line(`self._${p.name} = ${p.name}`);
    });
    c.line();
    c.line(`def execute(self, command: ${uc.command}) -> ${ret}:`);
    c.indent(() => {
      c.docstring(
        deps.uow
          ? "Runs the steps in one transaction. Events marked publish_after_commit are published only after a successful commit."
          : "Runs the steps without a transaction boundary.",
      );
      c.line("after_commit: list[DomainEvent] = []");
      const call = `self._run(command, after_commit)`;
      if (deps.uow) {
        c.line("try:");
        c.indent(() => {
          c.line(ret === "None" ? call : `result = ${call}`);
          c.line("self._unit_of_work.commit()");
        });
        c.line("except BaseException:");
        c.indent(() => {
          c.line("self._unit_of_work.rollback()");
          c.line("raise");
        });
      } else {
        c.line(ret === "None" ? call : `result = ${call}`);
      }
      if (deps.publisher && info.publishes.length) {
        c.line("if after_commit:");
        c.indent(() => c.line("self._event_publisher.publish(tuple(after_commit))"));
      }
      if (ret !== "None") c.line("return result");
    });
    c.line();
    c.line(`def _run(self, command: ${uc.command}, after_commit: list[DomainEvent]) -> ${ret}:`);
    c.indent(() => {
      c.line("emitted: list[DomainEvent] = []");
      const counter = { n: 0 };
      emitSteps(L, c, uc.steps, ectx, imp, counter, bindings(uc.steps));
      if (ret === "None" && !endsTerminal(uc.steps)) c.line("return None");
    });
  });
}

function endsTerminal(steps: StepIR[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (last.kind === "return" || last.kind === "fail") return true;
  if (last.kind === "if") return endsTerminal(last.then) && endsTerminal(last.else);
  return false;
}

function emitSteps(L: Layout, c: Code, steps: StepIR[], ectx: () => ExprContext, imp: Imports, counter: { n: number }, vars: Map<string, string>): void {
  const aggregateOf = (v: string) => L.ca.ir.aggregates.find((a) => a.name === vars.get(v));
  const X = (p: (string | number)[]) => {
    const e = L.ca.exprs.get(formatPath(p));
    if (!e) throw new Error(`missing typed expression at ${formatPath(p)}`);
    return emitExpr(e, ectx());
  };
  for (const s of steps) {
    const n = ++counter.n;
    switch (s.kind) {
      case "load": {
        const ag = L.ca.ir.aggregates.find((a) => a.name === s.aggregate)!;
        imp.from(L.mod("aggregates"), ag.name);
        const key = X([...s.path, "by"]);
        c.line(`# ${n}. load ${s.aggregate}`);
        c.line(`${s.as} = self._${repoAttr(ag.name)}.get(${key})`);
        c.line(`if ${s.as} is None:`);
        c.indent(() => {
          if (s.notFound) {
            imp.from(L.mod("errors"), s.notFound);
            c.line(`raise ${s.notFound}(${ag.identity}=${key})`);
          } else {
            imp.from(L.runtime, "AggregateNotFound");
            c.line(`raise AggregateNotFound(aggregate="${ag.name}", ${ag.identity}=${key})`);
          }
        });
        break;
      }
      case "create": {
        imp.from(L.mod("aggregates"), s.aggregate);
        const ag = L.ca.ir.aggregates.find((a) => a.name === s.aggregate)!;
        const f = ag.factories.find((x) => x.name === s.factory)!;
        const args = f.parameters.filter((p) => s.args[p.name] !== undefined).map((p) => `${p.name}=${X([...s.path, "args", p.name])}`);
        c.line(`# ${n}. create ${s.aggregate} via ${s.factory}`);
        c.line(`transition_${n} = ${s.aggregate}.${s.factory}(${args.join(", ")})`);
        c.line(`${s.as} = transition_${n}.aggregate`);
        c.line(`emitted.extend(transition_${n}.events)`);
        break;
      }
      case "invoke": {
        const lookup = aggregateOf(s.target);
        const op = lookup?.operations.find((o) => o.name === s.operation);
        const args = (op?.parameters ?? []).filter((p) => s.args[p.name] !== undefined).map((p) => `${p.name}=${X([...s.path, "args", p.name])}`);
        c.line(`# ${n}. ${s.target}.${s.operation}`);
        c.line(`transition_${n} = ${s.target}.${s.operation}(${args.join(", ")})`);
        c.line(`${s.target} = transition_${n}.aggregate`);
        c.line(`emitted.extend(transition_${n}.events)`);
        break;
      }
      case "save": {
        const ag = aggregateOf(s.target)!;
        c.line(`# ${n}. save ${s.target}`);
        c.line(`self._${repoAttr(ag.name)}.save(${s.target})`);
        break;
      }
      case "publish": {
        imp.from(L.mod("events"), s.event);
        const sel = `(event for event in emitted if isinstance(event, ${s.event}))`;
        c.line(`# ${n}. publish ${s.event}${s.afterCommit ? " after commit" : ""}`);
        if (s.afterCommit) c.line(`after_commit.extend${sel}`);
        else c.line(`self._event_publisher.publish(tuple${sel})`);
        break;
      }
      case "if": {
        c.line(`# ${n}. if ${s.condition}`);
        c.line(`if ${X([...s.path, "condition"])}:`);
        c.indent(() => {
          if (!s.then.length) c.line("pass");
          emitSteps(L, c, s.then, ectx, imp, counter, vars);
        });
        if (s.else.length) {
          c.line("else:");
          c.indent(() => emitSteps(L, c, s.else, ectx, imp, counter, vars));
        }
        break;
      }
      case "fail":
        imp.from(L.mod("errors"), s.error);
        c.line(`# ${n}. fail`);
        c.line(`raise ${s.error}()`);
        break;
      case "return":
        c.line(`# ${n}. return`);
        c.line(`return ${X(s.path)}`);
        break;
    }
  }
}

/** Variable → aggregate bindings of one use case (names are unique within a use case). */
function bindings(steps: StepIR[], out = new Map<string, string>()): Map<string, string> {
  for (const s of steps) {
    if (s.kind === "load" || s.kind === "create") out.set(s.as, s.aggregate);
    if (s.kind === "if") {
      bindings(s.then, out);
      bindings(s.else, out);
    }
  }
  return out;
}
