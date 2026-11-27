"""JSON conversion for payloads and handler results (pydantic models, dataclasses, datetimes)."""

from __future__ import annotations

import dataclasses
import datetime as dt
import decimal
import enum
import json
import uuid
from typing import Any

MAX_PAYLOAD_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 64 * 1024


def _default(value: Any) -> Any:
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):  # pydantic v2
        return model_dump(mode="json")
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    if isinstance(value, (uuid.UUID, decimal.Decimal)):
        return str(value)
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def dumps(value: Any) -> str:
    return json.dumps(value, default=_default, separators=(",", ":"), ensure_ascii=False)


def to_jsonable(value: Any) -> Any:
    """Converts ``value`` to plain JSON types (raises TypeError when impossible)."""
    return json.loads(dumps(value))


def serialise_output(output: Any) -> Any:
    """Handler result as stored by Chronos: JSON, size-limited, never raising."""
    if output is None:
        return None
    try:
        text = dumps(output)
    except (TypeError, ValueError):
        return {"unserialisable": True, "type": type(output).__name__}
    size = len(text.encode("utf-8"))
    if size > MAX_OUTPUT_BYTES:
        return {"truncated": True, "bytes": size}
    return json.loads(text)


def safe_jsonable(value: Any) -> Any:
    try:
        return to_jsonable(value)
    except (TypeError, ValueError):
        return str(value)
