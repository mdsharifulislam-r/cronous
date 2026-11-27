"""Submitting and cancelling executions (POST /queue), shared by Chronos and ChronosAdmin."""

from __future__ import annotations

import asyncio
import datetime as dt
import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from ._http import HttpClient, seg
from ._json import MAX_PAYLOAD_BYTES, dumps, to_jsonable
from .errors import ChronosConfigError, ChronosConflictError, ChronosValidationError

JOB_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
QUEUE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
IDEMPOTENCY_KEY = re.compile(r"^[!-~]{1,200}$")
MAX_DELAY_MS = 365 * 86_400_000

#: A duration: seconds (int/float) or a timedelta.
Duration = int | float | dt.timedelta


def to_ms(value: Duration, field: str) -> int:
    seconds = value.total_seconds() if isinstance(value, dt.timedelta) else value
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
        raise ChronosConfigError(f'"{field}" must be a number of seconds or a timedelta')
    return int(round(seconds * 1000))


def iso(value: dt.datetime | str | None) -> str | None:
    if value is None or isinstance(value, str):
        return value
    if value.tzinfo is None:
        raise ChronosConfigError("datetimes must be timezone-aware (e.g. datetime.now(timezone.utc))")
    return value.isoformat()


def build_submission(
    job: str,
    payload: Any = None,
    *,
    delay: Duration | None = None,
    run_at: dt.datetime | str | None = None,
    priority: int | None = None,
    queue: str | None = None,
    idempotency_key: str | None = None,
    max_attempts: int | None = None,
    retry_backoff: Duration | None = None,
    retry_backoff_max: Duration | None = None,
    timeout: Duration | None = None,
) -> dict[str, Any]:
    """Builds and validates a POST /queue body with the server's rules, for fast, precise errors."""
    problems: list[str] = []
    body: dict[str, Any] = {"job": job}
    if not isinstance(job, str) or not JOB_NAME.match(job):
        problems.append('job: must start with a letter or digit and contain only letters, digits, ".", "_", ":" or "-" (max 128)')
    if payload is not None:
        try:
            body["payload"] = to_jsonable(payload)
            if len(dumps(body["payload"]).encode("utf-8")) > MAX_PAYLOAD_BYTES:
                problems.append(f"payload: exceeds {MAX_PAYLOAD_BYTES} bytes")
        except (TypeError, ValueError) as error:
            problems.append(f"payload: must be JSON-serialisable ({error})")
    if delay is not None and run_at is not None:
        problems.append('run_at: use either "delay" or "run_at", not both')
    if delay is not None:
        delay_ms = to_ms(delay, "delay")
        if not 0 <= delay_ms <= MAX_DELAY_MS:
            problems.append("delay: must be between 0 and 365 days")
        body["delayMs"] = delay_ms
    if run_at is not None:
        body["runAt"] = iso(run_at)
    if priority is not None:
        if isinstance(priority, bool) or not isinstance(priority, int) or not 0 <= priority <= 100:
            problems.append("priority: must be an integer 0-100")
        body["priority"] = priority
    if queue is not None:
        if not QUEUE_NAME.match(queue):
            problems.append('queue: must be lowercase letters, digits, "_" or "-" (max 63)')
        body["queue"] = queue
    # Always sent, so retries of this call can never create a second execution.
    key = idempotency_key if idempotency_key is not None else f"sdk-{uuid.uuid4()}"
    if not IDEMPOTENCY_KEY.match(key):
        problems.append("idempotency_key: 1-200 printable ASCII characters without spaces")
    body["idempotencyKey"] = key
    if max_attempts is not None:
        if not 1 <= max_attempts <= 100:
            problems.append("max_attempts: must be 1-100")
        body["maxAttempts"] = max_attempts
    if retry_backoff is not None:
        body["retryBackoffMs"] = to_ms(retry_backoff, "retry_backoff")
    if retry_backoff_max is not None:
        body["retryBackoffMaxMs"] = to_ms(retry_backoff_max, "retry_backoff_max")
    if timeout is not None:
        body["timeoutMs"] = to_ms(timeout, "timeout")
        if not 1000 <= body["timeoutMs"] <= 86_400_000:
            problems.append("timeout: must be between 1 second and 24 hours")
    if problems:
        details = [{"path": p.split(":", 1)[0], "message": p.split(":", 1)[1].strip()} for p in problems]
        raise ChronosValidationError(f'Invalid submission for "{job}": {"; ".join(problems)}', 400, "VALIDATION_FAILED", details)
    return body


def to_queued_execution(data: dict[str, Any]) -> dict[str, Any]:
    """Flattens ``{execution, created}`` into one dict with a ``created`` flag."""
    return {**data["execution"], "created": data["created"]}


def project_id_resolver(http: HttpClient, project: str, path: str) -> Callable[[], Awaitable[str]]:
    """Resolves (once, retried after failures) the id of the project the token belongs to,
    and checks it matches the configured slug."""
    cached: dict[str, str] = {}
    lock: dict[str, asyncio.Lock] = {}

    async def resolve() -> str:
        if "id" in cached:
            return cached["id"]
        guard = lock.setdefault("lock", asyncio.Lock())
        async with guard:
            if "id" not in cached:
                identity = await http.request("GET", path)
                if identity["projectSlug"] != project:
                    raise ChronosConfigError(f'This token belongs to project "{identity["projectSlug"]}", but the client is configured for "{project}"')
                cached["id"] = identity["projectId"]
        return cached["id"]

    return resolve


class SubmissionClient:
    def __init__(self, http: HttpClient, project_id: Callable[[], Awaitable[str]]) -> None:
        self._http = http
        self._project_id = project_id

    async def queue(self, job: str, payload: Any = None, **options: Any) -> dict[str, Any]:
        body = build_submission(job, payload, **options)
        project_id = await self._project_id()
        data = await self._http.request("POST", f"/v1/projects/{project_id}/queue", body=body, idempotent=True)
        return to_queued_execution(data)

    async def cancel(self, execution_id: str) -> bool:
        project_id = await self._project_id()
        try:
            await self._http.request("POST", f"/v1/projects/{project_id}/executions/{seg(execution_id)}/cancel", idempotent=True)
            return True
        except ChronosConflictError:
            return False
