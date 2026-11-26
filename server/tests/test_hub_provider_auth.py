import asyncio
import base64
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

import agent_server as server
from codex_app_server import CodexAppServerClient
import hub_provider_auth as auth
from tests.test_codex_app_server import FakeProcess, FakeProcessFactory, wait_until
from title_generation import _cursor_auth_file, cursor_profile


def codex_token(subject="first", expiry=None):
    claims = {"sub": subject, "exp": time.time() + 3600 if expiry is None else expiry,
              "https://api.openai.com/auth": {"chatgpt_account_id": "workspace"}}
    return "header." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".sig"


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.install = Path(temp.name)
        proof = self.install / ".hub-provider-proof"
        proof.write_text("d" * 64)
        proof.chmod(0o600)
        self.path = auth.socket_path(self.install)
        self.addCleanup(shutil.rmtree, self.path.parent, True)
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", auth.__file__, str(self.install),
            env={"AGENTSDOCK_AGENT_TOKEN": "ordinary-http-token"}, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self.addAsyncCleanup(self.stop_relay)

    async def stop_relay(self):
        self.proc.stdin.close()
        await asyncio.wait_for(self.proc.wait(), 3)

    async def test_proof_required_before_issuing_a_grant(self):
        issue = AsyncMock()
        with self.assertRaises(auth.HubLoginError):
            await auth.forward_requests(self.proc, "ordinary-http-token", issue)
        issue.assert_not_awaited()

    async def test_concurrent_clients_receive_only_their_own_grants_and_sanitized_errors(self):
        async def issue(backend, previous, refresh):
            if previous == "unavailable":
                raise RuntimeError("sensitive upstream diagnostics")
            return {"accessToken": backend, "chatgptAccountId": "workspace"}

        forward = asyncio.create_task(auth.forward_requests(self.proc, "d" * 64, issue))
        try:
            await wait_until(lambda: self.path.is_socket())
            self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
            results = await asyncio.gather(*(asyncio.to_thread(auth.request, self.install, provider)
                                              for provider in ("codex", "cursor", "codex", "cursor")))
            self.assertEqual(results, [{"accessToken": "codex", "chatgptAccountId": "workspace"},
                                       {"accessToken": "cursor"}] * 2)
            with self.assertRaisesRegex(auth.HubLoginError, "^Hub provider login is unavailable"):
                await asyncio.to_thread(auth.request, self.install, "codex", "unavailable", True)
        finally:
            self.proc.stdin.close()
            await asyncio.wait_for(forward, 3)
        self.assertFalse(self.path.exists())


