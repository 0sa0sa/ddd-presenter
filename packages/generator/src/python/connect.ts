/**
 * The Connect protocol for the Python target (`generation.python.connect`, docs/09 §25): `generated/_connect.py`
 * (model-independent: protobuf JSON and wire format, the WSGI application) and `generated/connect.py` (the
 * procedures of the model's contract over its use cases and queries), plus `tests/generated/test_connect.py`.
 */
import { pascal, toSnake, type ModelIR } from "@ddd/core";
import type { CField, ConnectPlan, CType } from "../connect-plan.ts";
import { assemble, header, ModuleImports } from "./layout.ts";
import type { PyFile } from "./domain.ts";
import { Code, docstringLines, pyString } from "./support.ts";
import { rateLimitModule, securityModule } from "./security.ts";
import CONNECT_RUNTIME_PY from "./templates/connect_runtime.py.txt" with { type: "text" };

const WIDTH = 100;

function connectModule(model: ModelIR, name: "_connect" | "connect"): string {
  return `${model.generation.package}.generated.${name}`;
}

function modulePath(model: ModelIR, module: string): string {
  return `${model.generation.srcDir}/${module.replace(/\./g, "/")}.py`;
}

/** `_CLEANING_STAFF_INVITATION_STATUS`: the module constant of an enum's protobuf JSON shape. */
function enumConst(context: string, name: string): string {
  return `_${toSnake(context).toUpperCase()}_${toSnake(name).toUpperCase()}`;
}

function typeExpr(t: CType): string {
  switch (t.t) {
    case "string":
    case "int64":
    case "bool":
    case "timestamp":
      return t.t.toUpperCase();
    case "enum":
      return enumConst(t.context, t.name);
    case "message":
      return `msg(${pyString(t.name)})`;
    case "list":
      return `lst(${typeExpr(t.item)})`;
  }
}

function fieldExpr(field: CField): string {
  return `f(${field.no}, ${pyString(field.name)}, ${typeExpr(field.type)}${field.optional ? ", True" : ""})`;
}

/** A tuple literal as ruff format prints it: `()`, `(x,)`, or exploded one item per line (magic trailing comma). */
function tuple(c: Code, head: string, items: string[], tail: string): void {
  if (!items.length) c.line(`${head}()${tail}`);
  else if (items.length === 1 && 4 * 2 + `${head}(${items[0]},)${tail}`.length <= WIDTH) c.line(`${head}(${items[0]},)${tail}`);
  else {
    c.line(`${head}(`);
    c.indent(() => items.forEach((i) => c.line(`${i},`)));
    c.line(`)${tail}`);
  }
}

