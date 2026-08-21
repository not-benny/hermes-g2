#!/usr/bin/env python3
"""Quiet, endpoint-gated mitmproxy addon that persists sanitized shapes only."""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from urllib.parse import parse_qsl, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sanitize import ValueLabeler, build_request_record, build_response_record, write_private_json

ALLOWED_HOST = "api.evenrealities.com"
ALLOWED_PATHS = {"/v2/g/check_firmware", "/v2/g/list_devices"}
TARGET_PATH = "/v2/g/check_firmware"
DEFAULT_OUTPUT = Path("scratchpad/even-api-capture/check-firmware.sanitized.json")


def _items(headers: object) -> list[tuple[object, object]]:
    if hasattr(headers, "items"):
        return list(headers.items(multi=True)) if hasattr(headers, "get_all") else list(headers.items())
    return list(headers)  # type: ignore[arg-type]


def _header(headers: object, name: str) -> str:
    if hasattr(headers, "get"):
        return str(headers.get(name, ""))
    for key, value in _items(headers):
        if str(key).lower() == name.lower():
            return str(value)
    return ""


class CaptureAddon:
    def __init__(
        self,
        output: str | os.PathLike[str] = DEFAULT_OUTPUT,
        writer=write_private_json,
        *,
        test_output: bool = False,
        app_version: str | None = None,
    ) -> None:
        self.output = Path(output)
        self.writer = writer
        self.app_version = app_version or os.environ.get("EVEN_CAPTURE_APP_VERSION", "unknown")
        self._target_complete = False
        if not test_output:
            allowed_root = (Path.cwd() / "scratchpad/even-api-capture").resolve()
            resolved = (Path.cwd() / self.output).resolve()
            if resolved != allowed_root and allowed_root not in resolved.parents:
                raise ValueError("capture output must stay under scratchpad/even-api-capture")

    @staticmethod
    def _allowed(flow: object) -> tuple[bool, str]:
        request = flow.request
        path = urlsplit(str(request.path)).path
        return str(request.host).lower() == ALLOWED_HOST and path in ALLOWED_PATHS, path

    def request(self, flow: object) -> None:
        allowed, path = self._allowed(flow)
        if not allowed:
            return
        request = flow.request
        split = urlsplit(str(request.path))
        labeler = ValueLabeler()
        record = build_request_record(
            method=str(request.method),
            host=ALLOWED_HOST,
            path=path,
            headers=_items(request.headers),
            query=parse_qsl(split.query, keep_blank_values=True),
            body=bytes(request.content or b""),
            content_type=_header(request.headers, "content-type"),
            labeler=labeler,
        )
        setattr(flow, "_even_sanitized_request", (record, labeler))

    def response(self, flow: object) -> None:
        pending = getattr(flow, "_even_sanitized_request", None)
        if pending is None or getattr(flow, "response", None) is None or self._target_complete:
            return
        request_record, labeler = pending
        try:
            response = flow.response
            response_record = build_response_record(
                status_code=response.status_code,
                headers=_items(response.headers),
                body=bytes(response.content or b""),
                content_type=_header(response.headers, "content-type"),
                labeler=labeler,
            )
            combined = {
                "sanitizer_version": "1",
                "capture_date_utc": datetime.now(timezone.utc).date().isoformat(),
                "official_app_version": self.app_version,
                "endpoint": {"host": ALLOWED_HOST, "path": request_record["path"]},
                "request": request_record,
                "response": response_record,
            }
            self.writer(self.output, combined)
            if request_record["path"] == TARGET_PATH:
                self._target_complete = True
        finally:
            delattr(flow, "_even_sanitized_request")


addons = [CaptureAddon()]