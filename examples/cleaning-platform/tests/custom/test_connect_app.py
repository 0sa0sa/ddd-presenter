"""The generated Connect WSGI application wired to the use cases and queries (customer-owned test).

The requests are what a Connect client sends (protobuf JSON, the binary codec, GET for queries); the
cross-language check with the official Connect client is in the generator's test suite.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from io import BytesIO
from typing import Any
from uuid import UUID

import pytest

from cleaning_platform.generated._connect import decode_message, encode_message, response_fields
from cleaning_platform.generated._persistence import HmacCursorCodec
from cleaning_platform.generated.cleaning_staff.application.queries import SearchInvitationsQuery
from cleaning_platform.generated.cleaning_staff.application.use_cases import (
    IssueInvitationUseCase,
)
from cleaning_platform.generated.cleaning_staff.testing import (
    CapturingEventPublisher,
    FakeUnitOfWork,
    FixedClock,
    InMemoryCleaningStaffInvitationRepository,
    InMemorySearchInvitationsReader,
    SequentialIds,
    StubExtensions,
)
from cleaning_platform.generated.connect import MESSAGES, PROCEDURES, create_connect_app
from cleaning_platform.generated.security import Principal, TenantId

TENANT = TenantId(UUID("00000000-0000-4000-8000-0000000000a1"))
ISSUE = "/cleaning_staff.v1.CleaningStaffService/IssueInvitation"
SEARCH = "/cleaning_staff.v1.CleaningStaffService/SearchInvitations"
TOKEN = "Bearer staff-token"


class Connect:
    """The WSGI application with an issue use case and the search query over in-memory adapters."""

    def __init__(self) -> None:
        unit_of_work = FakeUnitOfWork()
        self.repository = InMemoryCleaningStaffInvitationRepository(unit_of_work)
        issue = IssueInvitationUseCase(
            cleaning_staff_invitation_repository=self.repository,
            clock=FixedClock(datetime(2026, 1, 1, 10, tzinfo=UTC)),
            ids=SequentialIds([UUID(int=0xAA), UUID(int=0xAB)]),
            extensions=StubExtensions(),
            event_publisher=CapturingEventPublisher(),
            unit_of_work=unit_of_work,
        )
        search = SearchInvitationsQuery(
            reader=InMemorySearchInvitationsReader(self.repository),
            cursors=HmacCursorCodec(["connect-test-cursor-secret-0123456789"]),
        )
        staff = Principal(id="staff-1", tenant_id=TENANT, roles=("staff",))
        self.app = create_connect_app(
            {"issue_invitation": issue, "search_invitations": search},
            authenticate=lambda header: staff if header == TOKEN else None,
        )

    def request(
        self,
        path: str,
        body: bytes = b"{}",
        *,
        content_type: str = "application/json",
        method: str = "POST",
        query: str = "",
        token: str | None = TOKEN,
    ) -> tuple[int, dict[str, str], bytes]:
        environ: dict[str, Any] = {
            "REQUEST_METHOD": method,
            "PATH_INFO": f"/api{path}",
            "QUERY_STRING": query,
            "CONTENT_TYPE": content_type,
            "CONTENT_LENGTH": str(len(body)),
            "REMOTE_ADDR": "127.0.0.1",
            "wsgi.input": BytesIO(body),
        }
        if token is not None:
            environ["HTTP_AUTHORIZATION"] = token
        status: list[str] = []
        headers: dict[str, str] = {}

        def start(line: str, pairs: list[tuple[str, str]]) -> None:
            status.append(line)
            headers.update(pairs)

        out = b"".join(self.app(environ, start))
        return int(status[0].split()[0]), headers, out

    def json(
        self, path: str, message: Mapping[str, object], **kw: Any
    ) -> tuple[int, dict[str, Any]]:
        status, _, body = self.request(path, json.dumps(message).encode(), **kw)
        data: dict[str, Any] = json.loads(body)
        return status, data


@pytest.fixture
def connect() -> Connect:
    return Connect()


ISSUE_MESSAGE: dict[str, object] = {
    "email": {"value": "New@Example.com"},
    "validUntil": "2026-01-08T10:00:00Z",
}


def test_issue_invitation_in_protobuf_json(connect: Connect) -> None:
    status, reply = connect.json(ISSUE, ISSUE_MESSAGE)
    assert (status, reply) == (200, {"result": "00000000-0000-0000-0000-0000000000aa"})
    [stored] = connect.repository.all()
    assert stored.email.value == "new@example.com"


def test_issue_invitation_in_the_binary_codec(connect: Connect) -> None:
    request = PROCEDURES[ISSUE].request
    body = encode_message(MESSAGES, request, ISSUE_MESSAGE)
    status, headers, out = connect.request(ISSUE, body, content_type="application/proto")
    assert (status, headers["Content-Type"]) == (200, "application/proto")
    reply = decode_message(MESSAGES, response_fields(PROCEDURES[ISSUE].response), out)
    assert reply == {"result": "00000000-0000-0000-0000-0000000000aa"}


def test_search_invitations_by_post_and_get(connect: Connect) -> None:
    connect.json(ISSUE, ISSUE_MESSAGE)
    message = {"status": "INVITATION_STATUS_PENDING", "limit": "10"}
    status, page = connect.json(SEARCH, message)
    assert status == 200
    assert page["items"][0]["status"] == "INVITATION_STATUS_PENDING"
    assert page["items"][0]["createdAt"] == "2026-01-01T10:00:00Z"
    assert "nextCursor" not in page
    encoded = base64.urlsafe_b64encode(json.dumps(message).encode()).decode().rstrip("=")
    query = f"encoding=json&base64=1&message={encoded}"
    status, _, body = connect.request(SEARCH, b"", method="GET", query=query)
    assert (status, json.loads(body)) == (200, page)


def test_errors_are_connect_errors_with_the_domain_code(connect: Connect) -> None:
    status, reply = connect.json(ISSUE, ISSUE_MESSAGE, token=None)
    assert (status, reply["code"]) == (401, "unauthenticated")
    status, reply = connect.json(ISSUE, {**ISSUE_MESSAGE, "email": {"value": "nope"}})
    assert (status, reply["code"]) == (400, "invalid_argument")
    past = {**ISSUE_MESSAGE, "validUntil": "2025-12-31T10:00:00Z"}
    status, headers, body = connect.request(ISSUE, json.dumps(past).encode())
    assert (status, json.loads(body)["code"]) == (400, "failed_precondition")
    assert headers["ddd-error-code"] == "invalid_invitation_window"
    accept = "/cleaning_staff.v1.CleaningStaffService/AcceptInvitation"
    status, reply = connect.json(accept, {"invitationId": str(UUID(int=0xAA))})
    assert (status, reply["code"]) == (501, "unimplemented")
