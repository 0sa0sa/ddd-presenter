"""Hand-written test: wires the generated use case with the customer-owned extension."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

import pytest

from cleaning_platform.extensions.cleaning_staff.extensions import CleaningStaffExtensions
from cleaning_platform.generated.cleaning_staff.application.use_cases import IssueInvitationUseCase
from cleaning_platform.generated.cleaning_staff.domain.commands import IssueInvitation
from cleaning_platform.generated.cleaning_staff.domain.errors import EmailBlocked
from cleaning_platform.generated.cleaning_staff.domain.value_objects import EmailAddress
from cleaning_platform.generated.cleaning_staff.testing import (
    CapturingEventPublisher,
    FakeUnitOfWork,
    FixedClock,
    InMemoryCleaningStaffInvitationRepository,
    SequentialIds,
)


def make_use_case(blocked: frozenset[str]) -> IssueInvitationUseCase:
    uow = FakeUnitOfWork()
    return IssueInvitationUseCase(
        cleaning_staff_invitation_repository=InMemoryCleaningStaffInvitationRepository(uow),
        clock=FixedClock(datetime.fromisoformat("2026-01-01T10:00:00+00:00")),
        ids=SequentialIds([UUID(int=1)]),
        extensions=CleaningStaffExtensions(blocked_domains=blocked),
        event_publisher=CapturingEventPublisher(),
        unit_of_work=uow,
    )


def test_blocked_domain_is_rejected() -> None:
    use_case = make_use_case(frozenset({"spam.example"}))
    command = IssueInvitation(
        email=EmailAddress(value="someone@spam.example"),
        valid_until=datetime.fromisoformat("2026-01-08T10:00:00+00:00"),
    )
    with pytest.raises(EmailBlocked):
        use_case.execute(command)


def test_other_domains_are_accepted() -> None:
    use_case = make_use_case(frozenset({"spam.example"}))
    command = IssueInvitation(
        email=EmailAddress(value="someone@example.com"),
        valid_until=datetime.fromisoformat("2026-01-08T10:00:00+00:00"),
    )
    assert use_case.execute(command) == UUID(int=1)