class StaleRelayTests(unittest.IsolatedAsyncioTestCase):
    """A relay whose connection died without a close must end, or its lock stops the hub's next relay.

    Reproduced 2026-11-26 over ssh with a frozen sshd session. Here the test plays the hub on the relay's
    stdin and stdout, and a hub that does not answer stands for the dead connection.
    """

    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.install = Path(temp.name)
        proof = self.install / ".hub-provider-proof"
        proof.write_text("d" * 64)
        proof.chmod(0o600)
        self.path = auth.socket_path(self.install)
        self.addCleanup(shutil.rmtree, self.path.parent, True)

    async def start_relay(self, answer_seconds=None):
        # -I as in production: it ignores PYTHONPATH, hence the sys.path line. The relay is its own process,
        # so its wait for an answer is shortened there.
        program = ["import sys", "sys.path.insert(0, sys.argv[2])", "import hub_provider_auth as auth"]
        if answer_seconds is not None:
            program.append(f"auth.ANSWER_SECONDS = {answer_seconds}")
        program.append("auth.remote_relay(sys.argv[1])")
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", "-c", "\n".join(program), str(self.install), str(Path(auth.__file__).parent),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self.addAsyncCleanup(self.end_relay, proc)
        return proc

    async def end_relay(self, proc):
        proc.stdin.close()
        await asyncio.wait_for(proc.wait(), 3)

    async def proof_after_challenge(self, proc):
        proc.stdin.write(b"c" * 64 + b"\n")
        await proc.stdin.drain()
        return await asyncio.wait_for(proc.stdout.readline(), 5)

    async def test_a_relay_ends_when_the_hub_does_not_answer_a_login_request(self):
        stale = await self.start_relay(answer_seconds=0.3)
        await self.proof_after_challenge(stale)
        await wait_until(lambda: self.path.is_socket(), 5)
        request = asyncio.create_task(asyncio.to_thread(auth.request, self.install, "codex"))
        self.assertEqual(json.loads(await asyncio.wait_for(stale.stdout.readline(), 5)), ["codex", "", False])
        with self.assertRaises(auth.HubLoginError):
            await request
        self.assertEqual(await asyncio.wait_for(stale.wait(), 5), 0)
        self.assertFalse(self.path.exists())

    async def test_a_relay_that_finds_the_lock_held_makes_a_stale_holder_end(self):
        stale = await self.start_relay(answer_seconds=0.3)
        await self.proof_after_challenge(stale)
        await wait_until(lambda: self.path.is_socket(), 5)
        blocked = await self.start_relay()
        self.assertEqual(await asyncio.wait_for(blocked.wait(), 5), 1)
        self.assertEqual(await asyncio.wait_for(stale.stdout.readline(), 5), auth.PROBE)
        # The hub does not answer: the holder ends, and the next relay gets the lock and proves itself.
        self.assertEqual(await asyncio.wait_for(stale.wait(), 5), 0)
        proof = await self.proof_after_challenge(await self.start_relay())
        self.assertEqual(len(proof), 65, "64 hex digits and a newline")

    async def test_a_holder_whose_hub_answers_the_probe_keeps_serving(self):
        holder = await self.start_relay(answer_seconds=5)
        issue = AsyncMock(return_value={"accessToken": "token"})
        forward = asyncio.create_task(auth.forward_requests(holder, "d" * 64, issue))
        try:
            await wait_until(lambda: self.path.is_socket(), 5)
            blocked = await self.start_relay()
            self.assertEqual(await asyncio.wait_for(blocked.wait(), 5), 1)
            # The holder takes the probe first. Unanswered, it would end 5 s later and this request would fail.
            self.assertEqual(await asyncio.to_thread(auth.request, self.install, "cursor"), {"accessToken": "token"})
            issue.assert_awaited_once_with("cursor", "", False)
        finally:
            forward.cancel()
            await asyncio.gather(forward, return_exceptions=True)


