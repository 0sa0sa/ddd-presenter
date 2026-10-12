import { formatPath, leadingLoads, requiresPrincipal, usesPermissions, walkExpr, type StepIR, type TExpr, type Type, type UseCaseIR } from "@ddd/core";

import { Code, relativeSpecifier, TsImports, tsString, unparen } from "./code.ts";
import { entry, file, type TsFile } from "./domain.ts";
import { emitAs, emitExpr, type ExprContext } from "./expr.ts";
import type { TsLayout } from "./layout.ts";
import { camel, ident, pascal, prop, toSnake } from "./names.ts";
import { requirementText, rolesLiteral } from "./security.ts";
import { tsType } from "./types.ts";

export function repoName(aggregate: string): string {
  return `${camel(toSnake(aggregate))}Repository`;
}

export function portsFile(L: TsLayout): TsFile {
  const mod = L.ports;
  const imp = new TsImports(mod);
  const c = new Code();
  const shared = ["Clock", "EventPublisher", "IdGenerator", "UnitOfWork"];
  if (L.ca.ir.useCases.some((u) => u.idempotencyKey)) shared.push("IdempotencyStore", "RecordedResult");
  c.line();
  c.comment("Ports shared by every context (defined once in the runtime).");
  c.line(`export type { ${shared.sort().join(", ")} } from "${relativeSpecifier(mod, L.runtime)}";`);
  if (L.ca.ir.useCases.some((u) => u.authorize?.crossTenant) && L.model.security?.tenancy) {
    c.comment("Records cross-tenant access by platform roles (defined in the security module).");
    c.line(`export type { CrossTenantAudit } from "${relativeSpecifier(mod, L.security)}";`);
  }
  for (const ag of L.ca.ir.aggregates) {
    imp.type(L.runtime, "Awaitable");
    imp.type(L.mod("aggregates"), ag.name);
    const idType = tsType(L.tsFieldType(ag.name, ag.identity)!, imp, L);
    c.line();
    if (L.tenantScoped(ag)) {
      imp.type(L.security, "TenantId");
      c.doc(
        [
          `Loads and stores ${ag.name} aggregates of one tenant at a time. Implemented by an adapter outside the domain.`,
          "",
          "Every call names the tenant (the use case passes the caller's): `get` returns null for an aggregate of another tenant (the same as a missing one, so nothing leaks), and `save` refuses an aggregate whose `tenantId` is not `tenant` (TenantMismatch).",
        ].join("\n"),
      );
      c.block(`export interface ${ag.name}Repository`, () => {
        c.line(`get(tenant: TenantId, ${ident(ag.identity)}: ${idType}): Awaitable<${ag.name} | null>;`);
        c.line(`save(tenant: TenantId, aggregate: ${ag.name}): Awaitable<void>;`);
      });
      continue;
    }
    c.doc(`Loads and stores ${ag.name} aggregates. Implemented by an adapter outside the domain.`);
    c.block(`export interface ${ag.name}Repository`, () => {
      c.line(`get(${ident(ag.identity)}: ${idType}): Awaitable<${ag.name} | null>;`);
      c.line(`save(aggregate: ${ag.name}): Awaitable<void>;`);
    });
  }
  const exts = L.ca.ir.extensionPoints;
  // A context without extension points has no Extensions interface (an empty interface would accept any value).
  if (exts.length) {
    c.line();
    c.doc(`Customer-owned extension points of ${L.ca.ir.name}.\n\nImplement this interface in the extensions directory; the generator never overwrites it.`);
    c.block("export interface Extensions", () => {
      exts.forEach((x, i) => {
        if (i) c.line();
        c.doc(x.description ?? `Extension point ${x.name}.`);
        c.line(`${extensionSignature(L, x, imp)}: Awaitable<${tsType(L.resolve(x.returns), imp, L)}>;`);
        imp.type(L.runtime, "Awaitable");
      });
    });
  }
  return file(L, mod, `Ports (interfaces to the outside world) of the ${L.ca.ir.name} context.`, imp, c.toString());
}

