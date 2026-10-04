/**
 * HTTP API of the TypeScript target (`generation.typescript.api`): a framework-agnostic contract, a Web-standard
 * server handler, a typed client and TanStack Query (v5) query / mutation options and hooks. Design notes and the
 * TkDodo rules the client follows: docs/09 §18; contract: docs/05 §8.
 */
import { formatPath, type AggregateIR, type ApiSettings, type StepIR, type Type, type UseCaseIR } from "@ddd/core";
import { useCaseClass } from "./application.ts";
import { assemble, Code, header, TsImports, tsString } from "./code.ts";
import { file, type TsFile } from "./domain.ts";
import type { TsLayout, TsPaths } from "./layout.ts";
import { camel, ident, kebab, pascal, prop, toSnake } from "./names.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";
import { zodSchema } from "./types.ts";

/** `readonly name?: Pick<Type, "member">;` at `depth`, broken like Prettier breaks long type arguments. */
function pickLine(c: Code, depth: number, name: string, type: string, member: string): void {
  const line = `readonly ${name}?: Pick<${type}, ${tsString(member)}>;`;
  if (strWidth("  ".repeat(depth) + line) <= PRINT_WIDTH) {
    c.line(line);
    return;
  }
  c.open(`readonly ${name}?: Pick<`, () => c.line(`${type},`).line(`${tsString(member)}`), ">;");
}

export type ErrorStatus = 400 | 404 | 409 | 422;

/** Contexts that get endpoints: those with use cases or aggregates. */
export function apiContexts(Ls: TsLayout[]): TsLayout[] {
  return Ls.filter((L) => L.ca.ir.useCases.length || L.ca.ir.aggregates.length);
}

/** `cleaningStaff`: the context's key in the contract, the client and the server dependencies. */
export function contextKey(L: TsLayout): string {
  return prop(toSnake(L.ca.ir.name));
}

