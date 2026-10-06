/**
 * Generated tests of the HTTP API of one context: the client and TanStack Query run against the generated server
 * handler (no DOM, no network), backed by the in-memory test doubles. They check the object query keys and how filters
 * match them, the validated data, the error mapping (status and domain error class) and that each mutation
 * invalidates exactly what it changes. They use the factories like an app does: `queries.<context>.<aggregate>`.
 */
import { effectiveRateLimit, evaluateOnValues, formatPath, makePrincipal, otherRoles, requiresPrincipal, scenarioPrincipal, windowSeconds, type AggregateIR, type RateLimitIR, type Type, type UseCaseIR, type UseCaseScenarioIR } from "@ddd/core";
import { aggregateKey, contextKey, idKind, idLiteral, invalidationLabel, invalidations, readPath, servedUseCases, useCaseErrors, useCasePath, type IdKind } from "./api.ts";
import { repoName } from "./application.ts";
import { Code, TsImports, tsString } from "./code.ts";
import type { TsFile } from "./domain.ts";
import type { TsLayout } from "./layout.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";
import { kebab, prop, toSnake } from "./names.ts";
import { build, importError, principalLiteral, testFile, useCaseSetup } from "./tests.ts";
import { expectEqual, record, typedValue } from "./values.ts";
import { contextPlans, inputObject, protectedQuery, queryClass, readerName, TEST_SECRET } from "./queries.ts";
import type { QueryPlan } from "@ddd/core";
import { queryKey, queryPath } from "./api.ts";

const ORIGIN = "http://localhost";

/**
 * `const { … } = connect({ context: { … } });` inside a test (depth 2), expanded like Prettier expands an object
 * argument that does not fit.
 */
function connectLine(c: Code, names: string, key: string, parts: string[], principal?: string): void {
  const inner = `{ ${parts.join(", ")} }`;
  const head = `const { ${names} } = connect(`;
  const tail = principal ? `, ${principal})` : ")";
  if (strWidth(`    ${head}{ ${key}: ${inner} }${tail};`) <= PRINT_WIDTH) {
    c.line(`${head}{ ${key}: ${inner} }${tail};`);
    return;
  }
  if (principal) {
    c.line(head);
    c.indent(() => {
      if (strWidth(`      { ${key}: ${inner} },`) <= PRINT_WIDTH) c.line(`{ ${key}: ${inner} },`);
      else {
        c.open("{", () => {
          if (strWidth(`        ${key}: ${inner},`) <= PRINT_WIDTH) c.line(`${key}: ${inner},`);
          else c.open(`${key}: {`, () => parts.forEach((p) => c.line(`${p},`)), "},");
        }, "},");
      }
      c.line(`${principal},`);
    });
    c.line(");");
    return;
  }
  c.open(`${head}{`, () => {
    if (strWidth(`      ${key}: ${inner},`) <= PRINT_WIDTH) c.line(`${key}: ${inner},`);
    else c.open(`${key}: {`, () => parts.forEach((p) => c.line(`${p},`)), "},");
  }, "});");
}
/** An id no scenario uses: its cache entry must never be invalidated by a mutation of another aggregate. */
const OTHER_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

function otherId(kind: IdKind): string {
  return kind === "integer" ? "987654321" : kind === "string" ? '"no-such-id"' : tsString(OTHER_ID);
}

/** An id literal for the key-matching test (canonical: a UUID in lower case). */
function someId(kind: IdKind): string {
  return kind === "integer" ? "1" : kind === "string" ? '"some-id"' : '"00000000-0000-4000-8000-000000000001"';
}

/** `cleaningStaffInvitationQueries`: a test's local name for an aggregate's query factory. */
function factory(ag: AggregateIR): string {
  return `${aggregateKey(ag.name)}Queries`;
}

/** `const cleaningStaffInvitationQueries = queries.cleaningStaff.cleaningStaffInvitation;` (reached like an app does). */
function factoryLine(L: TsLayout, ag: AggregateIR): string {
  return `const ${factory(ag)} = queries.${contextKey(L)}.${aggregateKey(ag.name)};`;
}

function hasEntity(t: Type): boolean {
  if (t.k === "optional") return hasEntity(t.inner);
  if (t.k === "list") return hasEntity(t.item);
  return t.k === "entity" || t.k === "aggregate" || t.k === "event";
}

/** Field values of a stored `ag` taken from the scenarios (given aggregates, then aggregate scenarios). */
function sampleAggregate(L: TsLayout, ag: AggregateIR): Record<string, unknown> | undefined {
  for (const uc of L.ca.ir.useCases) for (const sc of uc.scenarios) for (const a of sc.given.aggregates) if (a.type === ag.name) return a.fields;
  for (const sc of ag.scenarios) if (sc.given && !sc.then.raises) return sc.given.aggregate;
  for (const sc of ag.scenarios) if (sc.when.kind === "construct" && !sc.then.raises) return sc.when.fields;
  return undefined;
}

