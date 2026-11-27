"""Task definitions, handler binding and TaskRouter."""

from __future__ import annotations

import asyncio
import datetime as dt
import functools
import inspect
import threading
import typing
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Generic, Literal, TypeVar

from ._json import safe_jsonable
from ._submission import JOB_NAME, QUEUE_NAME, Duration, iso, to_ms
from .errors import ChronosConfigError, NonRetryableError

P = TypeVar("P")
F = TypeVar("F", bound=Callable[..., Any])

LogLevel = Literal["DEBUG", "INFO", "WARN", "ERROR"]
MisfirePolicy = Literal["FIRE_ONCE", "SKIP", "FIRE_ALL"]
ConcurrencyPolicy = Literal["ALLOW", "FORBID"]


class TaskLogger:
    """Log lines written here are stored with the execution in Chronos."""

    def __init__(self, emit: Callable[[LogLevel, str, Any], None]) -> None:
        self._emit = emit

    def debug(self, message: str, data: Any = None) -> None:
        self._emit("DEBUG", message, data)

    def info(self, message: str, data: Any = None) -> None:
        self._emit("INFO", message, data)

    def warn(self, message: str, data: Any = None) -> None:
        self._emit("WARN", message, data)

    warning = warn

    def error(self, message: str, data: Any = None) -> None:
        self._emit("ERROR", message, data)


class TaskContext(Generic[P]):
    """What a handler knows about the execution it is running."""

    def __init__(
        self,
        *,
        execution_id: str,
        attempt: int,
        task: str,
        scheduled_for: dt.datetime,
        idempotency_key: str,
        payload: P,
        log: TaskLogger,
        cancel_event: threading.Event | None = None,
    ) -> None:
        self.execution_id = execution_id
        #: 1 for the first attempt; higher on retries.
        self.attempt = attempt
        self.task = task
        self.scheduled_for = scheduled_for
        #: Stable across retries of the same execution: use it to make side effects idempotent.
        self.idempotency_key = idempotency_key
        self.payload = payload
        self.log = log
        self._cancel_event = cancel_event or threading.Event()
        self.cancel_reason: str | None = None

    @property
    def cancelled(self) -> bool:
        """True after a timeout, cancellation or shutdown. Async handlers are also
        interrupted with CancelledError; sync handlers (run in a thread) should check this."""
        return self._cancel_event.is_set()

    def __repr__(self) -> str:
        return f"TaskContext(task={self.task!r}, execution_id={self.execution_id!r}, attempt={self.attempt})"


@dataclass
class RegisteredTask:
    name: str
    definition: dict[str, Any]
    invoke: Callable[[TaskContext[Any]], Awaitable[Any]]
    handler: Callable[..., Any]


