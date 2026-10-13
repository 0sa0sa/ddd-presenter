/**
 * The Python target's Connect server (generation.python.connect, docs/09 §25) against the official Connect client
 * over real HTTP: the generated WSGI application runs under wsgiref in the example's venv, and
 * @connectrpc/connect-web (JSON and binary codecs, POST and GET) calls it with descriptors that `buf build` reads
 * from the generated contract. Skipped unless the venv and the TypeScript example's dependencies are installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { validateModelText } from "@ddd/core";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatePython } from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");
const VENV = join(ROOT, "examples/cleaning-platform/.venv/bin/python");
const TS_EXAMPLE = join(ROOT, "examples/cleaning-platform-ts");
const BUF = join(TS_EXAMPLE, "node_modules/.bin/buf");
const available = existsSync(VENV) && existsSync(BUF) && existsSync(join(TS_EXAMPLE, "node_modules/@connectrpc/connect-web"));

/** The Python example (it enables `generation.python.connect` with base path /api). */
const MODEL = readFileSync(join(ROOT, "examples/cleaning-platform/model.ddd.yaml"), "utf8");

const SERVER = `
import sys
from datetime import UTC, datetime
from uuid import UUID
from socketserver import TCPServer, ThreadingMixIn
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from cleaning_platform.generated._persistence import HmacCursorCodec
from cleaning_platform.generated.cleaning_staff.application.queries import SearchInvitationsQuery
from cleaning_platform.generated.cleaning_staff.application.use_cases import IssueInvitationUseCase
from cleaning_platform.generated.cleaning_staff.testing import (
    CapturingEventPublisher,
    FakeUnitOfWork,
    FixedClock,
    InMemoryCleaningStaffInvitationRepository,
    InMemorySearchInvitationsReader,
    SequentialIds,
    StubExtensions,
)
from cleaning_platform.generated.connect import create_connect_app
from cleaning_platform.generated.security import Principal

TENANT = UUID("00000000-0000-4000-8000-0000000000a1")
uow = FakeUnitOfWork()
repo = InMemoryCleaningStaffInvitationRepository(uow)
ids = [UUID("00000000-0000-0000-0000-0000000000aa"), UUID("00000000-0000-0000-0000-0000000000ab"), UUID("00000000-0000-0000-0000-0000000000ac")]
issue = IssueInvitationUseCase(
    cleaning_staff_invitation_repository=repo,
    clock=FixedClock(datetime(2026, 1, 1, 10, tzinfo=UTC)),
    ids=SequentialIds(ids),
    extensions=StubExtensions(),
    event_publisher=CapturingEventPublisher(),
    unit_of_work=uow,
)
search = SearchInvitationsQuery(
    reader=InMemorySearchInvitationsReader(repo),
    cursors=HmacCursorCodec(["interop-cursor-secret-0123456789abcdef"]),
)
staff = Principal(id="staff-1", tenant_id=TENANT, roles=("staff",))
app = create_connect_app(
    {"issue_invitation": issue, "search_invitations": search},
    authenticate=lambda header: staff if header == "Bearer staff-token" else None,
)


class Quiet(WSGIRequestHandler):
    def log_message(self, format, *args):
        pass


class Threaded(ThreadingMixIn, WSGIServer):
    daemon_threads = True

    def server_bind(self):
        # HTTPServer.server_bind resolves the host name (socket.getfqdn), which can stall for seconds.
        TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]
        self.setup_environ()


server = make_server("127.0.0.1", 0, app, server_class=Threaded, handler_class=Quiet)
print(server.server_port, flush=True)
server.serve_forever()
`;

