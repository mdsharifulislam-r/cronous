"""The Chronos agent and producer client."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import random
import socket
import threading
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

import httpx
import websockets
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from ._http import HttpClient, socket_url
from ._json import dumps, serialise_output
from ._submission import Duration, SubmissionClient, project_id_resolver
from ._version import __version__
from .errors import ChronosConfigError, ChronosConnectionError, NonRetryableError
from .tasks import LogLevel, RegisteredTask, TaskContext, TaskLogger, TaskRouter, log_message

if TYPE_CHECKING:
    from .admin import ChronosAdmin

PROTOCOL_VERSION = 1
AGENT_WS_PATH = "/v1/agent/ws"
MAX_FRAME_BYTES = 256 * 1024
#: Close codes after which reconnecting cannot succeed without operator action.
FATAL_CLOSE_CODES = {4001, 4002, 4003}

ChronosStatus = Literal["idle", "connecting", "connected", "reconnecting", "stopping", "stopped"]

_default_logger = logging.getLogger("cronous")


@dataclass
class _Running:
    attempt: int
    ctx: TaskContext[Any]
    task: asyncio.Task[Any] | None = None
    reason: str | None = None
    done: asyncio.Future[None] = field(default_factory=lambda: asyncio.get_running_loop().create_future())


class _Abort(Exception):
    pass


class Chronos(TaskRouter):
    """Runs task handlers in this process and submits jobs.

    Create one instance per application, register handlers with ``@chronos.task(...)``
    (or routers with ``include_router``), then ``await chronos.start()`` once inside the
    event loop. Producing (``queue``, ``cancel``) works without ``start()``.

    Delivery is at least once: a handler can run more than once for the same execution.
    Use ``ctx.idempotency_key`` to make side effects idempotent.
    """

    def __init__(
        self,
        *,
        server: str,
        project: str,
        token: str | None = None,
        timezone: str | None = None,
        concurrency: int = 5,
        instance_id: str | None = None,
        hostname: str | None = None,
        shutdown_timeout: Duration = 30,
        reconnect_initial_delay: float = 0.5,
        reconnect_max_delay: float = 30.0,
        logger: logging.Logger | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__()
        if not server:
            raise ChronosConfigError('"server" is required')
        if not project:
            raise ChronosConfigError('"project" is required')
        if isinstance(concurrency, bool) or not isinstance(concurrency, int) or not 1 <= concurrency <= 1000:
            raise ChronosConfigError('"concurrency" must be an integer between 1 and 1000')
        self.server = server
        self.project = project
        self._token = token
        self.timezone = timezone
        self.concurrency = concurrency
        self.instance_id = instance_id or uuid.uuid4().hex
        self.hostname = hostname or socket.gethostname()
        self.shutdown_timeout = shutdown_timeout.total_seconds() if isinstance(shutdown_timeout, dt.timedelta) else float(shutdown_timeout)
        self._reconnect = (reconnect_initial_delay, reconnect_max_delay)
        self._log = logger or _default_logger
        self._socket_url = socket_url(server, AGENT_WS_PATH)  # validates the URL early

        self._http = HttpClient(
            server=server,
            token=lambda: self._token or os.environ.get("CHRONOS_AGENT_TOKEN"),
            missing_token_message='An agent token is required: pass "token" or set CHRONOS_AGENT_TOKEN',
            user_agent=f"chronos-sdk-python/{__version__}",
            transport=transport,
        )
        self._transport = transport
        self._submissions = SubmissionClient(self._http, project_id_resolver(self._http, project, "/v1/agent/identity"))

        self._state: ChronosStatus = "idle"
        self._tasks: dict[str, RegisteredTask] = {}
        self._running: dict[str, _Running] = {}
        self._unacked: dict[str, dict[str, Any]] = {}
        self._drained: asyncio.Event | None = None
        self._ws: ClientConnection | None = None
        self._welcomed = False
        self._send_lock: asyncio.Lock | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._runner: asyncio.Task[None] | None = None
        self._started: asyncio.Future[None] | None = None
        self._background: set[asyncio.Task[Any]] = set()
        self._outbox: asyncio.Queue[dict[str, Any]] | None = None
        self._writer: asyncio.Task[None] | None = None
        self.agent_id: str | None = None

    # ------------------------------------------------------------------ registration

    def _register(self, task: RegisteredTask) -> None:
        if self._state != "idle":
            raise ChronosConfigError(f'Cannot register task "{task.name}" after start(); register all tasks before starting')
        if self.timezone and task.definition.get("schedule") and "timezone" not in task.definition["schedule"]:
            task.definition["schedule"]["timezone"] = self.timezone
        super()._register(task)
        self._tasks[task.name] = task

    @property
    def status(self) -> ChronosStatus:
        return self._state

    # ------------------------------------------------------------------ producing

    async def queue(
        self,
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
        """Submits job ``job`` (a task of any application of the project, or a job created
        through the API) to run now, after ``delay`` seconds, or at ``run_at``.

        Retries of this call reuse one idempotency key, so it creates at most one execution.
        Returns the execution (``id``, ``status``, ``delayed``, ``scheduledFor``, ``created``...).
        """
        return await self._submissions.queue(
            job,
            payload,
            delay=delay,
            run_at=run_at,
            priority=priority,
            queue=queue,
            idempotency_key=idempotency_key,
            max_attempts=max_attempts,
            retry_backoff=retry_backoff,
            retry_backoff_max=retry_backoff_max,
            timeout=timeout,
        )

    async def cancel(self, execution_id: str) -> bool:
        """Cancels an execution that has not started yet. False if it already started or finished."""
        return await self._submissions.cancel(execution_id)

    def admin(self, *, token: str | None = None, max_attempts: int = 5, request_timeout: float = 10.0) -> ChronosAdmin:
        """An admin client for the same server and project. Pass a project API key
        (``chr_p_…``) or set CHRONOS_API_KEY."""
        from .admin import ChronosAdmin

        return ChronosAdmin(
            server=self.server, project=self.project, token=token, max_attempts=max_attempts, request_timeout=request_timeout, transport=self._transport
        )

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """Connects, registers the tasks and starts receiving executions. Returns after the
        first successful handshake; raises ChronosConnectionError on unrecoverable errors
        (bad token, project mismatch, invalid tasks). Network errors are retried."""
        if self._started is not None:
            return await asyncio.shield(self._started)
        if self._state != "idle":
            raise ChronosConfigError(f"Cannot start: the client is {self._state}")
        token = self._token or os.environ.get("CHRONOS_AGENT_TOKEN")
        if not token:
            raise ChronosConfigError('An agent token is required: pass "token" or set CHRONOS_AGENT_TOKEN')
        if not self._tasks:
            self._log.warning("Starting with no registered tasks")
        self._token = token
        self._loop = asyncio.get_running_loop()
        self._send_lock = asyncio.Lock()
        self._drained = asyncio.Event()
        self._drained.set()
        self._started = self._loop.create_future()
        self._state = "connecting"
        # Logs and results go through one FIFO, so a handler's logs always precede its result.
        self._outbox = asyncio.Queue()
        self._writer = asyncio.create_task(self._write_outbox(), name="chronos-writer")
        self._runner = asyncio.create_task(self._run(), name="chronos-agent")
        await asyncio.shield(self._started)

    async def stop(self, timeout: Duration | None = None) -> None:
        """Graceful shutdown: stop taking work, wait for running handlers (up to
        ``timeout``, default ``shutdown_timeout``, then cancel them), deliver their
        results and disconnect."""
        if self._state in ("idle", "stopped"):
            self._state = "stopped"
            await self._http.aclose()
            return
        if self._state == "stopping":
            return
        self._state = "stopping"
        await self._send({"type": "goodbye", "reason": "shutdown"})

        wait_for = self.shutdown_timeout if timeout is None else (timeout.total_seconds() if isinstance(timeout, dt.timedelta) else float(timeout))
        pending = [entry.done for entry in self._running.values()]
        if pending:
            _, still_running = await asyncio.wait(pending, timeout=wait_for)
            if still_running:
                self._log.warning("Cancelling %d handler(s) still running after %.0fs", len(self._running), wait_for)
                for entry in list(self._running.values()):
                    self._abort(entry, "shutdown")
                remaining = [entry.done for entry in self._running.values()]
                if remaining:
                    await asyncio.wait(remaining)

        # Give the server a moment to acknowledge the final results before disconnecting.
        if self._unacked and self._welcomed and self._drained is not None:
            try:
                await asyncio.wait_for(self._drained.wait(), 5)
            except asyncio.TimeoutError:
                pass
        if self._unacked:
            self._log.warning("%d result(s) were not acknowledged before shutdown; Chronos will retry those executions", len(self._unacked))

        ws = self._ws
        if ws is not None:
            try:
                await asyncio.wait_for(ws.close(1000, "agent stopped"), 2)
            except (asyncio.TimeoutError, ConnectionClosed, OSError):
                pass
        for task in (self._runner, self._writer):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self._state = "stopped"
        if self._started is not None and not self._started.done():
            self._started.set_exception(ChronosConfigError("stop() was called before the connection was established"))
            self._started.exception()  # mark retrieved
        await self._http.aclose()

    async def __aenter__(self) -> Chronos:
        await self.start()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.stop()

    # ------------------------------------------------------------------ connection

    async def _run(self) -> None:
        attempt = 0
        initial, maximum = self._reconnect
        while self._state not in ("stopping", "stopped"):
            code, reason, fatal = 1006, "", False
            try:
                async with connect(
                    self._socket_url,
                    additional_headers={"Authorization": f"Bearer {self._token}"},
                    user_agent_header=f"chronos-sdk-python/{__version__}",
                    open_timeout=15,
                    max_size=MAX_FRAME_BYTES,
                    ping_interval=20,
                    ping_timeout=20,
                ) as ws:
                    self._ws = ws
                    await self._send_now(ws, self._hello())
                    async for frame in ws:
                        if await self._on_frame(ws, frame):
                            attempt = 0
                    if ws.close_code is not None:
                        code, reason = ws.close_code, ws.close_reason or ""
            except InvalidStatus as error:
                status = error.response.status_code
                fatal = status in (401, 403, 404)
                code = 4001 if fatal else 1006
                reason = (
                    "authentication failed: invalid, revoked or expired agent token" if status == 401 else f"server responded {status} to the WebSocket upgrade"
                )
            except ConnectionClosed as error:
                received = error.rcvd
                code, reason = (received.code, received.reason) if received is not None else (1006, "connection lost")
            except (OSError, asyncio.TimeoutError, websockets.exceptions.InvalidHandshake) as error:
                reason = str(error) or type(error).__name__
            finally:
                self._ws = None
                self._welcomed = False

            if self._state in ("stopping", "stopped"):
                return
            if fatal or code in FATAL_CLOSE_CODES:
                rejection = ChronosConnectionError(f"Chronos rejected this agent: {reason or f'close code {code}'}", code)
                self._log.error(str(rejection))
                self._state = "stopped"
                for entry in list(self._running.values()):
                    self._abort(entry, "shutdown")
                if self._started is not None and not self._started.done():
                    self._started.set_exception(rejection)
                return

            if self._state == "connected":
                self._state = "reconnecting"
            delay = random.random() * min(maximum, initial * 2 ** min(attempt, 20))
            attempt += 1
            self._log.warning("Disconnected from Chronos (%s%s); reconnecting in %.1fs", code, f": {reason}" if reason else "", delay)
            await asyncio.sleep(delay)

    def _hello(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "protocolVersion": PROTOCOL_VERSION,
            "sdkVersion": f"py-{__version__}"[:40],
            "instanceId": self.instance_id,
            "project": self.project,
            "hostname": self.hostname[:255],
            "concurrency": self.concurrency,
            "tasks": [task.definition for task in self._tasks.values()],
        }

    async def _on_frame(self, ws: ClientConnection, frame: str | bytes) -> bool:
        """Handles one server frame. Returns True on a welcome."""
        try:
            message = json.loads(frame)
            kind = message["type"]
        except (ValueError, KeyError, TypeError) as error:
            self._log.warning("Ignoring malformed server frame: %s", error)
            return False

        if kind == "welcome":
            self._welcomed = True
            self.agent_id = message.get("agentId")
            if self._state in ("connecting", "reconnecting"):
                self._state = "connected"
            for task in message.get("tasks", []):
                if task.get("managedBy") == "api":
                    self._log.warning(
                        'Task "%s" is managed through the Chronos API; its schedule and settings there take precedence over code', task.get("name")
                    )
            interval = max(1.0, float(message.get("heartbeatIntervalMs", 10_000)) / 1000)
            self._spawn(self._heartbeat(ws, interval))
            # Renew leases of executions that kept running through a reconnect, then re-send
            # results the server has not acknowledged (they may have been lost in flight).
            await self._send_now(ws, self._heartbeat_message())
            for result in list(self._unacked.values()):
                await self._send_now(ws, result)
            self._log.info("Connected as agent %s with %d task(s)", self.agent_id, len(message.get("tasks", [])))
            if self._started is not None and not self._started.done():
                self._started.set_result(None)
            return True
        if kind == "execute":
            await self._on_execute(ws, message)
        elif kind == "cancel":
            entry = self._running.get(message.get("executionId", ""))
            if entry is not None and entry.attempt == message.get("attempt"):
                self._log.info("Execution %s cancelled: %s", message["executionId"], message.get("reason"))
                self._abort(entry, "cancel")
        elif kind == "result_ack":
            key = f"{message.get('executionId')}:{message.get('attempt')}"
            was_pending = self._unacked.pop(key, None) is not None
            if was_pending and not message.get("accepted", True):
                self._log.warning("Result for execution %s was discarded (cancelled, timed out or re-assigned)", message.get("executionId"))
            if not self._unacked and self._drained is not None:
                self._drained.set()
        elif kind == "error":
            self._log.error("Server error %s: %s", message.get("code"), message.get("message"))
        return False

    async def _heartbeat(self, ws: ClientConnection, interval: float) -> None:
        while self._ws is ws:
            await asyncio.sleep(interval)
            if self._ws is not ws:
                return
            await self._send_now(ws, self._heartbeat_message())

    def _heartbeat_message(self) -> dict[str, Any]:
        return {"type": "heartbeat", "running": [{"executionId": eid, "attempt": entry.attempt} for eid, entry in self._running.items()]}

    async def _send_now(self, ws: ClientConnection, message: dict[str, Any]) -> bool:
        assert self._send_lock is not None
        try:
            async with self._send_lock:
                await ws.send(dumps(message))
            return True
        except (ConnectionClosed, OSError):
            return False

    async def _send(self, message: dict[str, Any]) -> bool:
        ws = self._ws
        if ws is None or not self._welcomed:
            return False
        return await self._send_now(ws, message)

    def _post(self, message: dict[str, Any]) -> None:
        """Queues a message for the writer; callable from the loop or from handler threads."""
        loop, outbox = self._loop, self._outbox
        if loop is None or outbox is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            outbox.put_nowait(message)
        else:
            loop.call_soon_threadsafe(outbox.put_nowait, message)

    async def _write_outbox(self) -> None:
        assert self._outbox is not None
        while True:
            message = await self._outbox.get()
            await self._send(message)  # dropped while disconnected; results are re-sent on welcome

    def _spawn(self, coroutine: Any) -> None:
        task = asyncio.ensure_future(coroutine)
        self._background.add(task)  # the loop keeps only weak references to tasks
        task.add_done_callback(self._background.discard)

    # ------------------------------------------------------------------ executions

    async def _on_execute(self, ws: ClientConnection, message: dict[str, Any]) -> None:
        execution_id, attempt = message["executionId"], message["attempt"]
        existing = self._running.get(execution_id)
        if existing is not None and existing.attempt == attempt:
            await self._send_now(ws, {"type": "ack", "executionId": execution_id, "attempt": attempt})
            return
        task = self._tasks.get(message["task"])
        if task is None:
            await self._send_result(
                {
                    "type": "result",
                    "executionId": execution_id,
                    "attempt": attempt,
                    "status": "failed",
                    "error": {
                        "message": f'No handler registered for task "{message["task"]}" in this process',
                        "code": "NO_HANDLER",
                        "retryable": True,
                        "timedOut": False,
                    },
                }
            )
            return
        await self._send_now(ws, {"type": "ack", "executionId": execution_id, "attempt": attempt})
        self._start_execution(task, message)

    def _start_execution(self, task: RegisteredTask, message: dict[str, Any]) -> None:
        execution_id, attempt = message["executionId"], message["attempt"]

        def emit(level: LogLevel, text: str, data: Any) -> None:
            self._log.debug("[%s] %s", message["task"], text)
            self._post(log_message(execution_id, attempt, level, text, data))

        cancel_event = threading.Event()
        ctx: TaskContext[Any] = TaskContext(
            execution_id=execution_id,
            attempt=attempt,
            task=message["task"],
            scheduled_for=_parse_time(message.get("scheduledFor")),
            idempotency_key=message.get("idempotencyKey", ""),
            payload=message.get("payload"),
            log=TaskLogger(emit),
            cancel_event=cancel_event,
        )
        entry = _Running(attempt=attempt, ctx=ctx)
        self._running[execution_id] = entry
        entry.task = asyncio.create_task(self._execute(task, entry, execution_id, float(message.get("timeoutMs", 300_000)) / 1000))

    def _abort(self, entry: _Running, reason: str) -> None:
        if entry.reason is None:
            entry.reason = reason
        entry.ctx.cancel_reason = entry.reason
        entry.ctx._cancel_event.set()
        if entry.task is not None:
            entry.task.cancel()

    async def _execute(self, task: RegisteredTask, entry: _Running, execution_id: str, timeout: float) -> None:
        loop = asyncio.get_running_loop()
        timer = loop.call_later(timeout, self._abort, entry, "timeout")
        ref = {"executionId": execution_id, "attempt": entry.attempt}
        try:
            try:
                output = await task.invoke(entry.ctx)
            except asyncio.CancelledError:
                if entry.reason is None:
                    raise
                raise _Abort(entry.reason) from None
            result: dict[str, Any] = {"type": "result", **ref, "status": "succeeded"}
            serialised = serialise_output(output)
            if serialised is not None:
                result["output"] = serialised
            await self._send_result(result)
        except _Abort as abort:
            kind = str(abort)
            if kind == "cancel":
                return  # the server already finalised it
            timed_out = kind == "timeout"
            text = f"Task exceeded its timeout of {int(timeout * 1000)}ms" if timed_out else "agent shutting down"
            error: dict[str, Any] = {"message": text, "retryable": True, "timedOut": timed_out}
            if timed_out:
                error["code"] = "TIMEOUT"
            await self._send_result({"type": "result", **ref, "status": "failed", "error": error})
        except asyncio.CancelledError:
            raise
        except Exception as failure:  # noqa: BLE001 - every handler failure is reported
            error = {"message": (str(failure) or type(failure).__name__)[:4000], "retryable": not isinstance(failure, NonRetryableError), "timedOut": False}
            if isinstance(failure, NonRetryableError) and failure.code:
                error["code"] = failure.code[:100]
            await self._send_result({"type": "result", **ref, "status": "failed", "error": error})
        finally:
            timer.cancel()
            if self._running.get(execution_id) is entry:
                del self._running[execution_id]
            if not entry.done.done():
                entry.done.set_result(None)

    async def _send_result(self, result: dict[str, Any]) -> None:
        """Results are kept until the server acknowledges them, and re-sent after reconnects."""
        self._unacked[f"{result['executionId']}:{result['attempt']}"] = result
        if self._drained is not None:
            self._drained.clear()
        self._post(result)


def _parse_time(value: str | None) -> dt.datetime:
    if not value:
        return dt.datetime.now(dt.timezone.utc)
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
