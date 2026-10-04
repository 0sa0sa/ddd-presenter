/**
 * Generated tests of the HTTP API of one context: the client and TanStack Query run against the generated server
 * handler (no DOM, no network), backed by the in-memory test doubles. They check the query keys, the validated data,
 * the error mapping (status and domain error class) and that each mutation invalidates exactly what it changes.
 */
import type { AggregateIR, Type, UseCaseIR, UseCaseScenarioIR } from "@ddd/core";
import { contextKey, invalidations, keysName, mutationsName, queriesName, readPath, useCaseErrors, useCasePath } from "./api.ts";
import { repoName } from "./application.ts";
import { Code, TsImports, tsString } from "./code.ts";
import type { TsFile } from "./domain.ts";
import type { TsLayout } from "./layout.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";
import { prop } from "./names.ts";
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
  c.line();
  c.doc("The client wired to the generated server handler (its `fetch`): requests never leave the process. Retries are off, as in any test of TanStack Query.");
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
    c.line("return { api, handler, queryClient, statuses };");
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
      const path = `${ORIGIN}${readPath(api, L, ag).replace(":id", "not-an-id")}`;
      c.line(`const invalid = await served.handler(new Request(${tsString(path)}));`);
      c.line("expect(invalid.status).toBe(400);");
      c.line('expect(await responseJson(invalid)).toMatchObject({ code: "constraint_violation" });');
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

/** The detail query: key, fetched JSON form, typed cache data, 404 → AggregateNotFound. */
function readTest(L: TsLayout, c: Code, ag: AggregateIR, imp: TsImports): void {
  const key = contextKey(L);
  const repo = repoName(ag.name);
  const K = keysName(ag.name);
  const Q = queriesName(ag.name);
  const queries = L.apiContext(L.ca.ir.name, "queries");
  const sample = sampleAggregate(L, ag);
  imp.value(queries, Q);
  imp.value(L.contextTesting, `InMemory${ag.name}Repository`, "expectRejects");
  imp.value(L.runtime, "AggregateNotFound");
  c.doc(
    `\`${Q}.detail\` loads a stored ${ag.name} through \`GET ${readPath(L.model.generation.typescript.api!, L, ag)}\`: hierarchical key (ids lower-cased), the JSON form validated by its schema, the same data in the cache. An unknown id rejects with AggregateNotFound (404).`,
  );
  c.block(`test(${tsString(`${ag.name}: detail query`)}, async () =>`, () => {
    c.line(`const ${repo} = new InMemory${ag.name}Repository();`);
    connectLine(c, "api, queryClient, statuses", key, [`repositories: { ${repo} }`]);
    const id = sample?.[ag.identity];
    if (sample && typeof id === "string") {
      imp.value(L.contextTesting, "jsonOf");
      c.line(`const stored = ${build(L, ag.name, "aggregate", sample, imp)};`);
      c.line(`${repo}.seed(stored);`);
      c.line(`const options = ${Q}.detail(api, ${tsString(id.toUpperCase())});`);
      imp.value(queries, K);
      c.line(`expect([...options.queryKey]).toEqual([...${K}.details(), ${tsString(id.toLowerCase())}]);`);
      c.line(`expect(${K}.details().slice(0, ${K}.all.length)).toEqual([...${K}.all]);`);
      c.line("const data = await queryClient.query(options);");
      c.line("expect(statuses).toEqual([200]);");
      c.line("expect(jsonOf(data)).toEqual(jsonOf(stored));");
      c.line('expect(queryClient.getQueryState(options.queryKey)?.status).toBe("success");');
    }
    c.line(`const missing = ${Q}.detail(api, ${tsString(OTHER_ID)});`);
    c.line("const error = await expectRejects(() => queryClient.query(missing), AggregateNotFound);");
    c.line(`expect(error.details).toMatchObject({ aggregate: ${tsString(ag.name)} });`);
    c.line("expect(statuses.at(-1)).toBe(404);");
    c.line("expect(queryClient.getQueryState(missing.queryKey)?.error).toBe(error);");
  }, ");");
}