describe.skipIf(!available)("the official Connect client against the generated Python WSGI server", () => {
  let dir = "";
  let server: ChildProcess | undefined;
  let baseUrl = "";
  // Loaded from the TypeScript example (the generator itself has no Connect dependency).
  let lib: {
    create: (schema: unknown, init: unknown) => unknown;
    timestampFromDate: (d: Date) => unknown;
    timestampDate: (t: unknown) => Date;
    ConnectError: { from: (e: unknown) => { code: number; metadata: Headers } };
    Code: Record<string, number>;
    createConnectTransport: (o: object) => { unary: (...args: unknown[]) => Promise<{ message: Record<string, unknown> }> };
  };
  let service: { methods: { name: string; input: unknown }[] };

  beforeAll(async () => {
    const r = validateModelText(MODEL);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    dir = mkdtempSync(join(tmpdir(), "ddd-py-connect-"));
    for (const f of generatePython(r.analysis!, MODEL).files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    const set = join(dir, "contract.binpb");
    const buf = spawnSync(BUF, ["build", "src/cleaning_platform/generated/proto", "-o", set], { cwd: dir, encoding: "utf8" });
    if (buf.status !== 0) throw new Error(buf.stderr);
    const resolve = (m: string) => Bun.resolveSync(m, TS_EXAMPLE);
    const protobuf = await import(resolve("@bufbuild/protobuf"));
    const wkt = await import(resolve("@bufbuild/protobuf/wkt"));
    const connect = await import(resolve("@connectrpc/connect"));
    const web = await import(resolve("@connectrpc/connect-web"));
    lib = { create: protobuf.create, timestampFromDate: wkt.timestampFromDate, timestampDate: wkt.timestampDate, ConnectError: connect.ConnectError, Code: connect.Code, createConnectTransport: web.createConnectTransport };
    const registry = protobuf.createFileRegistry(protobuf.fromBinary(wkt.FileDescriptorSetSchema, readFileSync(set)));
    service = registry.getService("cleaning_staff.v1.CleaningStaffService");
    writeFileSync(join(dir, "serve.py"), SERVER);
    server = spawn(VENV, ["serve.py"], { cwd: dir, env: { ...process.env, PYTHONPATH: join(dir, "src") }, stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise<string>((ok, fail) => {
      let err = "";
      server!.stdout!.once("data", (d: Buffer) => ok(d.toString().trim()));
      server!.stderr!.on("data", (d: Buffer) => (err += d.toString()));
      server!.once("exit", () => fail(new Error(`the Python server exited: ${err}`)));
    });
    baseUrl = `http://127.0.0.1:${port}/api`;
  }, 60_000);

  afterAll(() => {
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const call = async (name: string, input: Record<string, unknown>, opts: { binary?: boolean; get?: boolean; token?: string | null } = {}) => {
    const m = service.methods.find((x) => x.name === name)!;
    const transport = lib.createConnectTransport({ baseUrl, useBinaryFormat: !!opts.binary, useHttpGet: !!opts.get });
    const token = opts.token === undefined ? "Bearer staff-token" : opts.token;
    const res = await transport.unary(m, undefined, undefined, token ? { authorization: token } : undefined, lib.create(m.input, input));
    return res.message;
  };
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return lib.ConnectError.from(e);
    }
    throw new Error("expected a Connect error");
  };

  test("IssueInvitation (JSON, then binary) and SearchInvitations (POST / GET, JSON / binary)", async () => {
    const issued = await call("IssueInvitation", { email: { value: "Py@Example.com" }, validUntil: lib.timestampFromDate(new Date("2026-01-08T10:00:00Z")) });
    expect(issued.result).toBe("00000000-0000-0000-0000-0000000000aa");
    const binary = await call("IssueInvitation", { email: { value: "bin@example.com" }, validUntil: lib.timestampFromDate(new Date("2026-01-09T10:00:00.250Z")) }, { binary: true });
    expect(binary.result).toBe("00000000-0000-0000-0000-0000000000ab");
    for (const opts of [{}, { get: true }, { binary: true }, { get: true, binary: true }]) {
      const page = await call("SearchInvitations", { status: 1, limit: 10n }, opts);
      const items = page.items as Record<string, unknown>[];
      expect({ opts, emails: items.map((i) => (i.email as { value: string }).value).sort() }).toEqual({ opts, emails: ["bin@example.com", "py@example.com"] });
      expect(items.every((i) => i.status === 1)).toBe(true);
      const expires = items.map((i) => lib.timestampDate(i.expiresAt).toISOString()).sort();
      expect(expires).toEqual(["2026-01-08T10:00:00.000Z", "2026-01-09T10:00:00.250Z"]);
      expect(page.nextCursor).toBeUndefined();
    }
  });

  test("errors: Connect codes and the domain error code", async () => {
    const valid = { email: { value: "a@example.com" }, validUntil: lib.timestampFromDate(new Date("2026-01-08T10:00:00Z")) };
    expect((await failure(call("IssueInvitation", valid, { token: null }))).code).toBe(lib.Code.Unauthenticated!);
    expect((await failure(call("IssueInvitation", { ...valid, email: { value: "nope" } }))).code).toBe(lib.Code.InvalidArgument!);
    const past = await failure(call("IssueInvitation", { ...valid, validUntil: lib.timestampFromDate(new Date("2025-12-31T10:00:00Z")) }));
    expect(past.code).toBe(lib.Code.FailedPrecondition!);
    expect(past.metadata.get("ddd-error-code")).toBe("invalid_invitation_window");
    expect((await failure(call("AcceptInvitation", { invitationId: "00000000-0000-0000-0000-0000000000aa" }))).code).toBe(lib.Code.Unimplemented!);
  });
});