export function apiTestFile(L: TsLayout): TsFile | undefined {
  const api = L.model.generation.typescript.api;
  if (!api) return undefined;
  const module = L.testModule("api");
  const imp = new TsImports(module);
  const c = new Code();
  imp.value("@tanstack/react-query", "QueryClient");
  imp.value(L.apiModule("server"), "createApiHandler");
  imp.type(L.apiModule("server"), "ApiDependencies");
  imp.value(L.apiModule("client"), "createApiClient");
  imp.value(L.apiModule("queries"), "createApiQueries", "createApiMutations");
  c.line();
  c.doc(
    "The client wired to the generated server handler (its `fetch`): requests never leave the process. The query and mutation factories are built from it once, as an app does. Retries are off, as in any test of TanStack Query.",
  );
  const sec = L.model.security;
  if (sec) {
    imp.value(L.security, "Principal");
    c.doc("A principal holding every role: the requests of these tests authenticate as it unless a test says otherwise.");
    c.line(`const everyone = ${principalLiteral(L, makePrincipal(sec, { roles: sec.roles, claims: {} }), imp)};`);
    c.line();
    c.doc("What the client sends (`getToken`) and the test authenticator accepts.");
    c.line('const AUTHORIZATION = { authorization: "Bearer test-token" };');
    c.line();
  }
  c.block(sec ? "function connect(dependencies: ApiDependencies, principal: Principal | null = everyone)" : "function connect(dependencies: ApiDependencies)", () => {
    if (sec) {
      c.block("const handler = createApiHandler(dependencies,", () => {
        c.comment("The bearer token the client sends stands for `principal` (the JWT authenticator is tested on its own).");
        c.line("authenticate: (request) =>");
        c.indent(() => c.line('Promise.resolve(request.headers.get("authorization") === AUTHORIZATION.authorization ? principal : null),'));
      }, ");");
    } else c.line("const handler = createApiHandler(dependencies);");
    c.line("const statuses: number[] = [];");
    c.block("const api = createApiClient(", () => {
      c.line(`baseUrl: ${tsString(ORIGIN)},`);
      if (sec) c.line('getToken: () => "test-token",');
      c.block("fetch: async (request) =>", () => {
        c.line("const response = await handler(request);");
        c.line("statuses.push(response.status);");
        c.line("return response;");
      }, ",");
    }, ");");
    c.line("const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });");
    c.line("const queries = createApiQueries(api);");
    c.line("const mutations = createApiMutations(api);");
    c.line("return { handler, queryClient, statuses, queries, mutations };");
  });
  c.line();
  c.doc("The JSON body of a response.");
  c.block("async function responseJson(response: Response): Promise<unknown>", () => {
    c.line("return JSON.parse(await response.text()) as unknown;");
  });
  c.line();
  c.block(`describe(${tsString(`${L.ca.ir.name} API (server handler + TanStack Query client)`)}, () =>`, () => {
    let first = true;
    const sep = () => {
      if (!first) c.line();
      first = false;
    };
    handlerTest(L, c, imp, sep);
    if (sec) securityTests(L, c, imp, sep);
    if (sec) querySecurityTests(L, c, imp, sep);
    for (const ag of L.ca.ir.aggregates) {
      sep();
      readTest(L, c, ag, imp);
      sep();
      keyMatchTest(L, c, ag);
    }
    for (const plan of contextPlans(L)) {
      sep();
      queryApiTest(L, c, plan, imp);
    }
    for (const uc of servedUseCases(L)) {
      const ok = uc.scenarios.find((s) => !s.then.raises);
      const failing = uc.scenarios.find((s) => s.then.raises);
      for (const sc of [ok, failing]) {
        if (!sc) continue;
        sep();
        mutationTest(L, c, uc, sc, imp);
      }
    }
  }, ");");
  return testFile(L, module, `HTTP API of the ${L.ca.ir.name} context: server handler, client and TanStack Query options, end to end without a network.`, imp, c.toString());
}

/**
 * A query through HTTP and TanStack Query: the infinite query's object key under `lists()`, every page fetched by
 * following `nextCursor` gives the query's whole result, `lists()` invalidates it, and the HTTP layer answers 400 for a
 * bad cursor (`invalid_cursor`) or an unknown query parameter.
 */
