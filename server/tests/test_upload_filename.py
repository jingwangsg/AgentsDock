import os
import shutil
import tempfile
import unittest
import urllib.parse

os.environ.setdefault("AGENTSDOCK_AGENT_TOKEN", "upload-filename-test-token")
_STATE_DIR = tempfile.mkdtemp(prefix="agentsdock-upload-filename-")
os.environ["AGENTSDOCK_STATE_DIR"] = _STATE_DIR

import agent_server  # noqa: E402  (reads the state dir and token at import)
from fastapi.testclient import TestClient  # noqa: E402


class UploadFilenameTests(unittest.TestCase):
    """A non-ASCII upload name survives both ways clients send it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.session_id = "sess_upload_filename_test"
        agent_server.STORE.sessions[cls.session_id] = {"id": cls.session_id, "title": "t", "backend": "codex"}
        cls.client = TestClient(agent_server.app)
        cls.headers = {"Authorization": f"Bearer {agent_server.AGENT_TOKEN}"}

    @classmethod
    def tearDownClass(cls) -> None:
        agent_server.STORE.sessions.pop(cls.session_id, None)
        shutil.rmtree(_STATE_DIR, ignore_errors=True)

    def test_raw_utf8_filename_is_kept(self) -> None:
        # React Native and browsers put the UTF-8 name straight into filename="…".
        response = self.client.post(
            f"/api/sessions/{self.session_id}/files",
            headers=self.headers,
            files={"file": ("截图 测试.jpg", b"xx", "image/jpeg")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["file"]["filename"], "截图 测试.jpg")

    def test_rfc5987_filename_star_beats_the_ascii_fallback(self) -> None:
        # The desktop app sends an ASCII fallback plus filename*=UTF-8''… for the real name.
        boundary = "----agentsdock-test"
        encoded = urllib.parse.quote("截图 测试.jpg")
        body = (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"__ __.jpg\"; filename*=UTF-8''{encoded}\r\n"
            "Content-Type: image/jpeg\r\n\r\nxx\r\n"
            f"--{boundary}--\r\n"
        ).encode()
        response = self.client.post(
            f"/api/sessions/{self.session_id}/files",
            headers={**self.headers, "Content-Type": f"multipart/form-data; boundary={boundary}"},
            content=body,
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["file"]["filename"], "截图 测试.jpg")

    def test_react_native_percent_encoded_filename_is_decoded(self) -> None:
        # React Native's FormData sends encodeURIComponent(name) inside filename="…".
        response = self.client.post(
            f"/api/sessions/{self.session_id}/files",
            headers=self.headers,
            files={"file": ("%E6%88%AA%E5%9B%BE%20%E6%B5%8B%E8%AF%95.jpg", b"xx", "image/jpeg")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["file"]["filename"], "截图 测试.jpg")

    def test_a_literal_percent_sign_is_not_mistaken_for_encoding(self) -> None:
        response = self.client.post(
            f"/api/sessions/{self.session_id}/files",
            headers=self.headers,
            files={"file": ("progress 100%.txt", b"xx", "text/plain")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["file"]["filename"], "progress 100_.txt")

    def test_ascii_fallback_alone_is_still_accepted(self) -> None:
        response = self.client.post(
            f"/api/sessions/{self.session_id}/files",
            headers=self.headers,
            files={"file": ("plain.txt", b"xx", "text/plain")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["file"]["filename"], "plain.txt")


if __name__ == "__main__":
    unittest.main()