export function pyConnectFiles(model: ModelIR, plan: ConnectPlan): PyFile[] {
  const py = model.generation.python!;
  const sec = model.security;
  const files: PyFile[] = [];
  files.push({
    path: modulePath(model, connectModule(model, "_connect")),
    content: `${header(model)}\n\n${docstringLines("The Connect protocol (unary; JSON and binary codecs) as a WSGI application, independent of the model: protobuf JSON and the protobuf wire format ↔ Python values, procedures, Connect errors (Pydantic + stdlib only).", "").join("\n")}\n\n${CONNECT_RUNTIME_PY}`,
  });

  const mod = connectModule(model, "connect");
  const imp = new ModuleImports(mod);
  const rt = connectModule(model, "_connect");
  imp.from("collections.abc", "Callable", "Mapping");
  imp.from("typing", "Final");
  imp.from(rt, "Executes", "Field", "Procedure", "WsgiApp", "connect_app", "f", "result");
  const c = new Code();
  const body = [...plan.procedures.flatMap((p) => [...p.request, ...(p.result ? [{ no: 0, name: "", type: p.result, optional: false }] : [])]), ...plan.messages.flatMap((m) => m.fields)];
  const kinds = new Set<string>();
  const visit = (t: CType) => {
    kinds.add(t.t);
    if (t.t === "list") visit(t.item);
  };
  body.forEach((x) => visit(x.type));
  for (const k of ["string", "int64", "bool", "timestamp"]) if (kinds.has(k)) imp.from(rt, k.toUpperCase());
  if (kinds.has("message")) imp.from(rt, "msg");
  if (kinds.has("list")) imp.from(rt, "lst");
  if (plan.enums.length) imp.from(rt, "enum_of");
  if (plan.procedures.some((p) => p.kind === "query")) imp.from(rt, "page");

  if (plan.enums.length) {
    c.line().line();
    c.line("# Enums in protobuf JSON: each value travels as its name in the contract (ORDER_STATUS_OPEN).");
    for (const e of plan.enums) {
      c.line(`${enumConst(e.ca.ir.name, e.name)}: Final = enum_of(`);
      c.indent(() => {
        c.line(`${pyString(e.prefix)},`);
        c.line(`(${e.values.map(pyString).join(", ")}${e.values.length === 1 ? "," : ""}),`);
      });
      c.line(")");
    }
  }
  c.line().line();
  c.line("MESSAGES: Final[Mapping[str, tuple[Field, ...]]] = {" + (plan.messages.length ? "" : "}"));
  if (plan.messages.length) {
    c.indent(() => {
      for (const m of plan.messages) tuple(c, `${pyString(m.name)}: `, m.fields.map(fieldExpr), ",");
    });
    c.line("}");
  }
  c.line('"""Fields of each message of the contract, by full name (`generated/proto/`)."""');
  c.line();
  c.line("PROCEDURES: Final[Mapping[str, Procedure]] = {" + (plan.procedures.length ? "" : "}"));
  if (plan.procedures.length) {
    c.indent(() => {
      for (const p of plan.procedures) {
        const L = { base: `${model.generation.package}.generated.${toSnake(p.ca.ir.name)}` };
        let input: string;
        if (p.kind === "useCase") {
          input = p.useCase!.command;
          imp.from(`${L.base}.domain.commands`, input);
        } else {
          input = `${pascal(p.plan!.query.name)}Input`;
          imp.from(`${L.base}.application.queries`, input);
        }
        c.line(`${pyString(p.path)}: Procedure(`);
        c.indent(() => {
          c.line(`service=${pyString(p.kind === "useCase" ? p.useCase!.name : p.plan!.query.name)},`);
          c.line(`input=${input},`);
          tuple(c, "request=", p.request.map(fieldExpr), ",");
          c.line(`response=${p.kind === "query" ? `page(${pyString(p.item!)})` : p.result ? `result(${typeExpr(p.result)})` : "result()"},`);
          c.line(`principal=${sec ? "True" : "False"},`);
          if (p.kind === "query") c.line("query=True,");
          if (p.notFound.length) c.line(`not_found=frozenset({${[...new Set(p.notFound)].map(pyString).join(", ")}}),`);
        });
        c.line("),");
      }
    });
    c.line("}");
  }
  c.line('"""The rpcs of the contract and the use case or query (by name in `services`) that serves each."""');
  c.line().line();

  const doc = [
    `The model's use cases and queries over the Connect protocol, as a WSGI application: \`POST ${py.basePath}/<package>.<Service>/<Method>\` with a protobuf JSON or binary body (queries also \`GET ?encoding=json|proto&message=\`), for any Connect client of the contract in \`generated/proto/\`.`,
    "",
    "`services` maps each use case / query name to its service (anything with `execute`); an rpc whose service is not given answers `unimplemented`.",
    ...(sec
      ? [
          "",
          "`authenticate` turns the Authorization header into the principal (e.g. `BearerJwtAuthenticator(...).authenticate`); the use cases and queries authorize it. Rate limits follow `RATE_LIMITS` (`rate_limiter`, per principal, tenant, client IP or for everyone).",
        ]
      : []),
    "",
    "Mount it with any WSGI server or framework (`wsgiref`, gunicorn, Flask's `DispatcherMiddleware`, Django).",
  ].join("\n");
  c.line("def create_connect_app(");
  c.indent(() => {
    c.line("services: Mapping[str, Executes],");
    c.line("*,");
    if (sec) {
      imp.from(securityModule(model), "Principal");
      imp.from(rateLimitModule(model), "RateLimiter", "rate_limit_headers");
      imp.from(securityModule(model), "RATE_LIMITS");
      imp.from(connectModule(model, "_connect"), "RateDecision");
      c.line("authenticate: Callable[[str | None], Principal | None] | None = None,");
      c.line("rate_limiter: RateLimiter | None = None,");
    }
    c.line("on_error: Callable[[Exception], None] | None = None,");
  });
  c.line(") -> WsgiApp:");
  c.indent(() => {
    c.docstring(doc);
    if (sec) {
      c.line("limiter = rate_limiter if rate_limiter is not None else RateLimiter()");
      c.line();
      c.line("def rate_check(");
      c.indent(() => c.line("procedure: Procedure, principal: Principal | None, client_ip: str"));
      c.line(") -> RateDecision:");
      c.indent(() => {
        c.line("limit = RATE_LIMITS.get(procedure.service)");
        c.line("if limit is None:");
        c.indent(() => c.line("return RateDecision(allowed=True, headers={})"));
        c.line('if limit.by == "principal" and principal is not None:');
        c.indent(() => c.line("subject = str(principal.id)"));
        if (sec.tenancy) {
          c.line('elif limit.by == "tenant" and principal is not None and principal.tenant_id is not None:');
          c.indent(() => c.line("subject = str(principal.tenant_id)"));
        }
        c.line('elif limit.by == "global":');
        c.indent(() => c.line('subject = "*"'));
        c.line("else:");
        c.indent(() => c.line("subject = client_ip"));
        c.line("decision = limiter.consume(limit, subject)");
        c.line("return RateDecision(decision.allowed, rate_limit_headers(limit, decision))");
      });
      c.line();
    }
    c.line("return connect_app(");
    c.indent(() => {
      c.line("PROCEDURES,");
      c.line("MESSAGES,");
      c.line("services,");
      c.line(`base_path=${pyString(py.basePath)},`);
      if (sec) {
        c.line("authenticate=authenticate,");
        c.line("rate_check=rate_check,");
      }
      c.line("on_error=on_error,");
    });
    c.line(")");
  });
  files.push({
    path: modulePath(model, mod),
    content: assemble(model, "The Connect protocol for the model's protobuf contract (`generated/proto/`): its procedures over the use cases and queries, as a WSGI application.", imp, c.toString()),
  });
  return files;
}