function queryApiTest(L: TsLayout, c: Code, plan: QueryPlan, imp: TsImports): void {
  const key = contextKey(L);
  const ag = plan.aggregate;
  const sample = plan.query.scenarios.find((s) => (s.then.items?.length ?? 0) >= 2) ?? plan.query.scenarios[0];
  const params = sample?.when.params ?? {};
  const rows = sample?.given.aggregates ?? [];
  const api = L.model.generation.typescript.api!;
  const name = queryKey(plan);
  imp.value(L.contextTesting, `InMemory${ag.name}Repository`, `InMemory${readerName(plan)}`, "jsonOf");
  imp.value(L.persistenceRuntime, "HmacCursorCodec");
  imp.value(L.queries, queryClass(plan));
  imp.value(L.mod("aggregates"), ag.name);
  c.doc(
    `\`queries.${key}.${aggregateKey(ag.name)}.${name}(params)\` runs ${plan.query.name} through \`GET ${queryPath(api, L, plan)}\` as an infinite query: its key is under \`lists()\` (so the mutations that save ${ag.name} invalidate it), following \`nextCursor\` page by page gives the whole result, and a bad cursor or an unknown query parameter is answered 400.`,
  );
  c.block(`test(${tsString(`${plan.query.name}: infinite query over HTTP`)}, async () =>`, () => {
    c.line(`const repository = new InMemory${ag.name}Repository();`);
    if (rows.length) {
      c.open("repository.seed(", () => rows.forEach((r) => c.line(`${ag.name}.from(${record(ag.name, r.fields, imp, L)}),`)), ");");
    }
    c.line(`const cursors = new HmacCursorCodec({ secrets: [${tsString(TEST_SECRET)}] });`);
    c.line(`const ${name} = new ${queryClass(plan)}({ reader: new InMemory${readerName(plan)}(repository), cursors });`);
    const secured = protectedQuery(L, plan);
    if (secured) {
      // The client's token stands for the scenario's caller (rows scoped to it, cursors bound to it).
      c.line(`const principal = ${principalLiteral(L, scenarioPrincipal(L.model.security!, plan.query, sample ?? { given: {} }), imp)};`);
    }
    connectLine(c, "handler, queries, queryClient, statuses", key, [`queries: { ${name} }`], secured ? "principal" : undefined);
    c.line(factoryLine(L, ag));
    const input = inputObject(L, plan, params, imp, ["limit: 1"]);
    c.line(`const options = ${factory(ag)}.${name}(${input});`);
    c.line(
      `expect([...options.queryKey]).toEqual([{ scope: ${tsString(kebab(L.ca.ir.name))}, entity: ${tsString(kebab(ag.name))}, kind: "list", query: ${tsString(kebab(plan.query.name))}, params: ${input} }]);`,
    );
    c.line(`const whole = await ${name}.execute(${inputObject(L, plan, params, imp, [`limit: ${plan.query.page.maxSize}`])}${secured ? ", principal" : ""});`);
    c.line("const data = await queryClient.infiniteQuery({ ...options, pages: whole.items.length + 1 });");
    c.line("expect(jsonOf(data.pages.flatMap((page) => page.items))).toEqual(jsonOf(whole.items));");
    c.line("expect(data.pages.at(-1)?.nextCursor).toBeNull();");
    c.line("expect(statuses.every((status) => status === 200)).toBe(true);");
    c.line(`await queryClient.invalidateQueries({ queryKey: ${factory(ag)}.lists(), refetchType: "none" });`);
    c.line("expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(true);");
    c.line(`const path = ${tsString(`${ORIGIN}${queryPath(api, L, plan)}`)};`);
    // The scenario's parameters as query-string text (model names), plus a cursor the server never issued.
    const text = Object.entries(params).map(([k, v]) => `${k}: ${tsString(String(v))}`);
    c.line(`const query = new URLSearchParams({ ${[...text, 'cursor: "not-a-cursor"'].join(", ")} });`);
    if (secured) {
      c.line("const badCursor = await handler(");
      c.indent(() => c.line("new Request(`${path}?${query.toString()}`, { headers: AUTHORIZATION }),"));
      c.line(");");
    } else c.line("const badCursor = await handler(new Request(`${path}?${query.toString()}`));");
    c.line("expect(badCursor.status).toBe(400);");
    c.line('expect(await responseJson(badCursor)).toMatchObject({ code: "invalid_cursor" });');
    c.line(`const unknown = await handler(new Request(path + "?no_such_parameter=1"${secured ? ", { headers: AUTHORIZATION }" : ""}));`);
    c.line("expect(unknown.status).toBe(400);");
    c.line('expect(await responseJson(unknown)).toMatchObject({ code: "constraint_violation" });');
  }, ");");
}

/** Routing and the error responses that do not come from the domain. */
function handlerTest(L: TsLayout, c: Code, imp: TsImports, sep: () => void): void {
  const api = L.model.generation.typescript.api!;
  const uc = servedUseCases(L).find((u) => u.scenarios.length);
  const ag = L.ca.ir.aggregates[0];
  const key = contextKey(L);
  sep();
  c.doc("Unknown paths and unwired endpoints answer 404, a wrong method 405 with Allow; an invalid id is a ConstraintViolation (400).");
  c.block(`test("routing: 404, 405 and 400 responses", async () =>`, () => {
    c.line("const { handler } = connect({});");
    c.line(`const unknown = await handler(new Request(${tsString(`${ORIGIN}${api.basePath}/no-such-endpoint`)}));`);
    c.line("expect(unknown.status).toBe(404);");
    c.line('expect(await responseJson(unknown)).toMatchObject({ code: "route_not_found" });');
    if (servedUseCases(L).length) {
      const path = `${ORIGIN}${useCasePath(api, L, servedUseCases(L)[0]!)}`;
      c.line(`const wrongMethod = await handler(new Request(${tsString(path)}));`);
      c.line("expect(wrongMethod.status).toBe(405);");
      c.line('expect(wrongMethod.headers.get("allow")).toBe("POST");');
      c.comment("A use case the app did not pass to the handler is not served.");
      const auth = L.model.security && requiresPrincipal(servedUseCases(L)[0]!) ? ", headers: AUTHORIZATION" : "";
      c.line(`const unwired = await handler(new Request(${tsString(path)}, { method: "POST", body: "{}"${auth} }));`);
      c.line("expect(unwired.status).toBe(404);");
    }
    if (ag) {
      imp.value(L.contextTesting, `InMemory${ag.name}Repository`);
      const repo = repoName(ag.name);
      c.line(`const ${repo} = new InMemory${ag.name}Repository();`);
      c.line(`const served = connect({ ${key}: { repositories: { ${repo} } } });`);
      if (idKind(L, ag) !== "string") {
        const path = `${ORIGIN}${readPath(api, L, ag).replace(":id", "not-an-id")}`;
        const auth = L.model.security && requiresPrincipal(ag) ? ", { headers: AUTHORIZATION }" : "";
        c.line(`const invalid = await served.handler(new Request(${tsString(path)}${auth}));`);
        c.line("expect(invalid.status).toBe(400);");
        c.line('expect(await responseJson(invalid)).toMatchObject({ code: "constraint_violation" });');
      }
      c.comment("Malformed percent-encoding matches no endpoint (the handler never throws).");
      const malformed = `${ORIGIN}${readPath(api, L, ag).replace(":id", "%E0%A4%A")}`;
      c.line(`const malformed = await served.handler(new Request(${tsString(malformed)}));`);
      c.line("expect(malformed.status).toBe(404);");
    }
  }, ");");
  if (!uc) return;
  const sc = uc.scenarios[0]!;
  sep();
  c.doc("A body that is not JSON is a ConstraintViolation (400). An unexpected error answers 500 without its message and goes to onError.");
  c.block(`test("server errors: invalid JSON is 400, a failure is 500 without details", async () =>`, () => {
    c.line("const failures: unknown[] = [];");
    c.line("const handler = createApiHandler(");
    c.indent(() => {
      c.line(`{ ${key}: { useCases: { ${prop(uc.name)}: { execute: () => Promise.reject(new Error("database is down")) } } } },`);
      c.open("{", () => {
        c.block("onError: (error) =>", () => c.line("failures.push(error);"), ",");
        if (L.model.security && requiresPrincipal(uc)) c.line("authenticate: () => Promise.resolve(everyone),");
      }, "},");
    });
    c.line(");");
    const url = tsString(`${ORIGIN}${useCasePath(api, L, uc)}`);
    c.line(`const invalid = await handler(new Request(${url}, { method: "POST", body: "{" }));`);
    c.line("expect(invalid.status).toBe(400);");
    c.line('expect(await responseJson(invalid)).toMatchObject({ code: "constraint_violation" });');
    c.line(`const body = JSON.stringify(${record(uc.command, sc.when.input, imp, L)});`);
    c.line(`const failed = await handler(new Request(${url}, { method: "POST", body }));`);
    c.line("expect(failed.status).toBe(500);");
    c.line('expect(await responseJson(failed)).toEqual({ code: "internal_error", message: "Internal server error" });');
    c.line("expect(failures).toHaveLength(1);");
  }, ");");
}