/** `isBlockedEmail(email: EmailAddress)` */
export function extensionSignature(L: TsLayout, x: { name: string; parameters: { name: string; type: string; required: boolean }[] }, imp: TsImports): string {
  const types = L.paramTypes(undefined, x.parameters as never);
  return `${prop(x.name)}(${x.parameters.map((p) => `${ident(p.name)}: ${tsType(types.get(p.name)!, imp, L)}`).join(", ")})`;
}

interface Deps {
  repos: string[];
  clock: boolean;
  ids: boolean;
  extensions: boolean;
  publisher: boolean;
  uow: boolean;
  idempotency: boolean;
  /** Cross-tenant use cases record each access (`CrossTenantAudit`). */
  audit?: boolean;
}

export function useCaseDeps(L: TsLayout, uc: UseCaseIR): Deps {
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

/** Constructor dependencies in a stable order (shared with the test generator), like the Python target. */
export function depParams(d: Deps): { name: string; type: string }[] {
  const out = d.repos.map((r) => ({ name: repoName(r), type: `${r}Repository` }));
  if (d.clock) out.push({ name: "clock", type: "Clock" });
  if (d.ids) out.push({ name: "ids", type: "IdGenerator" });
  if (d.extensions) out.push({ name: "extensions", type: "Extensions" });
  if (d.publisher) out.push({ name: "eventPublisher", type: "EventPublisher" });
  if (d.uow) out.push({ name: "unitOfWork", type: "UnitOfWork" });
  if (d.idempotency) out.push({ name: "idempotencyStore", type: "IdempotencyStore" });
  if (d.audit) out.push({ name: "audit", type: "CrossTenantAudit" });
  return out;
}


export function useCaseClass(uc: UseCaseIR): string {
  return `${pascal(uc.name)}UseCase`;
}

export function useCasesFile(L: TsLayout): TsFile {
  const mod = L.useCases;
  const imp = new TsImports(mod);
  const c = new Code();
  for (const uc of L.ca.ir.useCases) useCase(L, c, uc, imp);
  if (!L.ca.ir.useCases.length) c.line("// This context declares no use cases.").line("export {};");
  return file(L, mod, `Use cases (application services) of the ${L.ca.ir.name} context.`, imp, c.toString());
}

export function describeSteps(steps: StepIR[], indent = "  ", counter = { n: 0 }): string[] {
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
        out.push(...describeSteps(s.then, indent + "  ", counter));
        if (s.else.length) {
          out.push(`${indent}  else:`);
          out.push(...describeSteps(s.else, indent + "  ", counter));
        }
        break;
    }
  }
  return out;
}

function walkSteps(steps: StepIR[], fn: (s: StepIR) => void): void {
  for (const s of steps) {
    fn(s);
    if (s.kind === "if") {
      walkSteps(s.then, fn);
      walkSteps(s.else, fn);
    }
  }
}

