from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from cronous import Chronos, TaskContext
from cronous.fastapi import AdminDep, ChronosDep, chronos_lifespan, setup

PROJECT_ID = "11111111-1111-1111-1111-111111111111"


def transport(requests: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/identity"):
            return httpx.Response(200, json={"data": {"projectId": PROJECT_ID, "projectSlug": "shop"}})
        if request.url.path.endswith("/queue"):
            body = json.loads(request.content)
            if body["job"] == "missing":
                return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": 'Job "missing" not found'}})
            return httpx.Response(201, json={"data": {"execution": {"id": "exe-1", "status": "PENDING", "delayed": "delayMs" in body}, "created": True}})
        if request.url.path.endswith("/queues"):
            return httpx.Response(200, json={"data": [{"name": "default", "counts": {"waiting": 0}}]})
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "no route"}})

    return httpx.MockTransport(handler)


class Signup(BaseModel):
    email: str


def build_app(chronos: Chronos) -> FastAPI:
    app = FastAPI()

    @app.post("/signup")
    async def signup(body: Signup, chronos: ChronosDep) -> dict[str, Any]:
        queued = await chronos.queue("email.send", {"to": body.email}, delay=60)
        return {"execution": queued["id"], "delayed": queued["delayed"]}

    @app.post("/queue/{job}")
    async def queue(job: str, chronos: ChronosDep) -> dict[str, Any]:
        return await chronos.queue(job)

    @app.get("/queues")
    async def queues(admin: AdminDep) -> list[dict[str, Any]]:
        return await admin.queues.list()

    return app


def test_dependencies_and_error_mapping_without_tasks() -> None:
    requests: list[httpx.Request] = []
    # No tasks registered: the app never opens the agent connection (server is unreachable here).
    chronos = Chronos(server="http://127.0.0.1:9", project="shop", token="chr_a_x", transport=transport(requests))
    app = setup(build_app(chronos), chronos, api_key="chr_p_x")
    with TestClient(app) as http:
        response = http.post("/signup", json={"email": "a@example.com"})
        assert response.status_code == 200
        assert response.json() == {"execution": "exe-1", "delayed": True}

        missing = http.post("/queue/missing")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "NOT_FOUND"

        invalid = http.post("/queue/bad name!")
        assert invalid.status_code == 400
        assert invalid.json()["error"]["code"] == "VALIDATION_FAILED"

        assert http.get("/queues").json() == [{"name": "default", "counts": {"waiting": 0}}]
    assert chronos.status == "stopped"
    admin_calls = [r for r in requests if r.url.path.endswith("/queues")]
    assert admin_calls[0].headers["authorization"] == "Bearer chr_p_x"


def test_lifespan_starts_and_stops_the_agent_with_the_app(monkeypatch: Any) -> None:
    calls: list[str] = []
    chronos = Chronos(server="http://127.0.0.1:9", project="shop", token="chr_a_x")

    @chronos.task("email.send")
    async def send(ctx: TaskContext) -> None: ...

    async def fake_start() -> None:
        calls.append("start")

    async def fake_stop(timeout: Any = None) -> None:
        calls.append("stop")

    monkeypatch.setattr(chronos, "start", fake_start)
    monkeypatch.setattr(chronos, "stop", fake_stop)

    @asynccontextmanager
    async def own(app: FastAPI) -> AsyncIterator[dict[str, Any]]:
        calls.append("own-enter")
        yield {"db": "connected"}
        calls.append("own-exit")

    app = FastAPI(lifespan=chronos_lifespan(chronos, lifespan=own))

    @app.get("/state")
    async def state(chronos: ChronosDep) -> dict[str, Any]:
        return {"status": chronos.status}

    with TestClient(app) as http:
        assert http.get("/state").json() == {"status": "idle"}
    assert calls == ["start", "own-enter", "own-exit", "stop"]


def test_worker_false_never_starts(monkeypatch: Any) -> None:
    chronos = Chronos(server="http://127.0.0.1:9", project="shop", token="chr_a_x")
    chronos.add_task("email.send", lambda ctx: None)

    async def boom() -> None:
        raise AssertionError("start() must not be called")

    monkeypatch.setattr(chronos, "start", boom)
    app = FastAPI(lifespan=chronos_lifespan(chronos, worker=False))
    with TestClient(app):
        pass