/** The detail query: object key, fetched JSON form, typed cache data, 404 → AggregateNotFound. */
function readTest(L: TsLayout, c: Code, ag: AggregateIR, imp: TsImports): void {
  const key = contextKey(L);
  const repo = repoName(ag.name);
  const F = factory(ag);
  const kind = idKind(L, ag);
  const sample = sampleAggregate(L, ag);
  imp.value(L.contextTesting, `InMemory${ag.name}Repository`, "expectRejects");
  imp.value(L.runtime, "AggregateNotFound");
  c.doc(
    `\`queries.${key}.${aggregateKey(ag.name)}.detail(id)\` loads a stored ${ag.name} through \`GET ${readPath(L.model.generation.typescript.api!, L, ag)}\`: an object key (\`{ scope, entity, kind, id }\`${kind === "uuid" ? ", the id lower-cased" : ""}), the JSON form validated by its schema, the same data in the cache. An unknown id rejects with AggregateNotFound (404).`,
  );
  c.block(`test(${tsString(`${ag.name}: detail query`)}, async () =>`, () => {
    c.line(`const ${repo} = new InMemory${ag.name}Repository();`);
    connectLine(c, "queries, queryClient, statuses", key, [`repositories: { ${repo} }`]);
    c.line(factoryLine(L, ag));
    const id = sample?.[ag.identity];
    if (sample && (typeof id === "string" || typeof id === "number")) {
      imp.value(L.contextTesting, "jsonOf");
      c.line(`const stored = ${build(L, ag.name, "aggregate", sample, imp)};`);
      c.line(`${repo}.seed(stored);`);
      c.line(`const options = ${F}.detail(${kind === "uuid" ? tsString(String(id).toUpperCase()) : idLiteral(kind, id)});`);
      c.line(
        `expect([...options.queryKey]).toEqual([{ scope: ${tsString(kebab(L.ca.ir.name))}, entity: ${tsString(kebab(ag.name))}, kind: "detail", id: ${idLiteral(kind, id, true)} }]);`,
      );
      const allowed = readAllowed(L, ag, sample);
      if (allowed === false) {
        imp.value(L.security, "NotAuthorized");
        c.comment("allow_if does not hold for this principal and aggregate: 403.");
        c.line("await expectRejects(() => queryClient.query(options), NotAuthorized);");
        c.line("expect(statuses).toEqual([403]);");
      } else {
        c.line("const data = await queryClient.query(options);");
        c.line("expect(statuses).toEqual([200]);");
        c.line("expect(jsonOf(data)).toEqual(jsonOf(stored));");
        c.line('expect(queryClient.getQueryState(options.queryKey)?.status).toBe("success");');
      }
    }
    // An unknown id that still passes the identity's schema (a constrained String / Integer id may reject any guess).
    const constrained = Object.keys(ag.fields.find((f) => f.name === ag.identity)?.constraints ?? {}).length > 0;
    if (kind === "uuid" || !constrained) {
      c.line(`const missing = ${F}.detail(${otherId(kind)});`);
      c.line("const error = await expectRejects(() => queryClient.query(missing), AggregateNotFound);");
      c.line(`expect(error.details).toMatchObject({ aggregate: ${tsString(ag.name)} });`);
      c.line("expect(statuses.at(-1)).toBe(404);");
      c.line("expect(queryClient.getQueryState(missing.queryKey)?.error).toBe(error);");
    }
  }, ");");
}

/**
 * Object keys are matched by name (a partial deep match, independent of property order): a detail's key touches only
 * that id, `details()` every detail, `all()` every query of the aggregate, and nothing of another scope.
 */