/**
 * `tests/generated/test_connect.py`: every rpc has a procedure; request messages round-trip between protobuf JSON
 * and Python values and through the binary codec; the protocol's edges (unknown procedure, other codecs, method,
 * unwired services) answer Connect errors.
 */
export function pyConnectTestFile(model: ModelIR, plan: ConnectPlan): PyFile {
  const pkg = model.generation.package;
  const imp = new ModuleImports("tests.generated.test_connect");
  imp.from("io", "BytesIO");
  imp.from("typing", "Any", "NamedTuple");
  imp.import("json");
  imp.from(`${pkg}.generated._connect`, "CONNECT_STATUS", "Field", "Type", "decode_message", "encode_message", "message_from_python", "message_to_python");
  imp.from(`${pkg}.generated.connect`, "MESSAGES", "PROCEDURES", "create_connect_app");
  const c = new Code();
  const paths = plan.procedures.map((p) => p.path).sort();
  const firstUseCase = plan.procedures.find((p) => p.kind === "useCase")?.path;
  c.line().line();
  c.line("class Reply(NamedTuple):");
  c.indent(() => {
    c.line("status: int");
    c.line("headers: dict[str, str]");
    c.line("body: bytes");
  });
  c.line().line();
  c.line("def call(");
  c.indent(() => c.line('path: str, body: bytes = b"{}", content_type: str = "application/json", method: str = "POST"'));
  c.line(") -> Reply:");
  c.indent(() => {
    c.docstring("Runs one request through the WSGI application with nothing wired.");
    c.line("app = create_connect_app({})");
    c.line("environ: dict[str, Any] = {");
    c.indent(() => {
      c.line('"REQUEST_METHOD": method,');
      c.line(`"PATH_INFO": ${pyString(model.generation.python!.basePath)} + path,`);
      c.line('"CONTENT_TYPE": content_type,');
      c.line('"CONTENT_LENGTH": str(len(body)),');
      c.line('"wsgi.input": BytesIO(body),');
    });
    c.line("}");
    c.line("status: list[str] = []");
    c.line("headers: dict[str, str] = {}");
    c.line();
    c.line("def start(line: str, pairs: list[tuple[str, str]]) -> None:");
    c.indent(() => {
      c.line("status.append(line)");
      c.line("headers.update(pairs)");
    });
    c.line();
    c.line('out = b"".join(app(environ, start))');
    c.line("return Reply(int(status[0].split()[0]), headers, out)");
  });
  c.line().line();
  c.line("def sample(fields: tuple[Field, ...], depth: int = 0) -> dict[str, object]:");
  c.indent(() => {
    c.docstring("A protobuf JSON value of every field: strings, int64 as decimal strings, first enum values.");
    c.line("return {field.json: sample_value(field.type, depth) for field in fields}");
  });
  c.line().line();
  c.line("def sample_value(type_: Type, depth: int) -> object:");
  c.indent(() => {
    c.line('if type_.t == "string":');
    c.indent(() => c.line('return "x"'));
    c.line('if type_.t == "timestamp":');
    c.indent(() => c.line('return "2026-01-02T03:04:05.678Z"'));
    c.line('if type_.t == "int64":');
    c.indent(() => c.line('return "7"'));
    c.line('if type_.t == "bool":');
    c.indent(() => c.line("return True"));
    c.line('if type_.t == "enum":');
    c.indent(() => c.line("return type_.values[0][0]"));
    c.line('if type_.t == "message":');
    c.indent(() => c.line("return {} if depth > 6 else sample(MESSAGES[type_.name], depth + 1)"));
    c.line("assert type_.item is not None");
    c.line("return [sample_value(type_.item, depth)]");
  });
  c.line().line();
  c.line("def test_every_rpc_of_the_contract_has_a_procedure() -> None:");
  c.indent(() => {
    c.line("assert sorted(PROCEDURES) == [");
    c.indent(() => paths.forEach((p) => c.line(`${pyString(p)},`)));
    c.line("]");
  });
  c.line().line();
  c.line("def test_request_messages_round_trip_through_python_values_and_the_binary_codec() -> None:");
  c.indent(() => {
    c.line("for path, procedure in PROCEDURES.items():");
    c.indent(() => {
      c.line("message = sample(procedure.request)");
      c.line("values = message_to_python(MESSAGES, procedure.request, message)");
      c.line("assert (path, message_from_python(MESSAGES, procedure.request, values)) == (path, message)");
      c.line("data = encode_message(MESSAGES, procedure.request, message)");
      c.line("assert (path, decode_message(MESSAGES, procedure.request, data)) == (path, message)");
    });
  });
  c.line().line();
  c.line("def test_unknown_procedures_other_codecs_and_unwired_services() -> None:");
  c.indent(() => {
    c.line('status, _, body = call("/no.such.v1.Service/Method")');
    c.line("assert status == 501");
    c.line('assert json.loads(body)["code"] == "unimplemented"');
    if (firstUseCase) {
      c.line(`status, _, _ = call(${pyString(firstUseCase)}, content_type="application/xml")`);
      c.line("assert status in (415, 501)");
    }
    c.line("for path in PROCEDURES:");
    c.indent(() => {
      c.line("status, headers, body = call(path)");
      c.line('assert headers["Content-Type"] == "application/json"');
      c.line('code = json.loads(body)["code"]');
      c.line("assert CONNECT_STATUS[code] == status");
    });
  });
  return { path: `${model.generation.testsDir}/generated/test_connect.py`, content: assemble(model, "The Connect protocol for the model's contract: procedures, codecs and the protocol's edges.", imp, c.toString(), { exports: false }) };
}