/** One scenario run as a mutation through the client: result, status, invalidated keys, state seen by a refetch. */
function mutationTest(L: TsLayout, c: Code, uc: UseCaseIR, sc: UseCaseScenarioIR, imp: TsImports): void {
  const key = contextKey(L);
  const info = L.ca.useCases.get(uc.name)!;
  const queries = L.apiContext(L.ca.ir.name, "queries");
  const then = sc.then;
  const keys = invalidations(L, uc);
  imp.value("@tanstack/react-query", "MutationObserver");
  imp.value(queries, mutationsName(L));
  c.doc(
    [
      `Scenario \`${sc.name}\` of ${uc.name} as a mutation (\`POST ${useCasePath(L.model.generation.typescript.api!, L, uc)}\`).`,
      then.raises
        ? `It rejects with ${then.raises} and invalidates nothing.`
        : keys.length
          ? `On success it invalidates ${keys.map((k) => k.replace(/^\w+Keys\./, "").replace("input.", "")).join(", ")} of what it changes, and nothing else.`
          : "It saves no aggregate and invalidates nothing.",
    ].join("\n"),
  );
  c.block(`test(${tsString(`${uc.name}: ${sc.name}`)}, async () =>`, () => {
    const repos = useCaseSetup(L, c, uc, sc, imp);
    const deps = [`useCases: { ${prop(uc.name)}: useCase }`];
    if (repos.length) deps.push(`repositories: { ${repos.map(repoName).join(", ")} }`);
    connectLine(c, "api, queryClient, statuses", key, deps);
    // Cache entries the mutation may make stale: stored aggregates fetched through the API, plus probes.
    const probes: { expr: string; label: string; invalidated: boolean }[] = [];
    const input = sc.when.input;
    const fetched = new Set<string>();
    c.comment("Cache entries a mutation could make stale: the stored aggregates, a list and an unrelated detail.");
    for (const a of sc.given.aggregates) {
      const ag = L.aggregate(a.type)!;
      const id = a.fields[ag.identity];
      if (typeof id !== "string" || fetched.has(`${ag.name}:${id.toLowerCase()}`)) continue;
      fetched.add(`${ag.name}:${id.toLowerCase()}`);
      imp.value(queries, queriesName(ag.name));
      c.line(`await queryClient.query(${queriesName(ag.name)}.detail(api, ${tsString(id)}));`);
    }
    const touched = [...new Set([...keys.map((k) => k.split(".")[0]!), ...sc.given.aggregates.map((a) => keysName(a.type))])];
    for (const ag of L.ca.ir.aggregates) {
      const K = keysName(ag.name);
      if (!touched.includes(K)) continue;
      imp.value(queries, K);
      c.line(`queryClient.setQueryData([...${K}.lists(), "probe"], []);`);
      c.line(`queryClient.setQueryData(${K}.detail(${tsString(OTHER_ID)}), null);`);
      const ok = !then.raises;
      const has = (k: string) => ok && keys.includes(`${K}.${k}`);
      probes.push({ expr: `[...${K}.lists(), "probe"]`, label: `${K}.lists()`, invalidated: has("lists()") });
      probes.push({ expr: `${K}.detail(${tsString(OTHER_ID)})`, label: "other", invalidated: has("details()") });
      for (const f of fetched) {
        const [name, id] = f.split(":") as [string, string];
        if (name !== ag.name) continue;
        const byInput = keys.find((k) => k.startsWith(`${K}.detail(input.`));
        const field = byInput ? /input\.(\w+)/.exec(byInput)![1]! : undefined;
        const inputField = field ? uc.input.find((x) => prop(x.name) === field) : undefined;
        const hit = inputField && typeof input[inputField.name] === "string" && String(input[inputField.name]).toLowerCase() === id;
        probes.push({ expr: `${K}.detail(${tsString(id)})`, label: id, invalidated: ok && (has("details()") || !!hit) });
      }
    }
    const status = (code: string) => useCaseErrors(L, uc).get(code) ?? 422;
    c.line(`const observer = new MutationObserver(queryClient, ${mutationsName(L)}.${prop(uc.name)}(api));`);
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
    if (!then.raises && Array.isArray(then.state)) {
      imp.value(L.contextTesting, "jsonOf", "expectPresent");
      then.state.forEach((s, i) => {
        const ag = L.aggregate(s.aggregate)!;
        if (typeof s.id !== "string") return;
        imp.value(queries, queriesName(ag.name));
        if (!i) c.comment("A refetch shows the stored state.");
        const stored = typedValue(s.id, L.tsFieldType(ag.name, ag.identity)!, imp, L);
        c.line(`const after${i} = await queryClient.query(${queriesName(ag.name)}.detail(api, ${tsString(s.id)}));`);
        c.line(`expect(jsonOf(after${i})).toEqual(jsonOf(expectPresent(${repoName(ag.name)}.get(${stored}))));`);
      });
    }
  }, ");");
}