function keyMatchTest(L: TsLayout, c: Code, ag: AggregateIR): void {
  const F = factory(ag);
  const kind = idKind(L, ag);
  c.doc(
    `Filters match the object keys of ${ag.name} by name: \`detail(id).queryKey\` touches only that id, \`details()\` every detail, \`all()\` every query of the aggregate, and the same entity under another scope is never touched.`,
  );
  c.block(`test(${tsString(`${ag.name}: object query keys match by name`)}, async () =>`, () => {
    c.line("const { queries, queryClient } = connect({});");
    c.line(factoryLine(L, ag));
    c.line(`const target = [{ ...${F}.details()[0], id: ${someId(kind)} }] as const;`);
    c.line(`const neighbour = [{ ...${F}.details()[0], id: ${otherId(kind)} }] as const;`);
    c.line(`const list = [{ ...${F}.lists()[0], page: 1 }] as const;`);
    c.line(`const elsewhere = [{ ...${F}.details()[0], scope: "another-context", id: ${someId(kind)} }] as const;`);
    c.line("const keys = [target, neighbour, list, elsewhere];");
    c.block("for (const key of keys)", () => c.line("queryClient.setQueryData(key, null);"));
    c.line("const invalidated = () => keys.map((key) => queryClient.getQueryState(key)?.isInvalidated);");
    c.line(`await queryClient.invalidateQueries({ queryKey: ${F}.detail(${someId(kind)}).queryKey });`);
    c.line("expect(invalidated()).toEqual([true, false, false, false]);");
    c.line(`await queryClient.invalidateQueries({ queryKey: ${F}.details() });`);
    c.line("expect(invalidated()).toEqual([true, true, false, false]);");
    c.line(`await queryClient.invalidateQueries({ queryKey: ${F}.all() });`);
    c.line("expect(invalidated()).toEqual([true, true, true, false]);");
  }, ");");
}

/** One scenario run as a mutation through the client: result, status, invalidated keys, state seen by a refetch. */
function mutationTest(L: TsLayout, c: Code, uc: UseCaseIR, sc: UseCaseScenarioIR, imp: TsImports): void {
  const key = contextKey(L);
  const info = L.ca.useCases.get(uc.name)!;
  const then = sc.then;
  const keys = invalidations(L, uc);
  imp.value("@tanstack/react-query", "MutationObserver");
  c.doc(
    [
      `Scenario \`${sc.name}\` of ${uc.name} as a mutation (\`POST ${useCasePath(L.model.generation.typescript.api!, L, uc)}\`).`,
      then.raises
        ? `It rejects with ${then.raises} and invalidates nothing.`
        : keys.length
          ? `On success it invalidates ${keys.map(invalidationLabel).join(", ")} of what it changes, and nothing else.`
          : "It saves no aggregate and invalidates nothing.",
    ].join("\n"),
  );
  c.block(`test(${tsString(`${uc.name}: ${sc.name}`)}, async () =>`, () => {
    const repos = useCaseSetup(L, c, uc, sc, imp);
    const deps = [`useCases: { ${prop(uc.name)}: useCase }`];
    if (repos.length) deps.push(`repositories: { ${repos.map(repoName).join(", ")} }`);
    // Cache entries the mutation may make stale: stored aggregates fetched through the API, plus probes.
    const probes: { expr: string; invalidated: boolean }[] = [];
    const input = sc.when.input;
    const fetched = new Set<string>();
    const cache: string[] = [];
    for (const a of sc.given.aggregates) {
      const ag = L.aggregate(a.type)!;
      const id = a.fields[ag.identity];
      if (typeof id !== "string" && typeof id !== "number") continue;
      const canonical = idKind(L, ag) === "uuid" ? String(id).toLowerCase() : String(id);
      if (fetched.has(`${ag.name}:${canonical}`)) continue;
      fetched.add(`${ag.name}:${canonical}`);
      cache.push(`await queryClient.query(${factory(ag)}.detail(${idLiteral(idKind(L, ag), id)}));`);
    }
    const touched = new Set([...keys.map((k) => k.aggregate), ...sc.given.aggregates.map((a) => a.type)]);
    const ok = !then.raises;
    for (const ag of L.ca.ir.aggregates) {
      if (!touched.has(ag.name)) continue;
      const F = factory(ag);
      const kind = idKind(L, ag);
      const has = (k: "details" | "lists") => ok && keys.some((x) => x.aggregate === ag.name && x.kind === k);
      const list = `${aggregateKey(ag.name)}List`;
      const other = `${aggregateKey(ag.name)}Other`;
      cache.push(`const ${list} = [{ ...${F}.lists()[0], filter: "probe" }] as const;`);
      cache.push(`const ${other} = [{ ...${F}.details()[0], id: ${otherId(kind)} }] as const;`);
      cache.push(`queryClient.setQueryData(${list}, []);`);
      cache.push(`queryClient.setQueryData(${other}, null);`);
      probes.push({ expr: list, invalidated: has("lists") });
      probes.push({ expr: other, invalidated: has("details") });
      const byInput = keys.find((k) => k.aggregate === ag.name && k.kind === "detail");
      const value = byInput?.kind === "detail" ? input[byInput.byInput] : undefined;
      for (const f of fetched) {
        const [name, id] = f.split(":") as [string, string];
        if (name !== ag.name) continue;
        const given = kind === "uuid" ? String(value).toLowerCase() : String(value);
        const hit = value !== undefined && value !== null && given === id;
        probes.push({ expr: `${F}.detail(${idLiteral(kind, id)}).queryKey`, invalidated: ok && (has("details") || hit) });
      }
    }
    const refetches = !then.raises && Array.isArray(then.state) && then.state.length > 0;
    const used = L.ca.ir.aggregates.filter((ag) => touched.has(ag.name) || (refetches && Array.isArray(then.state) && then.state.some((x) => x.aggregate === ag.name)));
    let principal: string | undefined;
    const sec = L.model.security;
    if (sec && requiresPrincipal(uc)) {
      const p = scenarioPrincipal(sec, uc, sc);
      if (p.anonymous) principal = "null";
      else {
        c.line(`const principal = ${principalLiteral(L, p, imp)};`);
        principal = "principal";
      }
    }
    connectLine(c, [...(used.length ? ["queries"] : []), "mutations", "queryClient", "statuses"].join(", "), key, deps, principal);
    for (const ag of used) c.line(factoryLine(L, ag));
    if (cache.length) {
      c.comment("Cache entries a mutation could make stale: the stored aggregates, a list and an unrelated detail.");
      c.lines_(cache);
    }
    const status = (code: string) => useCaseErrors(L, uc).get(code) ?? 422;
    c.line(`const observer = new MutationObserver(queryClient, mutations.${key}.${prop(uc.name)});`);
    c.line(`const input = ${record(uc.command, input, imp, L)};`);
    if (then.raises) {
      importError(L, imp, then.raises);
      imp.value(L.contextTesting, "expectRejects");
      c.line(`const error = await expectRejects(() => observer.mutate(input), ${then.raises});`);
      const builtin: Record<string, string> = { ConstraintViolation: "constraint_violation", AggregateNotFound: "aggregate_not_found", NotAuthorized: "not_authorized", Unauthenticated: "unauthenticated" };
      const code = builtin[then.raises] ?? L.ca.ir.errors.find((e) => e.name === then.raises)?.code ?? "";
      c.line(`expect(statuses.at(-1)).toBe(${status(code)});`);
      c.line("expect(observer.getCurrentResult().error).toBe(error);");
    } else {
      const assertsResult = then.hasReturns && info.returnType && !hasEntity(info.returnType);
      c.line(`${assertsResult ? "const result = " : ""}await observer.mutate(input);`);
      c.line(`expect(statuses.at(-1)).toBe(${info.returnType ? 200 : 204});`);
      if (assertsResult) c.line(expectEqual("result", then.returns, info.returnType!, imp, L));
    }
    for (const p of probes) c.line(`expect(queryClient.getQueryState(${p.expr})?.isInvalidated).toBe(${p.invalidated});`);
    if (refetches && Array.isArray(then.state)) {
      imp.value(L.contextTesting, "jsonOf", "expectPresent");
      then.state.forEach((s, i) => {
        const ag = L.aggregate(s.aggregate)!;
        if (typeof s.id !== "string" && typeof s.id !== "number") return;
        if (!i) c.comment("A refetch shows the stored state.");
        const stored = typedValue(s.id, L.tsFieldType(ag.name, ag.identity)!, imp, L);
        c.line(`const after${i} = await queryClient.query(${factory(ag)}.detail(${idLiteral(idKind(L, ag), s.id)}));`);
        c.line(`expect(jsonOf(after${i})).toEqual(jsonOf(expectPresent(${repoName(ag.name)}.get(${stored}))));`);
      });
    }
  }, ");");
}

