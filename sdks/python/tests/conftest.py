from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from http import HTTPStatus
from typing import Any

import pytest
from websockets.asyncio.server import Server, ServerConnection, serve


class FakeChronos:
    """A minimal agent-protocol server: answers hello with welcome, acknowledges results,
    and lets tests send execute/cancel frames and inspect what the agent sent."""

    def __init__(self, *, reject_status: HTTPStatus | None = None, close_code: int | None = None, ack_results: bool = True) -> None:
        self.reject_status = reject_status
        self.close_code = close_code
        self.ack_results = ack_results
        self.hellos: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []
        self.messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.connection: ServerConnection | None = None
        self.server: Server | None = None
        self.url = ""

    async def __aenter__(self) -> FakeChronos:
        def process_request(connection: ServerConnection, request: Any) -> Any:
            self.headers.append(dict(request.headers))
            if self.reject_status is not None:
                return connection.respond(self.reject_status, "rejected\n")
            return None

        self.server = await serve(self._handle, "127.0.0.1", 0, process_request=process_request)
        port = self.server.sockets[0].getsockname()[1] if hasattr(self.server, "sockets") else list(self.server.sockets)[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        return self

    async def __aexit__(self, *exc: object) -> None:
        assert self.server is not None
        self.server.close()
        await self.server.wait_closed()

    async def _handle(self, ws: ServerConnection) -> None:
        hello = json.loads(await ws.recv())
        self.hellos.append(hello)
        if self.close_code is not None:
            await ws.close(self.close_code, "rejected by test")
            return
        self.connection = ws
        await ws.send(
            json.dumps(
                {
                    "type": "welcome",
                    "protocolVersion": 1,
                    "agentId": str(uuid.uuid4()),
                    "heartbeatIntervalMs": 1000,
                    "tasks": [{"name": t["name"], "jobId": str(uuid.uuid4()), "managedBy": "sdk", "nextRunAt": None} for t in hello["tasks"]],
                }
            )
        )
        try:
            async for raw in ws:
                message = json.loads(raw)
                if message["type"] == "result" and self.ack_results:
                    await ws.send(json.dumps({"type": "result_ack", "executionId": message["executionId"], "attempt": message["attempt"], "accepted": True}))
                await self.messages.put(message)
        except Exception:
            pass

    async def execute(self, task: str, payload: Any = None, *, timeout_ms: int = 5000, attempt: int = 1) -> str:
        assert self.connection is not None
        execution_id = str(uuid.uuid4())
        await self.connection.send(
            json.dumps(
                {
                    "type": "execute",
                    "executionId": execution_id,
                    "attempt": attempt,
                    "task": task,
                    "idempotencyKey": f"idem-{execution_id}",
                    "scheduledFor": "2026-11-27T10:00:00.000Z",
                    "payload": payload,
                    "timeoutMs": timeout_ms,
                }
            )
        )
        return execution_id

    async def cancel(self, execution_id: str, attempt: int = 1) -> None:
        assert self.connection is not None
        await self.connection.send(json.dumps({"type": "cancel", "executionId": execution_id, "attempt": attempt, "reason": "cancelled by test"}))

    async def next(self, kind: str, execution_id: str | None = None, timeout: float = 5) -> dict[str, Any]:
        """The next message of type ``kind`` (heartbeats and other types are skipped)."""

        async def find() -> dict[str, Any]:
            while True:
                message = await self.messages.get()
                if message["type"] == kind and (execution_id is None or message.get("executionId") == execution_id):
                    return message

        return await asyncio.wait_for(find(), timeout)

    async def drain(self, kind: str, execution_id: str, wait: float = 0.5) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        try:
            while True:
                found.append(await self.next(kind, execution_id, timeout=wait))
        except asyncio.TimeoutError:
            return found


@pytest.fixture
async def fake() -> AsyncIterator[FakeChronos]:
    async with FakeChronos() as server:
        yield server
