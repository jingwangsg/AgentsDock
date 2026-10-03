"""Shared helper-CLI plumbing: authority/CHAT_ID agreement and origin checks."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agentsdock_cli_common as common


class ProviderAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        path = Path(self.temporary.name) / "authority.json"
        path.write_text(json.dumps({
            "provider_capability": "provider-secret",
            "source_session_id": "sess/source",
            "provider_server_origin": "http://[fd00::10]:7850",
        }), encoding="utf-8")
        path.chmod(0o600)
        self.authority_file = str(path)

    def test_matching_or_absent_chat_id_returns_capability_and_chat(self) -> None:
        for environment in ({}, {"AGENTSDOCK_CHAT_ID": "sess/source"}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                self.assertEqual(
                    common.provider_authority(self.authority_file),
                    ("provider-secret", "sess/source"),
                )

    def test_mismatched_chat_id_is_rejected_for_explicit_and_ambient_authority(self) -> None:
        with patch.dict(os.environ, {"AGENTSDOCK_CHAT_ID": "sess/other"}, clear=True):
            with self.assertRaisesRegex(common.CLIError, "AGENTSDOCK_CHAT_ID does not match the authority file"):
                common.provider_authority(self.authority_file)
        with patch.dict(os.environ, {
            "AGENTSDOCK_PROVIDER_AUTHORITY_FILE": self.authority_file,
            "AGENTSDOCK_CHAT_ID": "sess/other",
        }, clear=True):
            with self.assertRaisesRegex(common.CLIError, "AGENTSDOCK_CHAT_ID does not match the authority file"):
                common.provider_authority(None)

    def test_validated_server_url_reads_the_ambient_authority_only_off_loopback(self) -> None:
        # Loopback: no authority file is needed or read.
        with patch.dict(os.environ, {"AGENTSDOCK_SERVER_URL": "http://127.0.0.1:7850/"}, clear=True):
            self.assertEqual(common.validated_server_url(), "http://127.0.0.1:7850")
        # Non-loopback with no explicit origin: the ambient authority file decides.
        with patch.dict(os.environ, {"AGENTSDOCK_SERVER_URL": "http://[fd00:0::10]:7850"}, clear=True):
            with self.assertRaisesRegex(common.CLIError, "--authority-file is required"):
                common.validated_server_url()
        with patch.dict(os.environ, {
            "AGENTSDOCK_SERVER_URL": "http://[fd00:0::10]:7850",
            "AGENTSDOCK_PROVIDER_AUTHORITY_FILE": self.authority_file,
        }, clear=True):
            self.assertEqual(common.validated_server_url(), "http://[fd00::10]:7850")
            with self.assertRaisesRegex(common.CLIError, "non-loopback AGENTSDOCK_SERVER_URL must match"):
                common.validated_server_url("")
            with self.assertRaisesRegex(common.CLIError, "non-loopback AGENTSDOCK_SERVER_URL must match"):
                common.validated_server_url("http://192.0.2.10:7850")


class CanonicalHttpOriginTests(unittest.TestCase):
    def test_canonical_forms(self) -> None:
        cases = {
            "http://127.0.0.1:7850/": ("http://127.0.0.1:7850", True),
            "http://localhost": ("http://localhost:80", True),
            "http://LOCALHOST:7850": ("http://localhost:7850", True),
            "http://[::1]:7850": ("http://[::1]:7850", True),
            "http://[fd00:0::10]:7850/": ("http://[fd00::10]:7850", False),
            "http://[::ffff:127.0.0.1]:7850": ("http://127.0.0.1:7850", True),
            "http://192.0.2.10": ("http://192.0.2.10:80", False),
            "  http://example.com:8080/  ": ("http://example.com:8080", False),
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(common.canonical_http_origin(value, "AGENTSDOCK_SERVER_URL"), expected)

    def test_non_origin_values_are_rejected(self) -> None:
        for value in (
            "https://127.0.0.1:7850",
            "http://user@127.0.0.1:7850",
            "http://user:pw@127.0.0.1:7850",
            "http://127.0.0.1:7850/api",
            "http://127.0.0.1:7850/?x=1",
            "http://127.0.0.1:7850/#fragment",
            "http://127.0.0.1:99999",
            "127.0.0.1:7850",
            "",
        ):
            with self.subTest(value=value), self.assertRaisesRegex(common.CLIError, "AGENTSDOCK_SERVER_URL must be an HTTP origin"):
                common.canonical_http_origin(value, "AGENTSDOCK_SERVER_URL")


if __name__ == "__main__":
    unittest.main()
