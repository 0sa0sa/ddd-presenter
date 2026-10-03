"""Hand-written test: no public API of the generated models can produce an invalid state."""

from __future__ import annotations

import copy
from datetime import datetime
from uuid import UUID

import pytest

from cleaning_platform.generated._runtime import ConstraintViolation
from cleaning_platform.generated.cleaning_staff.domain.aggregates import CleaningStaffInvitation
from cleaning_platform.generated.cleaning_staff.domain.enums import InvitationStatus
from cleaning_platform.generated.cleaning_staff.domain.errors import InvalidInvitationWindow
from cleaning_platform.generated.cleaning_staff.domain.events import (
    InvitationIssued,
    parse_event,
)
from cleaning_platform.generated.cleaning_staff.domain.value_objects import EmailAddress


def invitation() -> CleaningStaffInvitation:
    return CleaningStaffInvitation(
        id=UUID(int=1),
        email=EmailAddress(value="staff@example.com"),
        status=InvitationStatus.PENDING,
        created_at=datetime.fromisoformat("2026-01-01T10:00:00+00:00"),
        expires_at=datetime.fromisoformat("2026-01-08T10:00:00+00:00"),
    )


def test_model_copy_with_update_checks_invariants() -> None:
    # Pydantic's own model_copy(update=...) would return an accepted invitation without accepted_at.
    with pytest.raises(InvalidInvitationWindow) as raised:
        invitation().model_copy(update={"status": InvitationStatus.ACCEPTED})
    assert raised.value.details["rule"] == "accepted_invitation_has_accepted_at"


def test_model_copy_with_update_checks_constraints_and_normalizes() -> None:
    email = EmailAddress(value="staff@example.com")
    with pytest.raises(ConstraintViolation, match="value"):
        email.model_copy(update={"value": "not an email"})
    assert email.model_copy(update={"value": " New@Example.COM "}).value == "new@example.com"
    with pytest.raises(ConstraintViolation):
        invitation().model_copy(update={"no_such_field": 1})


def test_copy_without_update_is_equal() -> None:
    original = invitation()
    assert original.model_copy().same_state_as(original)
    assert copy.deepcopy(original).same_state_as(original)


def test_constraint_violation_keeps_the_pydantic_error_as_cause() -> None:
    with pytest.raises(ConstraintViolation) as raised:
        EmailAddress(value="x")
    assert raised.value.__cause__ is not None
    assert raised.value.details["model"] == "EmailAddress"


def test_events_round_trip_through_json() -> None:
    event = InvitationIssued(
        id=UUID(int=1),
        email=EmailAddress(value="staff@example.com"),
        expires_at=datetime.fromisoformat("2026-01-08T10:00:00+00:00"),
    )
    data = event.model_dump(mode="json")
    assert data["event_type"] == "CleaningStaff.InvitationIssued"
    assert parse_event(data) == event


def test_unknown_event_type_is_a_constraint_violation() -> None:
    with pytest.raises(ConstraintViolation, match="AnyEvent"):
        parse_event({"event_type": "CleaningStaff.Nope", "id": str(UUID(int=1))})