/** `cleaningStaffInvitationKeys` / `…Queries` */
export function keysName(aggregate: string): string {
  return `${camel(toSnake(aggregate))}Keys`;
}
export function queriesName(aggregate: string): string {
  return `${camel(toSnake(aggregate))}Queries`;
}
export function mutationsName(L: TsLayout): string {
  return `${camel(toSnake(L.ca.ir.name))}Mutations`;
}
/** `CleaningStaffInvitationJson`: schema (and type) of the aggregate's / entity's JSON form. */
export function jsonName(name: string): string {
  return `${name}Json`;
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

/** Query keys a successful run of the use case makes stale (code expressions over `input`). */
export function invalidations(L: TsLayout, uc: UseCaseIR): string[] {
  const bound = new Map<string, { aggregate: string; byInput?: string; created: boolean }>();
  const saved: string[] = [];
  const inputs = new Set(uc.input.map((f) => f.name));
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
  const keys: string[] = [];
  const add = (k: string) => {
    if (!keys.includes(k)) keys.push(k);
  };
  for (const v of saved) {
    const b = bound.get(v);
    if (!b) continue;
    const k = keysName(b.aggregate);
    if (!b.created) add(b.byInput ? `${k}.detail(input.${prop(b.byInput)})` : `${k}.details()`);
    add(`${k}.lists()`);
  }
  return keys;
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
    c.block("useCases:", () => {
      for (const uc of L.ca.ir.useCases) {
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
          c.line(`id: ${zodSchema(L.tsFieldType(ag.name, ag.identity)!, imp, L)},`);
          c.line(`output: ${jsonName(ag.name)},`);
          c.line("errors: { constraint_violation: 400, aggregate_not_found: 404 },");
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
        if (L.ca.ir.useCases.length) {
          imp.value(P.apiModule("runtime"), "useCaseRoute");
          c.block("readonly useCases?:", () => {
            for (const uc of L.ca.ir.useCases) {
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
              routes.push(`readRoute(contract.${key}.aggregates.${prop(toSnake(ag.name))}, (d) => d.${key}?.repositories?.${repo}),`);
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
      "Inputs are parsed with the command schemas (400 with the issues). Domain errors answer `{ code, message, details }` with the endpoint's status (404 not found, 409 state conflict, 422 other rules); unexpected errors answer 500 without details and go to `options.onError`. There is no authentication or authorization: put that in front of the handler.",
      "",
      "`dependencies` is an object, or a function of the request (e.g. use cases with a unit of work per request).",
    ].join("\n"),
  );
  c.line("export function createApiHandler(");
  c.indent(() => {
    c.line("dependencies: ApiDependencies | ((request: Request) => Awaitable<ApiDependencies>),");
    c.line("options: ApiHandlerOptions = {},");
  });
  c.block("): (request: Request) => Promise<Response>", () => {
    if (!routes.length) {
      c.line("return apiHandler<ApiDependencies>([], dependencies, options);");
      return;
    }
    c.line("return apiHandler<ApiDependencies>(");
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
    const parts = [L.ca.ir.useCases.length ? "useCases" : "", L.ca.ir.aggregates.length ? "aggregates" : ""].filter(Boolean);
    c.line();
    c.block(`function ${key}Client(transport: Transport)`, () => {
      c.line(`const { ${parts.join(", ")} } = contract.${key};`);
      c.line(`const errors = errorRegistry(${errorsNs}.ALL_ERRORS);`);
      c.block("return", () => {
        if (!L.ca.ir.useCases.length) c.line("useCases: {},");
        else {
          imp.value(P.apiModule("runtime"), "useCaseCaller");
          c.block("useCases:", () => {
            for (const uc of L.ca.ir.useCases) c.line(`${prop(uc.name)}: useCaseCaller(transport, useCases.${prop(uc.name)}, errors),`);
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
// TanStack Query: keys, query options, mutation options, hooks
// ---------------------------------------------------------------------------

export function queriesFile(L: TsLayout): TsFile {
  const mod = L.apiContext(L.ca.ir.name, "queries");
  const imp = new TsImports(mod);
  const c = new Code();
  const key = contextKey(L);
  const ctxKebab = kebab(L.ca.ir.name);
  for (const ag of L.ca.ir.aggregates) {
    imp.value("@tanstack/react-query", "queryOptions", "skipToken");
    imp.type(L.apiModule("client"), "ApiClient");
    const K = keysName(ag.name);
    const Q = queriesName(ag.name);
    const call = `api.${key}.aggregates.${prop(toSnake(ag.name))}(id, { signal })`;
    c.line();
    c.doc(
      `Query keys of ${ag.name}, from generic to specific: invalidate \`all\` for everything, \`lists()\` for every list, \`detail(id)\` for one. Ids are lower-cased like the schema stores them.`,
    );
    c.block(`export const ${K} =`, () => {
      c.line(`all: [${tsString(ctxKebab)}, ${tsString(kebab(ag.name))}] as const,`);
      c.comment("Prefix of the list queries you add yourself (the model declares no queries yet).");
      c.line(`lists: () => [...${K}.all, "list"] as const,`);
      c.line(`details: () => [...${K}.all, "detail"] as const,`);
      c.line(`detail: (id: string | undefined) => [...${K}.details(), id?.toLowerCase()] as const,`);
    }, ";");
    c.line();
    c.doc(`Query options of ${ag.name}: key and fetcher together, for useQuery, useSuspenseQuery, queryClient.query and prefetching.`);
    c.block(`export const ${Q} =`, () => {
      c.doc(`The ${ag.name} with this ${ag.identity}, validated with its JSON schema (\`GET ${readPath(L.model.generation.typescript.api!, L, ag)}\`).`);
      c.line("detail: (api: ApiClient, id: string) =>");
      c.indent(() => {
        c.block("queryOptions(", () => {
          c.line(`queryKey: ${K}.detail(id),`);
          c.line(`queryFn: ({ signal }) => ${call},`);
        }, "),");
      });
      c.doc("Like `detail`, but disabled (skipToken) while the id is undefined. Not for useSuspenseQuery.");
      c.line("detailOrSkip: (api: ApiClient, id: string | undefined) =>");
      c.indent(() => {
        c.block("queryOptions(", () => {
          c.line(`queryKey: ${K}.detail(id),`);
          c.line(`queryFn: id === undefined ? skipToken : ({ signal }) => ${call},`);
        }, "),");
      });
    }, ";");
  }
  if (L.ca.ir.useCases.length) {
    imp.value("@tanstack/react-query", "mutationOptions");
    imp.type(L.apiModule("client"), "ApiClient");
    c.line();
    c.doc(
      [
        `Mutation options of the ${L.ca.ir.name} use cases. On success each one invalidates the queries the model says it changed, and returns that promise: the mutation stays pending until the active queries have refetched.`,
        "",
        "Add UI reactions with `mutate(input, { onSuccess })` instead of overriding `onSuccess` here.",
      ].join("\n"),
    );
    c.block(`export const ${mutationsName(L)} =`, () => {
      for (const uc of L.ca.ir.useCases) {
        imp.type(L.mod("commands"), `${uc.command}Input`);
        const keys = invalidations(L, uc);
        c.doc(`${uc.description ?? `Use case ${uc.name}`} (\`POST ${useCasePath(L.model.generation.typescript.api!, L, uc)}\`).`);
        c.line(`${prop(uc.name)}: (api: ApiClient) =>`);
        c.indent(() => {
          c.block("mutationOptions(", () => {
            c.line(`mutationKey: [${tsString(ctxKebab)}, ${tsString(kebab(uc.name))}],`);
            c.line(`mutationFn: (input: ${uc.command}Input) => api.${key}.useCases.${prop(uc.name)}(input),`);
            if (!keys.length) {
              c.comment("Saves no aggregate: nothing to invalidate.");
              return;
            }
            const usesInput = keys.some((k) => k.includes("(input."));
            const head = `onSuccess: (_data, ${usesInput ? "input" : "_input"}, _result, context) =>`;
            const inv = (k: string) => `context.client.invalidateQueries({ queryKey: ${k} })`;
            if (keys.length === 1) c.line(`${head} ${inv(keys[0]!)},`);
            else {
              c.line(head);
              c.indent(() => c.open("Promise.all([", () => keys.forEach((k) => c.line(`${inv(k)},`)), "]),"));
            }
          }, "),");
        });
      }
    }, ";");
  }
  return file(L, mod, `TanStack Query keys, query options and mutation options of the ${L.ca.ir.name} context (no React).`, imp, c.toString());
}

export function hooksFile(L: TsLayout): TsFile {
  const mod = L.apiContext(L.ca.ir.name, "hooks");
  const imp = new TsImports(mod);
  const c = new Code();
  const queries = L.apiContext(L.ca.ir.name, "queries");
  for (const ag of L.ca.ir.aggregates) {
    imp.value("@tanstack/react-query", "useQuery");
    imp.value(L.apiModule("react"), "useApiClient");
    imp.value(queries, queriesName(ag.name));
    c.line();
    c.doc(`The ${ag.name} with this ${ag.identity} (\`useQuery\`); disabled while the id is undefined. Check \`data\` before \`error\`: a failed background refetch keeps the last data.`);
    c.block(`export function use${ag.name}(id: string | undefined)`, () => {
      c.line(`return useQuery(${queriesName(ag.name)}.detailOrSkip(useApiClient(), id));`);
    });
  }
  for (const uc of L.ca.ir.useCases) {
    imp.value("@tanstack/react-query", "useMutation");
    imp.value(L.apiModule("react"), "useApiClient");
    imp.value(queries, mutationsName(L));
    c.line();
    c.doc(`Runs use case ${uc.name} (\`useMutation\`); invalidates what it changes before it settles.`);
    c.block(`export function use${pascal(uc.name)}()`, () => {
      c.line(`return useMutation(${mutationsName(L)}.${prop(uc.name)}(useApiClient()));`);
    });
  }
  if (!L.ca.ir.aggregates.length && !L.ca.ir.useCases.length) c.line("export {};");
  return file(L, mod, `React hooks of the ${L.ca.ir.name} context: thin wrappers over the query and mutation options.`, imp, c.toString());
}
