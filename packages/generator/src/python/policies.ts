import { formatPath, type Analysis, type PolicyInfo, type PolicyIR, type RelationshipIR, type TExpr, type Type, type UseCaseIR } from "@ddd/core";
import type { PyFile } from "./domain.ts";
import { assemble, ModuleImports, type Layout } from "./layout.ts";
import { assertEquals, Code, emitExpr, Imports, pascal, pyString, pyValue, toSnake, type ValueContext } from "./support.ts";

/**
 * Policies (event → use case reactions) of one context:
 * - application/policies.py: a handler class per policy, a `subscriptions()` registry for an event bus,
 *   and for anticorruption layers a translator protocol (implemented in the extensions package).
 * - tests/generated/test_<context>_policies.py: each policy maps its event onto the use case input.
 */

interface Resolved {
  policy: PolicyIR;
  info: PolicyInfo;
  useCase: UseCaseIR;
}

function resolved(L: Layout): Resolved[] {
  return L.ca.ir.policies.flatMap((policy) => {
    const info = L.ca.policies.get(policy.name);
    const useCase = L.ca.ir.useCases.find((u) => u.name === policy.run);
    return info && useCase ? [{ policy, info, useCase }] : [];
  });
}

export const policyClass = (p: PolicyIR) => `${pascal(p.name)}Policy`;
const runnerClass = (uc: UseCaseIR) => `${pascal(uc.name)}Runner`;
const translatorProtocol = (upstream: string) => `${upstream}Translator`;
const isAcl = (r: Resolved) => r.info.crossContext && r.info.relationship?.pattern === "anticorruption_layer";

/** Python reference to the consumed event class; upstream events are imported as a module alias (no name clashes). */
function eventClass(L: Layout, info: PolicyInfo, imp: Imports): string {
  if (!info.crossContext) {
    imp.from(L.mod("events"), info.event.name);
    return info.event.name;
  }
  const alias = `${toSnake(info.event.context)}_events`;
  const mod = L.eventsOf(info.event.context);
  imp.from(mod.slice(0, mod.lastIndexOf(".")), `events as ${alias}`);
  return `${alias}.${info.event.name}`;
}

/** Constructor keywords of a policy handler, in a stable order (shared with the tests). */
function deps(r: Resolved): { name: string; type: string }[] {
  const out = [{ name: "use_case", type: runnerClass(r.useCase) }];
  if (r.info.usesClock) out.push({ name: "clock", type: "Clock" });
  if (r.info.usesIds) out.push({ name: "ids", type: "IdGenerator" });
  if (isAcl(r)) out.push({ name: "translator", type: translatorProtocol(r.info.event.context) });
  return out;
}

function argExpr(L: Layout, p: PolicyIR, input: string): TExpr {
  const e = L.ca.exprs.get(formatPath([...p.path, "args", input]));
  if (!e) throw new Error(`missing typed policy argument ${p.name}.${input}`);
  return e;
}

/** `Command(a=event.x, b=self._clock.now())` built from the policy's args (inputs without an arg keep their default). */
function commandCall(L: Layout, r: Resolved, imp: Imports): string {
  imp.from(L.mod("commands"), r.useCase.command);
  const args = r.useCase.input
    .filter((f) => r.policy.args[f.name] !== undefined)
    .map((f) => `${f.name}=${emitExpr(argExpr(L, r.policy, f.name), L.exprCtx(imp, "self", { ports: { clock: "self._clock", ids: "self._ids", extensions: "self._extensions" } }))}`);
  return `${r.useCase.command}(${args.join(", ")})`;
}

function describeRelationship(rel: RelationshipIR | undefined, info: PolicyInfo): string {
  if (!info.crossContext) return "this context";
  return `${info.event.context}, ${rel?.pattern ?? "customer_supplier"}`;
}

