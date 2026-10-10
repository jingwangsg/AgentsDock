"""Pins the server's WebSocket protocol (agent_server.WebSocketSendAsInUvicorn051Protocol).

A server close waits for the client's close frame: Node's WebSocket, which the desktop's port
tunnels use, drops the messages it has not processed when the connection closes immediately after
the server's close frame. A send never waits on a client that reads slowly or not at all, and does
nothing once the client has left.
"""

from __future__ import annotations

import base64
import os
import socket
import threading
import time
import unittest
from contextlib import contextmanager

import uvicorn

import agent_server

CLOSE_CODE_1000 = b"\x03\xe8"
# FIN + close opcode, unmasked, 2-byte payload.
SERVER_CLOSE_FRAME = b"\x88\x02" + CLOSE_CODE_1000


@contextmanager
def serve(app):
    """Runs `app` with the server's WebSocket protocol; yields a client that has sent the upgrade request."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    config = uvicorn.Config(app, ws=agent_server.WebSocketSendAsInUvicorn051Protocol, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started:
            if not thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.01)
        with socket.create_connection(("127.0.0.1", port), timeout=5) as client:
            key = base64.b64encode(os.urandom(16)).decode()
            client.sendall(
                f"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
            )
            yield client
    finally:
        server.should_exit = True
        thread.join(10)
        listener.close()


class WebSocketProtocolTests(unittest.TestCase):
    def test_server_keeps_the_connection_open_until_the_client_answers_its_close(self) -> None:
        async def send_then_close(scope, receive, send) -> None:
            if scope["type"] != "websocket":
                return
            await receive()
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.send", "bytes": b"last bytes"})
            await send({"type": "websocket.close", "code": 1000})

        with serve(send_then_close) as client:
            received = b""
            while SERVER_CLOSE_FRAME not in received:
                chunk = client.recv(65536)
                self.assertTrue(chunk, "the connection closed before the server's close frame")
                received += chunk

            # uvicorn 0.51 closes at once; from 0.52.1 the server waits 10 s for the client.
            client.settimeout(0.5)
            with self.assertRaises(TimeoutError, msg="the server closed before the client's close frame"):
                client.recv(1)

            mask = os.urandom(4)
            masked_code = bytes(byte ^ mask[index] for index, byte in enumerate(CLOSE_CODE_1000))
            # FIN + close opcode, masked, 2-byte payload.
            client.sendall(b"\x88\x82" + mask + masked_code)
            client.settimeout(5)
            self.assertEqual(client.recv(1), b"")

    def test_send_does_not_wait_for_a_client_that_stops_reading(self) -> None:
        all_sent = threading.Event()

        async def send_8_mb(scope, receive, send) -> None:
            if scope["type"] != "websocket":
                return
            await receive()
            await send({"type": "websocket.accept"})
            # 8 MB: well past the ~700 KiB at which uvicorn 0.54's own protocol makes send() wait.
            for _ in range(128):
                await send({"type": "websocket.send", "bytes": b"x" * 65536})
            all_sent.set()
            await send({"type": "websocket.close", "code": 1000})

        # The client reads nothing after the handshake.
        with serve(send_8_mb):
            self.assertTrue(all_sent.wait(5), "send() waited for a client that stopped reading")

    def test_a_close_after_the_client_left_returns(self) -> None:
        outcome: dict[str, str] = {}
        closed = threading.Event()

        async def close_after_disconnect(scope, receive, send) -> None:
            if scope["type"] != "websocket":
                return
            await receive()
            await send({"type": "websocket.accept"})
            while (await receive())["type"] != "websocket.disconnect":
                pass
            try:
                await send({"type": "websocket.close", "code": 1000})
                outcome["close"] = "returned"
            except Exception as error:
                outcome["close"] = f"raised {type(error).__name__}"
            closed.set()

        with serve(close_after_disconnect) as client:
            received = b""
            while b"\r\n\r\n" not in received:
                received += client.recv(4096)
            client.close()
            self.assertTrue(closed.wait(5), "the endpoint did not reach its close")
        self.assertEqual(outcome["close"], "returned")


if __name__ == "__main__":
    unittest.main()
