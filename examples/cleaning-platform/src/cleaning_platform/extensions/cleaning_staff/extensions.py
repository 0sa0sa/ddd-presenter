# Created by DDD Presenter as a starting point. This file is yours to edit.

from __future__ import annotations

from cleaning_platform.generated.cleaning_staff.application.ports import Extensions
from cleaning_platform.generated.cleaning_staff.domain.value_objects import EmailAddress


class CleaningStaffExtensions:
    """Implementation of the CleaningStaff extension points (customer-owned)."""

    def __init__(self, blocked_domains: frozenset[str] = frozenset()) -> None:
        self._blocked_domains = blocked_domains

    def is_blocked_email(self, email: EmailAddress) -> bool:
        """配信停止・ブロック済みのメールアドレスか"""
        return email.value.rsplit("@", 1)[-1] in self._blocked_domains


# Static check that the class satisfies the generated protocol (verified by mypy).
_conforms: Extensions = CleaningStaffExtensions()
