"""NVIDIA Inference Hub's native Gemini protocol, scoped to a single CLI or SSH channel."""
from contextlib import contextmanager, suppress
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import stat
from threading import Event, Thread

import httpx

HUB = "https://inference-api.nvidia.com"
# Captured from the server configuration before spawning any provider.
hub_key = ""
MODEL = re.compile(r"gcp/google/(?:eccn-)?gemini-[A-Za-z0-9._-]{1,100}")
GENERATE = re.compile(r"/v1beta/models/" + MODEL.pattern
                      + r":(?:streamGenerateContent|generateContent|countTokens)(?:\?alt=sse)?")
MAX_BODY = 16 * 1024 * 1024


class GatewayError(RuntimeError):
    def __init__(self, status, *, budget=False):
        self.status = status if 400 <= status <= 599 else 502
        self.kind = "budget_exceeded" if budget else "gateway_error"
        super().__init__("The NVIDIA Inference Hub budget for this credential is exhausted." if budget else {
            400: "NVIDIA Inference Hub rejected the Gemini request.",
            401: "NVIDIA Inference Hub requires a valid Hub credential.",
            403: "This credential cannot access the requested Inference Hub model.",
            422: "NVIDIA Inference Hub rejected the Gemini request.",
            429: "NVIDIA Inference Hub is rate limited. Try again later.",
        }.get(self.status, "NVIDIA Inference Hub is unavailable."))


def upstream_failure(response):
    # Upstream messages can contain credential identifiers. Only propagate a recognized machine code.
    budget = False
    if 400 <= response.status_code < 500:
        raw = bytearray()
        for piece in response.iter_bytes(4096):
            raw.extend(piece)
            if len(raw) >= 8192:
                break
        try:
            error = json.loads(raw)["error"]
            budget = isinstance(error, dict) and "budget_exceeded" in (error.get("type"), error.get("code"))
        except (TypeError, ValueError, KeyError):
            pass
    return GatewayError(response.status_code, budget=budget)


def credential(config_dir):
    key = hub_key
    if not key:
        try:
            fd = os.open(Path(config_dir) / "gemini-inference-key", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as f:
                info = os.fstat(f.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise GatewayError(401)
                raw = f.read(16385)
                if len(raw) > 16384:
                    raise GatewayError(401)
                key = raw.decode("ascii").strip()
        except FileNotFoundError:
            return ""
        except (OSError, UnicodeError):
            raise GatewayError(401) from None
    if not re.fullmatch(r"[!-~]{1,16384}", key):
        raise GatewayError(401)
    return key


def models(base, token):
    try:
        response = httpx.get(base + "/v1/models", headers={"Authorization": "Bearer " + token}, timeout=5,
                             follow_redirects=False, trust_env=base == HUB)
        if response.status_code != 200:
            raise upstream_failure(response)
        rows = response.json()["data"]
        if not isinstance(rows, list):
            raise GatewayError(502)
        return sorted({row["id"] for row in rows if isinstance(row, dict)
                       and isinstance(row.get("id"), str) and MODEL.fullmatch(row["id"])})
    except (httpx.HTTPError, TypeError, KeyError, ValueError):
        raise GatewayError(502) from None


@contextmanager
def open_gateway(config_dir):
    """Issue a temporary bearer accepted only by this loopback listener."""
    token = secrets.token_urlsafe(48)
    revoked = Event()

    class Handler(BaseHTTPRequestHandler):
        timeout = 30
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass  # URLs, headers and provider errors may contain private data.

        def reply(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def dispatch(self):
            if revoked.is_set() or "Origin" in self.headers or not hmac.compare_digest(
                self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode()
            ):
                self.reply(403, {"error": {"code": 403, "message": "Invalid Gemini gateway session."}})
                return
            catalog = self.command == "GET" and self.path == "/v1/models"
            # Match the entire origin-form target before appending it to the authenticated origin.
            if not catalog and not (self.command == "POST" and GENERATE.fullmatch(self.path)):
                self.reply(404, {"error": {"code": 404, "message": "Unsupported Gemini operation."}})
                return
            if not catalog:
                lengths = self.headers.get_all("Content-Length", [])
                if (len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,9}", lengths[0])
                        or int(lengths[0]) > MAX_BODY or "Transfer-Encoding" in self.headers):
                    self.reply(413, {"error": {"code": 413, "message": "Invalid Gemini request size."}})
                    return
                length = int(lengths[0])
                body = self.rfile.read(length)
                if len(body) != length or revoked.is_set():
                    return

            key = credential(config_dir)
            if not key:
                raise GatewayError(401)
            if catalog:
                self.reply(200, {"data": [{"id": value} for value in models(HUB, key)]})
                return
            headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json",
                       "Accept": "text/event-stream, application/json"}
            with httpx.stream("POST", HUB + self.path, content=body, timeout=httpx.Timeout(240, connect=10),
                              follow_redirects=False, headers=headers) as response:
                if response.status_code != 200:
                    raise upstream_failure(response)
                self.send_response(200)
                content_type = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
                self.send_header("Content-Type", "text/event-stream" if content_type == "text/event-stream" else "application/json")
                # An incomplete upstream stream must also be visibly incomplete to the native CLI.
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for chunk in response.iter_bytes():
                        if revoked.is_set():
                            return
                        self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                except httpx.HTTPError:
                    return  # Headers were sent. Closing without the final chunk signals the failure.

        def do_POST(self):
            self.close_connection = True
            try:
                self.dispatch()
            except (GatewayError, httpx.HTTPError) as exc:
                error = exc if isinstance(exc, GatewayError) else GatewayError(502)
                with suppress(OSError):
                    self.reply(error.status, {"error": {"code": error.status, "type": error.kind, "message": str(error)}})
            except OSError:
                return  # The client closed its connection.

        do_GET = do_POST

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as httpd:
        thread = Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        thread.start()
        try:
            yield {"port": httpd.server_port, "accessToken": token}
        finally:
            revoked.set()
            httpd.shutdown()
            thread.join()
