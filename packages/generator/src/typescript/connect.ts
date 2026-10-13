/**
 * The Connect protocol over the generated HTTP API (`generation.typescript.api.connect`, docs/09 §25): the rpcs of
 * the model's protobuf contract (`generated/proto/`, written by the same code as `ddd migrate --split`) served in
 * protobuf JSON by translating each call to the REST endpoint that serves it.
 */
import { toSnake, type ApiSettings } from "@ddd/core";
import type { CField, ConnectPlan, CProcedure, CType } from "../connect-plan.ts";
import { queryPath, useCasePath } from "./api.ts";
import { Code, header, assemble, TsImports, tsString } from "./code.ts";
import type { TsFile } from "./domain.ts";
import type { TsLayout, TsPaths } from "./layout.ts";
import { prop } from "./names.ts";
import { testFile } from "./tests.ts";
import { PRINT_WIDTH, strWidth } from "./format.ts";

/** `cleaningStaffInvitationStatus`: the module constant of an enum's protobuf JSON shape. */
function enumConst(context: string, name: string): string {
  return `${prop(toSnake(context))}${name}`;
}

/** The ConnectType expression of a planned type. */
function typeExpr(t: CType): string {
  switch (t.t) {
    case "string":
    case "int64":
    case "bool":
    case "timestamp":
      return `T.${t.t}`;
    case "enum":
      return enumConst(t.context, t.name);
    case "message":
      return `msg(${tsString(t.name)})`;
    case "list":
      return `list(${typeExpr(t.item)})`;
  }
}

/** `f(no, name, type[, true])`. */
function fieldExpr(field: CField): string {
  return `f(${field.no}, ${tsString(field.name)}, ${typeExpr(field.type)}${field.optional ? ", true" : ""})`;
}

