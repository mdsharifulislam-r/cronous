# cronous (Python)

Python and FastAPI client for [Chronos](https://github.com/mdsharifulislam-r/cronous), a
self-hosted job scheduler. Run job handlers inside your app, submit immediate, delayed and
scheduled jobs, and manage jobs, queues and executions.

```bash
pip install "cronous[fastapi]"   # or: pip install cronous
```

Requires Python 3.10+ and a running Chronos server (`docker pull cronouss/cronous`, see the
[main README](https://github.com/mdsharifulislam-r/cronous#readme)).

## FastAPI in one file

```python
from fastapi import FastAPI
from pydantic import BaseModel

from cronous import Chronos, NonRetryableError, TaskContext
from cronous.fastapi import AdminDep, ChronosDep, setup

chronos = Chronos(server="http://localhost:8080", project="shop")  # token: CHRONOS_AGENT_TOKEN


class SendEmail(BaseModel):
    to: str
    subject: str


@chronos.task("email.send", queue="emails", max_attempts=5, timeout=30)
async def send_email(email: SendEmail, ctx: TaskContext) -> dict:
    ctx.log.info("sending", {"to": email.to, "attempt": ctx.attempt})
    await mailer.send(email, idempotency_key=ctx.idempotency_key)
    return {"sent": True}


@chronos.task("report.daily", schedule="0 2 * * *", timezone="Asia/Dhaka")
async def daily_report(ctx: TaskContext) -> dict:
    return {"rows": await build_report()}


app = FastAPI()
setup(app, chronos)  # starts the agent with the app, stops it gracefully, maps errors to HTTP


@app.post("/signup")
async def signup(user: SendEmail, chronos: ChronosDep):
    now = await chronos.queue("email.send", {"to": user.to, "subject": "Welcome"})
    later = await chronos.queue("email.send", {"to": user.to, "subject": "How is it going?"}, delay=3 * 24 * 3600)
    return {"welcome": now["id"], "follow_up": later["id"]}


@app.get("/failed")
async def failed(admin: AdminDep):  # admin token: CHRONOS_API_KEY
    return await admin.executions.list(status="FAILED", limit=20)
```

```bash
CHRONOS_AGENT_TOKEN=chr_a_… CHRONOS_API_KEY=chr_p_… uvicorn main:app
```

The agent keeps one **outbound** WebSocket to Chronos, so your app needs no public port to
receive jobs.

## Handlers

Register with `@chronos.task(name, **options)` (or `chronos.add_task(name, fn, **options)`).
Arguments are chosen from the handler's signature, FastAPI style:

| Parameter | Receives |
| --- | --- |
| annotated `TaskContext`, or named `ctx` / `context` | the context (below) |
| annotated with a **pydantic model** | the payload validated into the model. Its JSON Schema is sent to Chronos, so invalid submissions are rejected **before** they are queued. A payload that still fails validation fails the execution without retries. |
| named `payload` | the raw payload |
| a single unannotated parameter | the context |

`TaskContext` has `execution_id`, `attempt`, `task`, `scheduled_for`, `idempotency_key`,
`payload`, `log` (`debug/info/warn/error(message, data)`, stored with the execution) and
`cancelled`.

* `async def` handlers run on the event loop. On timeout, cancellation or shutdown they get
  `asyncio.CancelledError`.
* Plain `def` handlers run in a worker thread so they never block the loop. Long ones should
  check `ctx.cancelled`.
* Raise `NonRetryableError("reason", code="OPTIONAL")` for permanent failures. Any other
  exception is retried with backoff.
* Delivery is at least once: make side effects idempotent with `ctx.idempotency_key`.

Task options (durations are seconds or `timedelta`):

| Option | Meaning |
| --- | --- |
| `schedule` | 5-field cron expression |
| `run_at` | one-time run (timezone-aware `datetime` or ISO string) |
| `timezone`, `misfire_policy` (`FIRE_ONCE`/`SKIP`/`FIRE_ALL`), `misfire_grace`, `max_catch_up` | schedule behaviour |
| `timeout`, `max_attempts`, `retry_backoff`, `retry_backoff_max` | execution settings |
| `concurrency_policy` (`ALLOW`/`FORBID`) | skip a run while the previous one is running |
| `queue`, `priority` (0-100), `max_concurrency` | admission |
| `payload_schema` | explicit JSON Schema (`False` to skip the generated one) |
| `description` | shown in the dashboard |

### Task routers

Split tasks across modules like `APIRouter`:

```python
# emails.py
from cronous import TaskRouter

router = TaskRouter(prefix="email.", queue="emails", max_attempts=5)

@router.task()               # name: "email.send"
async def send(email: SendEmail) -> None: ...

@router.task("bounce")       # name: "email.bounce"
def bounce(payload: dict) -> None: ...

# main.py
chronos.include_router(emails.router)
```

## Producing

```python
await chronos.queue("email.send", {"to": "a@example.com"})                       # now
await chronos.queue("email.send", payload, delay=300)                            # in 5 minutes
await chronos.queue("email.send", payload, run_at=datetime(2026, 12, 1, 9, tzinfo=timezone.utc))
await chronos.queue("email.send", payload, priority=90, queue="urgent", idempotency_key=f"welcome-{user.id}")
await chronos.cancel(execution_id)                                               # False if it already started
```

Payloads may contain pydantic models, dataclasses, datetimes, UUIDs and decimals. `queue`
works without starting the agent: it only needs the server and a token. Retries of one call
reuse a single idempotency key, so a call creates at most one execution.

## Admin API

```python
from cronous import ChronosAdmin

async with ChronosAdmin(server="http://localhost:8080", project="shop") as admin:  # CHRONOS_API_KEY
    await admin.jobs.create({"name": "sync-crm", "mode": "HTTP",
                             "http": {"url": "https://app.example.com/hooks/sync", "method": "POST"},
                             "schedule": {"cron": "*/15 * * * *"}})
    run = await admin.jobs.trigger("report.daily", payload={"full": True})
    done = await admin.executions.wait(run["id"], timeout=120)       # SUCCEEDED, FAILED, …
    async for failed in admin.executions.iterate(status="DEAD_LETTERED"):
        await admin.executions.retry(failed["id"])
    await admin.queues.pause("emails")
    print(await admin.stats.summary(hours=24))
```

| Area | Methods |
| --- | --- |
| `admin.jobs` | `list`, `get`, `create`, `update`, `delete`, `enable`, `disable`, `pause`, `resume`, `trigger`, `next_runs`, `resolve_id` (jobs by id or name) |
| `admin.queues` | `list`, `get`, `create`, `update`, `delete`, `pause`, `resume` |
| `admin.executions` | `list`, `iterate`, `get`, `logs`, `cancel`, `retry`, `wait` |
| `admin.schedules` | `preview`, `upcoming` |
| `admin.agents` | `list`, `get`, `remove` |
| `admin.stats` | `summary`, `timeseries` |
| `admin` | `queue`, `queue_batch`, `cancel`, `project_info`, `identity` |

Results are the API's JSON as dicts. Errors are typed: `ChronosValidationError` (400),
`ChronosAuthError` (401/403), `ChronosNotFoundError` (404), `ChronosConflictError` (409),
`ChronosRequestError` (others, `status=0` for network errors), `ChronosWaitTimeoutError`.
GETs and submissions are retried on network errors and 502/503/504/429.

## FastAPI reference

| API | Purpose |
| --- | --- |
| `setup(app, chronos, *, api_key=None, worker=True, wait_for_connection=True, exception_handlers=True)` | Adds Chronos to an existing app; keeps the app's own lifespan |
| `chronos_lifespan(chronos, *, lifespan=None, ...)` | The same as a `lifespan` for `FastAPI(lifespan=...)`; your own lifespan runs inside it |
| `ChronosDep`, `AdminDep` | Dependencies (`Annotated` types) for route parameters |
| `get_chronos`, `get_admin` | The dependency functions |
| `register_exception_handlers(app)` | Validation → 400, not found → 404, conflict → 409, wait timeout → 504, auth and other Chronos errors → 502 |

* `worker=False` never connects as an agent: use it for API-only replicas that only submit
  jobs. An app without registered tasks never connects either, and needs no agent token.
* `wait_for_connection=False` starts the app even while Chronos is unreachable (errors are
  logged). By default a bad token or invalid task fails startup.
* On shutdown running handlers finish (up to `shutdown_timeout`, default 30 s), then results
  are delivered before the connection closes.

## Without FastAPI

```python
import asyncio
from cronous import Chronos

chronos = Chronos(server="http://localhost:8080", project="shop")

@chronos.task("cleanup", schedule="0 * * * *")
async def cleanup(ctx): ...

async def main():
    async with chronos:            # start() … stop()
        await asyncio.Event().wait()

asyncio.run(main())
```

## Client options

`Chronos(server, project, token=None, timezone=None, concurrency=5, instance_id=None,
hostname=None, shutdown_timeout=30, reconnect_initial_delay=0.5, reconnect_max_delay=30,
logger=None)`. `token` defaults to `CHRONOS_AGENT_TOKEN`. SDK logs go to the `cronous`
logger.

## License

Apache-2.0
