#!/usr/bin/env python3
import importlib.util
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("even_capture_sanitize", HERE / "sanitize.py")
sanitize = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sanitize)

ADDON_SPEC = importlib.util.spec_from_file_location("even_capture_addon", HERE / "mitm_addon.py")
VALIDATOR_SPEC = importlib.util.spec_from_file_location("even_capture_validator", HERE / "validate_capture.py")


class NameSanitizationTests(unittest.TestCase):
    def test_sensitive_names_ignore_case_and_separators(self):
        sensitive = [
            "Authorization", "X_Token", "set-cookie", "API-Auth", "access.key.secret",
            "device-ID", "open_udid", "Android ID", "serial", "SN", "mac-address",
            "BSSID", "SSID", "IMEI", "IMSI", "advertising-id", "account", "e-mail",
            "phone", "signature", "nonce", "appKey", "jwt",
        ]
        for name in sensitive:
            with self.subTest(name=name):
                self.assertTrue(sanitize.is_sensitive_name(name))
        self.assertEqual(sanitize.normalize_name(" Device-ID "), "deviceid")


class RecordSanitizationTests(unittest.TestCase):
    SECRETS = [
        "eyJsynthetic.jwt.value", "device-sentinel-9381", "AA:BB:CC:DD:EE:FF",
        "cookie-sentinel", "signature-sentinel", "person@example.invalid",
    ]

    def test_nested_values_are_opaque_but_equality_and_shape_survive(self):
        labeler = sanitize.ValueLabeler()
        value = {
            "deviceId": self.SECRETS[1],
            "nested": [self.SECRETS[1], True, None, 7, {"token": self.SECRETS[0]}],
        }
        result = sanitize.sanitize_json(value, (), labeler)
        serialized = json.dumps(result, sort_keys=True)
        self.assertNotIn(self.SECRETS[1], serialized)
        self.assertEqual(result["type"], "object")
        entries = {entry["name"]: entry["value"] for entry in result["entries"]}
        self.assertEqual(entries["deviceId"]["equality_label"], entries["nested"]["items"][0]["equality_label"])
        self.assertEqual(entries["nested"]["items"][1]["type"], "boolean")
        self.assertEqual(entries["nested"]["items"][2]["type"], "null")

    def test_request_and_response_records_never_emit_values_or_derivatives(self):
        labeler = sanitize.ValueLabeler()
        request = sanitize.build_request_record(
            method="POST",
            host="api.evenrealities.com",
            path="/v2/g/check_firmware",
            headers=[("x-token", self.SECRETS[0]), ("Content-Type", "application/json"), ("Cookie", self.SECRETS[3])],
            query=[("deviceId", self.SECRETS[1]), ("channel", "production-private")],
            body=json.dumps({"mac": self.SECRETS[2], "sign": self.SECRETS[4], "account": self.SECRETS[5]}).encode(),
            content_type="application/json; charset=utf-8",
            labeler=labeler,
        )
        response = sanitize.build_response_record(
            status_code=200,
            headers=[("Set-Cookie", self.SECRETS[3]), ("Content-Type", "application/json")],
            body=json.dumps({"code": 0, "data": {"deviceId": self.SECRETS[1]}, "msg": "private-message"}).encode(),
            content_type="application/json",
            labeler=labeler,
        )
        serialized = json.dumps({"request": request, "response": response}, sort_keys=True)
        derivatives = []
        for secret in self.SECRETS:
            derivatives.extend([
                secret,
                base64.b64encode(secret.encode()).decode(),
                secret.encode().hex(),
                hashlib.sha256(secret.encode()).hexdigest(),
            ])
        for value in derivatives:
            self.assertNotIn(value, serialized)
        self.assertIn("/v2/g/check_firmware", serialized)
        self.assertIn('"name": "deviceId"', serialized)
        self.assertIn('"status": 200', serialized)

    def test_malformed_oversized_and_deep_bodies_are_bounded(self):
        malformed = sanitize.build_request_record(
            "POST", "api.evenrealities.com", "/v2/g/check_firmware", [], [],
            b"not-json-private", "application/json",
        )
        self.assertEqual(malformed["body"]["parse_status"], "malformed")
        self.assertNotIn("not-json-private", json.dumps(malformed))
        oversized = sanitize.build_request_record(
            "POST", "api.evenrealities.com", "/v2/g/check_firmware", [], [],
            b"x" * (sanitize.MAX_BODY_BYTES + 1), "application/octet-stream",
        )
        self.assertEqual(oversized["body"]["parse_status"], "body_too_large")
        deep = []
        cursor = deep
        for _ in range(sanitize.MAX_DEPTH + 3):
            child = []
            cursor.append(child)
            cursor = child
        shaped = sanitize.sanitize_json(deep, ())
        self.assertIn('"truncated": "max_depth"', json.dumps(shaped))

    def test_atomic_writer_uses_mode_0600_and_rejects_oversized_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "record.json"
            sanitize.write_private_json(path, {"safe": True})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text()), {"safe": True})
            with self.assertRaises(ValueError):
                sanitize.write_private_json(path, {"x": "y" * sanitize.MAX_OUTPUT_BYTES})


class AddonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert ADDON_SPEC is not None and ADDON_SPEC.loader is not None
        cls.addon_module = importlib.util.module_from_spec(ADDON_SPEC)
        ADDON_SPEC.loader.exec_module(cls.addon_module)

    def _flow(self, host="api.evenrealities.com", path="/v2/g/check_firmware?deviceId=private"):
        class Message:
            pass
        class Flow:
            pass
        flow = Flow()
        flow.request = Message()
        flow.request.host = host
        flow.request.path = path
        flow.request.method = "POST"
        flow.request.scheme = "https"
        flow.request.headers = [("Content-Type", "application/json")]
        flow.request.content = b'{"deviceId":"private-device"}'
        flow.response = Message()
        flow.response.status_code = 200
        flow.response.headers = [("Content-Type", "application/json")]
        flow.response.content = b'{"code":0,"data":null}'
        return flow

    def test_unrelated_endpoints_write_nothing(self):
        written = []
        addon = self.addon_module.CaptureAddon(writer=lambda path, record: written.append(record), test_output=True)
        flow = self._flow(host="example.invalid")
        addon.request(flow)
        addon.response(flow)
        self.assertEqual(written, [])

    def test_allowed_endpoint_writes_only_combined_sanitized_record(self):
        written = []
        addon = self.addon_module.CaptureAddon(writer=lambda path, record: written.append(record), test_output=True)
        flow = self._flow()
        addon.request(flow)
        addon.response(flow)
        self.assertEqual(len(written), 1)
        serialized = json.dumps(written[0])
        self.assertNotIn("private-device", serialized)
        self.assertEqual(written[0]["endpoint"]["path"], "/v2/g/check_firmware")
        self.assertIn("response", written[0])

    def test_context_response_cannot_overwrite_completed_target_capture(self):
        written = []
        addon = self.addon_module.CaptureAddon(writer=lambda path, record: written.append(record), test_output=True)
        target = self._flow()
        addon.request(target)
        addon.response(target)
        context = self._flow(path="/v2/g/list_devices")
        addon.request(context)
        addon.response(context)
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0]["endpoint"]["path"], "/v2/g/check_firmware")

    def test_writer_exception_discards_transient_request_values(self):
        def failing_writer(path, record):
            del path, record
            raise RuntimeError("synthetic write failure")

        addon = self.addon_module.CaptureAddon(writer=failing_writer, test_output=True)
        flow = self._flow()
        addon.request(flow)
        with self.assertRaises(RuntimeError):
            addon.response(flow)
        self.assertFalse(hasattr(flow, "_even_sanitized_request"))


class ValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert VALIDATOR_SPEC is not None and VALIDATOR_SPEC.loader is not None
        cls.validator = importlib.util.module_from_spec(VALIDATOR_SPEC)
        VALIDATOR_SPEC.loader.exec_module(cls.validator)

    def test_validator_accepts_structure_and_rejects_raw_private_patterns(self):
        safe = {
            "sanitizer_version": "1",
            "capture_date_utc": "2026-08-20",
            "official_app_version": "2.2.9",
            "endpoint": {"host": "api.evenrealities.com", "path": "/v2/g/check_firmware"},
            "request": {"method": "POST", "path": "/v2/g/check_firmware"},
            "response": {"status": 200, "body": {"parse_status": "parsed"}},
        }
        self.validator.validate_record(safe, serialized=json.dumps(safe))
        unsafe = dict(safe)
        unsafe["raw"] = "AA:BB:CC:DD:EE:FF"
        with self.assertRaises(ValueError):
            self.validator.validate_record(unsafe, serialized=json.dumps(unsafe))


if __name__ == "__main__":
    unittest.main()