export function policiesFile(L: Layout): PyFile | undefined {
  const all = resolved(L);
  if (!all.length) return undefined;
  const mod = L.policies;
  const imp = new ModuleImports(mod);
  imp.from(L.runtime, "DomainEvent", "EventHandler");
  const c = new Code();

  const runners = [...new Map(all.map((r) => [r.useCase.name, r.useCase])).values()];
  imp.from("typing", "Protocol");
  for (const uc of runners) {
    imp.from(L.mod("commands"), uc.command);
    c.line().line();
    c.line(`class ${runnerClass(uc)}(Protocol):`);
    c.indent(() => {
      c.docstring(`What a policy needs from use case \`${uc.name}\` (${pascal(uc.name)}UseCase satisfies it).`);
      c.line();
      c.line(`def execute(self, command: ${uc.command}) -> object: ...`);
    });
  }

  // Anticorruption layers: one translator protocol per upstream context.
  const upstreams = [...new Set(all.filter(isAcl).map((r) => r.info.event.context))].sort();
  for (const up of upstreams) {
    const acl = all.filter((r) => isAcl(r) && r.info.event.context === up);
    c.line().line();
    c.line(`class ${translatorProtocol(up)}(Protocol):`);
    c.indent(() => {
      c.docstring(
        `Anticorruption layer from ${up} (upstream) into ${L.ca.ir.name}.\n\nReceives the upstream event and the command built from the model's args, and returns the command to run.\nImplement it in the extensions package (extensions/${L.ctxModule}/translators.py); the generator never overwrites it.`,
      );
      for (const r of acl) {
        c.line();
        c.line(`def ${r.policy.name}(self, event: ${eventClass(L, r.info, imp)}, command: ${r.useCase.command}) -> ${r.useCase.command}: ...`);
      }
    });
    c.line().line();
    c.line(`class PassThrough${translatorProtocol(up)}:`);
    c.indent(() => {
      c.docstring(`${translatorProtocol(up)} that keeps the command built from the model (used by the generated tests).`);
      for (const r of acl) {
        c.line();
        c.line(`def ${r.policy.name}(self, event: ${eventClass(L, r.info, imp)}, command: ${r.useCase.command}) -> ${r.useCase.command}:`);
        c.indent(() => c.line("return command"));
      }
    });
  }

  for (const r of all) {
    const p = r.policy;
    const ev = eventClass(L, r.info, imp);
    const params = deps(r);
    for (const d of params) if (d.type === "Clock" || d.type === "IdGenerator") imp.from(L.ports, d.type);
    c.line().line();
    c.line(`class ${policyClass(p)}:`);
    c.indent(() => {
      const args = r.useCase.input.filter((f) => p.args[f.name] !== undefined).map((f) => `${f.name}=${p.args[f.name]}`);
      c.docstring(
        [
          p.description ?? `Policy ${p.name}.`,
          "",
          `When: ${r.info.crossContext ? `${r.info.event.context}.` : ""}${r.info.event.name} (${describeRelationship(r.info.relationship, r.info)})`,
          `Run: ${r.useCase.name}`,
          ...(args.length ? [`Args: ${args.join(", ")}`] : []),
          ...(isAcl(r) ? [`Translated by: ${translatorProtocol(r.info.event.context)}.${p.name}`] : []),
        ].join("\n"),
      );
      c.line();
      imp.from("typing", "ClassVar");
      c.line(`event_type: ClassVar[type[${ev}]] = ${ev}`);
      c.line();
      c.line(`def __init__(self, *${params.map((d) => `, ${d.name}: ${d.type}`).join("")}) -> None:`);
      c.indent(() => {
        for (const d of params) c.line(`self._${d.name} = ${d.name}`);
      });
      c.line();
      c.line(`def handle(self, event: ${ev}) -> None:`);
      c.indent(() => {
        c.docstring(`Runs ${r.useCase.name} for one ${r.info.event.name}.`);
        c.line(`command = ${commandCall(L, r, imp)}`);
        if (isAcl(r)) c.line(`command = self._translator.${p.name}(event, command)`);
        c.line("self._use_case.execute(command)");
      });
      c.line();
      c.line("def __call__(self, event: DomainEvent) -> None:");
      c.indent(() => {
        c.docstring("Event bus entry point (EventHandler).");
        c.line(`if not isinstance(event, ${ev}):`);
        c.indent(() => c.line(`raise TypeError(f"{type(self).__name__} handles ${r.info.event.name}, not {type(event).__name__}")`));
        c.line("self.handle(event)");
      });
    });
  }

  c.line().line();
  c.line(`def subscriptions(*${all.map((r) => `, ${r.policy.name}: ${policyClass(r.policy)}`).join("")}) -> dict[type[DomainEvent], tuple[EventHandler, ...]]:`);
  c.indent(() => {
    c.docstring(
      `Event type → policies of ${L.ca.ir.name}. Register them with your event bus, or call\n_runtime.dispatch(subscriptions(...), events) for in-process delivery.`,
    );
    const byEvent = new Map<string, string[]>();
    for (const r of all) {
      const ev = eventClass(L, r.info, imp);
      byEvent.set(ev, [...(byEvent.get(ev) ?? []), r.policy.name]);
    }
    c.line("return {");
    c.indent(() => {
      for (const [ev, names] of byEvent) c.line(`${ev}: (${names.join(", ")}${names.length === 1 ? "," : ""}),`);
    });
    c.line("}");
  });
  return { path: L.path(mod), content: assemble(L.model, `Policies (reactions to domain events) of the ${L.ca.ir.name} context.`, imp, c.toString()) };
}