// ---------------------------------------------------------------------------
// Authentication, authorization and rate limiting over HTTP (docs/09 §20)
// ---------------------------------------------------------------------------

/** Whether the aggregate's allow_if holds for `everyone` on the sample (undefined: cannot tell, or no rule). */
function readAllowed(L: TsLayout, ag: AggregateIR, sample: Record<string, unknown>): boolean | undefined {
  const sec = L.model.security;
  const rule = ag.authorize?.allowIf !== undefined ? L.ca.exprs.get(formatPath([...ag.authorize.path, "allow_if"])) : undefined;
  if (!sec || !rule) return undefined;
  const v = evaluateOnValues(rule, sample, makePrincipal(sec, { roles: sec.roles, claims: {} }));
  return typeof v === "boolean" ? v : undefined;
}

/** An endpoint with a rate limit: its request (unwired, so it answers 404 after taking a token) and limit. */
function limitedEndpoint(L: TsLayout): { name: string; method: "GET" | "POST"; path: string; limit: RateLimitIR; secured: boolean } | undefined {
  const api = L.model.generation.typescript.api!;
  for (const uc of servedUseCases(L)) {
    const limit = effectiveRateLimit(L.model, uc);
    if (limit) return { name: uc.name, method: "POST", path: useCasePath(api, L, uc), limit, secured: requiresPrincipal(uc) };
  }
  for (const ag of L.ca.ir.aggregates) {
    const limit = effectiveRateLimit(L.model, ag);
    const id = idKind(L, ag) === "integer" ? "1" : idKind(L, ag) === "string" ? "some-id" : "00000000-0000-4000-8000-000000000001";
    if (limit) return { name: `read_${toSnake(ag.name)}`, method: "GET", path: readPath(api, L, ag).replace(":id", id), limit, secured: requiresPrincipal(ag) };
  }
  return undefined;
}