function connectSchemaFile(P: TsPaths, Ls: TsLayout[], api: ApiSettings, plan: ConnectPlan): TsFile {
  const mod = P.apiModule("connect-schema");
  const imp = new TsImports(mod);
  const c = new Code();
  imp.value(P.apiModule("connect-runtime"), "f", "result", "T");
  imp.type(P.apiModule("connect-runtime"), "ConnectSchema");
  const layout = (p: CProcedure) => Ls.find((L) => L.ca.ir.name === p.ca.ir.name)!;
  const procedures = new Code();
  for (const p of plan.procedures) {
    const L = layout(p);
    procedures.block(`${tsString(p.path)}:`, () => {
      if (p.kind === "useCase") {
        procedures.line('method: "POST",');
        procedures.line(`path: ${tsString(useCasePath(api, L, p.useCase!))},`);
      } else {
        imp.value(P.apiModule("connect-runtime"), "page");
        procedures.line('method: "GET",');
        procedures.line(`path: ${tsString(queryPath(api, L, p.plan!))},`);
      }
      procedures.line(`request: [${p.request.map(fieldExpr).join(", ")}],`);
      procedures.line(`response: ${p.kind === "query" ? `page(${tsString(p.item!)})` : p.result ? `result(${typeExpr(p.result)})` : "result()"},`);
    }, ",");
  }
  const enums = plan.enums.map((e) => `const ${enumConst(e.ca.ir.name, e.name)} = enumOf(${tsString(e.prefix)}, [${e.values.map(tsString).join(", ")}]);`);
  if (enums.length) imp.value(P.apiModule("connect-runtime"), "enumOf");
  const body = procedures.toString() + plan.messages.map((m) => m.fields.map(fieldExpr).join("")).join("");
  if (/\bmsg\(/.test(body)) imp.value(P.apiModule("connect-runtime"), "msg");
  if (/\blist\(/.test(body)) imp.value(P.apiModule("connect-runtime"), "list");

  c.line();
  if (enums.length) {
    c.comment("Enums in protobuf JSON: each value travels as its name in the contract (ORDER_STATUS_OPEN).");
    c.lines_(enums);
    c.line();
  }
  c.doc(
    "Protobuf JSON shapes of the contract's messages and the procedures (rpcs) of its services, each with the HTTP API endpoint that serves it. Field names and numbers are the contract's (`generated/proto/`); `f(number, name, type, optional)`.",
  );
  c.block("export const connectSchema: ConnectSchema =", () => {
    if (!plan.messages.length) c.line("messages: {},");
    else {
      c.block("messages:", () => {
        for (const m of plan.messages) c.line(`${tsString(m.name)}: [${m.fields.map(fieldExpr).join(", ")}],`);
      }, ",");
    }
    c.block("procedures:", () => {
      for (const l of procedures.toString().split("\n")) c.line(l);
    }, ",");
  }, ";");
  return { path: P.file(mod), content: assemble(header(P.model), "The model's protobuf contract as the Connect layer reads it: message shapes and procedures (no dependencies).", imp, c.toString()) };
}

/** `generated/api/connect-schema.ts` (shared by the server handler and the client), `connect.ts` (server), `connect-client.ts`. */
export function connectFiles(P: TsPaths, Ls: TsLayout[], api: ApiSettings, plan: ConnectPlan): TsFile[] {
  return [connectSchemaFile(P, Ls, api, plan), connectServerFile(P, api), connectClientFile(P, api)];
}

function connectServerFile(P: TsPaths, api: ApiSettings): TsFile {
  const mod = P.apiModule("connect");
  const imp = new TsImports(mod);
  const c = new Code();
  imp.value(P.apiModule("server"), "createApiHandler");
  imp.value(P.apiModule("connect-runtime"), "connectHandler");
  imp.value(P.apiModule("connect-schema"), "connectSchema");
  c.line();
  c.doc(
    [
      "The use cases and queries over the Connect protocol (unary): `POST " +
        `${api.basePath}/<package>.<Service>/<Method>` +
        "` with a protobuf JSON or binary body (queries also `GET …?encoding=json|proto&message=`), for any Connect client of the contract in `generated/proto/` (`createConnectClient`, or one generated with protoc-gen-es).",
      "",
      "Takes the same arguments as `createApiHandler`: each call goes through the HTTP API's endpoint for the rpc (the same authentication, authorization, rate limits and validation). Errors answer Connect error codes, with the domain error code in the `ddd-error-code` header. Mount it next to the HTTP API (its paths contain dots, so they never clash).",
    ].join("\n"),
  );
  c.line("export function createConnectHandler(");
  c.indent(() => c.line("...args: Parameters<typeof createApiHandler>"));
  c.block("): (request: Request) => Promise<Response>", () => {
    c.line(`return connectHandler(createApiHandler(...args), connectSchema, { basePath: ${tsString(api.basePath)} });`);
  });
  return { path: P.file(mod), content: assemble(header(P.model), "The Connect protocol over the HTTP API: the rpcs of the model's protobuf contract.", imp, c.toString()) };
}

function connectClientFile(P: TsPaths, api: ApiSettings): TsFile {
  const mod = P.apiModule("connect-client");
  const imp = new TsImports(mod);
  const c = new Code();
  imp.value(P.apiModule("client"), "createApiClient");
  imp.value(P.apiModule("connect-runtime"), "connectFetch");
  imp.value(P.apiModule("connect-schema"), "connectSchema");
  imp.type(P.apiModule("runtime"), "ApiClientOptions");
  c.line();
  c.doc(
    [
      "The typed API client (`createApiClient`: the same methods, schemas, errors and TanStack Query options) over the Connect protocol: every call that has an rpc is sent to it in protobuf JSON, or in the binary codec with `binary: true`. Reading an aggregate by id has no rpc and stays on the HTTP API.",
      "",
      "`fetch` sends the Connect requests (default: the global `fetch`).",
    ].join("\n"),
  );
  c.line("export function createConnectClient(");
  c.indent(() => c.line("options: ApiClientOptions & { readonly binary?: boolean } = {},"));
  c.block("): ReturnType<typeof createApiClient>", () => {
    c.line("const { binary = false, fetch: send, ...rest } = options;");
    c.line(`const transport = { basePath: ${tsString(api.basePath)}, binary, ...(send ? { fetch: send } : {}) };`);
    c.line("return createApiClient({ ...rest, fetch: connectFetch(connectSchema, transport) });");
  });
  return { path: P.file(mod), content: assemble(header(P.model), "The typed API client over the Connect protocol (protobuf JSON or binary).", imp, c.toString()) };
}



/**
 * `tests/generated/connect.test.ts`: every rpc has a procedure, the protocol's edges (unknown procedure, binary
 * codec, method), every unwired procedure answers a Connect error, request messages round-trip between protobuf
 * JSON and the HTTP API's JSON, and the error code mapping.
 */
export function connectTestFile(Ls: TsLayout[], api: ApiSettings, plan: ConnectPlan): TsFile | undefined {
  // (codec round trips, protocol edges and error codes; the official client is exercised by the example's interop test)
  const L = Ls[0];
  if (!L) return undefined;
  const module = [L.model.generation.testsDir, "generated", "connect.test"].filter((p) => p && p !== ".").join("/");
  const imp = new TsImports(module);
  const c = new Code();
  imp.value(L.apiModule("connect"), "createConnectHandler");
  imp.value(L.apiModule("connect-schema"), "connectSchema");
  imp.value(L.apiModule("connect-runtime"), "CONNECT_STATUS", "connectCode", "decodeMessage", "encodeMessage", "messageFromRest", "messageToRest");
  imp.type(L.apiModule("connect-runtime"), "ConnectField", "ConnectType");
  const paths = plan.procedures.map((p) => p.path).sort();
  const firstUseCase = plan.procedures.find((p) => p.kind === "useCase")?.path;
  c.line();
  c.line(`const BASE = ${tsString(`http://localhost${api.basePath}`)};`);
  c.line();
  c.doc("Nothing is wired: every procedure reaches the HTTP API, which serves none of them (or asks for credentials).");
  c.line("const handler = createConnectHandler({});");
  c.line();
  c.block("function call(path: string, init: RequestInit = {}): Promise<Response>", () => {
    c.line('const headers = { "content-type": "application/json" };');
    c.line('return handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: "{}", ...init }));');
  });
  c.line();
  c.block("async function bodyOf(response: Response): Promise<unknown>", () => {
    c.line("return JSON.parse(await response.text()) as unknown;");
  });
  c.line();
  c.doc("A protobuf JSON value of every field: strings, int64 as decimal strings, the first enum value, nested messages.");
  c.block("function sample(fields: readonly ConnectField[], depth = 0): Record<string, unknown>", () => {
    c.line("return Object.fromEntries(fields.map((field) => [field.json, sampleValue(field.type, depth)]));");
  });
  c.line();
  c.block("function sampleValue(type: ConnectType, depth: number): unknown", () => {
    c.block("switch (type.t)", () => {
      c.line('case "string":');
      c.indent(() => c.line('return "x";'));
      c.line('case "timestamp":');
      c.indent(() => c.line('return "2026-01-02T03:04:05.678Z";'));
      c.line('case "int64":');
      c.indent(() => c.line('return "7";'));
      c.line('case "bool":');
      c.indent(() => c.line("return true;"));
      c.line('case "enum":');
      c.indent(() => c.line('return type.values[0]?.[0] ?? "";'));
      c.line('case "message":');
      c.indent(() => c.line("return depth > 6 ? {} : sample(connectSchema.messages[type.name] ?? [], depth + 1);"));
      c.line('case "list":');
      c.indent(() => c.line("return [sampleValue(type.item, depth)];"));
    });
  });
  c.line();
  c.block(`describe("Connect protocol over the HTTP API", () =>`, () => {
    c.block('test("every rpc of the contract has a procedure", () =>', () => {
      c.line(`expect(Object.keys(connectSchema.procedures).sort()).toEqual([${paths.map(tsString).join(", ")}]);`);
    }, ");");
    c.line();
    c.block('test("unknown procedures, other codecs and other methods", async () =>', () => {
      c.line('const unknown = await call("/no.such.v1.Service/Method");');
      c.line("expect(unknown.status).toBe(501);");
      c.line('expect(await bodyOf(unknown)).toMatchObject({ code: "unimplemented" });');
      if (firstUseCase) {
        c.line(`const xml = await call(${tsString(firstUseCase)}, { headers: { "content-type": "application/xml" } });`);
        c.line("expect(xml.status).toBe(415);");
        const get = `new Request(\`\${BASE}${firstUseCase}\`)`;
        if (strWidth(`    const get = await handler(${get});`) <= PRINT_WIDTH) c.line(`const get = await handler(${get});`);
        else c.open("const get = await handler(", () => c.line(`${get},`), ");");
        c.line("expect(get.status).toBe(501);");
        c.line('expect(get.headers.get("allow")).toBe("POST");');
      }
    }, ");");
    c.line();
    c.block('test("an unwired procedure answers a Connect error", async () =>', () => {
      c.block("for (const path of Object.keys(connectSchema.procedures))", () => {
        c.line("const response = await call(path);");
        c.line('expect(response.headers.get("content-type")).toBe("application/json");');
        c.line("const body = (await bodyOf(response)) as { code: string };");
        c.line("expect(Object.keys(CONNECT_STATUS)).toContain(body.code);");
        c.line("expect(response.status).toBe(CONNECT_STATUS[body.code as keyof typeof CONNECT_STATUS]);");
      });
    }, ");");
    c.line();
    c.block("test(\"request messages round-trip between protobuf JSON and the HTTP API's JSON\", () =>", () => {
      c.block("for (const [path, procedure] of Object.entries(connectSchema.procedures))", () => {
        c.line("const message = sample(procedure.request);");
        c.line("const rest = messageToRest(connectSchema, procedure.request, message);");
        c.line("const back = messageFromRest(connectSchema, procedure.request, rest);");
        c.line("expect({ path, back }).toEqual({ path, back: message });");
      });
    }, ");");
    c.line();
    c.block('test("request messages round-trip through the binary codec (protobuf wire format)", () =>', () => {
      c.block("for (const [path, procedure] of Object.entries(connectSchema.procedures))", () => {
        c.line("const message = sample(procedure.request);");
        c.line("const bytes = encodeMessage(connectSchema, procedure.request, message);");
        c.line("const back = decodeMessage(connectSchema, procedure.request, bytes);");
        c.line("expect({ path, back }).toEqual({ path, back: message });");
      });
    }, ");");
    c.line();
    c.block('test("HTTP API errors become Connect error codes", () =>', () => {
      for (const [status, code, expected] of [
        [400, "constraint_violation", "invalid_argument"],
        [401, "unauthenticated", "unauthenticated"],
        [403, "not_authorized", "permission_denied"],
        [404, "aggregate_not_found", "not_found"],
        [404, "route_not_found", "unimplemented"],
        [409, "concurrency_conflict", "aborted"],
        [409, "invitation_already_closed", "failed_precondition"],
        [422, "invalid_order", "failed_precondition"],
        [429, "rate_limited", "resource_exhausted"],
        [500, "internal_error", "internal"],
      ] as const) {
        c.line(`expect(connectCode(${status}, ${tsString(code)})).toBe(${tsString(expected)});`);
      }
    }, ");");
  }, ");");
  return testFile(L, module, "The Connect protocol over the HTTP API (the rpcs of `generated/proto/`, protobuf JSON).", imp, c.toString());
}
