/**
 * Interop with the official Connect client: @connectrpc/connect-web (JSON and binary codecs) calls the generated
 * Connect handler with message types read from the generated contract (src/cleaning_platform/generated/proto,
 * compiled with buf), as a browser or service built from that contract would. Then the generated typed client over
 * Connect (`createConnectClient`). No network: the transports' fetch is the handler.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  create,
  createFileRegistry,
  fromBinary,
  type DescMethodUnary,
  type DescService,
} from "@bufbuild/protobuf";
import {
  FileDescriptorSetSchema,
  timestampDate,
  timestampFromDate,
  type Timestamp,
} from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { describe, expect, test } from "vitest";

import { createConnectClient } from "../../src/cleaning_platform/generated/api/connect-client.js";
import { createConnectHandler } from "../../src/cleaning_platform/generated/api/connect.js";
import { createApiHandler } from "../../src/cleaning_platform/generated/api/server.js";
import { SearchInvitationsQuery } from "../../src/cleaning_platform/generated/cleaning-staff/application/queries.js";
import { IssueInvitationUseCase } from "../../src/cleaning_platform/generated/cleaning-staff/application/use-cases.js";
import { CleaningStaffInvitation } from "../../src/cleaning_platform/generated/cleaning-staff/domain/aggregates.js";
import { InvalidInvitationWindow } from "../../src/cleaning_platform/generated/cleaning-staff/domain/errors.js";
import {
  CapturingEventPublisher,
  FakeUnitOfWork,
  FixedClock,
  InMemoryCleaningStaffInvitationRepository,
  InMemorySearchInvitationsReader,
  SequentialIds,
  StubExtensions,
} from "../../src/cleaning_platform/generated/cleaning-staff/testing.js";
import { HmacCursorCodec } from "../../src/cleaning_platform/generated/persistence.js";
import { Principal } from "../../src/cleaning_platform/generated/security.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "Bearer staff-token";

/** The contract as protobuf-es descriptors: `buf build` over the generated .proto files. */
function contract(): DescService {
  const out = join(mkdtempSync(join(tmpdir(), "connect-interop-")), "contract.binpb");
  const buf = spawnSync(
    join(root, "node_modules/.bin/buf"),
    ["build", "src/cleaning_platform/generated/proto", "-o", out],
    { cwd: root, encoding: "utf8" },
  );
  if (buf.status !== 0) throw new Error(`buf build failed: ${buf.stderr}`);
  const registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, readFileSync(out)));
  const service = registry.getService("cleaning_staff.v1.CleaningStaffService");
  if (!service) throw new Error("CleaningStaffService is missing from the contract");
  return service;
}

const service = contract();

function method(name: string): DescMethodUnary {
  const m = service.methods.find((x) => x.name === name);
  if (m?.methodKind !== "unary") throw new Error(`${name} is not a unary rpc`);
  return m as DescMethodUnary;
}

function setup(useHttpGet = false, useBinaryFormat = false) {
  const unitOfWork = new FakeUnitOfWork();
  const repository = new InMemoryCleaningStaffInvitationRepository(unitOfWork);
  const issueInvitation = new IssueInvitationUseCase({
    cleaningStaffInvitationRepository: repository,
    clock: new FixedClock("2026-01-01T10:00:00+00:00"),
    ids: new SequentialIds([
      "00000000-0000-0000-0000-0000000000aa",
      "00000000-0000-0000-0000-0000000000ab",
    ]),
    extensions: new StubExtensions(),
    eventPublisher: new CapturingEventPublisher(),
    unitOfWork,
  });
  const searchInvitations = new SearchInvitationsQuery({
    reader: new InMemorySearchInvitationsReader(repository),
    cursors: new HmacCursorCodec({ secrets: ["interop-cursor-secret-0123456789abcdef"] }),
  });
  const staff = Principal.create({ id: "staff-1", tenantId: TENANT, roles: ["staff"] });
  const dependencies = {
    cleaningStaff: {
      useCases: { issueInvitation },
      queries: { searchInvitations },
      repositories: { cleaningStaffInvitationRepository: repository },
    },
  };
  const options = {
    authenticate: (request: Request) =>
      Promise.resolve(request.headers.get("authorization") === TOKEN ? staff : null),
  };
  const handler = createConnectHandler(dependencies, options);
  const rest = createApiHandler(dependencies, options);
  const requests: Request[] = [];
  const transport: Transport = createConnectTransport({
    baseUrl: "http://localhost/api",
    useHttpGet,
    useBinaryFormat,
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return handler(request);
    },
  });
  // One server: procedures (paths with a dot) go to the Connect handler, the rest to the HTTP API.
  const server = (request: Request) =>
    new URL(request.url).pathname.includes(".") ? handler(request) : rest(request);
  return { transport, repository, requests, server };
}