def build_definition(
    name: str,
    *,
    schedule: str | None = None,
    run_at: dt.datetime | str | None = None,
    timezone: str | None = None,
    misfire_policy: MisfirePolicy | None = None,
    misfire_grace: Duration | None = None,
    max_catch_up: int | None = None,
    timeout: Duration | None = None,
    max_attempts: int | None = None,
    retry_backoff: Duration | None = None,
    retry_backoff_max: Duration | None = None,
    concurrency_policy: ConcurrencyPolicy | None = None,
    description: str | None = None,
    queue: str | None = None,
    priority: int | None = None,
    max_concurrency: int | None = None,
    payload_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The agent task definition sent in the handshake (validated like the server does)."""
    problems: list[str] = []
    if not isinstance(name, str) or not JOB_NAME.match(name):
        problems.append('name: must start with a letter or digit and contain only letters, digits, ".", "_", ":" or "-" (max 128)')
    if schedule is not None and run_at is not None:
        problems.append('use either "schedule" or "run_at", not both')
    if schedule is not None and len(schedule.split()) != 5:
        problems.append("schedule: must have exactly 5 fields (minute hour day-of-month month day-of-week)")
    definition: dict[str, Any] = {"name": name}
    if description is not None:
        definition["description"] = description
    if timeout is not None:
        definition["timeoutMs"] = to_ms(timeout, "timeout")
        if not 1000 <= definition["timeoutMs"] <= 86_400_000:
            problems.append("timeout: must be between 1 second and 24 hours")
    if max_attempts is not None:
        if not 1 <= max_attempts <= 100:
            problems.append("max_attempts: must be 1-100")
        definition["maxAttempts"] = max_attempts
    if retry_backoff is not None:
        definition["retryBackoffMs"] = to_ms(retry_backoff, "retry_backoff")
    if retry_backoff_max is not None:
        definition["retryBackoffMaxMs"] = to_ms(retry_backoff_max, "retry_backoff_max")
    if concurrency_policy is not None:
        definition["concurrencyPolicy"] = concurrency_policy
    if queue is not None:
        if not QUEUE_NAME.match(queue):
            problems.append('queue: must be lowercase letters, digits, "_" or "-" (max 63)')
        definition["queue"] = queue
    if priority is not None:
        if not 0 <= priority <= 100:
            problems.append("priority: must be 0-100")
        definition["priority"] = priority
    if max_concurrency is not None:
        definition["maxConcurrency"] = max_concurrency
    if payload_schema is not None:
        definition["payloadSchema"] = payload_schema
    if schedule is not None or run_at is not None:
        sched: dict[str, Any] = {}
        if schedule is not None:
            sched["cron"] = schedule
        if run_at is not None:
            sched["runAt"] = iso(run_at)
        if timezone is not None:
            sched["timezone"] = timezone
        if misfire_policy is not None:
            sched["misfirePolicy"] = misfire_policy
        if misfire_grace is not None:
            sched["misfireGraceMs"] = to_ms(misfire_grace, "misfire_grace")
        if max_catch_up is not None:
            sched["maxCatchUp"] = max_catch_up
        definition["schedule"] = sched
    else:
        definition["schedule"] = None
    if problems:
        raise ChronosConfigError(f'Invalid task "{name}": {"; ".join(problems)}')
    return definition


# ---------------------------------------------------------------------------
# Handler binding: arguments are chosen from the handler's signature, FastAPI style.
# ---------------------------------------------------------------------------


def _pydantic_model(annotation: Any) -> Any:
    try:
        from pydantic import BaseModel
    except ImportError:  # pragma: no cover - pydantic is optional
        return None
    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
        return annotation
    return None


def _is_context(annotation: Any) -> bool:
    origin = typing.get_origin(annotation) or annotation
    return inspect.isclass(origin) and issubclass(origin, TaskContext)


def bind_handler(name: str, handler: Callable[..., Any]) -> tuple[Callable[[TaskContext[Any]], Awaitable[Any]], Any]:
    """Returns (invoke(ctx), payload model or None).

    Each parameter receives:
      * annotated ``TaskContext``, or named ``ctx``/``context`` -> the TaskContext
      * annotated with a pydantic model -> the payload validated into that model
      * named ``payload`` -> the raw payload
      * a handler with a single other parameter receives the TaskContext
    """
    if not callable(handler):
        raise ChronosConfigError(f'Task "{name}" needs a handler function')
    signature = inspect.signature(handler)
    try:
        hints = typing.get_type_hints(handler)
    except Exception:  # unresolved forward references: fall back to raw annotations
        hints = {}
    params = [p for p in signature.parameters.values() if p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)]

    kinds: list[tuple[inspect.Parameter, str, Any]] = []
    model: Any = None
    for param in params:
        annotation = hints.get(param.name, param.annotation)
        payload_model = _pydantic_model(annotation)
        if _is_context(annotation) or param.name in ("ctx", "context"):
            kinds.append((param, "context", None))
        elif payload_model is not None:
            if model is not None and model is not payload_model:
                raise ChronosConfigError(f'Task "{name}": only one parameter can receive the payload')
            model = payload_model
            kinds.append((param, "model", payload_model))
        elif param.name == "payload":
            kinds.append((param, "payload", None))
        elif len(params) == 1:
            kinds.append((param, "context", None))
        elif param.default is not param.empty:
            continue  # left to its default
        else:
            raise ChronosConfigError(
                f'Task "{name}": cannot tell what parameter "{param.name}" should receive; '
                "annotate it with TaskContext or a pydantic model, or name it ctx or payload"
            )

    is_async = inspect.iscoroutinefunction(handler) or (not inspect.isroutine(handler) and inspect.iscoroutinefunction(type(handler).__call__))

    def arguments(ctx: TaskContext[Any]) -> tuple[list[Any], dict[str, Any]]:
        args: list[Any] = []
        kwargs: dict[str, Any] = {}
        for param, kind, payload_model in kinds:
            if kind == "context":
                value: Any = ctx
            elif kind == "payload":
                value = ctx.payload
            else:
                try:
                    value = payload_model.model_validate(ctx.payload if ctx.payload is not None else {})
                except Exception as error:  # a bad payload never becomes valid by retrying
                    raise NonRetryableError(f"Invalid payload for {payload_model.__name__}: {error}", "INVALID_PAYLOAD") from error
            if param.kind == param.KEYWORD_ONLY:
                kwargs[param.name] = value
            else:
                args.append(value)
        return args, kwargs

    async def invoke(ctx: TaskContext[Any]) -> Any:
        args, kwargs = arguments(ctx)
        if is_async:
            return await handler(*args, **kwargs)
        # Sync handlers run in a worker thread so they never block the event loop.
        result = await asyncio.to_thread(functools.partial(handler, *args, **kwargs))
        if inspect.isawaitable(result):
            return await result
        return result

    return invoke, model


class TaskRouter:
    """Collects tasks in one module; include it into a Chronos client with
    ``chronos.include_router(router)``, like FastAPI's APIRouter.

    ``prefix`` is prepended to task names; other keyword arguments are defaults for every
    task of the router (e.g. ``queue="emails"``).
    """

    def __init__(self, *, prefix: str = "", **defaults: Any) -> None:
        self.prefix = prefix
        self.defaults = defaults
        self.tasks: list[RegisteredTask] = []

    def task(self, name: str | None = None, **options: Any) -> Callable[[F], F]:
        """Registers the decorated function as the handler of task ``name`` (default: the
        function name, with the router prefix). Returns the function unchanged."""

        def decorator(handler: F) -> F:
            self.add_task(name if name is not None else handler.__name__, handler, **options)
            return handler

        return decorator

    def add_task(self, name: str, handler: Callable[..., Any], **options: Any) -> None:
        full_name = f"{self.prefix}{name}"
        merged = {**self.defaults, **options}
        invoke, model = bind_handler(full_name, handler)
        if model is not None and "payload_schema" not in merged:
            merged["payload_schema"] = model.model_json_schema()
        elif merged.get("payload_schema") is False:
            merged.pop("payload_schema")
        definition = build_definition(full_name, **merged)
        self._register(RegisteredTask(name=full_name, definition=definition, invoke=invoke, handler=handler))

    def include_router(self, router: TaskRouter) -> None:
        """Adds every task of ``router`` (names keep the included router's prefix and get this one's)."""
        for task in router.tasks:
            name = f"{self.prefix}{task.name}"
            definition = {**task.definition, "name": name}
            if self.prefix and not JOB_NAME.match(name):
                raise ChronosConfigError(f'Invalid task name "{name}"')
            self._register(RegisteredTask(name=name, definition=definition, invoke=task.invoke, handler=task.handler))

    def _register(self, task: RegisteredTask) -> None:
        if any(existing.name == task.name for existing in self.tasks):
            raise ChronosConfigError(f'Task "{task.name}" is already registered')
        self.tasks.append(task)

    @property
    def task_names(self) -> list[str]:
        return [task.name for task in self.tasks]


def log_message(execution_id: str, attempt: int, level: LogLevel, message: str, data: Any) -> dict[str, Any]:
    msg: dict[str, Any] = {"type": "log", "executionId": execution_id, "attempt": attempt, "level": level, "message": str(message)[:4000]}
    if data is not None:
        msg["data"] = safe_jsonable(data)
    return msg
