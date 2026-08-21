#!/usr/bin/env python3
"""Validate a sanitized capture without printing its contents."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import stat

MAX_CAPTURE_BYTES = 512 * 1024
ALLOWED_PATHS = {"/v2/g/check_firmware", "/v2/g/list_devices"}
PRIVATE_PATTERNS = (
    re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)-----BEGIN [A-Z ]+-----"),
    re.compile(r"(?i)\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b"),
    re.compile(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b"),
    re.compile(r"\b\d{15}\b"),
    re.compile(r"\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
    re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"),
    re.compile(r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"),
)


def _private_derivatives(values: list[str]) -> list[str]:
    derivatives: list[str] = []
    for value in values:
        if not value:
            continue
        encoded = value.encode()
        derivatives.extend((
            value,
            base64.b64encode(encoded).decode(),
            encoded.hex(),
            hashlib.sha256(encoded).hexdigest(),
        ))
    return derivatives


def validate_record(
    record: object,
    *,
    serialized: str,
    private_values: list[str] | None = None,
) -> None:
    if not isinstance(record, dict):
        raise ValueError("capture root must be an object")
    endpoint = record.get("endpoint")
    request = record.get("request")
    response = record.get("response")
    if not isinstance(endpoint, dict) or endpoint.get("host") != "api.evenrealities.com":
        raise ValueError("unexpected endpoint host")
    if endpoint.get("path") not in ALLOWED_PATHS:
        raise ValueError("unexpected endpoint path")
    if not isinstance(request, dict) or request.get("path") != endpoint.get("path"):
        raise ValueError("request endpoint mismatch")
    if request.get("method") not in {"GET", "POST"}:
        raise ValueError("unexpected request method")
    if not isinstance(response, dict) or not isinstance(response.get("status"), int):
        raise ValueError("response status is missing")
    if record.get("sanitizer_version") != "1":
        raise ValueError("unexpected sanitizer version")
    if record.get("official_app_version") in {None, "", "unknown"}:
        raise ValueError("official app version is missing")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(record.get("capture_date_utc", ""))):
        raise ValueError("capture date must have day precision")
    for pattern in PRIVATE_PATTERNS:
        if pattern.search(serialized):
            raise ValueError("private-looking value survived sanitization")
    for derivative in _private_derivatives(private_values or []):
        if derivative in serialized:
            raise ValueError("known private value or derivative survived sanitization")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate one sanitized Even API capture")
    parser.add_argument("capture", type=Path)
    parser.add_argument("--private-values-file", type=Path)
    args = parser.parse_args()
    mode = stat.S_IMODE(args.capture.stat().st_mode)
    if mode != 0o600:
        raise SystemExit("FAIL: capture mode is not 0600")
    if args.capture.stat().st_size > MAX_CAPTURE_BYTES:
        raise SystemExit("FAIL: capture exceeds size bound")
    serialized = args.capture.read_text(encoding="utf-8")
    private_values: list[str] = []
    if args.private_values_file is not None:
        if stat.S_IMODE(args.private_values_file.stat().st_mode) != 0o600:
            raise SystemExit("FAIL: private comparison file mode is not 0600")
        private_values = args.private_values_file.read_text(encoding="utf-8").splitlines()
    try:
        record = json.loads(serialized)
        validate_record(record, serialized=serialized, private_values=private_values)
    except (json.JSONDecodeError, ValueError) as error:
        raise SystemExit(f"FAIL: {error}") from None
    print("Sanitized capture validation: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())