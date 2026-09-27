/**
 * Shared base classes emitted once per generated package. Plain Pydantic v2 + stdlib,
 * so customers do not depend on a DDD Presenter runtime library.
 */
export const RUNTIME_PY = `from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, ClassVar, Generic, Self, TypeVar

from pydantic import BaseModel, ConfigDict, ModelWrapValidatorHandler, ValidationError, model_validator


class DomainError(Exception):
    """Base class of all domain errors.

    \`message\` is safe to show to end users; \`details\` is internal diagnostic data.
    Domain errors never depend on HTTP or web framework types.
    """

    code: ClassVar[str] = "domain_error"
    default_message: ClassVar[str] = "A domain rule was violated"

    def __init__(self, message: str | None = None, **details: object) -> None:
        self.message = message or self.default_message
        self.details: dict[str, object] = details
        super().__init__(self.message)

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, message={self.message!r}, details={self.details!r})"


class ConstraintViolation(DomainError):
    """A field constraint (type, length, range, pattern, ...) was violated."""

    code = "constraint_violation"
    default_message = "A field constraint was violated"


class AggregateNotFound(DomainError):
    """Raised by a use case when a load step finds nothing and no specific error is declared."""

    code = "aggregate_not_found"
    default_message = "The requested aggregate does not exist"


def _describe(exc: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}" for e in exc.errors())


class DomainModel(BaseModel):
    """Immutable Pydantic model whose validation failures surface as \`ConstraintViolation\`."""

    model_config = ConfigDict(frozen=True, extra="forbid", validate_default=True)

    @model_validator(mode="wrap")
    @classmethod
    def _constraint_errors_as_domain_errors(cls, data: Any, handler: ModelWrapValidatorHandler[Self]) -> Self:
        try:
            return handler(data)
        except ValidationError as exc:
            raise ConstraintViolation(f"{cls.__name__}: {_describe(exc)}", model=cls.__name__, errors=exc.errors()) from None


class ValueObject(DomainModel):
    """Compared by value; immutable."""


class Entity(DomainModel):
    """Compared by identity; state changes go through named operations that return new instances."""

    identity_field: ClassVar[str] = "id"

    @property
    def identity(self) -> object:
        return getattr(self, self.identity_field)

    def __eq__(self, other: object) -> bool:
        if type(other) is not type(self):
            return NotImplemented
        assert isinstance(other, Entity)
        return bool(self.identity == other.identity)

    def __hash__(self) -> int:
        return hash((type(self).__name__, self.identity))

    def same_state_as(self, other: Self) -> bool:
        """Full structural comparison (identity equality ignores the other fields)."""
        return self.model_dump() == other.model_dump()

    def _replace(self, **changes: object) -> Self:
        """Build a candidate state; all construct-time invariants run on the new instance."""
        data = {name: getattr(self, name) for name in type(self).model_fields}
        data.update(changes)
        return type(self).model_validate(data)


class AggregateRoot(Entity):
    """Consistency boundary. Only the root is loaded and saved through a repository."""


class DomainEvent(DomainModel):
    """Something that happened in the domain. Immutable payload."""


EventHandler = Callable[[DomainEvent], None]
"""Reacts to a domain event, e.g. a generated policy (see \`subscriptions()\` in application/policies.py)."""


def dispatch(subscriptions: Mapping[type[DomainEvent], Sequence[EventHandler]], events: Iterable[DomainEvent]) -> None:
    """Minimal in-process event bus: runs the handlers subscribed to each event's exact type, in order.

    Production buses (outbox, message broker) call the same handlers; this helper is for tests and simple apps.
    """
    for event in events:
        for handler in subscriptions.get(type(event), ()):
            handler(event)


A = TypeVar("A", bound=AggregateRoot)


@dataclass(frozen=True)
class Transition(Generic[A]):
    """Result of a factory or operation: the new aggregate state plus the events it emitted."""

    aggregate: A
    events: tuple[DomainEvent, ...] = ()


@dataclass(frozen=True)
class StateGuard:
    """A named condition evaluated at a specific moment.

    \`checks()\` answers the question; \`assert_holds()\` raises the declared domain error.
    (\`assert\` is a Python keyword, hence the name.)
    """

    name: str
    holds: bool
    error: Callable[[], DomainError]

    def checks(self) -> bool:
        return self.holds

    def assert_holds(self) -> None:
        if not self.holds:
            raise self.error()

    def __bool__(self) -> bool:
        raise TypeError(f"Use {self.name}(...).checks() or .assert_holds() instead of truth-testing a StateGuard")
`;

export const ADAPTERS_PY = `from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4


class SystemClock:
    """Clock backed by the system time. Always returns an aware UTC datetime."""

    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class RandomIds:
    """IdGenerator producing random UUID4 identities."""

    def new_id(self) -> UUID:
        return uuid4()
`;