/** Customer-owned implementation of the anticorruption layers, created once. */
export function translatorScaffolds(L: Layout): PyFile | undefined {
  const acl = resolved(L).filter(isAcl);
  if (!acl.length) return undefined;
  const imp = new ModuleImports("__scaffold__");
  const c = new Code();
  const upstreams = [...new Set(acl.map((r) => r.info.event.context))].sort();
  for (const up of upstreams) {
    imp.from(L.policies, translatorProtocol(up));
    c.line().line();
    c.line(`class From${up}:`);
    c.indent(() => {
      c.docstring(
        `Anticorruption layer: translates what ${up} publishes into the language of ${L.ca.ir.name}.\n\nThis file was created once by DDD Presenter and belongs to you; it is never overwritten.`,
      );
      for (const r of acl.filter((x) => x.info.event.context === up)) {
        imp.from(L.mod("commands"), r.useCase.command);
        c.line();
        c.line(`def ${r.policy.name}(self, event: ${eventClass(L, r.info, imp)}, command: ${r.useCase.command}) -> ${r.useCase.command}:`);
        c.indent(() => {
          c.docstring(`${r.policy.description ?? r.policy.name}\n\n\`command\` is built from the model's args; adjust or replace it here.`);
          c.line("return command");
        });
      }
    });
  }
  c.line().line();
  c.line("# Static check that the classes satisfy the generated protocols (verified by mypy).");
  for (const up of upstreams) c.line(`_conforms_${toSnake(up)}: ${translatorProtocol(up)} = From${up}()`);
  const content = assemble(L.model, undefined, imp, c.toString(), { exports: false }).replace(
    /^# Generated by[^\n]*\n# Regenerate[^\n]*\n\n/,
    "# Created by DDD Presenter as a starting point. This file is yours to edit.\n\n",
  );
  return { path: `${L.model.generation.srcDir}/${L.pkg}/extensions/${L.ctxModule}/translators.py`, content };
}

// ---------------------------------------------------------------------------
// Generated tests
// ---------------------------------------------------------------------------

const SAMPLE_ID = "00000000-0000-0000-0000-00000000e001";
const SAMPLE_NOW = "2026-01-01T10:00:00+00:00";

/** A literal sample for an event field (events carry values only, so no entities/aggregates occur here). */
function sampleValue(t: Type, name: string, fieldTypes: (owner: string) => Map<string, Type>, enumValues: (e: string) => string[], depth = 0): unknown {
  if (t.k === "optional") return sampleValue(t.inner, name, fieldTypes, enumValues, depth);
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String":
          return name.includes("email") ? "user@example.com" : `sample ${name}`;
        case "Integer":
          return 1;
        case "Decimal":
          return "1.00";
        case "Boolean":
          return true;
        case "UUID":
          return "00000000-0000-0000-0000-0000000000e1";
        case "DateTime":
          return "2026-01-02T09:00:00+00:00";
        case "Date":
          return "2026-01-02";
      }
      break;
    case "ref":
      return "00000000-0000-0000-0000-0000000000e2";
    case "enum":
      return enumValues(t.name)[0];
    case "list":
      return depth > 2 ? [] : [sampleValue(t.item, name, fieldTypes, enumValues, depth + 1)];
    case "vo":
    case "entity": {
      const out: Record<string, unknown> = {};
      for (const [k, ft] of fieldTypes(t.name)) if (ft.k !== "optional" || depth < 2) out[k] = sampleValue(ft, `${name}.${k}`, fieldTypes, enumValues, depth + 1);
      return out;
    }
  }
  return null;
}

/**
 * Python literal for a sample value. Value objects are built with `model_construct` so the samples never trip
 * their constraints: the test is about the mapping, not about the upstream's rules.
 */