function useCase(L: TsLayout, c: Code, uc: UseCaseIR, imp: TsImports): void {
  const info = L.ca.useCases.get(uc.name)!;
  const deps = useCaseDeps(L, uc);
  const params = depParams(deps);
  for (const p of params) imp.type(L.ports, p.type);
  imp.type(L.mod("commands"), uc.command);
  const ret = info.returnType ? tsType(info.returnType, imp, L) : "void";
  const cls = useCaseClass(uc);
  let afterCommitSteps = false;
  let emits = false;
  const invoked = new Set<string>();
  walkSteps(uc.steps, (s) => {
    if (s.kind === "publish") {
      emits = true;
      if (s.afterCommit) afterCommitSteps = true;
    }
    if (s.kind === "create" || s.kind === "invoke") emits = true;
    if (s.kind === "invoke") invoked.add(s.target);
  });
  if (emits || afterCommitSteps) imp.type(L.runtime, "DomainEvent");
  const auth = useCaseAuthorization(L, uc);
  const scope = L.scopeOf(uc);
  const rbac = usesPermissions(L.model.security) || !!L.model.security?.tenancy;
  // Where the tenant of a tenant-scoped use case comes from (docs/09 §22): the caller's token, the command (cross-tenant)
  // or the tenant context an internal use case runs in (a policy passes its event's tenant).
  const tenantSource = scope === "tenant" ? (auth ? "principal.tenantId" : "context.tenantId") : scope === "cross_tenant" ? "command.tenantId" : undefined;
  const tenantContext = scope === "tenant" && !auth;

  c.line();
  const d = [uc.description ?? `Use case ${uc.name}.`, ""];
  if (uc.actor) d.push(`Actor: ${uc.actor}`);
  d.push(`Transaction: ${uc.transaction}`);
  if (uc.idempotencyKey) d.push(`Idempotency key: ${uc.idempotencyKey} (a repeated key returns the recorded result)`);
  if (uc.retry) d.push("Retried by callers: safe, because a retry with the same key does not run the steps again.");
  if (auth) d.push(...authorizationDoc(uc, auth));
  else if (L.model.security && uc.authorize?.kind === "public") d.push("Authorize: public (no principal needed)");
  else if (L.model.security && uc.authorize?.kind === "internal") d.push(tenantContext ? "Authorize: internal (run in-process, e.g. by a policy, in the tenant it is given; never served over HTTP)" : "Authorize: internal (run in-process, e.g. by a policy; never served over HTTP)");
  if (scope === "tenant" && auth) d.push("Tenant: the caller's active tenant (its token's tenant claim); every repository call is bound to it.");
  if (scope === "cross_tenant") d.push("Tenant: command.tenantId (cross-tenant: platform roles only; every access is recorded by the CrossTenantAudit port first).");
  d.push("", "Steps:", ...describeSteps(uc.steps));
  c.doc(d.join("\n"));
  c.block(`export class ${cls}`, () => {
    for (const p of params) c.line(`readonly #${p.name}: ${p.type};`);
    if (params.length) {
      c.line();
      c.block(`constructor(deps: { ${params.map((p) => `readonly ${p.name}: ${p.type}`).join("; ")} })`, () => {
        for (const p of params) c.line(`this.#${p.name} = deps.${p.name};`);
      });
      c.line();
    }
    const doc = [
      deps.uow
        ? "Runs the steps in one transaction. Events marked publish_after_commit are published only after a successful commit."
        : "Runs the steps without a transaction boundary.",
    ];
    if (uc.idempotencyKey) {
      doc.push(
        "",
        `Idempotent by command.${prop(uc.idempotencyKey)}: a key that already succeeded returns the recorded result without running the steps, saving or publishing again. Failed runs are not recorded.${tenantSource ? (auth ? " Keys are kept per tenant and principal, and authorization runs before the lookup." : " Keys are kept per tenant.") : auth ? " Keys are kept per principal, and authorization runs before the lookup." : ""}`,
      );
    }
    if (auth && scope === "tenant") {
      doc.push(
        "",
        `\`principal\` is checked first: Unauthenticated without one or without an active tenant, NotAuthorized without a required role or permission in that tenant (before anything is loaded)${auth.rule ? " or when allow_if does not hold" : ""}.`,
      );
    } else if (auth && scope === "cross_tenant") {
      doc.push(
        "",
        `\`principal\` is checked first: Unauthenticated without one, NotAuthorized without a required platform role or permission (before anything is loaded)${auth.rule ? " or when allow_if does not hold" : ""}. Then the access to command.tenantId is recorded.`,
      );
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
    c.doc(doc.join("\n"));
    // The steps are rendered first: #run takes `command` only if a step reads it, and is async only if it awaits.
    const run = new Code();
    if (emits) run.line("const emitted: DomainEvent[] = [];");
    const ctx: ExprContext = {
      L,
      imports: imp,
      self: "this",
      inputs: L.fieldTypes(uc.command),
      ports: { clock: "this.#clock", ids: "this.#ids", extensions: "this.#extensions" },
      ...(scope !== "none" ? { scope } : {}),
    };
    // allow_if runs right after the last leading load it reads (or first thing, when it reads only the inputs).
    const afterStep = (s: StepIR, code: Code) => {
      if (auth?.rule && s === auth.after) emitAllowIf(code, uc, auth.rule, ctx);
    };
    emitSteps(L, run, uc.steps, ctx, { n: 0 }, bindings(uc.steps), invoked, info.returnType, afterStep, tenantSource ? "tenant" : undefined);
    const runBody = run.toString();
    const runUsesCommand = /\bcommand\b/.test(runBody.replace(/^\s*\/\/.*$/gm, ""));
    const runUsesPrincipal = !!auth && /\bprincipal\b/.test(runBody.replace(/^\s*\/\/.*$/gm, ""));
    const runUsesTenant = !!tenantSource && /\btenant\b/.test(runBody.replace(/^\s*\/\/.*$/gm, ""));
    if (runUsesTenant) imp.type(L.security, "TenantId");
    const runIsAsync = /\bawait\b/.test(runBody);
    const runArgs = [...(runUsesCommand ? ["command"] : []), ...(runUsesPrincipal ? ["principal"] : []), ...(runUsesTenant ? [tenantSource] : []), ...(afterCommitSteps ? ["afterCommit"] : [])];
    const runParams = [
      ...(runUsesCommand ? [`command: ${uc.command}`] : []),
      ...(runUsesPrincipal ? ["principal: Principal"] : []),
      ...(runUsesTenant ? ["tenant: TenantId"] : []),
      ...(afterCommitSteps ? ["afterCommit: DomainEvent[]"] : []),
    ];
    const executeAwaits = runIsAsync || !!uc.idempotencyKey || deps.uow || (afterCommitSteps && deps.publisher) || !!deps.audit;
    const authorizeFirst = () => {
      if (!auth) return;
      if (!rbac) {
        imp.value(L.security, "authorize");
        c.line(`authorize(principal, ${tsString(uc.name)}, ${rolesLiteral(auth.roles)});`);
      } else {
        const check = scope === "tenant" ? "authorizeInTenant" : scope === "cross_tenant" ? "authorizeAcrossTenants" : "authorize";
        imp.value(L.security, check);
        c.line(`${check}(principal, ${tsString(uc.name)}, ${requirementLiteral(auth)});`);
      }
      if (scope === "cross_tenant") {
        c.comment("Every cross-tenant access is recorded before anything of the tenant is read.");
        c.line(`await this.#audit.record({ action: ${tsString(uc.name)}, principal, tenantId: command.tenantId });`);
      }
      if (auth.rule && !auth.after) emitAllowIf(c, uc, auth.rule, ctx);
    };
    const executeUsesCommand = runUsesCommand || !!uc.idempotencyKey || scope === "cross_tenant" || (!!auth?.rule && !auth.after && /\bcommand\b/.test(emitExpr(auth.rule, ctx)));
    const executeUsesContext = tenantContext && (runUsesTenant || !!uc.idempotencyKey);
    // `_command`: no step reads the (empty) command; the parameter stays for a uniform execute(command).
    const commandParam = `${executeUsesCommand ? "" : "_"}command: ${uc.command}${auth ? ", principal: Principal | null" : ""}${tenantContext ? `, ${executeUsesContext ? "" : "_"}context: TenantContext` : ""}`;
    if (auth) imp.type(L.security, "Principal");
    if (tenantContext) imp.type(L.security, "TenantContext");
    if (!executeAwaits && auth) {
      // Nothing to await: authorization and the steps run inside the promise, so their errors reject it.
      c.block(`execute(${commandParam}): Promise<${ret}>`, () => {
        c.block("return Promise.resolve().then(() =>", () => {
          authorizeFirst();
          c.line(`return this.#run(${runArgs.join(", ")});`);
        }, ");");
      });
    } else if (!executeAwaits) {
      // Nothing to await: errors thrown by the steps still reject the returned promise.
      c.block(`execute(${commandParam}): Promise<${ret}>`, () => {
        c.line(`return Promise.resolve().then(() => this.#run(${runArgs.join(", ")}));`);
      });
    }
    if (executeAwaits) c.block(`async execute(${commandParam}): Promise<${ret}>`, () => {
      const useCaseName = tsString(uc.name);
      authorizeFirst();
      if (uc.idempotencyKey && tenantSource) {
        // Keys are kept per tenant (and principal): the same key in another tenant is another request.
        c.line(`const key = \`\${${tenantSource}}:${auth ? "${principal.id}:" : ""}\${String(command.${prop(uc.idempotencyKey)})}\`;`);
        c.line(`const recorded = await this.#idempotencyStore.get(${useCaseName}, key);`);
        c.line(`if (recorded !== null) return${ret === "void" ? "" : ` recorded.value as ${ret}`};`);
      } else if (uc.idempotencyKey && auth) {
        c.line(`const key = \`\${principal.id}:\${String(command.${prop(uc.idempotencyKey)})}\`;`);
        c.line(`const recorded = await this.#idempotencyStore.get(${useCaseName}, key);`);
        c.line(`if (recorded !== null) return${ret === "void" ? "" : ` recorded.value as ${ret}`};`);
      } else if (uc.idempotencyKey) {
        c.line(`const key = String(command.${prop(uc.idempotencyKey)});`);
        c.line(`const recorded = await this.#idempotencyStore.get(${useCaseName}, key);`);
        c.line(`if (recorded !== null) return${ret === "void" ? "" : ` recorded.value as ${ret}`};`);
      }
      if (afterCommitSteps) c.line("const afterCommit: DomainEvent[] = [];");
      const call = `${runIsAsync ? "await " : ""}this.#run(${runArgs.join(", ")})`;
      const record = () => {
        if (uc.idempotencyKey) c.line(`await this.#idempotencyStore.record(${useCaseName}, key, { value: ${ret === "void" ? "null" : "result"} });`);
      };
      if (deps.uow) {
        if (ret !== "void") c.line(`let result: ${ret};`);
        c.line("try {");
        c.indent(() => {
          c.line(ret === "void" ? `${call};` : `result = ${call};`);
          record();
          c.line("await this.#unitOfWork.commit();");
        });
        c.line("} catch (error) {");
        c.indent(() => {
          c.line("await this.#unitOfWork.rollback();");
          c.line("throw error;");
        });
        c.line("}");
      } else {
        c.line(ret === "void" ? `${call};` : `const result = ${call};`);
        record();
      }
      if (afterCommitSteps && deps.publisher) c.line("if (afterCommit.length > 0) await this.#eventPublisher.publish(afterCommit);");
      if (ret !== "void") c.line("return result;");
    });
    c.line();
    c.block(`${runIsAsync ? "async " : ""}#run(${runParams.join(", ")}): ${runIsAsync ? `Promise<${ret}>` : ret}`, () => {
      for (const l of runBody.split("\n")) c.line(l);
    });
  });
}

function emitSteps(
  L: TsLayout,
  c: Code,
  steps: StepIR[],
  ctx: ExprContext,
  counter: { n: number },
  vars: Map<string, string>,
  invoked: Set<string>,
  returnType: Type | undefined,
  afterStep?: (s: StepIR, c: Code) => void,
  tenant?: string,
): void {
  const aggregateOf = (v: string) => L.aggregate(vars.get(v) ?? "");
  const T_ = (p: (string | number)[]): TExpr => {
    const e = L.ca.exprs.get(formatPath(p));
    if (!e) throw new Error(`missing typed expression at ${formatPath(p)}`);
    return e;
  };
  /** `{ name: value, … }` for the aggregate parameters the step sets (coerced to the parameter types). */
  const argsObject = (owner: string, params: { name: string; type: string; required: boolean }[], args: Record<string, string>, path: (string | number)[]) => {
    const ag = L.aggregate(owner)!;
    const types = L.paramTypes(ag, params as never);
    const set = params.filter((p) => args[p.name] !== undefined);
    // A tenant-scoped aggregate is created in the use case's tenant (never one from the input).
    const tenantArg = tenant && ag.factories.some((f) => f.parameters === params) && L.tenantScoped(ag) ? [`tenantId: ${tenant}`] : [];
    if (!set.length && !tenantArg.length) return "";
    return `{ ${[...tenantArg, ...set.map((p) => entry(prop(p.name), emitAs(T_([...path, "args", p.name]), types.get(p.name), ctx)))].join(", ")} }`;
  };
  /** `tenant, ` before the arguments of a repository call of a tenant-scoped aggregate. */
  const bound = (agName: string) => (tenant && L.tenantScoped(L.aggregate(agName)!) ? `${tenant}, ` : "");
  for (const s of steps) {
    const n = ++counter.n;
    switch (s.kind) {
      case "load": {
        const ag = L.aggregate(s.aggregate)!;
        const by = T_([...s.path, "by"]);
        const key = emitAs(by, L.tsFieldType(ag.name, ag.identity), ctx);
        const plainKey = emitExpr(by, ctx);
        const v = ident(s.as);
        const notFound = () => {
          if (s.notFound) {
            ctx.imports.value(L.mod("errors"), s.notFound);
            return `throw new ${s.notFound}({ ${prop(ag.identity)}: ${plainKey} });`;
          }
          ctx.imports.value(L.runtime, "AggregateNotFound");
          return `throw new AggregateNotFound({ aggregate: ${tsString(ag.name)}, ${prop(ag.identity)}: ${plainKey} });`;
        };
        c.line(`// ${n}. load ${s.aggregate}`);
        if (invoked.has(s.as)) {
          // Reassigned by later operations: bind the non-null value to a variable of the aggregate type.
          c.line(`const loaded${n} = await this.#${repoName(ag.name)}.get(${bound(ag.name)}${key});`);
          c.line(`if (loaded${n} === null) ${notFound()}`);
          c.line(`let ${v} = loaded${n};`);
        } else {
          c.line(`const ${v} = await this.#${repoName(ag.name)}.get(${bound(ag.name)}${key});`);
          c.line(`if (${v} === null) ${notFound()}`);
        }
        afterStep?.(s, c);
        break;
      }
      case "create": {
        ctx.imports.value(L.mod("aggregates"), s.aggregate);
        const ag = L.aggregate(s.aggregate)!;
        const f = ag.factories.find((x) => x.name === s.factory)!;
        c.line(`// ${n}. create ${s.aggregate} via ${s.factory}`);
        c.line(`const transition${n} = ${s.aggregate}.${prop(s.factory)}(${argsObject(ag.name, f.parameters, s.args, s.path)});`);
        c.line(`${invoked.has(s.as) ? "let" : "const"} ${ident(s.as)} = transition${n}.aggregate;`);
        c.line(`emitted.push(...transition${n}.events);`);
        break;
      }
      case "invoke": {
        const ag = aggregateOf(s.target);
        const op = ag?.operations.find((o) => o.name === s.operation);
        c.line(`// ${n}. ${s.target}.${s.operation}`);
        c.line(`const transition${n} = ${ident(s.target)}.${prop(s.operation)}(${argsObject(ag!.name, op?.parameters ?? [], s.args, s.path)});`);
        c.line(`${ident(s.target)} = transition${n}.aggregate;`);
        c.line(`emitted.push(...transition${n}.events);`);
        break;
      }
      case "save": {
        const ag = aggregateOf(s.target)!;
        c.line(`// ${n}. save ${s.target}`);
        c.line(`await this.#${repoName(ag.name)}.save(${bound(ag.name)}${ident(s.target)});`);
        break;
      }
      case "publish": {
        ctx.imports.value(L.mod("events"), s.event);
        c.line(`// ${n}. publish ${s.event}${s.afterCommit ? " after commit" : ""}`);
        if (s.afterCommit) c.line(`afterCommit.push(...emitted.filter(${s.event}.is));`);
        else c.line(`await this.#eventPublisher.publish(emitted.filter(${s.event}.is));`);
        break;
      }
      case "if": {
        c.line(`// ${n}. if ${s.condition}`);
        c.line(`if (${unparen(emitExpr(T_([...s.path, "condition"]), ctx))}) {`);
        c.indent(() => emitSteps(L, c, s.then, ctx, counter, vars, invoked, returnType, undefined, tenant));
        if (s.else.length) {
          c.line("} else {");
          c.indent(() => emitSteps(L, c, s.else, ctx, counter, vars, invoked, returnType, undefined, tenant));
        }
        c.line("}");
        break;
      }
      case "fail":
        ctx.imports.value(L.mod("errors"), s.error);
        c.line(`// ${n}. fail`);
        c.line(`throw new ${s.error}();`);
        break;
      case "return":
        c.line(`// ${n}. return`);
        c.line(`return ${emitAs(T_(s.path), returnType, ctx)};`);
        break;
      case "let": {
        const e = T_([...s.path, "value"]);
        c.line(`// ${n}. let ${s.name}`);
        c.line(`const ${ident(s.name)}: ${tsType(e.type, ctx.imports, L)} = ${emitAs(e, e.type, ctx)};`);
        break;
      }
    }
  }
}

/** How a use case is authorized (only when `security` is declared and it needs a principal). */
export interface UseCaseAuthorization {
  roles: string[];
  /** Permissions any of which admits the principal (map-form roles). */
  permissions: string[];
  /** The typed `allow_if`, if any. */
  rule?: TExpr;
  /** The leading load after which `allow_if` runs; undefined → first, before any step. */
  after?: StepIR;
}

export function useCaseAuthorization(L: TsLayout | { model: TsLayout["model"]; ca: TsLayout["ca"] }, uc: UseCaseIR): UseCaseAuthorization | undefined {
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
  const leading = leadingLoads(uc.steps);
  let after: StepIR | undefined;
  for (const l of leading) if (used.has(l.as)) after = l;
  return { roles: a.roles, permissions, rule, ...(after ? { after } : {}) };
}

/** `{ roles: ["admin"], permissions: ["invitation.read"] }`: the requirement argument of the authorize checks. */
export function requirementLiteral(a: { roles: string[]; permissions: string[] }): string {
  const parts = [...(a.roles.length ? [`roles: ${rolesLiteral(a.roles)}`] : []), ...(a.permissions.length ? [`permissions: ${rolesLiteral(a.permissions)}`] : [])];
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

function authorizationDoc(uc: UseCaseIR, auth: UseCaseAuthorization): string[] {
  const out = [`Authorize: ${requirementText(auth.roles, auth.permissions)}`];
  if (uc.authorize?.allowIf) out.push(`  allow_if ${uc.authorize.allowIf}${auth.after?.kind === "load" ? ` (after loading ${auth.after.as})` : ""}`);
  return out;
}

function emitAllowIf(c: Code, uc: UseCaseIR, rule: TExpr, ctx: ExprContext): void {
  ctx.imports.value(ctx.L.security, "allowIf");
  c.line("// authorize: allow_if");
  c.line(`allowIf(${emitExpr(rule, ctx)}, ${tsString(uc.name)});`);
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
