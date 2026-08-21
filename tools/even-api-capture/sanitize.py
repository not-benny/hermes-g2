#!/usr/bin/env python3
"""Fail-closed sanitization for the Even API capture harness."""

from __future__ import annotations

import re
import json
import os
from pathlib import Path
import tempfile
from typing import Iterable

SANITIZER_VERSION = "1"
MAX_DEPTH = 8
MAX_KEYS = 128
MAX_ARRAY_ITEMS = 64
MAX_BODY_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 512 * 1024

_SENSITIVE_NAMES = {
    "authorization", "xtoken", "token", "jwt", "cookie", "setcookie",
    "apiauth", "auth", "sign", "signature", "nonce", "appkey", "appid",
    "accesskey", "accesskeysecret", "secret", "account", "email", "phone",
    "deviceid", "openudid", "androidid", "serial", "sn", "mac", "macaddress",
    "bssid", "ssid", "imei", "imsi", "advertisingid",
}


def normalize_name(name: object) -> str:
    """Return a lowercase alphanumeric name for separator-insensitive matching."""
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def is_sensitive_name(name: object) -> bool:
    """Treat known identity, auth, and account names as sensitive."""
    normalized = normalize_name(name)
    return normalized in _SENSITIVE_NAMES or any(
        fragment in normalized
        for fragment in ("password", "credential", "apikey", "accesstoken", "devicemac")
    )


def _length_class(length: int) -> str:
    if length == 0:
        return "empty"
    if length <= 16:
        return "short"
    if length <= 64:
        return "medium"
    if length <= 256:
        return "long"
    return "very_long"


class ValueLabeler:
    """Assign per-record equality labels without exporting value derivatives."""

    def __init__(self) -> None:
        self._values: list[tuple[str, object]] = []

    def label(self, value: object) -> str:
        kind = type(value).__name__
        for index, existing in enumerate(self._values, 1):
            if existing[0] == kind and existing[1] == value:
                return f"value-{index}"
        self._values.append((kind, value))
        return f"value-{len(self._values)}"


def _primitive_shape(value: object, labeler: ValueLabeler) -> dict[str, object]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean", "equality_label": labeler.label(value)}
    if isinstance(value, str):
        return {
            "type": "string",
            "length_class": _length_class(len(value)),
            "equality_label": labeler.label(value),
        }
    if isinstance(value, (int, float)):
        return {"type": "number", "equality_label": labeler.label(value)}
    if isinstance(value, (bytes, bytearray)):
        return {
            "type": "bytes",
            "length_class": _length_class(len(value)),
            "equality_label": labeler.label(bytes(value)),
        }
    return {"type": "unknown"}


def sanitize_json(
    value: object,
    key_path: tuple[object, ...] = (),
    labeler: ValueLabeler | None = None,
    *,
    _depth: int = 0,
    _budget: list[int] | None = None,
) -> dict[str, object]:
    """Preserve JSON shape and equality while making every value opaque."""
    del key_path  # Names are retained for protocol shape, never used to expose values.
    labeler = labeler or ValueLabeler()
    budget = _budget if _budget is not None else [MAX_KEYS]
    if _depth >= MAX_DEPTH:
        return {"type": "truncated", "truncated": "max_depth"}
    if isinstance(value, dict):
        entries: list[dict[str, object]] = []
        for name, child in value.items():
            if budget[0] <= 0:
                entries.append({"truncated": "max_keys"})
                break
            budget[0] -= 1
            # JSON object keys can themselves be account/device identifiers.
            # Keep only bounded key-class metadata; never persist the key text.
            key_text = str(name)
            entries.append({
                "name_redacted": True,
                "name_length_class": _length_class(len(key_text)),
                "sensitive_name": is_sensitive_name(key_text),
                "value": sanitize_json(
                    child, (), labeler, _depth=_depth + 1, _budget=budget
                ),
            })
        return {"type": "object", "entries": entries}
    if isinstance(value, list):
        items = [
            sanitize_json(item, (), labeler, _depth=_depth + 1, _budget=budget)
            for item in value[:MAX_ARRAY_ITEMS]
        ]
        result: dict[str, object] = {"type": "array", "items": items}
        if len(value) > MAX_ARRAY_ITEMS:
            result["truncated"] = "max_array_items"
        return result
    return _primitive_shape(value, labeler)


