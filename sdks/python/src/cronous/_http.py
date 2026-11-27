"""Minimal async JSON client for the Chronos REST API: envelopes, typed errors and retries."""

from __future__ import annotations

import asyncio
import random
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from ._json import dumps
from .errors import ChronosConfigError, ChronosRequestError, error_for_status

#: Answers that mean "not processed, try again later".
ALWAYS_RETRY = {429, 503}
#: Answers after which the request may or may not have been processed.
RETRY_IF_IDEMPOTENT = {502, 504}


def http_base_url(server: str) -> str:
    """``server`` as an http(s) base URL ending in ``/``; ws(s) URLs map to http(s)."""
    parts = urlsplit(server)
    scheme = {"http": "http", "https": "https", "ws": "http", "wss": "https"}.get(parts.scheme)
    if scheme is None or not parts.netloc:
        raise ChronosConfigError(f'"server" must be an http(s) URL, got "{server}"')
    path = parts.path if parts.path.endswith("/") else f"{parts.path}/"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


def socket_url(server: str, path: str) -> str:
    """Agent WebSocket URL for ``server``."""
    parts = urlsplit(server)
    scheme = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}.get(parts.scheme)
    if scheme is None or not parts.netloc:
        raise ChronosConfigError(f'Unsupported Chronos server URL "{server}"')
    return urlunsplit((scheme, parts.netloc, parts.path.rstrip("/") + path, "", ""))


def seg(value: str) -> str:
    """Encodes one path segment."""
    return quote(str(value), safe="")


class HttpClient:
    def __init__(
        self,
        *,
        server: str,
        token: Callable[[], str | None],
        missing_token_message: str,
        user_agent: str,
        max_attempts: int = 5,
        request_timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base = http_base_url(server)
        self._token = token
        self._missing_token_message = missing_token_message
        self._user_agent = user_agent
        self._max_attempts = max(1, max_attempts)
        self._timeout = request_timeout
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _get_client(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        # An httpx client is bound to the event loop that created it.
        if self._client is None or self._loop is not loop or self._client.is_closed:
            self._client = httpx.AsyncClient(base_url=self._base, timeout=self._timeout, transport=self._transport)
            self._loop = loop
        return self._client

    async def aclose(self) -> None:
        client, self._client = self._client, None
        if client is not None and not client.is_closed:
            await client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        idempotent: bool | None = None,
    ) -> Any:
        token = self._token()
        if not token:
            raise ChronosConfigError(self._missing_token_message)
        params = {key: _query_value(value) for key, value in (query or {}).items() if value is not None and value != ""}
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": self._user_agent}
        content: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            content = dumps(body).encode("utf-8")
        if idempotent is None:
            idempotent = method == "GET"

        client = self._get_client()
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await client.request(method, path.lstrip("/"), params=params, headers=headers, content=content)
            except httpx.HTTPError as error:
                last_error = ChronosRequestError(f"Request to Chronos failed: {error}", 0, "NETWORK_ERROR")
                if not idempotent:
                    raise last_error from error
                await _backoff(attempt, self._max_attempts)
                continue
            if response.status_code == 204:
                return None
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            if response.is_success:
                return payload.get("data")
            failure = error_for_status(response.status_code, payload.get("error"))
            retryable = response.status_code in ALWAYS_RETRY or (idempotent and response.status_code in RETRY_IF_IDEMPOTENT)
            if not retryable:
                raise failure
            last_error = failure
            retry_after = _retry_after(response.headers.get("retry-after"))
            await _backoff(attempt, self._max_attempts, retry_after)
        assert last_error is not None
        raise last_error


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _retry_after(header: str | None) -> float | None:
    try:
        seconds = float(header) if header else 0.0
    except ValueError:
        return None
    return seconds if seconds > 0 else None


async def _backoff(attempt: int, attempts: int, override: float | None = None) -> None:
    if attempt >= attempts:
        return
    delay = override if override is not None else min(5.0, 0.2 * 2 ** (attempt - 1)) * (0.5 + random.random() / 2)
    await asyncio.sleep(delay)