function securityTests(L: TsLayout, c: Code, imp: TsImports, sep: () => void): void {
  const sec = L.model.security!;
  const api = L.model.generation.typescript.api!;
  const key = contextKey(L);
  const isProtected = servedUseCases(L).filter((u) => requiresPrincipal(u) && u.scenarios.length);
  const uc = isProtected[0];
  if (uc) {
    const sc = uc.scenarios[0]!;
    const url = tsString(`${ORIGIN}${useCasePath(api, L, uc)}`);
    imp.value(L.security, "Unauthenticated");
    imp.value(L.contextTesting, "expectRejects");
    imp.value("@tanstack/react-query", "MutationObserver");
    sep();
    c.doc(
      `\`POST ${useCasePath(api, L, uc)}\` needs a principal: without credentials it answers 401 with \`WWW-Authenticate: Bearer\`, with an invalid token 401 with \`error="invalid_token"\` (RFC 6750 §3.1); the client rejects with Unauthenticated.`,
    );
    c.block(`test("authentication: 401 with a Bearer challenge without or with an invalid token", async () =>`, () => {
      c.line('const badToken = new Unauthenticated({ error: "invalid_token" }, "The token is invalid");');
      c.line("const handler = createApiHandler(");
      c.indent(() => {
        c.line("{},");
        c.open("{", () => {
          c.line("authenticate: (request) =>");
          c.indent(() => {
            c.line('request.headers.get("authorization") === "Bearer bad"');
            c.indent(() => {
              c.line("? Promise.reject(badToken)");
              c.line(": Promise.resolve(null),");
            });
          });
        }, "},");
      });
      c.line(");");
      c.line(`const missing = await handler(new Request(${url}, { method: "POST", body: "{}" }));`);
      c.line("expect(missing.status).toBe(401);");
      c.line('expect(missing.headers.get("www-authenticate")).toBe("Bearer");');
      c.line('expect(await responseJson(missing)).toMatchObject({ code: "unauthenticated" });');
      c.line('const headers = { authorization: "Bearer bad" };');
      c.line(`const invalid = await handler(new Request(${url}, { method: "POST", body: "{}", headers }));`);
      c.line("expect(invalid.status).toBe(401);");
      c.line(`expect(invalid.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');`);
      c.line("const { mutations, queryClient, statuses } = connect({}, null);");
      c.line(`const observer = new MutationObserver(queryClient, mutations.${key}.${prop(uc.name)});`);
      c.line(`await expectRejects(() => observer.mutate(${record(uc.command, sc.when.input, imp, L)}), Unauthenticated);`);
      c.line("expect(statuses).toEqual([401]);");
    }, ");");
  }
  const withRoles = isProtected.find((u) => u.authorize!.roles.length);
  if (withRoles) {
    const sc = withRoles.scenarios[0]!;
    imp.value(L.security, "NotAuthorized");
    imp.value(L.contextTesting, "expectRejects");
    imp.value("@tanstack/react-query", "MutationObserver");
    const roles = otherRoles(sec, withRoles.authorize!);
    sep();
    c.doc(`A principal without ${withRoles.authorize!.roles.join(" / ")} is refused by ${withRoles.name}: 403, and the client rejects with NotAuthorized.`);
    c.block(`test(${tsString(`authorization: ${withRoles.name} without a required role is 403`)}, async () =>`, () => {
      useCaseSetup(L, c, withRoles, sc, imp);
      c.line(`const principal = ${principalLiteral(L, makePrincipal(sec, { roles, claims: {} }), imp)};`);
      connectLine(c, "mutations, queryClient, statuses", key, [`useCases: { ${prop(withRoles.name)}: useCase }`], "principal");
      c.line(`const observer = new MutationObserver(queryClient, mutations.${key}.${prop(withRoles.name)});`);
      c.line(`const error = await expectRejects(() => observer.mutate(${record(withRoles.command, sc.when.input, imp, L)}), NotAuthorized);`);
      c.line(`expect(error.details).toMatchObject({ requiredRoles: [${withRoles.authorize!.roles.map(tsString).join(", ")}] });`);
      c.line("expect(statuses).toEqual([403]);");
    }, ");");
  }
  rateLimitTest(L, c, imp, sep, limitedEndpoint(L));
}

/** `limited` allows its requests, then answers 429 with Retry-After and the RateLimit headers until a token refills. */
function rateLimitTest(L: TsLayout, c: Code, imp: TsImports, sep: () => void, limited: ReturnType<typeof limitedEndpoint>): void {
  if (limited) {
    const { limit } = limited;
    const w = windowSeconds(limit);
    const retry = Math.ceil(w / limit.requests);
    const name = limited.name;
    imp.value(L.apiModule("rate-limit"), "RateLimiter");
    sep();
    c.doc(
      `\`${limited.method} ${limited.path}\` allows ${limit.requests} request(s) per ${w} s (by ${limit.by}): then 429 with Retry-After and the IETF RateLimit headers, until a token has refilled. The endpoint is not wired, so allowed requests answer 404 after taking their token.`,
    );
    c.block(`test(${tsString(`rate limit: ${name} answers 429 when used up, then refills`)}, async () =>`, () => {
      c.line('let now = Date.parse("2026-01-01T00:00:00Z");');
      c.line("const handler = createApiHandler(");
      c.indent(() => {
        c.line("{},");
        c.open("{", () => {
          if (limited.secured) c.line("authenticate: () => Promise.resolve(everyone),");
          c.line("rateLimiter: new RateLimiter({ now: () => now }),");
          c.line('clientIp: () => "203.0.113.7",');
        }, "},");
      });
      c.line(");");
      const init = limited.method === "POST" ? `{ method: "POST", body: "{}" }` : "";
      c.line(`const send = () => handler(new Request(${tsString(`${ORIGIN}${limited.path}`)}${init ? `, ${init}` : ""}));`);
      c.line("const first = await send();");
      c.line("expect(first.status).toBe(404);");
      c.line(`expect(first.headers.get("ratelimit-policy")).toBe(${tsString(`"${name}";q=${limit.requests};w=${w}`)});`);
      c.line(`expect(first.headers.get("ratelimit")).toMatch(/^"${name}";r=${limit.requests - 1};t=\\d+$/);`);
      if (limit.requests > 1) {
        c.block(`for (let i = 1; i < ${limit.requests}; i++)`, () => c.line("expect((await send()).status).toBe(404);"));
      }
      c.line("const refused = await send();");
      c.line("expect(refused.status).toBe(429);");
      c.line(`expect(refused.headers.get("retry-after")).toBe(${tsString(String(retry))});`);
      c.line(`expect(refused.headers.get("ratelimit")).toBe(${tsString(`"${name}";r=0;t=${retry}`)});`);
      c.line(`expect(await responseJson(refused)).toMatchObject({ code: "rate_limited", details: { retryAfter: ${retry} } });`);
      c.line(`now += ${retry * 1000};`);
      c.line("expect((await send()).status).toBe(404);");
      c.line("expect((await send()).status).toBe(429);");
    }, ");");
  }
}

