import { formatPath, type Analysis, type PolicyInfo, type PolicyIR, type RelationshipIR, type TExpr, type Type, type UseCaseIR } from "@ddd/core";
import { assemble, Code, SCAFFOLD_HEADER, TsImports, tsString } from "./code.ts";
import { entry, eventType, file, type TsFile } from "./domain.ts";
import { emitExpr, type ExprContext } from "./expr.ts";
import { TsLayout } from "./layout.ts";
import { camel, pascal, prop, toSnake } from "./names.ts";
import { testFile } from "./tests.ts";
import { comparesByIdentity } from "./values.ts";

/**
 * Policies (event → use case reactions) of one context:
 * - application/policies.ts: a handler class per policy, a `subscriptions()` registry for an event bus,
 *   and for anticorruption layers a translator interface (implemented in the extensions directory).
 * - tests/generated/<context>-policies.test.ts: each policy maps its event onto the use case input.
 */

interface Resolved {
  policy: PolicyIR;
  info: PolicyInfo;
  useCase: UseCaseIR;
}

function resolved(L: TsLayout): Resolved[] {
  return L.ca.ir.policies.flatMap((policy) => {
    const info = L.ca.policies.get(policy.name);
    const useCase = L.ca.ir.useCases.find((u) => u.name === policy.run);
    return info && useCase ? [{ policy, info, useCase }] : [];
  });
}

export const policyClass = (p: PolicyIR) => `${pascal(p.name)}Policy`;
const runnerInterface = (uc: UseCaseIR) => `${pascal(uc.name)}Runner`;
const translatorInterface = (upstream: string) => `${upstream}Translator`;
const isAcl = (r: Resolved) => r.info.crossContext && r.info.relationship?.pattern === "anticorruption_layer";

/** TypeScript reference to the consumed event; upstream events come through a namespace import (no name clashes). */
function eventRef(L: TsLayout, info: PolicyInfo, imp: TsImports): string {
  if (!info.crossContext) {
    imp.value(L.mod("events"), info.event.name);
    return info.event.name;
  }
  const alias = `${camel(toSnake(info.event.context))}Events`;
  imp.namespace(L.eventsOf(info.event.context), alias);
  return `${alias}.${info.event.name}`;
}

/** Constructor dependencies of a policy handler, in a stable order (shared with the tests). */
function deps(r: Resolved): { name: string; type: string }[] {
  const out = [{ name: "useCase", type: runnerInterface(r.useCase) }];
  if (r.info.usesClock) out.push({ name: "clock", type: "Clock" });
  if (r.info.usesIds) out.push({ name: "ids", type: "IdGenerator" });
  if (isAcl(r)) out.push({ name: "translator", type: translatorInterface(r.info.event.context) });
  return out;
}

function argExpr(L: TsLayout, p: PolicyIR, input: string): TExpr {
  const e = L.ca.exprs.get(formatPath([...p.path, "args", input]));
  if (!e) throw new Error(`missing typed policy argument ${p.name}.${input}`);
  return e;
}

function exprCtx(L: TsLayout, imp: TsImports, ports: { clock: string; ids: string }): ExprContext {
  return { L, imports: imp, self: "this", fixedLocals: new Set(["event"]), ports: { ...ports, extensions: "this.#extensions" } };
}

/** `Command.create({ a: event.x, b: this.#clock.now() })` from the policy's args (other inputs keep their default). */
function commandCall(L: TsLayout, r: Resolved, imp: TsImports): string {
  imp.value(L.mod("commands"), r.useCase.command);
  const ctx = exprCtx(L, imp, { clock: "this.#clock", ids: "this.#ids" });
  const args = r.useCase.input.filter((f) => r.policy.args[f.name] !== undefined).map((f) => entry(prop(f.name), emitExpr(argExpr(L, r.policy, f.name), ctx)));
  return `${r.useCase.command}.create(${args.length ? `{ ${args.join(", ")} }` : "{}"})`;
}

function describeRelationship(rel: RelationshipIR | undefined, info: PolicyInfo): string {
  if (!info.crossContext) return "this context";
  return `${info.event.context}, ${rel?.pattern ?? "customer_supplier"}`;
}

