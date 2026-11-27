"""FastAPI integration: lifespan, dependencies and exception handlers.

Example::

    from fastapi import FastAPI
    from cronous import Chronos, TaskContext
    from cronous.fastapi import ChronosDep, setup

    chronos = Chronos(server="http://localhost:8080", project="shop")

    @chronos.task("email.send", queue="emails")
    async def send_email(email: SendEmail, ctx: TaskContext) -> dict:
        ...

    app = FastAPI()
    setup(app, chronos)

    @app.post("/signup")
    async def signup(user: User, chronos: ChronosDep):
        await chronos.queue("email.send", {"to": user.email})
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from .admin import ChronosAdmin
from .client import Chronos
from .errors import (
    ChronosAuthError,
    ChronosConflictError,
    ChronosNotFoundError,
    ChronosRequestError,
    ChronosValidationError,
    ChronosWaitTimeoutError,
)

__all__ = [
    "AdminDep",
    "ChronosDep",
    "chronos_lifespan",
    "get_admin",
    "get_chronos",
    "register_exception_handlers",
    "setup",
]

Lifespan = Callable[[Any], AbstractAsyncContextManager[Any]]
_log = logging.getLogger("cronous")


def chronos_lifespan(
    chronos: Chronos,
    *,
    admin: ChronosAdmin | None = None,
    api_key: str | None = None,
    worker: bool = True,
    wait_for_connection: bool = True,
    lifespan: Lifespan | None = None,
) -> Lifespan:
    """A FastAPI ``lifespan`` that starts Chronos with the app and stops it gracefully.

    * ``worker=False`` never connects as an agent (API-only replicas that just submit jobs).
      Without registered tasks it never connects either, and needs no agent token.
    * ``wait_for_connection=False`` lets the app start while Chronos is unreachable;
      connection errors are logged.
    * ``lifespan`` is your own lifespan, run inside this one (its state is merged).
    * The admin client uses ``admin``, or ``api_key`` / CHRONOS_API_KEY.

    Use it as ``FastAPI(lifespan=chronos_lifespan(chronos))``, or call ``setup(app, chronos)``.
    """

    @asynccontextmanager
    async def run(app: Any) -> AsyncIterator[dict[str, Any]]:
        admin_client = admin or chronos.admin(token=api_key)
        state: dict[str, Any] = {"chronos": chronos, "chronos_admin": admin_client}
        if hasattr(app, "state"):
            app.state.chronos = chronos
            app.state.chronos_admin = admin_client
        if worker and chronos.tasks:
            if wait_for_connection:
                await chronos.start()
            else:

                async def background_start() -> None:
                    try:
                        await chronos.start()
                    except Exception as error:  # noqa: BLE001
                        _log.error("Chronos agent could not start: %s", error)

                state["_chronos_start"] = asyncio.create_task(background_start())
        try:
            if lifespan is not None:
                async with lifespan(app) as inner_state:
                    yield {**state, **(inner_state or {})}
            else:
                yield state
        finally:
            await chronos.stop()  # also closes its HTTP client when it never started
            await admin_client.aclose()

    return run


def setup(
    app: FastAPI,
    chronos: Chronos,
    *,
    admin: ChronosAdmin | None = None,
    api_key: str | None = None,
    worker: bool = True,
    wait_for_connection: bool = True,
    exception_handlers: bool = True,
) -> FastAPI:
    """Adds Chronos to an existing app: wraps its lifespan, and (by default) maps Chronos
    errors to HTTP responses. Returns the app."""
    app.router.lifespan_context = chronos_lifespan(
        chronos,
        admin=admin,
        api_key=api_key,
        worker=worker,
        wait_for_connection=wait_for_connection,
        lifespan=app.router.lifespan_context,
    )
    if exception_handlers:
        register_exception_handlers(app)
    return app


def get_chronos(request: Request) -> Chronos:
    """Dependency: the Chronos client of the app."""
    chronos = getattr(request.app.state, "chronos", None)
    if chronos is None:
        raise RuntimeError("Chronos is not set up: use chronos_lifespan() or setup(app, chronos)")
    return chronos


def get_admin(request: Request) -> ChronosAdmin:
    """Dependency: the ChronosAdmin client of the app."""
    admin = getattr(request.app.state, "chronos_admin", None)
    if admin is None:
        raise RuntimeError("Chronos is not set up: use chronos_lifespan() or setup(app, chronos)")
    return admin


ChronosDep = Annotated[Chronos, Depends(get_chronos)]
AdminDep = Annotated[ChronosAdmin, Depends(get_admin)]


def _error_body(error: Exception, code: str, details: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": str(error)}}
    if details is not None:
        body["error"]["details"] = details
    return body


def register_exception_handlers(app: FastAPI) -> None:
    """Maps SDK errors to responses: validation 400, not found 404, conflict 409, wait
    timeout 504, auth and other Chronos failures 502 (a server-side misconfiguration or outage)."""

    async def request_error(_: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, ChronosRequestError)
        if isinstance(error, ChronosValidationError):
            status = 400
        elif isinstance(error, ChronosNotFoundError):
            status = 404
        elif isinstance(error, ChronosConflictError):
            status = 409
        else:
            status = 502
            if isinstance(error, ChronosAuthError):
                _log.error("Chronos rejected the credentials: %s", error)
        return JSONResponse(_error_body(error, error.code, error.details if status == 400 else None), status_code=status)

    async def wait_timeout(_: Request, error: Exception) -> JSONResponse:
        return JSONResponse(_error_body(error, "WAIT_TIMEOUT"), status_code=504)

    app.add_exception_handler(ChronosRequestError, request_error)
    app.add_exception_handler(ChronosWaitTimeoutError, wait_timeout)
