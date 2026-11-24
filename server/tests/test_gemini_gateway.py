import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
from tempfile import TemporaryDirectory
from threading import Event, Thread
import unittest
from unittest.mock import patch

import gemini_gateway as gateway


MODEL = "gcp/google/gemini-fixture"
PATH = f"/v1beta/models/{MODEL}:streamGenerateContent?alt=sse"
PART = b'data: {"candidates":[{"content":{"parts":[{"text":"one"}]}}]}\n\n'


class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):
        self.server.calls.append((self.path, self.headers, self.rfile.read(int(self.headers["Content-Length"]))))
        if self.server.status:
            self.send_response(self.server.status)
            self.send_header("Location", "/untrusted-redirect")
            self.end_headers()
            self.wfile.write(self.server.error)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        if self.server.truncate:
            self.send_header("Content-Length", str(len(PART) + 1))
        self.end_headers()
        self.wfile.write(PART)
        self.wfile.flush()
        if not self.server.truncate and self.server.finish.wait(2):
            self.wfile.write(b"data: {}\n\n")

    def do_GET(self):
        self.server.calls.append((self.path, self.headers, b""))
        self.send_response(200)
        self.end_headers()
        rows = [MODEL, MODEL, "openai/gpt", "gcp/google/gemini-injected:op"]
        self.wfile.write(json.dumps({"data": [{"id": row} for row in rows]}).encode())

    def log_message(self, *args):
        pass


class GeminiGatewayTests(unittest.TestCase):
    def setUp(self):
        self.config = Path(self.enterContext(TemporaryDirectory()))
        self.key = self.config / "gemini-inference-key"
        self.key.write_text("fixture-key")
        self.key.chmod(0o600)
        self.upstream = self.enterContext(ThreadingHTTPServer(("127.0.0.1", 0), Upstream))
        self.upstream.status = 0
        self.upstream.finish = Event()
        self.upstream.truncate = False
        self.upstream.calls = []
        thread = Thread(target=self.upstream.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.upstream.shutdown)
        self.addCleanup(self.upstream.finish.set)
        self.enterContext(patch.dict(os.environ, {"NO_PROXY": "127.0.0.1"}))
        self.enterContext(patch.object(gateway, "HUB", f"http://127.0.0.1:{self.upstream.server_port}"))
        self.enterContext(patch.object(gateway, "hub_key", ""))
        self.access = self.enterContext(gateway.open_gateway(self.config))
        self.headers = {"Authorization": "Bearer " + self.access["accessToken"]}

    def request(self, method="POST", path=PATH, body=b"{}", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.access["port"], timeout=4)
        self.addCleanup(conn.close)
        conn.request(method, path, body, self.headers if headers is None else headers)
        return conn.getresponse()

    def test_native_sse_arrives_before_upstream_finishes_and_only_hub_headers_are_sent(self):
        native = b'{"contents":[{"parts":[{"text":"hello"}]}]}'
        headers = {**self.headers, "x-goog-api-key": "local-only", "Cookie": "local-only", "X-Forwarded-Host": "bad"}
        with self.request(body=native, headers=headers) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            self.assertEqual(response.read(len(PART)), PART)
            self.upstream.finish.set()
            self.assertEqual(response.read(), b"data: {}\n\n")
        [(path, sent, body)] = self.upstream.calls
        self.assertEqual((path, body, sent["Authorization"]), (PATH, native, "Bearer fixture-key"))
        self.assertFalse({"x-goog-api-key", "cookie", "x-forwarded-host"} & {k.lower() for k in sent})

    def test_authorization_and_full_request_target_checked_before_forwarding(self):
        for target, headers, status in [
            (PATH, {}, 403), (PATH, {**self.headers, "Origin": ""}, 403),
            ("x.example.org://host" + PATH, self.headers, 404),
            (PATH + "&key=other", self.headers, 404), (PATH + "#fragment", self.headers, 404),
            (PATH.replace("gemini-fixture", "../not-a-model"), self.headers, 404),
            (PATH, {**self.headers, "Content-Length": str(gateway.MAX_BODY + 1)}, 413),
        ]:
            with self.subTest(target=target, status=status), self.request(path=target, headers=headers) as response:
                self.assertEqual(response.status, status)
        self.assertFalse(self.upstream.calls)

    def test_filtered_catalog_and_rotation_or_removal_on_existing_gateway(self):
        for key in ("fixture-key", "rotated-key"):
            self.key.write_text(key)
            with self.request("GET", "/v1/models", None) as response:
                self.assertEqual(json.load(response), {"data": [{"id": MODEL}]})
            self.assertEqual(self.upstream.calls[-1][1]["Authorization"], "Bearer " + key)
        self.key.unlink()
        with self.request("GET", "/v1/models", None) as response:
            self.assertEqual(response.status, 401)
        self.assertEqual(len(self.upstream.calls), 2)

    def test_error_categories_do_not_expose_upstream_detail_or_follow_redirects(self):
        for status, kind, expected in [(422, "budget_exceeded", 422), (422, "invalid_request", 422),
                                        (429, "limited", 429), (307, "", 502)]:
            self.upstream.status = status
            self.upstream.error = json.dumps({"error": {"type": kind, "message": "sensitive detail"}}).encode()
            with self.subTest(status=status, kind=kind), self.request() as response:
                self.assertEqual(response.status, expected)
                self.assertIsNone(response.headers.get("Location"))
                reply = json.load(response)["error"]
                self.assertEqual(reply["type"], "budget_exceeded" if kind == "budget_exceeded" else "gateway_error")
                self.assertNotIn("sensitive", str(reply))
        self.assertEqual(len(self.upstream.calls), 4)

    def test_network_failures_before_and_after_response_headers(self):
        self.upstream.truncate = True
        with self.request() as response:
            self.assertEqual(response.status, 200)
            with self.assertRaises(http.client.IncompleteRead):
                response.read()
        self.upstream.shutdown()
        self.upstream.server_close()
        with self.request() as response:
            self.assertEqual(response.status, 502)
            self.assertEqual(json.load(response)["error"]["type"], "gateway_error")

    def test_an_open_connection_cannot_send_after_revocation(self):
        with gateway.open_gateway(self.config) as grant:
            conn = self.enterContext(socket.create_connection(("127.0.0.1", grant["port"]), timeout=3))
            # An authenticated partial body can outlive even closure of the listening socket.
            headers = (f"POST {PATH} HTTP/1.1\r\nAuthorization: Bearer {grant['accessToken']}\r\n"
                       "Expect: 100-continue\r\nContent-Length: 2\r\n\r\n")
            conn.sendall(headers.encode() + b"{")
            self.assertIn(b"100 Continue", conn.recv(1024))
        try:
            conn.sendall(b"}")
            self.assertNotIn(b"200 OK", conn.recv(1024))
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.assertFalse(self.upstream.calls)

    def test_private_regular_key_file_required(self):
        self.key.chmod(0o644)
        with self.assertRaises(gateway.GatewayError):
            gateway.credential(self.config)
        self.key.rename(self.config / "target")
        self.key.symlink_to(self.config / "target")
        with self.assertRaises(gateway.GatewayError):
            gateway.credential(self.config)
