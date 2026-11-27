from __future__ import annotations

import datetime as dt
import json
from typing import Any

import httpx
import pytest

from cronous import (
    Chronos,
    ChronosAdmin,
    ChronosAuthError,
    ChronosConfigError,
    ChronosConflictError,
    ChronosNotFoundError,
    ChronosValidationError,
    ChronosWaitTimeoutError,
)
from cronous._submission import build_submission

PROJECT_ID = "11111111-1111-1111-1111-111111111111"
JOB_ID = "22222222-2222-2222-2222-222222222222"


class Api:
    """Records requests and answers them from a route table."""

    def __init__(self, routes: dict[tuple[str, str], Any]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.method, request.url.path)
        answer = self.routes.get(key)
        if answer is None:
            return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": f"no route {key}"}})
        if callable(answer):
            answer = answer(request)
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(200, json={"data": answer})

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


IDENTITY = {("GET", "/v1/identity"): {"projectId": PROJECT_ID, "projectSlug": "shop"}}
AGENT_IDENTITY = {("GET", "/v1/agent/identity"): {"projectId": PROJECT_ID, "projectSlug": "shop"}}


def execution(**extra: Any) -> dict[str, Any]:
    return {
        "id": "exe-1",
        "jobId": JOB_ID,
        "jobName": "email.send",
        "queue": "emails",
        "status": "PENDING",
        "trigger": "API",
        "priority": 0,
        "delayed": False,
        "scheduledFor": "2026-11-27T10:00:00.000Z",
        "idempotencyKey": "k",
        **extra,
    }


async def test_queue_sends_a_validated_submission_with_an_idempotency_key() -> None:
    api = Api({**AGENT_IDENTITY, ("POST", f"/v1/projects/{PROJECT_ID}/queue"): {"execution": execution(delayed=True), "created": True}})
    chronos = Chronos(server="http://chronos:8080", project="shop", token="chr_a_x", transport=api.transport)
    queued = await chronos.queue(
        "email.send", {"to": "a@example.com", "at": dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)}, delay=dt.timedelta(minutes=5), priority=10
    )
    assert queued["id"] == "exe-1" and queued["delayed"] is True and queued["created"] is True
    body = json.loads(api.requests[-1].content)
    assert body["job"] == "email.send" and body["delayMs"] == 300_000 and body["priority"] == 10
    assert body["payload"] == {"to": "a@example.com", "at": "2026-01-01T00:00:00+00:00"}
    assert body["idempotencyKey"].startswith("sdk-")
    assert api.requests[-1].headers["authorization"] == "Bearer chr_a_x"
    await chronos.stop()


def test_submission_validation() -> None:
    with pytest.raises(ChronosValidationError, match="job"):
        build_submission("bad name!")
    with pytest.raises(ChronosValidationError, match="not both"):
        build_submission("a", delay=1, run_at="2030-01-01T00:00:00Z")
    with pytest.raises(ChronosValidationError, match="priority"):
        build_submission("a", priority=101)
    with pytest.raises(ChronosValidationError, match="payload"):
        build_submission("a", {"blob": "x" * 70_000})
    with pytest.raises(ChronosConfigError, match="timezone-aware"):
        build_submission("a", run_at=dt.datetime(2030, 1, 1))
    assert build_submission("a", run_at=dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc))["runAt"] == "2030-01-01T00:00:00+00:00"


async def test_project_slug_mismatch_is_reported() -> None:
    api = Api({("GET", "/v1/identity"): {"projectId": PROJECT_ID, "projectSlug": "billing"}})
    async with ChronosAdmin(server="http://chronos:8080", project="shop", token="chr_p_x", transport=api.transport) as admin:
        with pytest.raises(ChronosConfigError, match='belongs to project "billing"'):
            await admin.queues.list()