class DelegatedLoginTests(unittest.IsolatedAsyncioTestCase):
    async def test_hub_rejects_different_users_in_one_workspace_and_expired_refresh(self):
        old = codex_token()
        owner = auth.codex_identity(old)
        for label, replacement in (("different user", codex_token("other-user")), ("expired", codex_token(expiry=0))):
            manager = AsyncMock()
            manager.request.side_effect = [{"authMethod": "chatgpt", "authToken": token} for token in (old, replacement)]
            with self.subTest(case=label), patch.object(server, "HUB_PROVIDER_INSTALL", None), \
                    patch.object(server, "codex_app_server_manager", return_value=manager):
                with self.assertRaises(auth.HubLoginError):
                    await server.issue_hub_provider_grant("codex", owner, True)

    async def test_codex_refresh_is_scoped_to_process_login_and_thread_uses_official_provider(self):
        first = codex_token()
        second = codex_token()
        issue = AsyncMock(side_effect=[{"accessToken": token, "chatgptAccountId": "workspace"} for token in (first, second)])
        proc = FakeProcess()
        proc.responders.update({"config/read": lambda _: {"config": auth.CODEX_CONFIG},
                                "account/login/start": lambda _: {"type": "chatgptAuthTokens"},
                                "thread/resume": lambda _: {}})
        factory = FakeProcessFactory(proc)
        client = CodexAppServerClient("codex", cwd="/tmp", env_factory=lambda: {"OPENAI_BASE_URL": "bad"},
                                      external_login=issue, process_factory=factory)
        self.addAsyncCleanup(client.close)
        await client.request("thread/resume", {"threadId": "t", "modelProvider": "another"})
        self.assertNotIn("OPENAI_BASE_URL", factory.calls[0][1]["env"])
        self.assertEqual(proc.messages[-1]["params"]["modelProvider"], "openai")
        self.assertEqual(proc.messages[-1]["params"]["config"], auth.CODEX_CONFIG)
        for request_id, previous in ((100, "other-workspace"), (101, None)):
            proc.feed({"id": request_id, "method": "account/chatgptAuthTokens/refresh",
                       "params": {"reason": "unauthorized", "previousAccountId": previous}})
            await wait_until(lambda: any(msg.get("id") == request_id for msg in proc.messages))
        self.assertIn("error", proc.messages[-2])
        self.assertEqual(proc.messages[-1]["result"]["accessToken"], second)
        issue.assert_awaited_with(auth.codex_identity(first), True)

    async def test_no_token_issued_when_native_routing_or_store_differs(self):
        for key in ("chatgpt_base_url", "openai_base_url", "cli_auth_credentials_store", "model_provider"):
            proc = FakeProcess()
            proc.responders["config/read"] = lambda _: {"config": {**auth.CODEX_CONFIG, key: "override"}}
            issue = AsyncMock()
            client = CodexAppServerClient("codex", cwd="/tmp", env_factory=dict,
                                          external_login=issue, process_factory=FakeProcessFactory(proc))
            with self.subTest(key=key), self.assertRaises(auth.HubLoginError):
                await client.start()
            issue.assert_not_awaited()
            self.assertIsNotNone(proc.returncode)

    async def test_cursor_turn_and_title_keep_native_store_and_endpoint_isolated(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(auth, "request", return_value={"accessToken": "fixture"}):
            env = {"HOME": directory, "CURSOR_API_KEY": "remote", "CURSOR_API_ENDPOINT": "https://remote.invalid",
                   "CURSOR_API_BASE_URL": "https://remote.invalid", "AGENT_CLI_CREDENTIAL_STORE": "file"}
            turn = server.cursor_hub_env(env)
            _, title = cursor_profile(Path(directory), turn)
            for child in (turn, title):
                self.assertEqual(child["AGENT_CLI_CREDENTIAL_STORE"], "memory")
                self.assertEqual(child["CURSOR_AUTH_TOKEN"], "fixture")
                self.assertNotIn("CURSOR_API_KEY", child)
                self.assertNotIn("CURSOR_API_ENDPOINT", child)
                self.assertNotIn("CURSOR_API_BASE_URL", child)
            self.assertEqual(env["AGENT_CLI_CREDENTIAL_STORE"], "file")

    def test_cursor_renews_the_browser_login_without_importing_environment_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {"HOME": directory, "AGENT_CLI_CREDENTIAL_STORE": "file",
                   "CURSOR_AUTH_TOKEN": "unrelated", "CURSOR_API_KEY": "unrelated"}
            path = _cursor_auth_file(Path(directory), env)
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"accessToken": codex_token(expiry=0)}))
            renewed = codex_token()

            def renew(_cmd, *, env):
                self.assertNotIn("CURSOR_AUTH_TOKEN", env)
                self.assertNotIn("CURSOR_API_KEY", env)
                path.write_text(json.dumps({"accessToken": renewed}))

            with patch.object(server, "runner_env", return_value=env), \
                    patch.object(server, "resolve_cursor_executable", return_value="fixture-cursor"), \
                    patch.object(server, "runtime_command", side_effect=renew):
                self.assertEqual(server.hub_cursor_access_token(), renewed)
