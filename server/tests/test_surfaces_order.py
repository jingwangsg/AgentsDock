import os
import tempfile
import unittest

os.environ.setdefault("AGENTSDOCK_AGENT_TOKEN", "surfaces-order-test-token")
_STATE_DIR = tempfile.mkdtemp(prefix="agentsdock-surfaces-order-")
os.environ["AGENTSDOCK_STATE_DIR"] = _STATE_DIR

import agent_server  # noqa: E402  (reads the state dir and token at import)
from fastapi.testclient import TestClient  # noqa: E402


class SurfaceOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(agent_server.app)
        cls.headers = {"Authorization": f"Bearer {agent_server.AGENT_TOKEN}"}

    def setUp(self) -> None:
        agent_server.SURFACES.clear()
        self.ids = []
        for folder in ("A", "A", "B", "A"):
            response = self.client.post("/api/surfaces", json={"kind": "browser", "folder": folder}, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.ids.append(response.json()["surface"]["id"])

    def listed(self) -> list[str]:
        return [surface["id"] for surface in self.client.get("/api/surfaces", headers=self.headers).json()["surfaces"]]

    def test_listed_tabs_take_their_slots_in_the_requested_order_and_bump_the_revision(self) -> None:
        a1, a2, b1, a3 = self.ids
        before = self.client.get("/api/surfaces", headers=self.headers).json()["revision"]
        # Reordering folder A's tabs leaves B's tab in its slot.
        response = self.client.put("/api/surfaces/order", json={"ids": [a3, a1, a2]}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([s["id"] for s in response.json()["surfaces"]], [a3, a1, b1, a2])
        self.assertEqual(self.listed(), [a3, a1, b1, a2])
        self.assertGreater(response.json()["revision"], before)

    def test_an_unchanged_order_is_not_a_new_revision(self) -> None:
        before = self.client.get("/api/surfaces", headers=self.headers).json()["revision"]
        response = self.client.put("/api/surfaces/order", json={"ids": self.ids}, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["revision"], before)

    def test_unknown_and_duplicate_ids_are_refused(self) -> None:
        self.assertEqual(self.client.put("/api/surfaces/order", json={"ids": ["browser_nope"]}, headers=self.headers).status_code, 404)
        self.assertEqual(self.client.put("/api/surfaces/order", json={"ids": [self.ids[0], self.ids[0]]}, headers=self.headers).status_code, 400)
        self.assertEqual(self.listed(), self.ids)


if __name__ == "__main__":
    unittest.main()