async def test_errors_are_typed_and_cancel_returns_false_on_conflict() -> None:
    base = f"/v1/projects/{PROJECT_ID}"
    api = Api(
        {
            **IDENTITY,
            ("POST", f"{base}/executions/done/cancel"): httpx.Response(409, json={"error": {"code": "INVALID_STATE", "message": "already finished"}}),
            ("GET", f"{base}/queues"): httpx.Response(403, json={"error": {"code": "FORBIDDEN", "message": "nope"}}),
            ("POST", f"{base}/jobs"): httpx.Response(409, json={"error": {"code": "CONFLICT", "message": "exists"}}),
        }
    )
    async with ChronosAdmin(server="http://chronos:8080", project="shop", token="chr_p_x", transport=api.transport) as admin:
        assert await admin.cancel("done") is False
        with pytest.raises(ChronosAuthError):
            await admin.queues.list()
        with pytest.raises(ChronosConflictError):
            await admin.jobs.create({"name": "x", "mode": "AGENT"})
        with pytest.raises(ChronosNotFoundError):
            await admin.executions.get("missing")


async def test_jobs_by_name_trigger_and_wait() -> None:
    base = f"/v1/projects/{PROJECT_ID}"
    statuses = iter(["RUNNING", "SUCCEEDED"])
    api = Api(
        {
            **IDENTITY,
            ("GET", f"{base}/jobs"): [{"id": JOB_ID, "name": "report.daily"}],
            ("POST", f"{base}/jobs/{JOB_ID}/trigger"): {"execution": execution(status="PENDING", trigger="MANUAL"), "created": True},
            ("GET", f"{base}/executions/exe-1"): lambda _: {"id": "exe-1", "status": next(statuses)},
            ("GET", f"{base}/jobs/{JOB_ID}/schedule/preview"): {"timezone": "UTC", "occurrences": ["a", "b", "c"]},
        }
    )
    async with ChronosAdmin(server="http://chronos:8080", project="shop", token="chr_p_x", transport=api.transport) as admin:
        run = await admin.jobs.trigger("report.daily", payload={"x": 1})
        assert run == {
            "id": "exe-1",
            "jobId": JOB_ID,
            "status": "PENDING",
            "trigger": "MANUAL",
            "scheduledFor": "2026-11-27T10:00:00.000Z",
            "idempotencyKey": "k",
            "created": True,
        }
        done = await admin.executions.wait("exe-1", interval=0.1)
        assert done["status"] == "SUCCEEDED"
        assert (await admin.jobs.next_runs("report.daily", 3))["occurrences"] == ["a", "b", "c"]
        # name -> id is cached: one list call for three lookups
        assert sum(1 for r in api.requests if r.url.path == f"{base}/jobs") == 1


async def test_wait_times_out() -> None:
    base = f"/v1/projects/{PROJECT_ID}"
    api = Api({**IDENTITY, ("GET", f"{base}/executions/exe-1"): {"id": "exe-1", "status": "RUNNING"}})
    async with ChronosAdmin(server="http://chronos:8080", project="shop", token="chr_p_x", transport=api.transport) as admin:
        with pytest.raises(ChronosWaitTimeoutError) as info:
            await admin.executions.wait("exe-1", timeout=0.3, interval=0.1)
        assert info.value.last_status == "RUNNING"


async def test_iterate_follows_cursors() -> None:
    base = f"/v1/projects/{PROJECT_ID}"

    def page(request: httpx.Request) -> dict[str, Any]:
        if request.url.params.get("cursor") == "c2":
            return {"items": [{"id": "3"}], "nextCursor": None}
        assert request.url.params["status"] == "FAILED,DEAD_LETTERED"
        return {"items": [{"id": "1"}, {"id": "2"}], "nextCursor": "c2"}

    api = Api({**IDENTITY, ("GET", f"{base}/executions"): page})
    async with ChronosAdmin(server="http://chronos:8080", project="shop", token="chr_p_x", transport=api.transport) as admin:
        ids = [e["id"] async for e in admin.executions.iterate(status=["FAILED", "DEAD_LETTERED"])]
    assert ids == ["1", "2", "3"]


async def test_retries_on_503_then_succeeds() -> None:
    base = f"/v1/projects/{PROJECT_ID}"
    calls = {"n": 0}

    def flaky(_: httpx.Request) -> Any:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, headers={"retry-after": "0"}, json={"error": {"code": "UNAVAILABLE", "message": "busy"}})
        return [{"name": "default"}]

    api = Api({**IDENTITY, ("GET", f"{base}/queues"): flaky})
    async with ChronosAdmin(server="http://chronos:8080", project="shop", token="chr_p_x", transport=api.transport) as admin:
        assert await admin.queues.list() == [{"name": "default"}]
    assert calls["n"] == 2