def sanitize_pairs(
    pairs: Iterable[tuple[object, object]],
    location: str,
    labeler: ValueLabeler | None = None,
) -> list[dict[str, object]]:
    """Sanitize ordered header/query-style pairs; values always remain opaque."""
    active = labeler or ValueLabeler()
    result = []
    for index, (name, value) in enumerate(pairs):
        if index >= MAX_KEYS:
            result.append({"truncated": "max_keys", "location": location})
            break
        name_text = str(name)
        entry = {
            "location": location,
            "sensitive_name": is_sensitive_name(name_text),
            "value": _primitive_shape(value, active),
        }
        if location == "query":
            entry.update({"name_redacted": True, "name_length_class": _length_class(len(name_text))})
        else:
            entry["name"] = name_text
        result.append(entry)
    return result


def sanitize_headers(
    headers: Iterable[tuple[object, object]],
    labeler: ValueLabeler | None = None,
) -> list[dict[str, object]]:
    return sanitize_pairs(headers, "header", labeler)


def _content_type_category(content_type: str | None) -> str:
    normalized = (content_type or "").split(";", 1)[0].strip().lower()
    if normalized == "application/json" or normalized.endswith("+json"):
        return "json"
    if normalized == "application/x-www-form-urlencoded":
        return "form"
    if normalized.startswith("text/"):
        return "text"
    if normalized:
        return "binary_or_other"
    return "absent"


def _sanitize_body(body: bytes, content_type: str | None, labeler: ValueLabeler) -> dict[str, object]:
    category = _content_type_category(content_type)
    if len(body) > MAX_BODY_BYTES:
        return {
            "content_type_category": category,
            "byte_count": len(body),
            "parse_status": "body_too_large",
        }
    if not body:
        return {"content_type_category": category, "byte_count": 0, "parse_status": "empty"}
    if category != "json":
        return {
            "content_type_category": category,
            "byte_count": len(body),
            "parse_status": "not_json",
        }
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {
            "content_type_category": category,
            "byte_count": len(body),
            "parse_status": "malformed",
        }
    return {
        "content_type_category": category,
        "byte_count": len(body),
        "parse_status": "parsed",
        "shape": sanitize_json(value, (), labeler),
    }


def build_request_record(
    method: str,
    host: str,
    path: str,
    headers: Iterable[tuple[object, object]],
    query: Iterable[tuple[object, object]],
    body: bytes,
    content_type: str | None,
    labeler: ValueLabeler | None = None,
) -> dict[str, object]:
    active = labeler or ValueLabeler()
    return {
        "method": method.upper(),
        "scheme": "https",
        "host": host,
        "path": path,
        "headers": sanitize_headers(headers, active),
        "query": sanitize_pairs(query, "query", active),
        "body": _sanitize_body(body, content_type, active),
    }


def build_response_record(
    status_code: int,
    headers: Iterable[tuple[object, object]],
    body: bytes,
    content_type: str | None,
    labeler: ValueLabeler | None = None,
) -> dict[str, object]:
    active = labeler or ValueLabeler()
    return {
        "status": int(status_code),
        "headers": sanitize_headers(headers, active),
        "body": _sanitize_body(body, content_type, active),
    }


def write_private_json(path: str | os.PathLike[str], record: object) -> None:
    """Atomically write deterministic JSON with owner-only permissions."""
    target = Path(path)
    payload = (json.dumps(record, indent=2, sort_keys=True, separators=(",", ": ")) + "\n").encode()
    if len(payload) > MAX_OUTPUT_BYTES:
        raise ValueError("sanitized output exceeds size limit")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, target)
        os.chmod(target, 0o600)
        directory_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise