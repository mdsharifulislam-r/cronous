from __future__ import annotations

import asyncio
import threading
import time
from http import HTTPStatus

import pytest
from conftest import FakeChronos
from pydantic import BaseModel

from cronous import Chronos, ChronosConfigError, ChronosConnectionError, NonRetryableError, TaskContext, TaskRouter


class SendEmail(BaseModel):
    to: str
    subject: str = "Hello"


def client(url: str) -> Chronos:
    return Chronos(server=url, project="shop", token="chr_a_test", concurrency=3, shutdown_timeout=2)


async def test_handshake_runs_handlers_and_reports_results(fake: FakeChronos) -> None:
    chronos = client(fake.url)

    @chronos.task("email.send", queue="emails", max_attempts=5, timeout=30)
    async def send(email: SendEmail, ctx: TaskContext) -> dict:
        ctx.log.info("sending", {"to": email.to})
        return {"sent": True, "to": email.to, "key": ctx.idempotency_key, "attempt": ctx.attempt}

    @chronos.task("report.daily", schedule="0 2 * * *", timezone="UTC")
    async def report(ctx: TaskContext) -> None:
        return None

    await chronos.start()
    assert chronos.status == "connected"
    hello = fake.hellos[0]
    assert fake.headers[0]["authorization"] == "Bearer chr_a_test"
    assert hello["project"] == "shop" and hello["concurrency"] == 3 and hello["protocolVersion"] == 1
    tasks = {t["name"]: t for t in hello["tasks"]}
    assert tasks["email.send"]["queue"] == "emails"
    assert tasks["email.send"]["maxAttempts"] == 5
    assert tasks["email.send"]["timeoutMs"] == 30_000
    assert tasks["email.send"]["schedule"] is None
    assert tasks["email.send"]["payloadSchema"]["required"] == ["to"]  # generated from the pydantic model
    assert tasks["report.daily"]["schedule"] == {"cron": "0 2 * * *", "timezone": "UTC"}

    execution_id = await fake.execute("email.send", {"to": "a@example.com"})
    assert (await fake.next("ack", execution_id))["attempt"] == 1
    log = await fake.next("log", execution_id)
    assert log["level"] == "INFO" and log["message"] == "sending" and log["data"] == {"to": "a@example.com"}
    result = await fake.next("result", execution_id)
    assert result["status"] == "succeeded"
    assert result["output"] == {"sent": True, "to": "a@example.com", "key": f"idem-{execution_id}", "attempt": 1}
    await chronos.stop()
    assert chronos.status == "stopped"


async def test_failures_retryable_and_permanent(fake: FakeChronos) -> None:
    chronos = client(fake.url)

    @chronos.task("flaky")
    async def flaky(ctx: TaskContext) -> None:
        raise RuntimeError("provider unavailable")

    @chronos.task("order.validate")
    async def validate(payload: dict) -> None:
        raise NonRetryableError("invalid amount", "BAD_AMOUNT")

    @chronos.task("email.send")
    async def send(email: SendEmail) -> None:
        return None

    await chronos.start()
    first = await fake.execute("flaky")
    assert (await fake.next("result", first))["error"] == {"message": "provider unavailable", "retryable": True, "timedOut": False}
    second = await fake.execute("order.validate", {"amount": 0})
    assert (await fake.next("result", second))["error"] == {"message": "invalid amount", "retryable": False, "timedOut": False, "code": "BAD_AMOUNT"}
    third = await fake.execute("email.send", {"subject": "missing to"})
    error = (await fake.next("result", third))["error"]
    assert error["retryable"] is False and error["code"] == "INVALID_PAYLOAD"
    unknown = await fake.execute("not.registered")
    assert (await fake.next("result", unknown))["error"]["code"] == "NO_HANDLER"
    await chronos.stop()


async def test_timeout_and_cancel(fake: FakeChronos) -> None:
    chronos = client(fake.url)
    cancelled = asyncio.Event()

    @chronos.task("video.process", timeout=60)
    async def process(ctx: TaskContext) -> None:
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            assert ctx.cancelled
            cancelled.set()
            raise

    await chronos.start()
    timed_out = await fake.execute("video.process", timeout_ms=300)
    result = await fake.next("result", timed_out)
    assert result["status"] == "failed"
    assert result["error"] == {"message": "Task exceeded its timeout of 300ms", "retryable": True, "timedOut": True, "code": "TIMEOUT"}
    assert cancelled.is_set()

    cancelled.clear()
    running = await fake.execute("video.process")
    await fake.next("ack", running)
    await fake.cancel(running)
    await asyncio.wait_for(cancelled.wait(), 2)
    assert await fake.drain("result", running) == []  # the server finalises cancelled executions
    await chronos.stop()