function samplePy(v: unknown, t: Type, vctx: ValueContext, typeModule: (kind: "vo" | "entity" | "enum", name: string) => string): string {
  if (t.k === "optional") return v === null || v === undefined ? "None" : samplePy(v, t.inner, vctx, typeModule);
  if (t.k === "list") {
    const items = (v as unknown[]).map((x) => samplePy(x, t.item, vctx, typeModule));
    return items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
  }
  if (t.k === "vo" || t.k === "entity") {
    vctx.imports.from(typeModule(t.k, t.name), t.name);
    const fields = vctx.fieldTypes.get(t.name) ?? new Map<string, Type>();
    const rec = v as Record<string, unknown>;
    return `${t.name}.model_construct(${[...fields.entries()].filter(([k]) => k in rec).map(([k, ft]) => `${k}=${samplePy(rec[k], ft, vctx, typeModule)}`).join(", ")})`;
  }
  if (t.k === "enum") {
    vctx.imports.from(typeModule("enum", t.name), t.name);
    return `${t.name}.${String(v).toUpperCase()}`;
  }
  return pyValue(v, t, vctx);
}

export function policyTestFile(L: Layout, analysis: Analysis): PyFile | undefined {
  const all = resolved(L);
  if (!all.length) return undefined;
  const imp = new Imports();
  imp.from("__future__", "annotations");
  const c = new Code();

  // Recording doubles: one per use case, satisfying the generated runner protocol.
  const runners = [...new Map(all.map((r) => [r.useCase.name, r.useCase])).values()];
  for (const uc of runners) {
    imp.from(L.mod("commands"), uc.command);
    c.line().line();
    c.line(`class Recording${pascal(uc.name)}:`);
    c.indent(() => {
      c.docstring(`Stands in for use case ${uc.name} and records the commands it receives.`);
      c.line();
      c.line("def __init__(self) -> None:");
      c.indent(() => c.line(`self.commands: list[${uc.command}] = []`));
      c.line();
      c.line(`def execute(self, command: ${uc.command}) -> None:`);
      c.indent(() => c.line("self.commands.append(command)"));
    });
  }

  /** Lines that build the policy (with its test doubles) under `var`, and the sample event under `event_var`. */
  const arrange = (r: Resolved, suffix: string): { lines: string[]; event: string; asserts: string[] } => {
    const lines: string[] = [];
    const up = analysis.contexts.get(r.info.event.context)!;
    const upL = { typeModule: (kind: "vo" | "entity" | "enum", _name: string) => `${L.eventsOf(r.info.event.context).replace(/\.events$/, "")}.${kind === "vo" ? "value_objects" : kind === "enum" ? "enums" : "entities"}` };
    const vctx: ValueContext = { imports: imp, typeModule: L.typeModule, fieldTypes: up.fieldTypes };
    const info = up.events.get(r.info.event.name)!;
    const sample: Record<string, unknown> = {};
    const fieldTypes = (owner: string) => up.fieldTypes.get(owner) ?? new Map<string, Type>();
    const enumValues = (e: string) => up.ir.enums.find((x) => x.name === e)?.values ?? [];
    for (const f of info.fields) sample[f.name] = sampleValue(f.type, f.name, fieldTypes, enumValues);
    const ev = eventClass(L, r.info, imp);
    lines.push(`use_case${suffix} = Recording${pascal(r.useCase.name)}()`);
    const kw = [`use_case=use_case${suffix}`];
    if (r.info.usesClock) {
      imp.from(L.testing, "FixedClock");
      imp.from("datetime", "datetime");
      lines.push(`clock${suffix} = FixedClock(datetime.fromisoformat(${pyString(SAMPLE_NOW)}))`);
      kw.push(`clock=clock${suffix}`);
    }
    const ids: string[] = [];
    if (r.info.usesIds) {
      imp.from(L.testing, "SequentialIds");
      imp.from("uuid", "UUID");
      const n = r.useCase.input.filter((f) => r.policy.args[f.name] !== undefined && argExpr(L, r.policy, f.name).t === "port").length || 1;
      for (let i = 0; i < n; i++) ids.push(SAMPLE_ID.slice(0, -1) + String(i + 1));
      lines.push(`ids${suffix} = SequentialIds([${ids.map((id) => `UUID(${pyString(id)})`).join(", ")}])`);
      kw.push(`ids=ids${suffix}`);
    }
    if (isAcl(r)) {
      imp.from(L.policies, `PassThrough${translatorProtocol(r.info.event.context)}`);
      kw.push(`translator=PassThrough${translatorProtocol(r.info.event.context)}()`);
    }
    imp.from(L.policies, policyClass(r.policy));
    lines.push(`policy${suffix} = ${policyClass(r.policy)}(${kw.join(", ")})`);
    const payload = info.fields.map((f) => `${f.name}=${samplePy(sample[f.name], f.type, { ...vctx }, (k, n) => (r.info.crossContext ? upL.typeModule(k, n) : L.typeModule(k, n)))}`);
    lines.push(`event${suffix} = ${ev}(${payload.join(", ")})`);

    // Expected command fields: event paths navigate the sample; ports and literals are re-emitted.
    const asserts: string[] = [];
    let idIndex = 0;
    for (const f of r.useCase.input) {
      if (r.policy.args[f.name] === undefined) continue;
      const e = argExpr(L, r.policy, f.name);
      let expected: string;
      if (e.t === "field" || (e.t === "local" && e.name === "event")) {
        const segs: string[] = [];
        for (let x: TExpr | undefined = e; x && x.t === "field"; x = x.owner) segs.unshift(x.name);
        let v: unknown = sample;
        for (const s of segs) v = (v as Record<string, unknown>)[s];
        expected = samplePy(v, e.type, { ...vctx }, (k, n) => (r.info.crossContext ? upL.typeModule(k, n) : L.typeModule(k, n)));
      } else if (e.t === "port" && e.port === "ids") {
        expected = `UUID(${pyString(ids[idIndex++]!)})`;
      } else {
        expected = emitExpr(e, L.exprCtx(imp, "self", { ports: { clock: `clock${suffix}`, ids: `ids${suffix}`, extensions: "extensions" } }));
      }
      asserts.push(assertEquals(`command${suffix}.${f.name}`, expected));
    }
    return { lines, event: `event${suffix}`, asserts };
  };

  for (const r of all) {
    const p = r.policy;
    c.line().line();
    c.line(`def test_${p.name}() -> None:`);
    c.indent(() => {
      c.docstring(
        [
          p.description ?? `Policy ${p.name}.`,
          "",
          `Given: a ${r.info.crossContext ? `${r.info.event.context}.` : ""}${r.info.event.name} event`,
          `When: the policy handles it`,
          `Then: ${r.useCase.name} runs once with the input mapped from the event`,
        ].join("\n"),
      );
      const a = arrange(r, "");
      c.lines_(a.lines);
      c.line(`policy.handle(${a.event})`);
      c.line("assert len(use_case.commands) == 1");
      if (a.asserts.length) c.line("command = use_case.commands[0]");
      c.lines_(a.asserts);
    });
  }

  c.line().line();
  c.line(`def test_${L.ctxModule}_subscriptions_route_each_event_to_its_policies() -> None:`);
  c.indent(() => {
    c.docstring("Dispatching the events through subscriptions() reaches every policy exactly once.");
    imp.from(L.runtime, "dispatch");
    imp.from(L.policies, "subscriptions");
    const events: string[] = [];
    all.forEach((r, i) => {
      const a = arrange(r, `_${i}`);
      c.lines_(a.lines);
      events.push(a.event);
    });
    c.line(`registry = subscriptions(${all.map((r, i) => `${r.policy.name}=policy_${i}`).join(", ")})`);
    // Each distinct event instance once; a policy sharing an event type also sees the other samples of that type.
    c.line(`dispatch(registry, [${events.join(", ")}])`);
    all.forEach((r, i) => {
      const sameType = all.filter((x) => x.info.event.context === r.info.event.context && x.info.event.name === r.info.event.name).length;
      const shared = runnersSharing(all, r);
      c.line(`assert len(use_case_${i}.commands) == ${sameType}${shared ? `  # ${shared}` : ""}`);
    });
  });
  return {
    path: L.testPath("policies"),
    content: assemble(L.model, `Policies of the ${L.ca.ir.name} context: each reaction maps its event onto the use case input.`, imp, c.toString(), { exports: false }),
  };
}

function runnersSharing(all: Resolved[], r: Resolved): string | undefined {
  const n = all.filter((x) => x.info.event.context === r.info.event.context && x.info.event.name === r.info.event.name).length;
  return n > 1 ? `every ${r.info.event.name} sample reaches this policy` : undefined;
}
