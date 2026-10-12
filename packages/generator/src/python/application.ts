import { formatPath, leadingLoads, requiresPrincipal, resolveType, usesPermissions, walkExpr, type StepIR, type TExpr, type Type, type UseCaseIR } from "@ddd/core";
import { paramTypes, type PyFile } from "./domain.ts";
import { assemble, ModuleImports, type Layout } from "./layout.ts";
import { Code, emitAs, emitExpr, MAX_LINE, pascal, pyString, pyType, toSnake, type ExprContext, type Imports } from "./support.ts";

import { accessCtx, requirementKwargs, requirementText, rolesTuple, securityModule } from "./security.ts";

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
    if (L.tenantScoped(ag)) {
      imp.from(L.securityModule, "TenantId");
      c.indent(() => {
        c.docstring(
          [
            `Loads and stores ${ag.name} aggregates of one tenant at a time. Implemented by an adapter outside the domain.`,
            "",
            "Every call names the tenant (the use case passes the caller's): `get` returns None for an aggregate of another tenant (the same as a missing one, so nothing leaks), and `save` refuses an aggregate whose `tenant_id` is not `tenant` (TenantMismatch).",
          ].join("\n"),
        );
        c.line();
        c.line(`def get(self, tenant: TenantId, ${ag.identity}: ${idType}) -> ${ag.name} | None: ...`);
        c.line();
        c.line(`def save(self, tenant: TenantId, aggregate: ${ag.name}) -> None: ...`);
      });
      continue;
    }
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
    c.docstring(
      "Source of the current time. Rules never read a hidden global clock.\n\nMust return a timezone-aware datetime (see adapters.SystemClock); model DateTime fields reject naive values.",
    );
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
  if (L.ca.ir.useCases.some((u) => u.idempotencyKey)) {
    imp.from("dataclasses", "dataclass");
    c.line().line();
    c.line("@dataclass(frozen=True)");
    c.line("class RecordedResult:");
    c.indent(() => {
      c.docstring("What an idempotent use case returned for one idempotency key.");
      c.line();
      c.line("value: object");
    });
    c.line().line();
    c.line("class IdempotencyStore(Protocol):");
    c.indent(() => {
      c.docstring(
        [
          "Results of idempotent use cases by key: a repeated command returns the first result instead of running again.",
          "",
          "record() is called inside the use case's transaction, before commit. Store the record in the same transaction as the aggregates, so a rolled-back run leaves none, and make (use_case, key) unique so that two concurrent runs with the same key cannot both commit. Only successful runs are recorded; a failed one may be retried.",
        ].join("\n"),
      );
      c.line();
      c.line("def get(self, use_case: str, key: str) -> RecordedResult | None: ...");
      c.line();
      c.line("def record(self, use_case: str, key: str, result: RecordedResult) -> None: ...");
    });
  }
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
  /** The use case declares an idempotency_key. */
  idempotency: boolean;
  /** Cross-tenant use cases record each access (`CrossTenantAudit`). */
  audit?: boolean;
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
    idempotency: !!uc.idempotencyKey,
    ...(L.scopeOf(uc) === "cross_tenant" ? { audit: true } : {}),
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
  if (d.idempotency) out.push({ name: "idempotency_store", type: "IdempotencyStore" });
  if (d.audit) out.push({ name: "audit", type: "CrossTenantAudit" });
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
      case "let":
        out.push(`${p}let ${s.name} = ${s.value}`);
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
  for (const p of params) imp.from(p.type === "CrossTenantAudit" ? securityModule(L.model) : L.ports, p.type);
  imp.from(L.mod("commands"), uc.command);
  imp.from(L.runtime, "DomainEvent");
  const ret = info.returnType ? pyType(info.returnType, imp, L.typeModule, { field: false }) : "None";
  const cls = `${pascal(uc.name)}UseCase`;
  const inputs = new Set(uc.input.map((f) => f.name));
  const ectx = (): ExprContext =>
    L.exprCtx(imp, "self", { inputs, ports: { clock: "self._clock", ids: "self._ids", extensions: "self._extensions" } });
  const auth = useCaseAuthorization(L, uc);
  const sec = securityModule(L.model);
  const scope = L.scopeOf(uc);
  const rbac = usesPermissions(L.model.security) || !!L.model.security?.tenancy;
  // Where the tenant comes from (docs/09 §22): the caller's token, the command (cross-tenant) or the tenant context of
  // an internal use case (a policy passes its event's tenant).
  const tenantContext = scope === "tenant" && !auth;
  const tenantSource = scope === "tenant" ? (auth ? "tenant" : "context.tenant_id") : scope === "cross_tenant" ? "command.tenant_id" : undefined;
  const ruleCtx = (): ExprContext => (rbac ? { ...ectx(), access: accessCtx(L, scope) } : ectx());
  const emitAllowIf = (rule: TExpr) => {
    imp.from(sec, "allow_if");
    c.line("# authorize: allow_if");
    c.line(`allow_if(${emitExpr(rule, ruleCtx())}, ${pyString(uc.name)})`);
  };
  const runTakesPrincipal = !!auth?.rule && !!auth.after;
  const runTakesTenant = !!tenantSource && touchesTenantRepo(L, uc);

  c.line().line();
  c.line(`class ${cls}:`);
  c.indent(() => {
    const d = [uc.description ?? `Use case ${uc.name}.`, ""];
    if (uc.actor) d.push(`Actor: ${uc.actor}`);
    d.push(`Transaction: ${uc.transaction}`);
    if (uc.idempotencyKey) d.push(`Idempotency key: ${uc.idempotencyKey} (a repeated key returns the recorded result)`);
    if (uc.retry) d.push("Retried by callers: safe, because a retry with the same key does not run the steps again.");
    if (auth) {
      d.push(`Authorize: ${requirementText(auth.roles, auth.permissions)}`);
      if (uc.authorize?.allowIf) d.push(`    allow_if ${uc.authorize.allowIf}${auth.after?.kind === "load" ? ` (after loading ${auth.after.as})` : ""}`);
    } else if (L.model.security && uc.authorize?.kind === "public") d.push("Authorize: public (no principal needed)");
    else if (L.model.security && uc.authorize?.kind === "internal") d.push(tenantContext ? "Authorize: internal (run in-process, e.g. by a policy, in the tenant it is given; never served over HTTP)" : "Authorize: internal (run in-process, e.g. by a policy; never served over HTTP)");
    if (scope === "tenant" && auth) d.push("Tenant: the caller's active tenant (its token's tenant claim); every repository call is bound to it.");
    if (scope === "cross_tenant") d.push("Tenant: command.tenant_id (cross-tenant: platform roles only; every access is recorded by the CrossTenantAudit port first).");
    d.push("", "Steps:", ...describeSteps(uc.steps));
    c.docstring(d.join("\n"));
    c.line();
    c.line(`def __init__(self${params.length ? ", *" : ""}${params.map((p) => `, ${p.name}: ${p.type}`).join("")}) -> None:`);
    c.indent(() => {
      if (!params.length) c.line("pass");
      for (const p of params) c.line(`self._${p.name} = ${p.name}`);
    });
    c.line();
    if (auth) imp.from(sec, "Principal");
    if (auth && (!rbac || scope === "none" || scope === "global")) imp.from(sec, "authorize");
    if (tenantContext) imp.from(sec, "TenantContext");
    const head = `def execute(self, command: ${uc.command}${auth ? ", principal: Principal | None" : ""}${tenantContext ? ", context: TenantContext" : ""}) -> ${ret}:`;
    if (head.length + 4 <= MAX_LINE) c.line(head);
    else {
      c.line("def execute(");
      c.indent(() => c.line(`self, command: ${uc.command}${auth ? ", principal: Principal | None" : ""}${tenantContext ? ", context: TenantContext" : ""}`));
      c.line(`) -> ${ret}:`);
    }
    c.indent(() => {
      const doc = [
        deps.uow
          ? "Runs the steps in one transaction. Events marked publish_after_commit are published only after a successful commit."
          : "Runs the steps without a transaction boundary.",
      ];
      if (uc.idempotencyKey) {
        doc.push(
          "",
          `Idempotent by command.${uc.idempotencyKey}: a key that already succeeded returns the recorded result without running the steps, saving or publishing again. Failed runs are not recorded.${tenantSource ? (auth ? " Keys are kept per tenant and principal, and authorization runs before the lookup." : " Keys are kept per tenant.") : auth ? " Keys are kept per principal, and authorization runs before the lookup." : ""}`,
        );
      }
      if (auth && scope === "tenant") {
        doc.push("", `\`principal\` is checked first: Unauthenticated without one or without an active tenant, NotAuthorized without a required role or permission in that tenant (before anything is loaded)${auth.rule ? " or when allow_if does not hold" : ""}.`);
      } else if (auth && scope === "cross_tenant") {
        doc.push("", `\`principal\` is checked first: Unauthenticated without one, NotAuthorized without a required platform role or permission (before anything is loaded)${auth.rule ? " or when allow_if does not hold" : ""}. Then the access to command.tenant_id is recorded.`);
      } else if (auth) {
        doc.push(
          "",
          rbac
            ? `\`principal\` is checked first: Unauthenticated without one, NotAuthorized without a required role or permission (before anything is loaded)${auth.rule ? " or when allow_if does not hold" : ""}.`
            : "`principal` is checked first: Unauthenticated without one, NotAuthorized without a required role (before anything is loaded) or when allow_if does not hold.",
        );
      } else if (tenantContext) {
        doc.push("", "`context` names the tenant it runs in (a policy passes its event's tenant); every repository call is bound to it.");
      }
      c.docstring(doc.join("\n"));
      if (auth && !rbac) {
        c.line(`principal = authorize(principal, ${pyString(uc.name)}, ${rolesTuple(auth.roles)})`);
      } else if (auth && scope === "tenant") {
        imp.from(sec, "authorize_in_tenant");
        c.line(`principal, tenant = authorize_in_tenant(principal, ${pyString(uc.name)}${requirementKwargs(auth.roles, auth.permissions)})`);
      } else if (auth && scope === "cross_tenant") {
        imp.from(sec, "authorize_across_tenants", "CrossTenantAccess");
        c.line(`principal = authorize_across_tenants(principal, ${pyString(uc.name)}${requirementKwargs(auth.roles, auth.permissions)})`);
        c.line("# Every cross-tenant access is recorded before anything of the tenant is read.");
        c.line(`self._audit.record(CrossTenantAccess(action=${pyString(uc.name)}, principal=principal, tenant_id=command.tenant_id))`);
      } else if (auth) {
        c.line(`principal = authorize(principal, ${pyString(uc.name)}${requirementKwargs(auth.roles, auth.permissions)})`);
      }
      if (auth?.rule && !auth.after) emitAllowIf(auth.rule);
      const record = () => {
        if (!uc.idempotencyKey) return;
        imp.from(L.ports, "RecordedResult");
        c.line(`self._idempotency_store.record(${pyString(uc.name)}, key, RecordedResult(value=${ret === "None" ? "None" : "result"}))`);
      };
      if (uc.idempotencyKey) {
        // Keys are kept per tenant (and principal): the same key in another tenant is another request.
        if (tenantSource) c.line(`key = f"{${tenantSource}}:${auth ? "{principal.id}:" : ""}{command.${uc.idempotencyKey}}"`);
        else c.line(auth ? `key = f"{principal.id}:{command.${uc.idempotencyKey}}"` : `key = str(command.${uc.idempotencyKey})`);
        c.line(`recorded = self._idempotency_store.get(${pyString(uc.name)}, key)`);
        c.line("if recorded is not None:");
        c.indent(() => {
          if (ret === "None") c.line("return");
          else {
            imp.from("typing", "cast");
            c.line(`return cast(${ret}, recorded.value)`);
          }
        });
      }
      c.line("after_commit: list[DomainEvent] = []");
      const call = `self._run(command, ${runTakesPrincipal ? "principal, " : ""}${runTakesTenant ? `${tenantSource}, ` : ""}after_commit)`;
      if (deps.uow) {
        c.line("try:");
        c.indent(() => {
          c.line(ret === "None" ? call : `result = ${call}`);
          record();
          c.line("self._unit_of_work.commit()");
        });
        c.line("except BaseException:");
        c.indent(() => {
          c.line("self._unit_of_work.rollback()");
          c.line("raise");
        });
      } else {
        c.line(ret === "None" ? call : `result = ${call}`);
        record();
      }
      if (deps.publisher && info.publishes.length) {
        c.line("if after_commit:");
        c.indent(() => c.line("self._event_publisher.publish(tuple(after_commit))"));
      }
      if (ret !== "None") c.line("return result");
    });
    c.line();
    const runParams = [`command: ${uc.command}`, ...(runTakesPrincipal ? ["principal: Principal"] : []), ...(runTakesTenant ? ["tenant: TenantId"] : []), "after_commit: list[DomainEvent]"];
    if (runTakesTenant) imp.from(sec, "TenantId");
    const runHead = `def _run(self, ${runParams.join(", ")}) -> ${ret}:`;
    if (runHead.length + 4 <= MAX_LINE) c.line(runHead);
    else {
      c.line("def _run(");
      const inner = `self, ${runParams.join(", ")}`;
      if (inner.length + 8 <= MAX_LINE) c.indent(() => c.line(inner));
      else c.indent(() => ["self", ...runParams].forEach((p) => c.line(`${p},`)));
      c.line(`) -> ${ret}:`);
    }
    c.indent(() => {
      // `emitted` collects the events of create / invoke steps for the publish steps (unused without them: ruff F841).
      if (usesEmitted(uc.steps)) c.line("emitted: list[DomainEvent] = []");
      const counter = { n: 0 };
      const afterStep = (s: StepIR) => {
        if (auth?.rule && s === auth.after) emitAllowIf(auth.rule);
      };
      emitSteps(L, c, uc.steps, ectx, imp, counter, bindings(uc.steps), info.returnType, afterStep, runTakesTenant ? "tenant" : undefined);
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

function emitSteps(
  L: Layout,
  c: Code,
  steps: StepIR[],
  ectx: () => ExprContext,
  imp: Imports,
  counter: { n: number },
  vars: Map<string, string>,
  returnType: Type | undefined,
  afterStep?: (s: StepIR) => void,
  tenant?: string,
): void {
  const aggregateOf = (v: string) => L.ca.ir.aggregates.find((a) => a.name === vars.get(v));
  /** `tenant, ` before the arguments of a repository call of a tenant-scoped aggregate. */
  const bound = (agName: string) => (tenant && L.tenantScoped(L.aggregate(agName)!) ? `${tenant}, ` : "");
  const T_ = (p: (string | number)[]) => {
    const e = L.ca.exprs.get(formatPath(p));
    if (!e) throw new Error(`missing typed expression at ${formatPath(p)}`);
    return e;
  };
  const X = (p: (string | number)[], target?: Type) => emitAs(T_(p), target, ectx());
  /** Argument for an aggregate parameter (Integer → Decimal is made explicit for mypy). */
  const arg = (owner: string, p: { name: string; type: string; required: boolean }, path: (string | number)[]) => {
    const r = resolveType(p.type, { context: L.ca.ir, aggregate: owner });
    return `${p.name}=${X(path, r.ok ? r.type : undefined)}`;
  };
  for (const s of steps) {
    const n = ++counter.n;
    switch (s.kind) {
      case "load": {
        const ag = L.ca.ir.aggregates.find((a) => a.name === s.aggregate)!;
        const key = X([...s.path, "by"]);
        c.line(`# ${n}. load ${s.aggregate}`);
        c.line(`${s.as} = self._${repoAttr(ag.name)}.get(${bound(ag.name)}${key})`);
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
        afterStep?.(s);
        break;
      }
      case "create": {
        imp.from(L.mod("aggregates"), s.aggregate);
        const ag = L.ca.ir.aggregates.find((a) => a.name === s.aggregate)!;
        const f = ag.factories.find((x) => x.name === s.factory)!;
        // A tenant-scoped aggregate is created in the use case's tenant (never one from the input).
        const args = [
          ...(tenant && L.tenantScoped(ag) ? [`tenant_id=${tenant}`] : []),
          ...f.parameters.filter((p) => s.args[p.name] !== undefined).map((p) => arg(ag.name, p, [...s.path, "args", p.name])),
        ];
        c.line(`# ${n}. create ${s.aggregate} via ${s.factory}`);
        c.line(`transition_${n} = ${s.aggregate}.${s.factory}(${args.join(", ")})`);
        c.line(`${s.as} = transition_${n}.aggregate`);
        c.line(`emitted.extend(transition_${n}.events)`);
        break;
      }
      case "invoke": {
        const lookup = aggregateOf(s.target);
        const op = lookup?.operations.find((o) => o.name === s.operation);
        const args = (op?.parameters ?? []).filter((p) => s.args[p.name] !== undefined).map((p) => arg(lookup!.name, p, [...s.path, "args", p.name]));
        c.line(`# ${n}. ${s.target}.${s.operation}`);
        c.line(`transition_${n} = ${s.target}.${s.operation}(${args.join(", ")})`);
        c.line(`${s.target} = transition_${n}.aggregate`);
        c.line(`emitted.extend(transition_${n}.events)`);
        break;
      }
      case "save": {
        const ag = aggregateOf(s.target)!;
        c.line(`# ${n}. save ${s.target}`);
        c.line(`self._${repoAttr(ag.name)}.save(${bound(ag.name)}${s.target})`);
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
          emitSteps(L, c, s.then, ectx, imp, counter, vars, returnType, undefined, tenant);
        });
        if (s.else.length && endsTerminal(s.then)) {
          // The then-branch returns or raises, so the else-branch needs no `else:` (ruff RET505 / RET506).
          emitSteps(L, c, s.else, ectx, imp, counter, vars, returnType, undefined, tenant);
        } else if (s.else.length) {
          c.line("else:");
          c.indent(() => emitSteps(L, c, s.else, ectx, imp, counter, vars, returnType, undefined, tenant));
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
        c.line(`return ${X(s.path, returnType)}`);
        break;
      case "let": {
        const e = T_([...s.path, "value"]);
        c.line(`# ${n}. let ${s.name}`);
        c.line(`${s.name}: ${pyType(e.type, imp, L.typeModule, { field: false })} = ${emitAs(e, e.type, ectx())}`);
        break;
      }
    }
  }
}

function usesEmitted(steps: StepIR[]): boolean {
  return steps.some((s) => s.kind === "create" || s.kind === "invoke" || s.kind === "publish" || (s.kind === "if" && (usesEmitted(s.then) || usesEmitted(s.else))));
}

/** How a use case is authorized (only when `security` is declared and it needs a principal). */
export interface UseCaseAuthorization {
  roles: string[];
  /** Permissions any of which admits the principal (map-form roles). */
  permissions: string[];
  rule?: TExpr;
  /** The leading load after which `allow_if` runs; undefined → first. */
  after?: StepIR;
}

export function useCaseAuthorization(L: Layout, uc: UseCaseIR): UseCaseAuthorization | undefined {
  if (!L.model.security || !requiresPrincipal(uc)) return undefined;
  const a = uc.authorize!;
  const permissions = a.permissions ?? [];
  if (a.allowIf === undefined) return { roles: a.roles, permissions };
  const rule = L.ca.exprs.get(formatPath([...a.path, "allow_if"]));
  if (!rule) throw new Error(`missing typed allow_if of ${uc.name}`);
  const used = new Set<string>();
  walkExpr(rule, (n) => {
    if (n.t === "local") used.add(n.name);
  });
  let after: StepIR | undefined;
  for (const l of leadingLoads(uc.steps)) if (used.has(l.as)) after = l;
  return { roles: a.roles, permissions, rule, ...(after ? { after } : {}) };
}

/** Whether a use case calls a repository of a tenant-scoped aggregate or creates one (it needs its tenant). */
function touchesTenantRepo(L: Layout, uc: UseCaseIR): boolean {
  const walk = (steps: StepIR[]): boolean =>
    steps.some((s) => ((s.kind === "load" || s.kind === "create") && L.tenantScoped(L.aggregate(s.aggregate)!)) || s.kind === "save" || (s.kind === "if" && (walk(s.then) || walk(s.else))));
  return walk(uc.steps);
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