async def test_sync_handlers_run_in_a_thread(fake: FakeChronos) -> None:
    chronos = client(fake.url)
    threads: list[int] = []

    @chronos.task("cpu.work")
    def work(payload: dict, ctx: TaskContext) -> int:
        threads.append(threading.get_ident())
        ctx.log.info("from a thread")
        time.sleep(0.05)
        return payload["n"] * 2

    await chronos.start()
    execution_id = await fake.execute("cpu.work", {"n": 21})
    assert (await fake.next("log", execution_id))["message"] == "from a thread"
    assert (await fake.next("result", execution_id))["output"] == 42
    assert threads and threads[0] != threading.get_ident()
    await chronos.stop()


async def test_shutdown_waits_for_running_handlers(fake: FakeChronos) -> None:
    chronos = client(fake.url)

    @chronos.task("slow")
    async def slow(ctx: TaskContext) -> str:
        await asyncio.sleep(0.3)
        return "done"

    await chronos.start()
    execution_id = await fake.execute("slow")
    await fake.next("ack", execution_id)
    await chronos.stop()
    assert (await fake.next("result", execution_id))["output"] == "done"


async def test_unacknowledged_results_are_resent_after_reconnect() -> None:
    async with FakeChronos(ack_results=False) as fake:
        chronos = Chronos(server=fake.url, project="shop", token="chr_a_test", reconnect_initial_delay=0.05, reconnect_max_delay=0.1)

        @chronos.task("quick")
        async def quick(ctx: TaskContext) -> int:
            return 1

        await chronos.start()
        execution_id = await fake.execute("quick")
        await fake.next("result", execution_id)
        assert fake.connection is not None
        await fake.connection.close(1012, "restart")
        resent = await fake.next("result", execution_id)
        assert resent["output"] == 1
        assert len(fake.hellos) == 2
        fake.ack_results = True
        await chronos.stop(timeout=1)


@pytest.mark.parametrize("close_code", [4001, 4003])
async def test_fatal_close_codes_fail_start(close_code: int) -> None:
    async with FakeChronos(close_code=close_code) as fake:
        chronos = client(fake.url)
        chronos.add_task("noop", lambda ctx: None)
        with pytest.raises(ChronosConnectionError) as info:
            await chronos.start()
        assert info.value.close_code == close_code
        assert chronos.status == "stopped"


async def test_rejected_upgrade_fails_start() -> None:
    async with FakeChronos(reject_status=HTTPStatus.UNAUTHORIZED) as fake:
        chronos = client(fake.url)
        chronos.add_task("noop", lambda ctx: None)
        with pytest.raises(ChronosConnectionError, match="authentication failed"):
            await chronos.start()


def test_registration_rules() -> None:
    chronos = Chronos(server="http://localhost:8080", project="shop", timezone="Asia/Dhaka")
    with pytest.raises(ChronosConfigError, match="not both"):
        chronos.add_task("a", lambda ctx: None, schedule="* * * * *", run_at="2030-01-01T00:00:00Z")
    with pytest.raises(ChronosConfigError, match="5 fields"):
        chronos.add_task("b", lambda ctx: None, schedule="* * *")
    with pytest.raises(ChronosConfigError, match="queue"):
        chronos.add_task("c", lambda ctx: None, queue="Bad Queue")
    with pytest.raises(ChronosConfigError, match="cannot tell"):
        chronos.add_task("d", lambda first, second: None)
    chronos.add_task("e", lambda ctx: None, schedule="0 9 * * *")
    assert chronos.tasks[-1].definition["schedule"]["timezone"] == "Asia/Dhaka"  # client default
    with pytest.raises(ChronosConfigError, match="already registered"):
        chronos.add_task("e", lambda ctx: None)
    with pytest.raises(ChronosConfigError, match="agent token"):
        asyncio.run(Chronos(server="http://localhost:8080", project="shop").start())


def test_routers_apply_prefix_and_defaults() -> None:
    emails = TaskRouter(prefix="email.", queue="emails", max_attempts=5)

    @emails.task()
    async def send(email: SendEmail) -> None: ...

    @emails.task("bounce", max_attempts=1)
    async def bounce(payload: dict) -> None: ...

    chronos = Chronos(server="http://localhost:8080", project="shop")
    chronos.include_router(emails)
    definitions = {t.name: t.definition for t in chronos.tasks}
    assert set(definitions) == {"email.send", "email.bounce"}
    assert definitions["email.send"]["queue"] == "emails" and definitions["email.send"]["maxAttempts"] == 5
    assert definitions["email.bounce"]["maxAttempts"] == 1