async function call(
  transport: Transport,
  name: string,
  input: Record<string, unknown>,
  token: string | null = TOKEN,
): Promise<Record<string, unknown>> {
  const m = method(name);
  const headers = token ? { authorization: token } : undefined;
  const response = await transport.unary(m, undefined, undefined, headers, create(m.input, input));
  return response.message as unknown as Record<string, unknown>;
}

async function connectError(promise: Promise<unknown>): Promise<ConnectError> {
  try {
    await promise;
  } catch (error) {
    return ConnectError.from(error);
  }
  throw new Error("expected a Connect error");
}

describe("the official Connect client against the generated Connect handler", () => {
  test("IssueInvitation: a message with a value object and a Timestamp; the result comes back", async () => {
    const { transport, repository, requests } = setup();
    const res = await call(transport, "IssueInvitation", {
      email: { value: "New@Example.com" },
      validUntil: timestampFromDate(new Date("2026-01-08T10:00:00Z")),
    });
    expect(res.result).toBe("00000000-0000-0000-0000-0000000000aa");
    // The wire format is protobuf JSON over the Connect protocol.
    expect(requests[0]?.url).toBe(
      "http://localhost/api/cleaning_staff.v1.CleaningStaffService/IssueInvitation",
    );
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(await requests[0]?.json()).toEqual({
      email: { value: "New@Example.com" },
      validUntil: "2026-01-08T10:00:00Z",
    });
    type Key = Parameters<typeof repository.get>;
    const stored = await repository.get(
      TENANT as Key[0],
      "00000000-0000-0000-0000-0000000000aa" as Key[1],
    );
    expect(stored?.email.value).toBe("new@example.com");
  });

  test("errors arrive as Connect codes with the domain error code", async () => {
    const { transport } = setup();
    const valid = {
      email: { value: "a@example.com" },
      validUntil: timestampFromDate(new Date("2026-01-08T10:00:00Z")),
    };
    const anonymous = await connectError(call(transport, "IssueInvitation", valid, null));
    expect(anonymous.code).toBe(Code.Unauthenticated);
    const invalid = await connectError(
      call(transport, "IssueInvitation", { email: { value: "not-an-email" } }),
    );
    expect(invalid.code).toBe(Code.InvalidArgument);
    const past = await connectError(
      call(transport, "IssueInvitation", {
        email: { value: "a@example.com" },
        validUntil: timestampFromDate(new Date("2025-12-31T10:00:00Z")),
      }),
    );
    expect(past.code).toBe(Code.FailedPrecondition);
    expect(past.metadata.get("ddd-error-code")).toBe("invalid_invitation_window");
    // AcceptInvitation is not wired in this handler.
    const unwired = await connectError(
      call(transport, "AcceptInvitation", { invitationId: "00000000-0000-0000-0000-0000000000aa" }),
    );
    expect(unwired.code).toBe(Code.Unimplemented);
  });

  test("the binary codec (application/proto): IssueInvitation round trip", async () => {
    const { transport, requests } = setup(false, true);
    const res = await call(transport, "IssueInvitation", {
      email: { value: "bin@example.com" },
      validUntil: timestampFromDate(new Date("2026-01-08T10:00:00.250Z")),
    });
    expect(res.result).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(requests[0]?.headers.get("content-type")).toBe("application/proto");
  });

  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "SearchInvitations (HTTP GET: %s, binary: %s): enums, int64 and Timestamps in the page",
    async (useHttpGet, useBinaryFormat) => {
      const { transport, repository, requests } = setup(useHttpGet, useBinaryFormat);
      repository.seed(
        CleaningStaffInvitation.from({
          tenantId: TENANT,
          id: "00000000-0000-0000-0000-000000000001",
          email: { value: "staff@example.com" },
          status: "pending",
          createdAt: "2026-01-01T10:00:00+00:00",
          expiresAt: "2026-01-08T10:00:00+00:00",
        }),
        CleaningStaffInvitation.from({
          tenantId: TENANT,
          id: "00000000-0000-0000-0000-000000000002",
          email: { value: "other@example.com" },
          status: "accepted",
          createdAt: "2026-01-02T10:00:00+00:00",
          expiresAt: "2026-01-09T10:00:00+00:00",
          acceptedAt: "2026-01-03T10:00:00+00:00",
        }),
      );
      // status: INVITATION_STATUS_PENDING (1); limit is an int64 (a bigint in protobuf-es).
      const page = await call(transport, "SearchInvitations", { status: 1, limit: 10n });
      expect(requests[0]?.method).toBe(useHttpGet ? "GET" : "POST");
      const items = page.items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe("00000000-0000-0000-0000-000000000001");
      expect(items[0]?.status).toBe(1);
      expect((items[0]?.email as { value: string }).value).toBe("staff@example.com");
      expect(timestampDate(items[0]?.createdAt as Timestamp).toISOString()).toBe(
        "2026-01-01T10:00:00.000Z",
      );
      // next_cursor is a proto3 optional: absent on the last page.
      expect(page.nextCursor).toBeUndefined();
    },
  );
});

