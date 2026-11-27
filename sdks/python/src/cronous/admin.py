"""Admin client: manage jobs, queues, executions, schedules, agents and statistics."""

from __future__ import annotations

import asyncio
import datetime as dt
import os
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any, TypeVar

import httpx

from ._http import HttpClient, seg
from ._submission import Duration, SubmissionClient, build_submission, iso, project_id_resolver
from ._version import __version__
from .errors import ChronosConfigError, ChronosNotFoundError, ChronosWaitTimeoutError

T = TypeVar("T")

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
TERMINAL_STATUSES = ("SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTERED")
MAX_BATCH_SUBMISSIONS = 100

PathFn = Callable[[str], Awaitable[str]]


class ChronosAdmin:
    """Manages one project. Use a project API key (``chr_p_…``, recommended for services)
    or a user session token. ``token`` defaults to CHRONOS_API_KEY.

    Example::

        admin = ChronosAdmin(server="http://localhost:8080", project="shop")
        run = await admin.jobs.trigger("report.daily")
        done = await admin.executions.wait(run["id"])
    """

    def __init__(
        self,
        *,
        server: str,
        project: str,
        token: str | None = None,
        max_attempts: int = 5,
        request_timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not server:
            raise ChronosConfigError('"server" is required')
        if not project:
            raise ChronosConfigError('"project" is required')
        self.server = server
        self.project = project
        self._token = token
        self._http = HttpClient(
            server=server,
            token=self._current_token,
            missing_token_message='A project API key or user token is required: pass "token" or set CHRONOS_API_KEY',
            user_agent=f"chronos-sdk-python/{__version__} admin",
            max_attempts=max_attempts,
            request_timeout=request_timeout,
            transport=transport,
        )
        by_key = project_id_resolver(self._http, project, "/v1/identity")
        self._user_project: str | None = None

        async def project_id() -> str:
            if not self._current_token().startswith("chr_u_"):
                return await by_key()
            if self._user_project is None:
                self._user_project = await self._find_project_for_user()
            return self._user_project

        self._project_id = project_id

        async def path(suffix: str) -> str:
            return f"/v1/projects/{await project_id()}{suffix}"

        self._submissions = SubmissionClient(self._http, project_id)
        self.jobs = JobsApi(self._http, path)
        self.queues = QueuesApi(self._http, path)
        self.executions = ExecutionsApi(self._http, path, self.jobs)
        self.schedules = SchedulesApi(self._http, path, self.jobs)
        self.agents = AgentsApi(self._http, path)
        self.stats = StatsApi(self._http, path, self.jobs)

    def _current_token(self) -> str:
        return self._token or os.environ.get("CHRONOS_API_KEY") or ""

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> ChronosAdmin:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def project_info(self) -> dict[str, Any]:
        """The project this client manages. Fails fast on a bad token or wrong project slug."""
        return await self._http.request("GET", f"/v1/projects/{await self._project_id()}")

    async def identity(self) -> dict[str, Any]:
        """The project a project key belongs to (not available for user tokens)."""
        return await self._http.request("GET", "/v1/identity")

    async def queue(self, job: str, payload: Any = None, **options: Any) -> dict[str, Any]:
        """Submits a job; same options as ``Chronos.queue``."""
        return await self._submissions.queue(job, payload, **options)

    async def queue_batch(self, items: Sequence[dict[str, Any]]) -> dict[str, Any]:
        """Submits up to 100 jobs in one request; each item is ``{"job", "payload"?, **options}``
        and succeeds or fails on its own."""
        if not items or len(items) > MAX_BATCH_SUBMISSIONS:
            raise ChronosConfigError(f"queue_batch() takes 1-{MAX_BATCH_SUBMISSIONS} items")
        body = {
            "items": [build_submission(item["job"], item.get("payload"), **{k: v for k, v in item.items() if k not in ("job", "payload")}) for item in items]
        }
        return await self._http.request("POST", f"/v1/projects/{await self._project_id()}/queue/batch", body=body, idempotent=True)

    async def cancel(self, execution_id: str) -> bool:
        """Cancels an execution that has not finished. False if it already finished."""
        return await self._submissions.cancel(execution_id)

    async def _find_project_for_user(self) -> str:
        matches: list[str] = []
        for organization in await self._http.request("GET", "/v1/organizations"):
            for project in await self._http.request("GET", f"/v1/organizations/{organization['id']}/projects"):
                if project["slug"] == self.project:
                    matches.append(project["id"])
        if not matches:
            raise ChronosNotFoundError(f'No project "{self.project}" in your organizations', 404, "NOT_FOUND")
        if len(matches) > 1:
            raise ChronosConfigError(f'Project slug "{self.project}" exists in several of your organizations; use a project API key')
        return matches[0]


class JobsApi:
    def __init__(self, http: HttpClient, path: PathFn) -> None:
        self._http = http
        self._path = path
        self._ids: dict[str, str] = {}

    async def list(
        self,
        *,
        mode: str | None = None,
        enabled: bool | None = None,
        source: str | None = None,
        queue: str | None = None,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        jobs = await self._http.request(
            "GET", await self._path("/jobs"), query={"mode": mode, "enabled": enabled, "source": source, "queue": queue, "q": search}
        )
        for job in jobs:
            self._ids[job["name"]] = job["id"]
        return jobs

    async def get(self, job: str) -> dict[str, Any]:
        """A job by id or name."""
        return await self._with_id(job, lambda id: self._call("GET", f"/jobs/{id}"))

    async def create(self, job: dict[str, Any]) -> dict[str, Any]:
        """Creates a job from the REST API body, e.g.
        ``{"name": "sync", "mode": "HTTP", "http": {"url": ..., "method": "POST"}, "schedule": {"cron": "*/15 * * * *"}}``."""
        created = await self._http.request("POST", await self._path("/jobs"), body=job)
        self._ids[created["name"]] = created["id"]
        return created

    async def update(self, job: str, changes: dict[str, Any]) -> dict[str, Any]:
        return await self._with_id(job, lambda id: self._call("PATCH", f"/jobs/{id}", body=changes))

    async def delete(self, job: str) -> None:
        await self._with_id(job, lambda id: self._call("DELETE", f"/jobs/{id}", idempotent=True))
        self._ids.pop(job, None)

    async def enable(self, job: str) -> dict[str, Any]:
        return await self.update(job, {"enabled": True})

    async def disable(self, job: str) -> dict[str, Any]:
        return await self.update(job, {"enabled": False})

    async def pause(self, job: str) -> dict[str, Any]:
        """Pauses the job's schedule."""
        return await self._with_id(job, lambda id: self._call("POST", f"/jobs/{id}/pause", idempotent=True))

    async def resume(self, job: str) -> dict[str, Any]:
        return await self._with_id(job, lambda id: self._call("POST", f"/jobs/{id}/resume", idempotent=True))

    async def trigger(self, job: str, *, payload: Any = None, idempotency_key: str | None = None) -> dict[str, Any]:
        """Runs the job now. Returns the execution (``id``, ``status``, ``created``...)."""
        body: dict[str, Any] = {}
        if payload is not None:
            body["payload"] = payload
        if idempotency_key:
            body["idempotencyKey"] = idempotency_key
        result = await self._with_id(job, lambda id: self._call("POST", f"/jobs/{id}/trigger", body=body, idempotent=bool(idempotency_key)))
        execution = result["execution"]
        keys = ("id", "jobId", "status", "trigger", "scheduledFor", "idempotencyKey")
        return {**{key: execution.get(key) for key in keys}, "created": result["created"]}

    async def next_runs(self, job: str, count: int = 5) -> dict[str, Any]:
        """Next run times of the job's schedule: ``{"timezone", "occurrences"}``."""
        return await self._with_id(job, lambda id: self._call("GET", f"/jobs/{id}/schedule/preview", query={"count": count}))

    async def resolve_id(self, job: str) -> str:
        """Job id for an id or name."""
        if UUID.match(job):
            return job
        if job in self._ids:
            return self._ids[job]
        for candidate in await self.list(search=job):
            if candidate["name"] == job:
                return str(candidate["id"])
        raise ChronosNotFoundError(f'Job "{job}" not found', 404, "NOT_FOUND")

    async def _call(self, method: str, suffix: str, **kwargs: Any) -> Any:
        return await self._http.request(method, await self._path(suffix), **kwargs)

    async def _with_id(self, job: str, call: Callable[[str], Awaitable[T]]) -> T:
        cached = not UUID.match(job) and job in self._ids
        try:
            return await call(await self.resolve_id(job))
        except ChronosNotFoundError:
            if not cached:
                raise
            # A stale cached id (job deleted and recreated): refresh once.
            self._ids.pop(job, None)
            return await call(await self.resolve_id(job))


class QueuesApi:
    def __init__(self, http: HttpClient, path: PathFn) -> None:
        self._http = http
        self._path = path

    async def list(self) -> list[dict[str, Any]]:
        """Queues with live counts."""
        return await self._http.request("GET", await self._path("/queues"))

    async def get(self, name: str) -> dict[str, Any]:
        return await self._http.request("GET", await self._path(f"/queues/{seg(name)}"))

    async def create(self, queue: dict[str, Any]) -> dict[str, Any]:
        """``{"name", "concurrency"?, "description"?, ...}``"""
        return await self._http.request("POST", await self._path("/queues"), body=queue)

    async def update(self, name: str, changes: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("PATCH", await self._path(f"/queues/{seg(name)}"), body=changes)

    async def delete(self, name: str) -> None:
        await self._http.request("DELETE", await self._path(f"/queues/{seg(name)}"), idempotent=True)

    async def pause(self, name: str) -> dict[str, Any]:
        return await self._http.request("POST", await self._path(f"/queues/{seg(name)}/pause"), idempotent=True)

    async def resume(self, name: str) -> dict[str, Any]:
        return await self._http.request("POST", await self._path(f"/queues/{seg(name)}/resume"), idempotent=True)


class ExecutionsApi:
    def __init__(self, http: HttpClient, path: PathFn, jobs: JobsApi) -> None:
        self._http = http
        self._path = path
        self._jobs = jobs

    async def list(
        self,
        *,
        job: str | None = None,
        status: str | Sequence[str] | None = None,
        trigger: str | None = None,
        mode: str | None = None,
        queue: str | None = None,
        delayed: bool | None = None,
        agent_id: str | None = None,
        worker_id: str | None = None,
        start: dt.datetime | str | None = None,
        end: dt.datetime | str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """One page: ``{"items": [...], "nextCursor": str | None}``."""
        query = {
            "jobId": await self._jobs.resolve_id(job) if job is not None else None,
            "status": status if status is None or isinstance(status, str) else ",".join(status),
            "trigger": trigger,
            "mode": mode,
            "queue": queue,
            "delayed": delayed,
            "agentId": agent_id,
            "workerId": worker_id,
            "from": iso(start),
            "to": iso(end),
            "limit": limit,
            "cursor": cursor,
        }
        return await self._http.request("GET", await self._path("/executions"), query=query)

    async def iterate(self, **filters: Any) -> AsyncIterator[dict[str, Any]]:
        """Every matching execution, page by page: ``async for e in admin.executions.iterate(status="DEAD_LETTERED")``."""
        cursor: str | None = None
        while True:
            page = await self.list(**filters, cursor=cursor)
            for item in page["items"]:
                yield item
            cursor = page.get("nextCursor")
            if not cursor:
                return

    async def get(self, execution_id: str) -> dict[str, Any]:
        """Execution with attempts and the first 500 log lines."""
        return await self._http.request("GET", await self._path(f"/executions/{seg(execution_id)}"))

    async def logs(self, execution_id: str, *, after_id: str | None = None, limit: int | None = None) -> dict[str, Any]:
        """``{"items": [...], "nextAfterId"}``, oldest first."""
        return await self._http.request("GET", await self._path(f"/executions/{seg(execution_id)}/logs"), query={"afterId": after_id, "limit": limit})

    async def cancel(self, execution_id: str) -> dict[str, Any]:
        return await self._http.request("POST", await self._path(f"/executions/{seg(execution_id)}/cancel"), idempotent=True)

    async def retry(self, execution_id: str) -> dict[str, Any]:
        """Runs a FAILED, DEAD_LETTERED or CANCELLED execution again (replay)."""
        return await self._http.request("POST", await self._path(f"/executions/{seg(execution_id)}/retry"))

    async def wait(self, execution_id: str, *, timeout: Duration = 60, interval: float = 1.0) -> dict[str, Any]:
        """Polls until the execution is SUCCEEDED, FAILED, CANCELLED or DEAD_LETTERED.
        Raises ChronosWaitTimeoutError after ``timeout`` seconds."""
        limit = timeout.total_seconds() if isinstance(timeout, dt.timedelta) else float(timeout)
        deadline = time.monotonic() + limit
        interval = max(0.1, interval)
        while True:
            execution = await self.get(execution_id)
            if execution["status"] in TERMINAL_STATUSES:
                return execution
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ChronosWaitTimeoutError(f"Execution {execution_id} is still {execution['status']} after {limit:g}s", execution["status"])
            await asyncio.sleep(min(interval, remaining))


class SchedulesApi:
    def __init__(self, http: HttpClient, path: PathFn, jobs: JobsApi) -> None:
        self._http = http
        self._path = path
        self._jobs = jobs

    async def preview(self, schedule: dict[str, Any], count: int = 10) -> dict[str, Any]:
        """Next occurrences of a schedule definition, e.g. ``{"cron": "0 9 * * 1-5", "timezone": "Asia/Dhaka"}``."""
        return await self._http.request("POST", await self._path("/schedule/preview"), body={"schedule": schedule, "count": count}, idempotent=True)

    async def upcoming(self, *, end: dt.datetime | str, start: dt.datetime | str | None = None, job: str | None = None) -> dict[str, Any]:
        query = {"from": iso(start), "to": iso(end), "jobId": await self._jobs.resolve_id(job) if job is not None else None}
        return await self._http.request("GET", await self._path("/schedule/upcoming"), query=query)


class AgentsApi:
    def __init__(self, http: HttpClient, path: PathFn) -> None:
        self._http = http
        self._path = path

    async def list(self, *, status: str | None = None) -> list[dict[str, Any]]:
        return await self._http.request("GET", await self._path("/agents"), query={"status": status})

    async def get(self, agent_id: str) -> dict[str, Any]:
        return await self._http.request("GET", await self._path(f"/agents/{seg(agent_id)}"))

    async def remove(self, agent_id: str) -> None:
        await self._http.request("DELETE", await self._path(f"/agents/{seg(agent_id)}"), idempotent=True)


class StatsApi:
    def __init__(self, http: HttpClient, path: PathFn, jobs: JobsApi) -> None:
        self._http = http
        self._path = path
        self._jobs = jobs

    async def summary(self, *, hours: int | None = None, job: str | None = None, queue: str | None = None) -> dict[str, Any]:
        query = {"hours": hours, "queue": queue, "jobId": await self._jobs.resolve_id(job) if job is not None else None}
        return await self._http.request("GET", await self._path("/stats"), query=query)

    async def timeseries(
        self,
        *,
        hours: int | None = None,
        bucket: str | None = None,
        job: str | None = None,
        queue: str | None = None,
        mode: str | None = None,
    ) -> dict[str, Any]:
        query = {"hours": hours, "bucket": bucket, "queue": queue, "mode": mode, "jobId": await self._jobs.resolve_id(job) if job is not None else None}
        return await self._http.request("GET", await self._path("/stats/timeseries"), query=query)
