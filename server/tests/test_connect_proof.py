"""connect_proof_v1: a second address of this server proves it holds the client's token without the client sending it."""

import hashlib
import hmac
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import agent_server as server

NONCE = "0123456789abcdef" * 4


def expected_proof(token: str, nonce: str) -> str:
    message = f"agentsdock-connect-proof-v1\n{nonce}\n{server.server_identity()}".encode("utf-8")
    return hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()


class ConnectProofTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(server, "AGENT_TOKEN", "test-secret"))
        self.client = TestClient(server.app)

    def test_the_proof_needs_no_token_and_verifies_only_under_the_servers_token(self):
        response = self.client.get(f"/api/connect-proof?nonce={NONCE}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"proof": expected_proof("test-secret", NONCE)})
        self.assertNotEqual(response.json()["proof"], expected_proof("another-token", NONCE))
        self.assertNotIn(server.server_identity(), response.text, "the identity is checked by the client, not disclosed")

    def test_only_a_get_with_one_well_formed_nonce_passes_without_a_token(self):
        for method, query in (("POST", f"nonce={NONCE}"), ("PUT", f"nonce={NONCE}"), ("DELETE", f"nonce={NONCE}"),
                              ("OPTIONS", f"nonce={NONCE}"), ("GET", ""), ("GET", "nonce=" + NONCE.upper()),
                              ("GET", "nonce=" + "a" * 31), ("GET", "nonce=" + "a" * 129), ("GET", f"nonce={NONCE}&nonce={NONCE}"),
                              ("GET", f"nonce={NONCE}&token=test-secret"), ("GET", f"token=x&nonce={NONCE}")):
            with self.subTest(method=method, query=query):
                response = self.client.request(method, f"/api/connect-proof?{query}")
                self.assertEqual(response.status_code, 404)
                self.assertNotIn("proof", response.text)

    def test_the_exemption_is_this_exact_path(self):
        for path in ("/api/connect-proof/", "/api/connect-proofs", "/api/connect-proof/x", "/api/health"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(f"{path}?nonce={NONCE}").status_code, 401)

    def test_a_server_without_a_token_has_nothing_to_prove(self):
        with patch.object(server, "AGENT_TOKEN", ""):
            self.assertEqual(self.client.get(f"/api/connect-proof?nonce={NONCE}").status_code, 404)

    def test_health_advertises_it_only_with_a_token(self):
        capability = self.client.get("/api/health", headers={"Authorization": "Bearer test-secret"}).json()["capabilities"]["connect_proof_v1"]
        self.assertEqual(capability, {"available": True, "version": 1})
        with patch.object(server, "AGENT_TOKEN", ""):
            self.assertFalse(self.client.get("/api/health").json()["capabilities"]["connect_proof_v1"]["available"])


if __name__ == "__main__":
    unittest.main()
