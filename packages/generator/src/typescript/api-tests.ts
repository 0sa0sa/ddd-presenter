/**
 * Generated tests of the HTTP API of one context: the client and TanStack Query run against the generated server
 * handler (no DOM, no network), backed by the in-memory test doubles. They check the object query keys and how filters
 * match them, the validated data, the error mapping (status and domain error class) and that each mutation
 * invalidates exactly what it changes. They use the factories like an app does: `queries.<context>.<aggregate>`.
 */
import type { AggregateIR, Type, UseCaseIR, UseCaseScenarioIR } from "@ddd/core";
import { aggregateKey, contextKey, idKind, idLiteral, invalidationLabel, invalidations, readPath, useCaseErrors, useCasePath, type IdKind } from "./api.ts";
import { repoName } from "./application.ts";
import { Code, TsImports, tsString } from "./code.ts";
import type { TsFile } from "./domain.ts";
import type { TsLayout } from "./layout.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";
import { kebab, prop } from "./names.ts";
import { build, importError, testFile, useCaseSetup } from "./tests.ts";
import { expectEqual, record, typedValue } from "./values.ts";

const ORIGIN = "http://localhost";

/**
 * `const { … } = connect({ context: { … } });` inside a test (depth 2), expanded like Prettier expands an object
 * argument that does not fit.
 */
function connectLine(c: Code, names: string, key: string, parts: string[]): void {
  const inner = `{ ${parts.join(", ")} }`;
  const head = `const { ${names} } = connect(`;
  if (strWidth(`    ${head}{ ${key}: ${inner} });`) <= PRINT_WIDTH) {
    c.line(`${head}{ ${key}: ${inner} });`);
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
  c.block("function connect(dependencies: ApiDependencies)", () => {
    c.line("const handler = createApiHandler(dependencies);");
    c.line("const statuses: number[] = [];");
    c.block("const api = createApiClient(", () => {
      c.line(`baseUrl: ${tsString(ORIGIN)},`);
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
    for (const ag of L.ca.ir.aggregates) {
      sep();
      readTest(L, c, ag, imp);
      sep();
      keyMatchTest(L, c, ag);
    }
    for (const uc of L.ca.ir.useCases) {
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

/** Routing and the error responses that do not come from the domain. */
function handlerTest(L: TsLayout, c: Code, imp: TsImports, sep: () => void): void {
  const api = L.model.generation.typescript.api!;
  const uc = L.ca.ir.useCases.find((u) => u.scenarios.length);
  const ag = L.ca.ir.aggregates[0];
  const key = contextKey(L);
  sep();
  c.doc("Unknown paths and unwired endpoints answer 404, a wrong method 405 with Allow; an invalid id is a ConstraintViolation (400).");
  c.block(`test("routing: 404, 405 and 400 responses", async () =>`, () => {
    c.line("const { handler } = connect({});");
    c.line(`const unknown = await handler(new Request(${tsString(`${ORIGIN}${api.basePath}/no-such-endpoint`)}));`);
    c.line("expect(unknown.status).toBe(404);");
    c.line('expect(await responseJson(unknown)).toMatchObject({ code: "route_not_found" });');
    if (L.ca.ir.useCases.length) {
      const path = `${ORIGIN}${useCasePath(api, L, L.ca.ir.useCases[0]!)}`;
      c.line(`const wrongMethod = await handler(new Request(${tsString(path)}));`);
      c.line("expect(wrongMethod.status).toBe(405);");
      c.line('expect(wrongMethod.headers.get("allow")).toBe("POST");');
      c.comment("A use case the app did not pass to the handler is not served.");
      c.line(`const unwired = await handler(new Request(${tsString(path)}, { method: "POST", body: "{}" }));`);
      c.line("expect(unwired.status).toBe(404);");
    }
    if (ag) {
      imp.value(L.contextTesting, `InMemory${ag.name}Repository`);
      const repo = repoName(ag.name);
      c.line(`const ${repo} = new InMemory${ag.name}Repository();`);
      c.line(`const served = connect({ ${key}: { repositories: { ${repo} } } });`);
      if (idKind(L, ag) !== "string") {
        const path = `${ORIGIN}${readPath(api, L, ag).replace(":id", "not-an-id")}`;
        c.line(`const invalid = await served.handler(new Request(${tsString(path)}));`);
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
      c.line("const data = await queryClient.query(options);");
      c.line("expect(statuses).toEqual([200]);");
      c.line("expect(jsonOf(data)).toEqual(jsonOf(stored));");
      c.line('expect(queryClient.getQueryState(options.queryKey)?.status).toBe("success");');
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
    connectLine(c, [...(used.length ? ["queries"] : []), "mutations", "queryClient", "statuses"].join(", "), key, deps);
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
      const code = then.raises === "ConstraintViolation" ? "constraint_violation" : then.raises === "AggregateNotFound" ? "aggregate_not_found" : (L.ca.ir.errors.find((e) => e.name === then.raises)?.code ?? "");
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