export function policiesFile(L: TsLayout): TsFile | undefined {
  const all = resolved(L);
  if (!all.length) return undefined;
  const mod = L.policies;
  const imp = new TsImports(mod);
  imp.type(L.runtime, "EventHandler", "Subscriptions");
  const c = new Code();

  const runners = [...new Map(all.map((r) => [r.useCase.name, r.useCase])).values()];
  for (const uc of runners) {
    imp.type(L.mod("commands"), uc.command);
    c.line();
    c.doc(`What a policy needs from use case \`${uc.name}\` (${pascal(uc.name)}UseCase satisfies it).`);
    c.block(`export interface ${runnerInterface(uc)}`, () => c.line(`execute(command: ${uc.command}): Promise<unknown>;`));
  }

  // Anticorruption layers: one translator interface per upstream context.
  const upstreams = [...new Set(all.filter(isAcl).map((r) => r.info.event.context))].sort();
  for (const up of upstreams) {
    const acl = all.filter((r) => isAcl(r) && r.info.event.context === up);
    imp.type(L.runtime, "Awaitable");
    c.line();
    c.doc(
      `Anticorruption layer from ${up} (upstream) into ${L.ca.ir.name}.\n\nReceives the upstream event and the command built from the model's args, and returns the command to run. Implement it in the extensions directory (extensions/${L.ctxDir}/translators.ts); the generator never overwrites it.`,
    );
    c.block(`export interface ${translatorInterface(up)}`, () => {
      for (const r of acl) {
        c.line(`${prop(r.policy.name)}(event: ${eventRef(L, r.info, imp)}, command: ${r.useCase.command}): Awaitable<${r.useCase.command}>;`);
      }
    });
    c.line();
    c.doc(`${translatorInterface(up)} that keeps the command built from the model (used by the generated tests).`);
    c.block(`export class PassThrough${translatorInterface(up)} implements ${translatorInterface(up)}`, () => {
      acl.forEach((r, i) => {
        if (i) c.line();
        c.block(`${prop(r.policy.name)}(_event: ${eventRef(L, r.info, imp)}, command: ${r.useCase.command}): ${r.useCase.command}`, () => c.line("return command;"));
      });
    });
  }

  for (const r of all) {
    const p = r.policy;
    const ev = eventRef(L, r.info, imp);
    const params = deps(r);
    for (const d of params) if (d.type === "Clock" || d.type === "IdGenerator") imp.type(L.runtime, d.type);
    c.line();
    const args = r.useCase.input.filter((f) => p.args[f.name] !== undefined).map((f) => `${f.name}=${p.args[f.name]}`);
    c.doc(
      [
        p.description ?? `Policy ${p.name}.`,
        "",
        `When: ${r.info.crossContext ? `${r.info.event.context}.` : ""}${r.info.event.name} (${describeRelationship(r.info.relationship, r.info)})`,
        `Run: ${r.useCase.name}`,
        ...(args.length ? [`Args: ${args.join(", ")}`] : []),
        ...(isAcl(r) ? [`Translated by: ${translatorInterface(r.info.event.context)}.${prop(p.name)}`] : []),
      ].join("\n"),
    );
    c.block(`export class ${policyClass(p)}`, () => {
      c.line(`static readonly eventType = ${ev}.type;`);
      for (const d of params) c.line(`readonly #${d.name}: ${d.type};`);
      c.line();
      c.block(`constructor(deps: { ${params.map((d) => `readonly ${d.name}: ${d.type}`).join("; ")} })`, () => {
        for (const d of params) c.line(`this.#${d.name} = deps.${d.name};`);
      });
      c.line();
      c.doc(`Runs ${r.useCase.name} for one ${r.info.event.name}.`);
      const call = commandCall(L, r, imp);
      // `_event`: the command takes nothing from the event (TypeScript's convention for an unused parameter).
      const eventParam = isAcl(r) || /\bevent\b/.test(call) ? "event" : "_event";
      c.block(`async handle(${eventParam}: ${ev}): Promise<void>`, () => {
        if (isAcl(r)) {
          c.line(`const command = await this.#translator.${prop(p.name)}(event, ${call});`);
        } else {
          c.line(`const command = ${call};`);
        }
        c.line("await this.#useCase.execute(command);");
      });
      c.line();
      c.doc("Event bus entry point (EventHandler).");
      c.block("readonly onEvent: EventHandler = async (event) =>", () => {
        c.line(`if (!${ev}.is(event)) throw new TypeError(${tsString(`${policyClass(p)} handles ${eventType(r.info.event.context, r.info.event.name)}, not `)} + event.type);`);
        c.line("await this.handle(event);");
      }, ";");
    });
  }

  c.line();
  c.doc(`Event type → policies of ${L.ca.ir.name}. Register them with your event bus, or call\n\`dispatch(subscriptions({...}), events)\` (runtime.ts) for in-process delivery.`);
  c.block(`export function subscriptions(policies: { ${all.map((r) => `readonly ${prop(r.policy.name)}: ${policyClass(r.policy)}`).join("; ")} }): Subscriptions`, () => {
    const byEvent = new Map<string, string[]>();
    for (const r of all) {
      const ev = eventRef(L, r.info, imp);
      byEvent.set(ev, [...(byEvent.get(ev) ?? []), prop(r.policy.name)]);
    }
    c.line("return new Map<string, ReadonlyArray<EventHandler>>([");
    c.indent(() => {
      for (const [ev, names] of byEvent) c.line(`[${ev}.type, [${names.map((n) => `policies.${n}.onEvent`).join(", ")}]],`);
    });
    c.line("]);");
  });
  return file(L, mod, `Policies (reactions to domain events) of the ${L.ca.ir.name} context.`, imp, c.toString());
}