describe("the generated typed client over Connect (createConnectClient)", () => {
  test.each([false, true])(
    "binary: %s — results, pages, domain errors and reads",
    async (binary) => {
      const { repository, server } = setup();
      const sent: string[] = [];
      const client = createConnectClient({
        baseUrl: "http://localhost",
        getToken: () => "staff-token",
        binary,
        fetch: (request) => {
          sent.push(
            `${request.method} ${new URL(request.url).pathname} ${request.headers.get("content-type") ?? ""}`,
          );
          return server(request);
        },
      });
      const id = await client.cleaningStaff.useCases.issueInvitation({
        email: { value: "typed@example.com" },
        validUntil: "2026-01-08T10:00:00+00:00",
      });
      expect(id).toBe("00000000-0000-0000-0000-0000000000aa");
      expect(sent[0]).toBe(
        `POST /api/cleaning_staff.v1.CleaningStaffService/IssueInvitation ${binary ? "application/proto" : "application/json"}`,
      );
      const page = await client.cleaningStaff.queries.searchInvitations({ status: "pending" });
      expect(page.items.map((i) => [i.email.value, i.status])).toEqual([
        ["typed@example.com", "pending"],
      ]);
      expect(page.nextCursor).toBeNull();
      await expect(
        client.cleaningStaff.useCases.issueInvitation({
          email: { value: "late@example.com" },
          validUntil: "2025-12-31T10:00:00+00:00",
        }),
      ).rejects.toBeInstanceOf(InvalidInvitationWindow);
      // Reading by id has no rpc: it stays on the HTTP API.
      const read = await client.cleaningStaff.aggregates.cleaningStaffInvitation(id);
      expect(read.status).toBe("pending");
      expect(sent.at(-1)).toMatch(/^GET \/api\/cleaning-staff\/cleaning-staff-invitation\//);
      expect(repository.all()).toHaveLength(1);
    },
  );
});
