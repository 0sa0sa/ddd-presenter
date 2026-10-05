/**
 * HTTP API of the TypeScript target (`generation.typescript.api`): a framework-agnostic contract, a Web-standard
 * server handler, a typed client and TanStack Query (v5) query factories (keys + queryOptions) and mutationOptions. Design notes and the
 * TkDodo rules the client follows: docs/09 §18; contract: docs/05 §8.
 */
import { effectiveRateLimit, formatPath, requiresPrincipal, servedOverHttp, windowSeconds, type AggregateIR, type ApiSettings, type AuthorizeIR, type RateLimitIR, type StepIR, type Type, type UseCaseIR } from "@ddd/core";
import { useCaseClass } from "./application.ts";
import { assemble, Code, header, TsImports, tsString } from "./code.ts";
import { file, type TsFile } from "./domain.ts";
import type { TsLayout, TsPaths } from "./layout.ts";
import { camel, ident, kebab, pascal, prop, toSnake } from "./names.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";
import { zodSchema } from "./types.ts";
import { protectedAggregates, readAccessName } from "./security.ts";

/** `readonly name?: Pick<Type, "member">;` at `depth`, broken like Prettier breaks long type arguments. */
function pickLine(c: Code, depth: number, name: string, type: string, member: string): void {
  const line = `readonly ${name}?: Pick<${type}, ${tsString(member)}>;`;
  if (strWidth("  ".repeat(depth) + line) <= PRINT_WIDTH) {
    c.line(line);
    return;
  }
  c.open(`readonly ${name}?: Pick<`, () => c.line(`${type},`).line(`${tsString(member)}`), ">;");
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422;

/** Use cases with an endpoint: all but `authorize: internal` (run in-process only, e.g. by a policy). */
export function servedUseCases(L: TsLayout): UseCaseIR[] {
  return L.ca.ir.useCases.filter(servedOverHttp);
}

/** `{ kind: "principal", roles: [...] }` / `{ kind: "public" }`: who may call an endpoint (contract). */
function authObject(a: AuthorizeIR | undefined): string {
  return a?.kind === "principal" ? `{ kind: "principal", roles: [${a.roles.map(tsString).join(", ")}] }` : '{ kind: "public" }';
}

/** The contract's rate limit of an endpoint (`name` is the policy name in the RateLimit headers). */
function rateLimitObject(name: string, limit: RateLimitIR | undefined): string {
  if (!limit) return "null";
  return `{ name: ${tsString(name)}, requests: ${limit.requests}, windowSeconds: ${windowSeconds(limit)}, by: ${tsString(limit.by)} }`;
}

/** Contract lines of an endpoint's authorization and rate limit (only with `security`). */
function securityLines(c: Code, L: TsLayout, owner: { authorize?: AuthorizeIR; rateLimit?: RateLimitIR | "none" }, name: string): void {
  if (!L.model.security) return;
  c.line(`auth: ${authObject(owner.authorize)},`);
  const limit = rateLimitObject(name, effectiveRateLimit(L.model, owner));
  if (strWidth(`      rateLimit: ${limit},`) <= PRINT_WIDTH) c.line(`rateLimit: ${limit},`);
  else {
    const l = effectiveRateLimit(L.model, owner)!;
    c.open("rateLimit: {", () => {
      c.line(`name: ${tsString(name)},`);
      c.line(`requests: ${l.requests},`);
      c.line(`windowSeconds: ${windowSeconds(l)},`);
      c.line(`by: ${tsString(l.by)},`);
    }, "},");
  }
}

/** Contexts that get endpoints: those with use cases or aggregates. */
export function apiContexts(Ls: TsLayout[]): TsLayout[] {
  return Ls.filter((L) => servedUseCases(L).length || L.ca.ir.aggregates.length);
}

/** `cleaningStaff`: the context's key in the contract, the client and the server dependencies. */
export function contextKey(L: TsLayout): string {
  return prop(toSnake(L.ca.ir.name));
}

/** `cleaningStaffInvitation`: an aggregate's member in the query factories (`queries.<context>.<aggregate>`). */
export function aggregateKey(aggregate: string): string {
  return prop(toSnake(aggregate));
}
/** `createCleaningStaffQueries` / `createCleaningStaffMutations`: the per-context factory creators. */
export function queriesCreator(L: TsLayout): string {
  return `create${pascal(L.ca.ir.name)}Queries`;
}
export function mutationsCreator(L: TsLayout): string {
  return `create${pascal(L.ca.ir.name)}Mutations`;
}
/** `cleaningStaffInvitationKey`: module constant with the fields every query key of the aggregate starts with. */
function baseKeyName(aggregate: string): string {
  return `${camel(toSnake(aggregate))}Key`;
}
/** `CleaningStaffInvitationJson`: schema (and type) of the aggregate's / entity's JSON form. */
export function jsonName(name: string): string {
  return `${name}Json`;
}

/** Kind of an aggregate's identity (core allows UUID, String or Integer). */
export type IdKind = "uuid" | "string" | "integer";

export function idKind(L: TsLayout, ag: AggregateIR): IdKind {
  const t = L.tsFieldType(ag.name, ag.identity);
  if (t?.k === "primitive" && t.name === "Integer") return "integer";
  if (t?.k === "primitive" && t.name === "String") return "string";
  return "uuid";
}

/** TypeScript type of an id parameter of the key factory / query options. */
export function idParam(kind: IdKind): string {
  return kind === "integer" ? "number" : "string";
}

/** An id value of `kind` as a code literal (a UUID in the canonical lower case when `canonical`). */
export function idLiteral(kind: IdKind, v: unknown, canonical = false): string {
  if (kind === "integer") return String(Number(v));
  return tsString(canonical && kind === "uuid" ? String(v).toLowerCase() : String(v));
}

export function useCasePath(api: ApiSettings, L: TsLayout, uc: UseCaseIR): string {
  return `${api.basePath}/${kebab(L.ca.ir.name)}/${kebab(uc.name)}`;
}
export function readPath(api: ApiSettings, L: TsLayout, ag: AggregateIR): string {
  return `${api.basePath}/${kebab(L.ca.ir.name)}/${kebab(ag.name)}/:id`;
}

// ---------------------------------------------------------------------------
// What a use case does, as the client needs to know it
// ---------------------------------------------------------------------------

function walk(steps: StepIR[], fn: (s: StepIR) => void): void {
  for (const s of steps) {
    fn(s);
    if (s.kind === "if") {
      walk(s.then, fn);
      walk(s.else, fn);
    }
  }
}

function errorCode(L: TsLayout, name: string): string {
  if (name === "AggregateNotFound") return "aggregate_not_found";
  if (name === "ConstraintViolation") return "constraint_violation";
  return L.ca.ir.errors.find((e) => e.name === name)?.code ?? toSnake(name);
}

/**
 * Domain error code → HTTP status for one use case: 400 constraint violations, 404 the load steps' not-found errors,
 * 409 the state guards its operations and factories require, 422 every other domain error it can raise (explicit
 * `fail`, invariants of the aggregates it changes and of the value objects in its input). The first status wins.
 */
export function useCaseErrors(L: TsLayout, uc: UseCaseIR): Map<string, ErrorStatus> {
  const out = new Map<string, ErrorStatus>([["constraint_violation", 400]]);
  if (L.model.security && requiresPrincipal(uc)) {
    out.set("unauthenticated", 401);
    out.set("not_authorized", 403);
  }
  const add = (name: string, status: ErrorStatus) => {
    const code = errorCode(L, name);
    if (!out.has(code)) out.set(code, status);
  };
  const changed: AggregateIR[] = [];
  const vars = new Map<string, string>();
  const guardErrors = (ag: AggregateIR, require: string[]) => {
    for (const r of require) {
      const g = ag.stateGuards.find((x) => x.name === r.replace(/\(.*$/s, "").trim());
      if (g) add(g.error, 409);
    }
  };
  walk(uc.steps, (s) => {
    if (s.kind === "load") {
      vars.set(s.as, s.aggregate);
      add(s.notFound ?? "AggregateNotFound", 404);
    }
  });
  walk(uc.steps, (s) => {
    if (s.kind === "invoke") {
      const ag = L.aggregate(vars.get(s.target) ?? "");
      const op = ag?.operations.find((o) => o.name === s.operation);
      if (ag && op) {
        guardErrors(ag, op.require);
        changed.push(ag);
      }
    }
    if (s.kind === "create") {
      const ag = L.aggregate(s.aggregate);
      const f = ag?.factories.find((x) => x.name === s.factory);
      if (ag && f) {
        guardErrors(ag, f.require);
        changed.push(ag);
      }
    }
  });
  walk(uc.steps, (s) => {
    if (s.kind === "fail") add(s.error, 422);
  });
  for (const ag of changed) for (const o of [ag, ...ag.entities]) for (const inv of o.invariants) add(inv.error, 422);
  const seen = new Set<string>();
  const voInvariants = (t: Type) => {
    if (t.k === "optional") voInvariants(t.inner);
    else if (t.k === "list") voInvariants(t.item);
    else if (t.k === "vo" && !seen.has(t.name)) {
      seen.add(t.name);
      for (const inv of L.ca.ir.valueObjects.find((v) => v.name === t.name)?.invariants ?? []) add(inv.error, 422);
      L.fieldTypes(t.name).forEach(voInvariants);
    }
  };
  L.fieldTypes(uc.command).forEach(voInvariants);
  return out;
}

/**
 * A query key a successful run of a use case makes stale: the detail of the loaded aggregate by an input field, every
 * detail of the aggregate (the identity is computed), or its lists.
 */
export type Invalidation = { aggregate: string; kind: "detail"; byInput: string } | { aggregate: string; kind: "details" | "lists" };

/** Query keys a successful run of the use case makes stale, in a stable order without duplicates. */
export function invalidations(L: TsLayout, uc: UseCaseIR): Invalidation[] {
  const bound = new Map<string, { aggregate: string; byInput?: string; created: boolean }>();
  const saved: string[] = [];
  // Only a required input field names one aggregate (an optional one may be absent: invalidate every detail then).
  const inputs = new Set(uc.input.filter((f) => f.required).map((f) => f.name));
  walk(uc.steps, (s) => {
    if (s.kind === "let") inputs.delete(s.name);
  });
  walk(uc.steps, (s) => {
    if (s.kind === "load") {
      const by = L.ca.exprs.get(formatPath([...s.path, "by"]));
      const byInput = by?.t === "local" && inputs.has(by.name) ? by.name : undefined;
      bound.set(s.as, { aggregate: s.aggregate, created: false, ...(byInput ? { byInput } : {}) });
    }
    if (s.kind === "create") bound.set(s.as, { aggregate: s.aggregate, created: true });
    if (s.kind === "save" && !saved.includes(s.target)) saved.push(s.target);
  });
  const out: Invalidation[] = [];
  const add = (k: Invalidation) => {
    if (!out.some((x) => invalidationExpr("q", x) === invalidationExpr("q", k))) out.push(k);
  };
  for (const v of saved) {
    const b = bound.get(v);
    if (!b) continue;
    if (!b.created) add(b.byInput ? { aggregate: b.aggregate, kind: "detail", byInput: b.byInput } : { aggregate: b.aggregate, kind: "details" });
    add({ aggregate: b.aggregate, kind: "lists" });
  }
  return out;
}

/** The query key of an invalidation as code over a context's query factories `q` (and the mutation's `input`). */
export function invalidationExpr(q: string, k: Invalidation): string {
  const member = `${q}.${aggregateKey(k.aggregate)}`;
  return k.kind === "detail" ? `${member}.detail(input.${prop(k.byInput)}).queryKey` : `${member}.${k.kind}()`;
}

/** Short label of an invalidation for docs: `detail(invitationId)`, `lists()`. */
export function invalidationLabel(k: Invalidation): string {
  return k.kind === "detail" ? `detail(${prop(k.byInput)})` : `${k.kind}()`;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Schema of a value in its JSON form: like the domain schema, but entities are plain objects (`XJson`). */
function jsonSchema(L: TsLayout, t: Type, imp: TsImports, constraints: object = {}): string {
  switch (t.k) {
    case "optional":
      return `${jsonSchema(L, t.inner, imp, constraints)}.nullable()`;
    case "entity":
    case "aggregate":
      return jsonName(t.name);
    case "list": {
      imp.value("zod", "z");
      const c = constraints as { min_items?: number; max_items?: number; min_length?: number; max_length?: number };
      let s = `z.array(${jsonSchema(L, t.item, imp)})`;
      const min = c.min_items ?? c.min_length;
      const max = c.max_items ?? c.max_length;
      if (min !== undefined) s += `.min(${min})`;
      if (max !== undefined) s += `.max(${max})`;
      return `${s}.readonly()`;
    }
    case "duration":
      imp.value("zod", "z");
      return "z.number()";
    case "null":
      imp.value("zod", "z");
      return "z.null()";
    case "event":
      imp.value("zod", "z");
      return "z.unknown()";
    default:
      return zodSchema(t, imp, L, constraints);
  }
}

function entityDeps(L: TsLayout, owner: string): string[] {
  const out: string[] = [];
  const visit = (t: Type) => {
    if (t.k === "optional") visit(t.inner);
    else if (t.k === "list") visit(t.item);
    else if (t.k === "entity") out.push(t.name);
  };
  L.fieldTypes(owner).forEach(visit);
  return out;
}

function errorsObject(errors: Map<string, ErrorStatus>): string {
  return `{ ${[...errors].map(([code, status]) => `${/^[A-Za-z_$][\w$]*$/.test(code) ? code : tsString(code)}: ${status}`).join(", ")} }`;
}

export function contextContractFile(L: TsLayout, api: ApiSettings): TsFile {
  const mod = L.apiContext(L.ca.ir.name, "contract");
  const imp = new TsImports(mod);
  const c = new Code();
  // Entities first (an entity's JSON form may hold other entities), then the aggregates.
  const owners = L.ca.ir.aggregates.flatMap((a) => [...a.entities.map((e) => ({ name: e.name, fields: e.fields, kind: "entity" })), { name: a.name, fields: a.fields, kind: "aggregate" }]);
  const done = new Set<string>();
  const ordered: typeof owners = [];
  const visit = (o: (typeof owners)[number]) => {
    if (done.has(o.name)) return;
    done.add(o.name);
    for (const d of entityDeps(L, o.name)) {
      const dep = owners.find((x) => x.name === d);
      if (dep) visit(dep);
    }
    ordered.push(o);
  };
  owners.forEach(visit);
  for (const o of ordered) {
    imp.value("zod", "z");
    const fields = o.fields.flatMap((f) => {
      const t = L.tsFieldType(o.name, f.name);
      return t ? [`${prop(f.name)}: ${jsonSchema(L, t, imp, f.constraints)},`] : [];
    });
    c.line();
    c.doc(
      o.kind === "aggregate"
        ? `JSON form of ${o.name} (what \`GET ${readPath(api, L, L.aggregate(o.name)!)}\` returns): its fields, validated, without behaviour. Unknown keys are dropped, so the server may add fields.`
        : `JSON form of the entity ${o.name} inside an aggregate's JSON form.`,
    );
    if (!fields.length) c.line(`export const ${jsonName(o.name)} = z.object({});`);
    else c.block(`export const ${jsonName(o.name)} = z.object(`, () => c.lines_(fields), ");");
    c.line(`export type ${jsonName(o.name)} = z.output<typeof ${jsonName(o.name)}>;`);
  }
  c.line();
  c.doc(`Endpoints of the ${L.ca.ir.name} context: a POST per use case, a GET per aggregate (load by identity).`);
  c.block("export const contract =", () => {
    if (!servedUseCases(L).length) c.line("useCases: {},");
    else c.block("useCases:", () => {
      for (const uc of servedUseCases(L)) {
        imp.value(L.apiModule("runtime"), "useCaseEndpoint");
        imp.value(L.mod("commands"), uc.command);
        const info = L.ca.useCases.get(uc.name)!;
        if (!info.returnType) imp.value("zod", "z");
        c.doc(`${uc.description ?? `Use case ${uc.name}`}${uc.actor ? ` (actor: ${uc.actor})` : ""}.`);
        c.block(`${prop(uc.name)}: useCaseEndpoint(`, () => {
          c.line(`name: ${tsString(uc.name)},`);
          c.line('method: "POST",');
          c.line(`path: ${tsString(useCasePath(api, L, uc))},`);
          c.line(`input: ${uc.command}.schema,`);
          c.line(`output: ${info.returnType ? jsonSchema(L, info.returnType, imp) : "z.void()"},`);
          c.line(`errors: ${errorsObject(useCaseErrors(L, uc))},`);
          securityLines(c, L, uc, uc.name);
        }, "),");
      }
    }, ",");
    c.block("aggregates:", () => {
      for (const ag of L.ca.ir.aggregates) {
        imp.value(L.apiModule("runtime"), "readEndpoint");
        c.doc(`Loads ${ag.name} by ${ag.identity}.`);
        c.block(`${prop(toSnake(ag.name))}: readEndpoint(`, () => {
          c.line(`name: ${tsString(ag.name)},`);
          c.line('method: "GET",');
          c.line(`path: ${tsString(readPath(api, L, ag))},`);
          c.line(`id: ${zodSchema(L.tsFieldType(ag.name, ag.identity)!, imp, L, ag.fields.find((f) => f.name === ag.identity)?.constraints ?? {})},`);
          c.line(`idType: ${idKind(L, ag) === "integer" ? '"number"' : '"string"'},`);
          c.line(`output: ${jsonName(ag.name)},`);
          const secured = !!L.model.security && requiresPrincipal(ag);
          c.line(`errors: { constraint_violation: 400, ${secured ? "unauthenticated: 401, not_authorized: 403, " : ""}aggregate_not_found: 404 },`);
          securityLines(c, L, ag, `read_${toSnake(ag.name)}`);
        }, "),");
      }
    }, ",");
  }, " as const;");
  return file(L, mod, `HTTP contract of the ${L.ca.ir.name} context (shared by the server handler and the client; zod only).`, imp, c.toString());
}

export function contractFile(P: TsPaths, Ls: TsLayout[], api: ApiSettings): TsFile {
  const mod = P.apiModule("contract");
  const imp = new TsImports(mod);
  const c = new Code();
  for (const L of Ls) imp.namespace(L.apiContext(L.ca.ir.name, "contract"), ident(toSnake(L.ca.ir.name)));
  c.line();
  c.doc("Path prefix of every endpoint (`generation.typescript.api.base_path`).");
  c.line(`export const API_BASE_PATH = ${tsString(api.basePath)};`);
  c.line();
  c.doc("Every endpoint, per bounded context.");
  if (!Ls.length) c.line("export const contract = {} as const;");
  else c.block("export const contract =", () => Ls.forEach((L) => c.line(`${contextKey(L)}: ${ident(toSnake(L.ca.ir.name))}.contract,`)), " as const;");
  return { path: P.file(mod), content: assemble(header(P.model), "HTTP contract of the API: the endpoints of every context.", imp, c.toString()) };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function serverFile(P: TsPaths, Ls: TsLayout[]): TsFile {
  const mod = P.apiModule("server");
  const imp = new TsImports(mod);
  const c = new Code();
  imp.value(P.apiModule("runtime"), "apiHandler");
  imp.type(P.apiModule("runtime"), "ApiHandlerOptions");
  imp.type(P.runtime, "Awaitable");
  const routes: string[] = [];
  c.line();
  c.doc(
    "What the handler calls, per context. Only what is given is served: a use case or repository left out answers 404, so a system-only use case (e.g. one run by a policy) stays private when it is not passed.",
  );
  c.block("export interface ApiDependencies", () => {
    for (const L of Ls) {
      const ns = ident(toSnake(L.ca.ir.name));
      imp.namespace(L.index, ns);
      const key = contextKey(L);
      c.block(`readonly ${key}?:`, () => {
        if (servedUseCases(L).length) {
          imp.value(P.apiModule("runtime"), "useCaseRoute");
          c.block("readonly useCases?:", () => {
            for (const uc of servedUseCases(L)) {
              pickLine(c, 3, prop(uc.name), `${ns}.${useCaseClass(uc)}`, "execute");
              routes.push(`useCaseRoute(contract.${key}.useCases.${prop(uc.name)}, (d) => d.${key}?.useCases?.${prop(uc.name)}),`);
            }
          }, ";");
        }
        if (L.ca.ir.aggregates.length) {
          imp.value(P.apiModule("runtime"), "readRoute");
          c.block("readonly repositories?:", () => {
            for (const ag of L.ca.ir.aggregates) {
              const repo = `${camel(toSnake(ag.name))}Repository`;
              pickLine(c, 3, repo, `${ns}.${ag.name}Repository`, "get");
              const read = protectedAggregates(L).includes(ag) ? `, ${ns}.${readAccessName(ag)}` : "";
              routes.push(`readRoute(contract.${key}.aggregates.${prop(toSnake(ag.name))}, (d) => d.${key}?.repositories?.${repo}${read}),`);
            }
          }, ";");
        }
      }, ";");
    }
  });
  if (routes.length) imp.value(P.apiModule("contract"), "contract");
  c.line();
  c.doc(
    [
      "The API as a Web-standard handler (`Request` → `Response`): use it with Bun.serve, Deno.serve, Hono (`app.all(\"/api/*\", (c) => handler(c.req.raw))`), a Next.js route handler or any fetch-style server.",
      "",
      P.model.security
        ? "Inputs are parsed with the command schemas (400 with the issues). Endpoints that need a principal authenticate the request with `options.authenticate` (401 with `WWW-Authenticate: Bearer` without valid credentials); the use cases and read access authorize it (403 NotAuthorized). Rate limits answer the RateLimit headers and 429 with Retry-After when used up (`options.rateLimiter`, `options.clientIp`). Domain errors answer `{ code, message, details }` with the endpoint's status (404 not found, 409 state conflict, 422 other rules); unexpected errors answer 500 without details and go to `options.onError`. Internal use cases (`authorize: internal`) have no endpoint."
        : "Inputs are parsed with the command schemas (400 with the issues). Domain errors answer `{ code, message, details }` with the endpoint's status (404 not found, 409 state conflict, 422 other rules); unexpected errors answer 500 without details and go to `options.onError`. There is no authentication or authorization: put that in front of the handler.",
      "",
      "`dependencies` is an object, or a function of the request (e.g. use cases with a unit of work per request).",
    ].join("\n"),
  );
  c.line("export function createApiHandler(");
  c.indent(() => {
    c.line("dependencies: ApiDependencies | ((request: Request) => Awaitable<ApiDependencies>),");
    c.line(`options: ApiHandlerOptions${P.model.security ? "<Principal>" : ""} = {},`);
  });
  if (P.model.security) imp.type(P.security, "Principal");
  const handlerTypes = P.model.security ? "<ApiDependencies, Principal>" : "<ApiDependencies>";
  c.block("): (request: Request) => Promise<Response>", () => {
    if (!routes.length) {
      c.line(`return apiHandler${handlerTypes}([], dependencies, options);`);
      return;
    }
    c.line(`return apiHandler${handlerTypes}(`);
    c.indent(() => {
      c.open("[", () => c.lines_(routes), "],");
      c.line("dependencies,");
      c.line("options,");
    });
    c.line(");");
  });
  return { path: P.file(mod), content: assemble(header(P.model), "Server side of the API: a Web-standard request handler over the generated use cases and repositories.", imp, c.toString()) };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function clientFile(P: TsPaths, Ls: TsLayout[]): TsFile {
  const mod = P.apiModule("client");
  const imp = new TsImports(mod);
  const c = new Code();
  imp.value(P.apiModule("runtime"), "createTransport");
  imp.type(P.apiModule("runtime"), "ApiClientOptions");
  for (const L of Ls) {
    const key = contextKey(L);
    const errorsNs = `${ident(toSnake(L.ca.ir.name))}Errors`;
    imp.namespace(L.mod("errors"), errorsNs);
    imp.value(P.apiModule("runtime"), "errorRegistry");
    imp.type(P.apiModule("runtime"), "Transport");
    imp.value(P.apiModule("contract"), "contract");
    const parts = [servedUseCases(L).length ? "useCases" : "", L.ca.ir.aggregates.length ? "aggregates" : ""].filter(Boolean);
    c.line();
    c.block(`function ${key}Client(transport: Transport)`, () => {
      c.line(`const { ${parts.join(", ")} } = contract.${key};`);
      if (P.model.security) {
        imp.value(P.security, "SECURITY_ERRORS");
        c.line(`const errors = errorRegistry([...${errorsNs}.ALL_ERRORS, ...SECURITY_ERRORS]);`);
      } else c.line(`const errors = errorRegistry(${errorsNs}.ALL_ERRORS);`);
      c.block("return", () => {
        if (!servedUseCases(L).length) c.line("useCases: {},");
        else {
          imp.value(P.apiModule("runtime"), "useCaseCaller");
          c.block("useCases:", () => {
            for (const uc of servedUseCases(L)) c.line(`${prop(uc.name)}: useCaseCaller(transport, useCases.${prop(uc.name)}, errors),`);
          }, ",");
        }
        if (!L.ca.ir.aggregates.length) c.line("aggregates: {},");
        else {
          imp.value(P.apiModule("runtime"), "readCaller");
          c.block("aggregates:", () => {
            for (const ag of L.ca.ir.aggregates) c.line(`${prop(toSnake(ag.name))}: readCaller(transport, aggregates.${prop(toSnake(ag.name))}, errors),`);
          }, ",");
        }
      }, ";");
    });
  }
  c.line();
  c.doc(
    [
      "A typed client of the API: `api.<context>.useCases.<useCase>(input)` and `api.<context>.aggregates.<aggregate>(id)`.",
      "",
      "Inputs are validated with the command schemas before sending, responses with the contract's output schemas. Error responses reject with the domain error class of their code (e.g. `InvitationNotFound`), anything else with an `ApiError`. Pass `fetch` to route requests elsewhere (the server handler in tests, a cookie-forwarding fetch in SSR).",
      ...(P.model.security
        ? [
            "",
            "`getToken` supplies the bearer token per request. 401 rejects with Unauthenticated, 403 with NotAuthorized, 429 with RateLimitedError (`retryAfter` in seconds); `apiRetry` / `apiRetryDelay` are the matching retry policy for the QueryClient defaults.",
          ]
        : []),
    ].join("\n"),
  );
  c.block("export function createApiClient(options: ApiClientOptions = {})", () => {
    c.line("const transport = createTransport(options);");
    if (!Ls.length) c.line("return { transport };");
    else c.block("return", () => Ls.forEach((L) => c.line(`${contextKey(L)}: ${contextKey(L)}Client(transport),`)), ";");
  });
  c.line();
  c.line("export type ApiClient = ReturnType<typeof createApiClient>;");
  return { path: P.file(mod), content: assemble(header(P.model), "Client side of the API: typed calls validated with the contract's schemas (no React, no TanStack Query).", imp, c.toString()) };
}

// ---------------------------------------------------------------------------
// TanStack Query: one factory object per aggregate (keys + queryOptions), mutationOptions per use case
// ---------------------------------------------------------------------------

export function queriesFile(L: TsLayout): TsFile {
  const mod = L.apiContext(L.ca.ir.name, "queries");
  const imp = new TsImports(mod);
  const c = new Code();
  const key = contextKey(L);
  const scope = kebab(L.ca.ir.name);
  const api = L.model.generation.typescript.api!;
  const aggregates = L.ca.ir.aggregates;
  for (const ag of aggregates) {
    c.line();
    c.doc(`Fields every query key of ${ag.name} starts with: the context (\`scope\`) and the aggregate (\`entity\`).`);
    c.line(`const ${baseKeyName(ag.name)} = { scope: ${tsString(scope)}, entity: ${tsString(kebab(ag.name))} } as const;`);
  }
  if (aggregates.length) {
    imp.value("@tanstack/react-query", "queryOptions", "skipToken");
    imp.type(L.apiModule("client"), "ApiClient");
    c.line();
    c.doc(
      [
        `Query factories of the ${L.ca.ir.name} aggregates: per aggregate one object with its query keys (\`all()\`, \`lists()\`, \`details()\`, for invalidation) and its \`queryOptions\` (\`detail(id)\`), from generic to specific.`,
        "",
        `Every key is an array with exactly one object (\`[{ scope, entity, kind, id }]\`): filters match it by name, so \`[{ scope: ${tsString(scope)} }]\` matches every query of the context, \`all()\` every query of the aggregate, \`details()\` every detail and \`detail(id).queryKey\` the one with that id. The options are not configurable; add \`select\`, \`staleTime\` or \`throwOnError\` at the call site: \`useQuery({ ...queries.x.detail(id), select })\`.`,
        "",
        "Create them once per API client (`createApiQueries(api)` builds every context); the client is a parameter so SSR and tests can bring their own.",
      ].join("\n"),
    );
    c.block(`export function ${queriesCreator(L)}(api: ApiClient)`, () => {
      c.block("return", () => {
        for (const ag of aggregates) {
          const base = baseKeyName(ag.name);
          const kind = idKind(L, ag);
          const T = idParam(kind);
          const call = (id: string) => `api.${key}.aggregates.${prop(toSnake(ag.name))}(${id}, { signal })`;
          c.block(`${aggregateKey(ag.name)}:`, () => {
            c.line(`all: () => [{ ...${base} }] as const,`);
            c.comment("Prefix of the list queries you add yourself (the model declares no queries yet).");
            c.line(`lists: () => [{ ...${base}, kind: "list" }] as const,`);
            c.line(`details: () => [{ ...${base}, kind: "detail" }] as const,`);
            c.doc(
              `The ${ag.name} with this ${ag.identity} (\`GET ${readPath(api, L, ag)}\`), validated with its JSON schema. For useQuery, useSuspenseQuery, \`queryClient.query\` (loaders, SSR) and \`getQueryData\`.${kind === "uuid" ? " The id in the key is lower-cased like the schema stores it." : ""}`,
            );
            c.line(`detail: (id: ${T}) =>`);
            c.indent(() => {
              c.block("queryOptions(", () => {
                c.line(`queryKey: [{ ...${base}, kind: "detail", ${kind === "uuid" ? "id: id.toLowerCase()" : "id"} }] as const,`);
                c.line(`queryFn: ({ queryKey: [{ id }], signal }) => ${call("id")},`);
              }, "),");
            });
            c.doc(
              "Like `detail`, but disabled (`skipToken`) while the id is undefined, for `useQuery` in a component that may not have the id yet. Not for useSuspenseQuery or `queryClient.query`, whose types reject `skipToken`. While disabled the key's `id` is undefined, which hashes like `details()` (never itself a query).",
            );
            c.line(`detailOrSkip: (id: ${T} | undefined) =>`);
            c.indent(() => {
              c.block("queryOptions(", () => {
                c.line(`queryKey: [{ ...${base}, kind: "detail", ${kind === "uuid" ? "id: id?.toLowerCase()" : "id"} }] as const,`);
                c.line(`queryFn: id === undefined ? skipToken : ({ signal }) => ${call("id")},`);
              }, "),");
            });
          }, ",");
        }
      }, ";");
    });
  }
  if (servedUseCases(L).length) {
    imp.value("@tanstack/react-query", "mutationOptions");
    imp.type(L.apiModule("client"), "ApiClient");
    const all = servedUseCases(L).map((uc) => invalidations(L, uc));
    c.line();
    c.doc(
      [
        `Mutation options of the ${L.ca.ir.name} use cases: \`useMutation(mutations.${key}.<useCase>)\`. On success each one invalidates the queries the model says it changed, through the query factories, and returns that promise: the mutation stays pending until the active queries have refetched.`,
        "",
        "Add UI reactions with `mutate(input, { onSuccess })` instead of overriding `onSuccess` here (that would drop the invalidation).",
      ].join("\n"),
    );
    c.block(`export function ${mutationsCreator(L)}(api: ApiClient)`, () => {
      if (all.some((ks) => ks.length)) c.line(`const queries = ${queriesCreator(L)}(api);`);
      c.block("return", () => {
        servedUseCases(L).forEach((uc, i) => {
          imp.type(L.mod("commands"), `${uc.command}Input`);
          const keys = all[i]!;
          c.doc(`${uc.description ?? `Use case ${uc.name}`} (\`POST ${useCasePath(api, L, uc)}\`).`);
          c.block(`${prop(uc.name)}: mutationOptions(`, () => {
            c.line(`mutationKey: [{ scope: ${tsString(scope)}, useCase: ${tsString(kebab(uc.name))} }],`);
            c.line(`mutationFn: (input: ${uc.command}Input) => api.${key}.useCases.${prop(uc.name)}(input),`);
            if (!keys.length) {
              c.comment("Saves no aggregate: nothing to invalidate.");
              return;
            }
            const usesInput = keys.some((k) => k.kind === "detail");
            const head = `onSuccess: (_data, ${usesInput ? "input" : "_input"}, _result, context) =>`;
            const inv = (k: Invalidation) => `context.client.invalidateQueries({ queryKey: ${invalidationExpr("queries", k)} })`;
            if (keys.length === 1) c.line(`${head} ${inv(keys[0]!)},`);
            else {
              c.line(head);
              c.indent(() => c.open("Promise.all([", () => keys.forEach((k) => c.line(`${inv(k)},`)), "]),"));
            }
          }, "),");
        });
      }, ";");
    });
  }
  return file(L, mod, `TanStack Query factories of the ${L.ca.ir.name} context: query keys and queryOptions per aggregate, mutationOptions per use case (no React API).`, imp, c.toString());
}

/** `createApiQueries(api)` / `createApiMutations(api)`: every context's factories, built once per API client. */
export function apiQueriesFile(P: TsPaths, Ls: TsLayout[]): TsFile {
  const mod = P.apiModule("queries");
  const imp = new TsImports(mod);
  const c = new Code();
  imp.type(P.apiModule("client"), "ApiClient");
  const withQueries = Ls.filter((L) => L.ca.ir.aggregates.length);
  const withMutations = Ls.filter((L) => servedUseCases(L).length);
  const creator = (name: string, doc: string, Lx: TsLayout[], fn: (L: TsLayout) => string) => {
    c.line();
    c.doc(doc);
    c.block(`export function ${name}(${Lx.length ? "api" : "_api"}: ApiClient)`, () => {
      if (!Lx.length) {
        c.line("return {};");
        return;
      }
      c.block("return", () => {
        for (const L of Lx) {
          imp.value(L.apiContext(L.ca.ir.name, "queries"), fn(L));
          c.line(`${contextKey(L)}: ${fn(L)}(api),`);
        }
      }, ";");
    });
  };
  creator(
    "createApiQueries",
    [
      "Query factories of every context: `queries.<context>.<aggregate>` holds the aggregate's query keys and queryOptions. Create them once next to the API client and use the same options everywhere:",
      "",
      "```ts",
      "export const queries = createApiQueries(api);",
      "useQuery(queries.<context>.<aggregate>.detail(id)); // or useSuspenseQuery",
      "await queryClient.query(queries.<context>.<aggregate>.detail(id)); // route loader, SSR",
      "queryClient.invalidateQueries({ queryKey: queries.<context>.<aggregate>.all() });",
      "```",
    ].join("\n"),
    withQueries,
    queriesCreator,
  );
  creator(
    "createApiMutations",
    "Mutation options of every context's use cases (`useMutation(mutations.<context>.<useCase>)`); each invalidates what its use case changes.",
    withMutations,
    mutationsCreator,
  );
  c.line();
  c.line("export type ApiQueries = ReturnType<typeof createApiQueries>;");
  c.line("export type ApiMutations = ReturnType<typeof createApiMutations>;");
  return { path: P.file(mod), content: assemble(header(P.model), "TanStack Query factories of the whole API: every context's query keys, queryOptions and mutationOptions (no React API).", imp, c.toString()) };
}