/** Customer-owned implementation of the anticorruption layers, created once. */
export function translatorScaffold(L: TsLayout): TsFile | undefined {
  const acl = resolved(L).filter(isAcl);
  if (!acl.length) return undefined;
  const module = L.extensions(L.ca.ir.name, "translators");
  const imp = new TsImports(module);
  const c = new Code();
  const upstreams = [...new Set(acl.map((r) => r.info.event.context))].sort();
  for (const up of upstreams) {
    imp.type(L.policies, translatorInterface(up));
    c.line();
    c.doc(
      `Anticorruption layer: translates what ${up} publishes into the language of ${L.ca.ir.name}.\n\nThis file was created once by DDD Presenter and belongs to you; it is never overwritten.`,
    );
    c.block(`export class From${up} implements ${translatorInterface(up)}`, () => {
      acl.filter((x) => x.info.event.context === up).forEach((r, i) => {
        imp.type(L.mod("commands"), r.useCase.command);
        if (i) c.line();
        c.doc(`${r.policy.description ?? r.policy.name}\n\n\`command\` is built from the model's args; adjust or replace it here.`);
        c.block(`${prop(r.policy.name)}(_event: ${eventRef(L, r.info, imp)}, command: ${r.useCase.command}): ${r.useCase.command}`, () => c.line("return command;"));
      });
    });
  }
  return { path: L.file(module), content: assemble(SCAFFOLD_HEADER, undefined, imp, c.toString()) };
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
 * A typed literal for a sample value. Value objects are written as plain object literals (not through their schema)
 * so the samples never trip their constraints: the test is about the mapping, not about the upstream's rules.
 */
function sampleLiteral(v: unknown, t: Type, U: TsLayout, imp: TsImports): string {
  if (t.k === "optional") return v === null || v === undefined ? "null" : sampleLiteral(v, t.inner, U, imp);
  switch (t.k) {
    case "primitive":
      switch (t.name) {
        case "String":
          return tsString(String(v));
        case "Integer":
          return String(v);
        case "Boolean":
          return v ? "true" : "false";
        case "Decimal":
          imp.value(U.runtime, "Decimal");
          return `new Decimal(${tsString(String(v))})`;
        case "UUID":
          imp.value(U.runtime, "uuid");
          return `uuid(${tsString(String(v))})`;
        case "DateTime":
          imp.value(U.runtime, "instant");
          return `instant(${tsString(String(v))})`;
        case "Date":
          imp.value(U.runtime, "localDate");
          return `localDate(${tsString(String(v))})`;
      }
      break;
    case "ref":
      imp.value(U.runtime, "id");
      return `id(${tsString(t.target)}, ${tsString(String(v))})`;
    case "enum":
      imp.value(U.typeModule("enum"), t.name);
      return `${t.name}.${String(v)}`;
    case "list":
      return `[${(v as unknown[]).map((x) => sampleLiteral(x, t.item, U, imp)).join(", ")}]`;
    case "vo":
    case "entity": {
      const rec = v as Record<string, unknown>;
      const fields = [...U.fieldTypes(t.name).entries()].filter(([k]) => k in rec);
      return `{ ${fields.map(([k, ft]) => `${prop(k)}: ${sampleLiteral(rec[k], ft, U, imp)}`).join(", ")} }`;
    }
  }
  throw new Error(`Cannot render a sample of type ${JSON.stringify(t)}`);
}

export function policyTestFile(L: TsLayout, analysis: Analysis): TsFile | undefined {
  const all = resolved(L);
  if (!all.length) return undefined;
  const module = L.testModule("policies");
  const imp = new TsImports(module);
  const c = new Code();

  // Recording doubles: one per use case, satisfying the generated runner interface.
  const runners = [...new Map(all.map((r) => [r.useCase.name, r.useCase])).values()];
  for (const uc of runners) {
    imp.type(L.mod("commands"), uc.command);
    imp.type(L.policies, runnerInterface(uc));
    c.line();
    c.doc(`Stands in for use case ${uc.name} and records the commands it receives.`);
    c.block(`class Recording${pascal(uc.name)} implements ${runnerInterface(uc)}`, () => {
      c.line(`readonly commands: ${uc.command}[] = [];`);
      c.line();
      c.block(`execute(command: ${uc.command}): Promise<void>`, () => {
        c.line("this.commands.push(command);");
        c.line("return Promise.resolve();");
      });
    });
  }

  /** Lines that build the policy (with its test doubles) and the sample event, plus the expected command fields. */
  const arrange = (r: Resolved, suffix: string): { lines: string[]; event: string; asserts: string[] } => {
    const lines: string[] = [];
    const up = analysis.contexts.get(r.info.event.context)!;
    // The upstream layout names the modules of the event's types; imports stay relative to this test file.
    const U = r.info.crossContext ? new TsLayout(L.model, up) : L;
    const info = up.events.get(r.info.event.name)!;
    const sample: Record<string, unknown> = {};
    const fieldTypes = (owner: string) => up.fieldTypes.get(owner) ?? new Map<string, Type>();
    const enumValues = (e: string) => up.ir.enums.find((x) => x.name === e)?.values ?? [];
    for (const f of info.fields) sample[f.name] = sampleValue(f.type, f.name, fieldTypes, enumValues);
    const ev = eventRef(L, r.info, imp);
    lines.push(`const useCase${suffix} = new Recording${pascal(r.useCase.name)}();`);
    const kw = [`useCase: useCase${suffix}`];
    if (r.info.usesClock) {
      imp.value(L.contextTesting, "FixedClock");
      lines.push(`const clock${suffix} = new FixedClock(${tsString(SAMPLE_NOW)});`);
      kw.push(`clock: clock${suffix}`);
    }
    const ids: string[] = [];
    if (r.info.usesIds) {
      imp.value(L.contextTesting, "SequentialIds");
      const n = r.useCase.input.filter((f) => r.policy.args[f.name] !== undefined && argExpr(L, r.policy, f.name).t === "port").length || 1;
      for (let i = 0; i < n; i++) ids.push(SAMPLE_ID.slice(0, -1) + String(i + 1));
      lines.push(`const ids${suffix} = new SequentialIds([${ids.map(tsString).join(", ")}]);`);
      kw.push(`ids: ids${suffix}`);
    }
    if (isAcl(r)) {
      imp.value(L.policies, `PassThrough${translatorInterface(r.info.event.context)}`);
      kw.push(`translator: new PassThrough${translatorInterface(r.info.event.context)}()`);
    }
    imp.value(L.policies, policyClass(r.policy));
    lines.push(`const policy${suffix} = new ${policyClass(r.policy)}({ ${kw.join(", ")} });`);
    const payload = info.fields.map((f) => `${prop(f.name)}: ${sampleLiteral(sample[f.name], f.type, U, imp)}`);
    lines.push(`const event${suffix}: ${ev} = { type: ${ev}.type${payload.length ? `, ${payload.join(", ")}` : ""} };`);

    // Expected command fields: event paths navigate the sample; ports and literals are re-emitted.
    const asserts: string[] = [];
    const commandTypes = L.fieldTypes(r.useCase.command);
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
        expected = sampleLiteral(v, e.type, U, imp);
      } else if (e.t === "port" && e.port === "ids") {
        imp.value(L.runtime, "uuid");
        expected = `uuid(${tsString(ids[idIndex++]!)})`;
      } else {
        expected = emitExpr(e, exprCtx(L, imp, { clock: `clock${suffix}`, ids: `ids${suffix}` }));
      }
      const target = `command${suffix}.${prop(f.name)}`;
      const t = commandTypes.get(f.name) ?? e.type;
      if (expected === "null") asserts.push(`expect(${target}).toBeNull();`);
      else if (comparesByIdentity(t)) asserts.push(`expect(${target}).toBe(${expected});`);
      else {
        imp.value(L.contextTesting, "plain");
        asserts.push(`expect(plain(${target})).toEqual(plain(${expected}));`);
      }
    }
    return { lines, event: `event${suffix}`, asserts };
  };

  c.line();
  c.block(`describe(${tsString(`${L.ca.ir.name} policies`)}, () =>`, () => {
    for (const r of all) {
      const p = r.policy;
      c.doc(
        [
          p.description ?? `Policy ${p.name}.`,
          "",
          `Given: a ${r.info.crossContext ? `${r.info.event.context}.` : ""}${r.info.event.name} event`,
          "When: the policy handles it",
          `Then: ${r.useCase.name} runs once with the input mapped from the event`,
        ].join("\n"),
      );
      c.block(`test(${tsString(p.name)}, async () =>`, () => {
        const a = arrange(r, "");
        c.lines_(a.lines);
        c.line(`await policy.handle(${a.event});`);
        c.line("expect(useCase.commands).toHaveLength(1);");
        imp.value(L.contextTesting, "expectPresent");
        if (a.asserts.length) {
          c.line("const command = expectPresent(useCase.commands[0]);");
          c.lines_(a.asserts);
        } else {
          c.line("expectPresent(useCase.commands[0]);");
        }
      }, ");");
      c.line();
    }
    c.doc("Dispatching the events through subscriptions() reaches every policy exactly once.");
    c.block(`test("subscriptions route each event to its policies", async () =>`, () => {
      imp.value(L.runtime, "dispatch");
      imp.value(L.policies, "subscriptions");
      const events: string[] = [];
      all.forEach((r, i) => {
        const a = arrange(r, `${i}`);
        c.lines_(a.lines);
        events.push(a.event);
      });
      c.line(`const registry = subscriptions({ ${all.map((r, i) => `${prop(r.policy.name)}: policy${i}`).join(", ")} });`);
      // Each distinct event instance once; a policy sharing an event type also sees the other samples of that type.
      c.line(`await dispatch(registry, [${events.join(", ")}]);`);
      all.forEach((r, i) => {
        const sameType = all.filter((x) => x.info.event.context === r.info.event.context && x.info.event.name === r.info.event.name).length;
        if (sameType > 1) c.comment(`every ${r.info.event.name} sample reaches this policy`);
        c.line(`expect(useCase${i}.commands).toHaveLength(${sameType});`);
      });
    }, ");");
  }, ");");
  return testFile(L, module, `Policies of the ${L.ca.ir.name} context: each reaction maps its event onto the use case input.`, imp, c.toString());
}
