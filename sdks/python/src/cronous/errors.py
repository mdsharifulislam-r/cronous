"""Exceptions raised by the Chronos SDK."""

from __future__ import annotations

from typing import Any


class NonRetryableError(Exception):
    """Raise from a task handler to mark a permanent failure: Chronos will not retry it."""

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class ChronosConfigError(Exception):
    """Invalid SDK configuration or task definition."""


class ChronosConnectionError(Exception):
    """The server rejected this agent in a way reconnecting cannot fix: bad token, wrong
    project, unsupported protocol version or invalid task definitions."""

    def __init__(self, message: str, close_code: int, fatal: bool = True) -> None:
        super().__init__(message)
        self.close_code = close_code
        self.fatal = fatal


class ChronosRequestError(Exception):
    """A REST call to Chronos failed. ``status`` is 0 for network errors and timeouts."""

    def __init__(self, message: str, status: int, code: str, details: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.details = details


class ChronosValidationError(ChronosRequestError):
    """400: the request is invalid (unknown fields, bad delay, payload fails the job's schema)."""


class ChronosAuthError(ChronosRequestError):
    """401/403: the token is missing, revoked or not allowed to do this."""


class ChronosNotFoundError(ChronosRequestError):
    """404: the job, queue or execution does not exist in this project."""


class ChronosConflictError(ChronosRequestError):
    """409: a state conflict, e.g. the job is disabled or the execution already finished."""


class ChronosWaitTimeoutError(Exception):
    """``ChronosAdmin.executions.wait()`` gave up before the execution finished."""

    def __init__(self, message: str, last_status: str) -> None:
        super().__init__(message)
        self.last_status = last_status


def error_for_status(status: int, error: dict[str, Any] | None) -> ChronosRequestError:
    error = error or {}
    code = str(error.get("code") or "HTTP_ERROR")
    message = str(error.get("message") or f"Chronos responded with HTTP {status}")
    details = error.get("details")
    if status == 400:
        return ChronosValidationError(message, status, code, details)
    if status in (401, 403):
        return ChronosAuthError(message, status, code, details)
    if status == 404:
        return ChronosNotFoundError(message, status, code, details)
    if status == 409:
        return ChronosConflictError(message, status, code, details)
    return ChronosRequestError(message, status, code, details)