/**
 * Protected queries over HTTP: 401 with the Bearer challenge without or with an invalid token, 403 for a principal
 * without a required role (the client rejects with Unauthenticated / NotAuthorized), and 429 when a query's rate
 * limit is used up.
 */
function querySecurityTests(L: TsLayout, c: Code, imp: TsImports, sep: () => void): void {
  const sec = L.model.security!;
  const api = L.model.generation.typescript.api!;
  const key = contextKey(L);
  const plans = contextPlans(L);
  const pq = plans.find((p) => protectedQuery(L, p));
  if (pq) {
    const ag = pq.aggregate;
    const sample = pq.query.scenarios[0];
    const params = sample?.when.params ?? {};
    const required = pq.params.some((p) => p.type.k !== "optional");
    const url = tsString(`${ORIGIN}${queryPath(api, L, pq)}`);
    imp.value(L.security, "Unauthenticated");
    imp.value(L.contextTesting, "expectRejects");
    sep();
    c.doc(
      `\`GET ${queryPath(api, L, pq)}\` needs a principal: without credentials it answers 401 with \`WWW-Authenticate: Bearer\`, with an invalid token 401 with \`error="invalid_token"\`; the infinite query rejects with Unauthenticated. Nothing is read.`,
    );
    c.block(`test(${tsString(`${pq.query.name}: 401 without or with an invalid token`)}, async () =>`, () => {
      c.line('const badToken = new Unauthenticated({ error: "invalid_token" }, "The token is invalid");');
      c.line("const handler = createApiHandler(");
      c.indent(() => {
        c.line("{},");
        c.open("{", () => {
          c.line("authenticate: (request) =>");
          c.indent(() => {
            c.line('request.headers.get("authorization") === "Bearer bad"');
            c.indent(() => {
              c.line("? Promise.reject(badToken)");
              c.line(": Promise.resolve(null),");
            });
          });
        }, "},");
      });
      c.line(");");
      c.line(`const missing = await handler(new Request(${url}));`);
      c.line("expect(missing.status).toBe(401);");
      c.line('expect(missing.headers.get("www-authenticate")).toBe("Bearer");');
      c.line('expect(await responseJson(missing)).toMatchObject({ code: "unauthenticated" });');
      c.line(`const invalid = await handler(new Request(${url}, { headers: { authorization: "Bearer bad" } }));`);
      c.line("expect(invalid.status).toBe(401);");
      c.line(`expect(invalid.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');`);
      if (sample || !required) {
        c.block("const reader =", () => c.block("read: (): never =>", () => c.line('throw new Error("read before authorization");'), ","), ";");
        imp.value(L.persistenceRuntime, "HmacCursorCodec");
        imp.value(L.queries, queryClass(pq));
        c.line(`const cursors = new HmacCursorCodec({ secrets: [${tsString(TEST_SECRET)}] });`);
        c.line(`const ${queryKey(pq)} = new ${queryClass(pq)}({ reader, cursors });`);
        connectLine(c, "queries, queryClient, statuses", key, [`queries: { ${queryKey(pq)} }`], "null");
        c.line(factoryLine(L, ag));
        c.line(`const options = ${factory(ag)}.${queryKey(pq)}(${inputObject(L, pq, params, imp)});`);
        c.line("await expectRejects(() => queryClient.infiniteQuery(options), Unauthenticated);");
        c.line("expect(statuses).toEqual([401]);");
      }
    }, ");");
    const auth = pq.query.authorize!;
    if (auth.roles.length && (sample || !required)) {
      const base = scenarioPrincipal(sec, pq.query, sample ?? { given: {} });
      const lacking = makePrincipal(sec, { id: base.id, roles: otherRoles(sec, auth), claims: base.claims });
      imp.value(L.security, "NotAuthorized");
      sep();
      c.doc(`A principal without ${auth.roles.join(" / ")} is refused by ${pq.query.name} before anything is read: 403, and the infinite query rejects with NotAuthorized.`);
      c.block(`test(${tsString(`${pq.query.name}: without a required role is 403`)}, async () =>`, () => {
        c.block("const reader =", () => c.block("read: (): never =>", () => c.line('throw new Error("read before authorization");'), ","), ";");
        imp.value(L.persistenceRuntime, "HmacCursorCodec");
        imp.value(L.queries, queryClass(pq));
        c.line(`const cursors = new HmacCursorCodec({ secrets: [${tsString(TEST_SECRET)}] });`);
        c.line(`const ${queryKey(pq)} = new ${queryClass(pq)}({ reader, cursors });`);
        c.line(`const principal = ${principalLiteral(L, lacking, imp)};`);
        connectLine(c, "queries, queryClient, statuses", key, [`queries: { ${queryKey(pq)} }`], "principal");
        c.line(factoryLine(L, ag));
        c.line(`const options = ${factory(ag)}.${queryKey(pq)}(${inputObject(L, pq, params, imp)});`);
        c.line("const error = await expectRejects(() => queryClient.infiniteQuery(options), NotAuthorized);");
        c.line(`expect(error.details).toMatchObject({ requiredRoles: [${auth.roles.map(tsString).join(", ")}] });`);
        c.line("expect(statuses).toEqual([403]);");
      }, ");");
    }
  }
  for (const plan of plans) {
    const limit = effectiveRateLimit(L.model, plan.query);
    if (!limit) continue;
    rateLimitTest(L, c, imp, sep, { name: plan.query.name, method: "GET", path: queryPath(api, L, plan), limit, secured: protectedQuery(L, plan) });
    break;
  }
}
