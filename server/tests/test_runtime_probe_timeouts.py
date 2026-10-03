"""Passive Claude checks and bounded, non-poisoning catalog refreshes."""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import Future
from pathlib import Path
from unittest.mock import patch

import agent_server
import claude_model_catalog


def completed(args, stdout="", returncode=0):
    return subprocess.CompletedProcess(args, returncode, stdout, "")


def setUpModule():
    # Claude runs and probes require the token (require_claude_oauth_token).
    unittest.enterModuleContext(patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": "test-token"}))


class RuntimeProbeTimeoutTests(unittest.TestCase):
    def setUp(self):
        with agent_server.RUNTIME_DIAGNOSTICS_LOCK:
            agent_server.RUNTIME_DIAGNOSTICS.clear()
            agent_server.RUNTIME_DIAGNOSTIC_GENERATIONS.clear()
        token = agent_server.RUNTIME_CATALOG_DEADLINE.set(None)
        self.addCleanup(agent_server.RUNTIME_CATALOG_DEADLINE.reset, token)
        self.enterContext(patch.object(agent_server, "RUNTIME_CATALOG_TIMEOUT_SECONDS", 6.0))
        self.enterContext(patch.object(agent_server, "runner_env", return_value={}))

    def test_claude_check_only_runs_version_and_leaves_authentication_unknown(self):
        def run(cmd, **kwargs):
            self.assertEqual(cmd[1:], ["--version"])
            self.assertEqual(kwargs["timeout"], 6.0)
            return completed(cmd, "2.1.283 (Claude Code)")

        with patch.object(agent_server.shutil, "which", return_value="/test/claude"), patch.object(
            agent_server.subprocess, "run", side_effect=run,
        ):
            result = agent_server.probe_runtime("claude")
        self.assertEqual(result["status"], "unknown")
        self.assertTrue(result["installed"])
        self.assertIsNone(result["authenticated"])
        self.assertIsNone(result["action"])

    def test_claude_catalog_refresh_never_starts_a_metadata_or_auth_process(self):
        from claude_model_catalog import clear_native_models
        clear_native_models()
        allowed = (["--help"], ["--effort", "ultracode", "--version"])
        def run(cmd, **kwargs):
            self.assertIn(cmd[1:], allowed)
            return completed(cmd, "--effort <level> (low, medium, high)")
        with patch.object(agent_server.subprocess, "Popen") as popen, patch.object(
            agent_server.subprocess, "run", side_effect=run,
        ), patch.object(agent_server, "discover_claude_provider_models", return_value=([], "unavailable")):
            result = agent_server.parse_claude_help_catalog()
        popen.assert_not_called()
        self.assertTrue(result["models"])
        self.assertIn("fallback", result["model_source"])

    def test_authentication_failure_invalidates_model_cache(self):
        with patch("claude_model_catalog.clear_native_models") as clear:
            agent_server.record_runtime_failure("claude", "OAuth session expired and could not be refreshed")
        clear.assert_called_once_with()

    def test_auth_timeout_is_explicit_unknown_auth_and_does_not_leak_output(self):
        error = subprocess.TimeoutExpired(
            ["codex", "login", "status"], 6,
            output=b"private-account@example.com", stderr=b"secret-token",
        )
        with patch.object(agent_server.shutil, "which", return_value="/test/claude"), patch.object(
            agent_server, "runtime_command", side_effect=[completed([], "2.1.277"), error],
        ), self.assertLogs(agent_server.logger, level="WARNING") as logs:
            result = agent_server.probe_runtime("codex")
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["authenticated"])
        self.assertTrue(result["installed"])
        self.assertIn("authentication check timed out", result["message"])
        self.assertNotIn("auth login", result["action"])
        exposed = json.dumps(result) + str(logs.output)
        self.assertNotIn("private-account", exposed)
        self.assertNotIn("secret-token", exposed)

    def test_codex_explicit_signed_out_still_blocks(self):
        with patch.object(agent_server.shutil, "which", return_value="/test/claude"), patch.object(
            agent_server, "runtime_command", side_effect=[
                completed([], "codex-cli"), completed([], 'Not logged in', 1),
            ],
        ):
            result = agent_server.probe_runtime("codex")
        self.assertEqual(result["status"], "unauthenticated")
        self.assertFalse(result["available"])
        self.assertFalse(result["authenticated"])
        self.assertIn("codex login", result["action"])

    def test_version_help_and_other_auth_keep_six_second_limit(self):
        with patch.object(agent_server.subprocess, "run", return_value=completed([])) as run:
            for cmd in (["claude", "--version"], ["codex", "login", "status"], ["agent", "status"]):
                agent_server.runtime_command(cmd)
                self.assertEqual(run.call_args.kwargs["timeout"], 6.0)
            agent_server.run_catalog_command(["claude", "--help"])
            self.assertEqual(run.call_args.kwargs["timeout"], 6.0)
            agent_server.claude_supports_effort("ultracode")
            self.assertEqual(run.call_args.kwargs["timeout"], 6.0)

    def test_forced_claude_recheck_never_starts_auth_even_after_cached_failure(self):
        agent_server.record_runtime_failure("claude", "Not logged in")
        with patch.object(
            agent_server.shutil, "which", return_value="/test/claude",
        ), patch.object(agent_server.subprocess, "run", return_value=completed([], "2.1.283")) as run:
            result = agent_server.runtime_diagnostic("claude", force=True)
        self.assertEqual(result["status"], "unauthenticated")
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ["/test/claude", "--version"])

    def test_remaining_catalog_budget_clamps_each_command(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(102.0)
        with patch.object(agent_server.time, "monotonic", return_value=100.0), patch.object(
            agent_server.subprocess, "run", return_value=completed([]),
        ) as run:
            agent_server.runtime_command(["claude", "auth", "status"], timeout_seconds=15)
            self.assertEqual(run.call_args.kwargs["timeout"], 2.0)
            agent_server.run_catalog_command(["claude", "--help"])
            self.assertEqual(run.call_args.kwargs["timeout"], 2.0)
            agent_server.claude_supports_effort("ultracode")
            self.assertEqual(run.call_args.kwargs["timeout"], 2.0)

    def test_exhausted_budget_starts_no_subprocess(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(100.0)
        with patch.object(agent_server.time, "monotonic", return_value=100.0), patch.object(
            agent_server.subprocess, "run",
        ) as run, self.assertRaises(agent_server.RuntimeCatalogBudgetExpired):
            agent_server.runtime_command(["claude", "--version"])
        run.assert_not_called()

    def test_budget_expiry_does_not_poison_or_freshen_cached_diagnostic(self):
        previous = agent_server.runtime_diagnostic_payload(
            "claude", "ready", installed=True, authenticated=True, version="2.1.277",
        )
        previous.update(checked_at="2026-09-18T01:00:00Z", checked_at_epoch=0.0)
        agent_server.store_runtime_diagnostic(previous)
        with patch.object(agent_server, "probe_runtime", side_effect=agent_server.RuntimeCatalogBudgetExpired):
            result = agent_server.runtime_diagnostic("claude", force=True)
        self.assertEqual(result, previous)
        self.assertEqual(agent_server.RUNTIME_DIAGNOSTICS["claude"], previous)

    def test_unchecked_provider_remains_unknown_and_uncached(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(0.0)
        with patch.object(agent_server, "probe_runtime") as probe, patch.object(
            agent_server, "runtime_executable",
        ) as resolve:
            result = agent_server.runtime_diagnostic("cursor", force=True)
        probe.assert_not_called()
        resolve.assert_not_called()
        self.assertEqual(result["status"], "unknown")
        self.assertIsNone(result["installed"])
        self.assertIsNone(result["authenticated"])
        self.assertIn("deadline", result["message"])
        self.assertNotIn("cursor", agent_server.RUNTIME_DIAGNOSTICS)

    def test_completed_signed_out_result_is_not_discarded_at_budget_boundary(self):
        clock = [100.0]
        agent_server.RUNTIME_CATALOG_DEADLINE.set(101.0)
        agent_server.store_runtime_diagnostic(agent_server.runtime_diagnostic_payload(
            "claude", "ready", installed=True, authenticated=True,
        ))

        def probe(backend):
            clock[0] = 101.0
            return agent_server.runtime_diagnostic_payload(
                backend, "unauthenticated", installed=True, authenticated=False,
            )

        with patch.object(agent_server.time, "monotonic", side_effect=lambda: clock[0]), patch.object(
            agent_server, "probe_runtime", side_effect=probe,
        ):
            result = agent_server.runtime_diagnostic("claude", force=True)
        self.assertEqual(result["status"], "unauthenticated")
        self.assertEqual(agent_server.RUNTIME_DIAGNOSTICS["claude"]["status"], "unauthenticated")

    def test_cursor_catalog_resolution_budget_expiry_returns_safe_auto_fallback(self):
        with patch.object(agent_server, "resolve_cursor_executable", side_effect=agent_server.RuntimeCatalogBudgetExpired), patch.object(
            agent_server, "run_catalog_command",
        ) as run:
            result = agent_server.discover_cursor_catalog()
        run.assert_not_called()
        self.assertEqual(result["models"], [{"value": "auto", "label": "Auto"}])

    def test_budget_exhaustion_is_not_a_normal_auth_timeout(self):
        clock = [100.0]
        agent_server.RUNTIME_CATALOG_DEADLINE.set(102.0)

        def run(cmd, **kwargs):
            clock[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

        with patch.object(agent_server.time, "monotonic", side_effect=lambda: clock[0]), patch.object(
            agent_server.subprocess, "run", side_effect=run,
        ), self.assertRaises(agent_server.RuntimeCatalogBudgetExpired):
            agent_server.runtime_command(["claude", "auth", "status"], timeout_seconds=15)

    def test_models_api_cannot_outlive_remaining_budget(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(100.25)
        with patch.dict(agent_server.os.environ, {"ANTHROPIC_API_KEY": "test-not-a-real-key"}), patch.object(
            agent_server.shutil, "which", return_value="/test/curl",
        ), patch.object(agent_server.time, "monotonic", return_value=100.0), patch.object(
            agent_server.subprocess, "run", return_value=completed([], b'{"data":[]}'),
        ) as run:
            _, status = agent_server.discover_claude_provider_models()
        self.assertEqual(status, "success")
        self.assertEqual(run.call_args.kwargs["timeout"], 0.25)
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("--max-time") + 1], "0.25")

    def test_native_models_read_cache_without_allocating_a_process_budget(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(102.0)
        with patch.object(agent_server.time, "monotonic", return_value=100.0), patch(
            "claude_model_catalog.cached_native_models", return_value=[],
        ) as probe:
            _, status = agent_server.discover_claude_native_models()
        self.assertEqual(status, "success")
        self.assertNotIn("timeout", probe.call_args.kwargs)

    def test_native_models_expired_budget_starts_no_process(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(100.0)
        with patch.object(agent_server.time, "monotonic", return_value=100.0), patch(
            "claude_model_catalog.cached_native_models", return_value=None,
        ), patch("subprocess.Popen") as probe:
            models, status = agent_server.discover_claude_native_models()
        probe.assert_not_called()
        self.assertEqual((models, status), ([], "unavailable"))

    def test_models_api_respects_callers_smaller_candidate_budget(self):
        with patch.dict(agent_server.os.environ, {"ANTHROPIC_API_KEY": "synthetic-key"}), patch.object(
            agent_server.shutil, "which", return_value="/test/curl",
        ), patch.object(agent_server.subprocess, "run", return_value=completed([], b'{"data":[]}')) as run:
            _, status = agent_server.discover_claude_provider_models(timeout_seconds=2.0)
        self.assertEqual(status, "success")
        self.assertEqual(run.call_args.kwargs["timeout"], 3.0)  # One second to reap curl.
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("--max-time") + 1], "2")

    def test_catalog_deadline_restored_on_exception_and_not_shared_between_threads(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(123.0)
        seen = []
        thread = threading.Thread(target=lambda: seen.append(agent_server.RUNTIME_CATALOG_DEADLINE.get()))
        thread.start()
        thread.join(timeout=5)
        self.assertEqual(seen, [None])
        with patch.object(agent_server, "discover_runtime_catalog_within_budget", side_effect=ValueError("test")):
            with self.assertRaises(ValueError):
                agent_server.discover_runtime_catalog()
        self.assertEqual(agent_server.RUNTIME_CATALOG_DEADLINE.get(), 123.0)

    def test_full_catalog_slow_claude_and_stalled_peers_share_25_second_budget(self):
        clock = [100.0]
        started = []

        class InlinePool:
            """Deterministic worst-case budget without a racing virtual clock."""

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def submit(self, fn, *args, **kwargs):
                future = Future()
                future.set_result(fn(*args, **kwargs))
                return future

        def run(cmd, **kwargs):
            self.assertLess(clock[0], 125.0)
            started.append((cmd, kwargs["timeout"]))
            if cmd[0] == "/test/claude" and cmd[1:] == ["--version"]:
                clock[0] += 0.1
                return completed(cmd, "2.1.277")
            if cmd[0] == "/test/claude" and cmd[1:] == ["auth", "status", "--json"]:
                self.fail("catalog must not invoke Claude authentication commands")
            clock[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

        with patch.object(agent_server.time, "monotonic", side_effect=lambda: clock[0]), patch.object(
            agent_server.shutil, "which", side_effect=lambda cmd, **kw: "/test/" + cmd,
        ), patch.object(agent_server, "CLAUDE_BIN", "claude"), patch.object(
            agent_server.subprocess, "run", side_effect=run,
        ), patch.object(agent_server, "codex_user_config_defaults", return_value=("", "", "")), patch.dict(
            agent_server.os.environ, {"ANTHROPIC_API_KEY": ""},
        ), patch.object(
            agent_server, "ThreadPoolExecutor", return_value=InlinePool(),
        ):
            result = agent_server.discover_runtime_catalog(force_runtime_probe=True)
        self.assertAlmostEqual(clock[0] - 100, 25.0)
        self.assertTrue(started)
        self.assertEqual(set(result["backends"]), agent_server.VALID_BACKENDS)
        self.assertEqual(result["backends"]["claude"]["diagnostic"]["status"], "unknown")
        self.assertEqual(result["backends"]["opencode"]["diagnostic"]["status"], "unknown")
        self.assertNotIn("opencode", agent_server.RUNTIME_DIAGNOSTICS)
        self.assertTrue(result["backends"]["claude"]["models"])
        self.assertIsNone(agent_server.RUNTIME_CATALOG_DEADLINE.get())

    def test_provider_checks_start_concurrently_and_inherit_refresh_deadline(self):
        agent_server.RUNTIME_CATALOG_DEADLINE.set(123.0)
        barrier = threading.Barrier(len(agent_server.VALID_BACKENDS))
        seen = {}
        lock = threading.Lock()

        def probe(backend, *, force_runtime_probe):
            with lock:
                seen[backend] = (force_runtime_probe, agent_server.RUNTIME_CATALOG_DEADLINE.get())
            # A sequential implementation would time out before reaching the
            # other providers, rather than letting the whole group proceed.
            barrier.wait(timeout=5)
            return {"backend": backend, "status": "ready"}

        with patch.object(agent_server, "discover_runtime_backend_catalog", side_effect=probe):
            results = agent_server.discover_runtime_catalog_within_budget(force_runtime_probe=True)
        self.assertEqual(set(results["backends"]), agent_server.VALID_BACKENDS)
        self.assertEqual(seen, {backend: (True, 123.0) for backend in agent_server.VALID_BACKENDS})
        self.assertEqual(agent_server.RUNTIME_CATALOG_DEADLINE.get(), 123.0)

    def test_slow_peer_diagnostic_cannot_starve_healthy_opencode_models(self):
        slow_started = threading.Event()
        models_finished = threading.Event()
        static = {"models": [], "efforts": []}

        def diagnostic(backend, *, force):
            if backend == "cursor":
                slow_started.set()
                self.assertTrue(models_finished.wait(timeout=5))
                return {"backend": backend, "status": "error"}
            return {"backend": backend, "status": "ready", "_executable": "/test/" + backend}

        def opencode_models(**_kwargs):
            self.assertTrue(slow_started.wait(timeout=5))
            models_finished.set()
            return {"models": [{"value": "opencode/test", "label": "Test"}], "efforts": []}

        with patch.object(agent_server, "runtime_diagnostic", side_effect=diagnostic), patch.object(
            agent_server, "parse_claude_help_catalog", return_value=dict(static),
        ), patch.object(agent_server, "discover_codex_catalog", return_value=dict(static)), patch.object(
            agent_server, "discover_opencode_catalog", side_effect=opencode_models,
        ):
            result = agent_server.discover_runtime_catalog(force_runtime_probe=True)
        self.assertEqual(result["backends"]["opencode"]["models"][0]["value"], "opencode/test")
        self.assertTrue(result["backends"]["opencode"]["available"])

    def test_http_catalog_route_propagates_budget_to_worker_and_returns_json(self):
        seen = []

        def discover(**kwargs):
            seen.append((kwargs, agent_server.RUNTIME_CATALOG_DEADLINE.get()))
            return {"backends": {}, "generated_at": "test"}

        with patch.object(agent_server, "discover_runtime_catalog_within_budget", side_effect=discover):
            result = asyncio.run(agent_server.runtime_catalog(refresh=True))
        self.assertEqual(json.loads(json.dumps(result))["backends"], {})
        self.assertEqual(seen[0][0], {"force_runtime_probe": True})
        self.assertIsInstance(seen[0][1], float)
        self.assertIsNone(agent_server.RUNTIME_CATALOG_DEADLINE.get())

    def test_real_subprocess_timeout_kills_and_reaps_child(self):
        # Exercise real subprocess cleanup, without a provider or credentials.
        with self.assertRaises(subprocess.TimeoutExpired):
            agent_server.runtime_command(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                timeout_seconds=0.1,
            )


# Stand-in for the Claude CLI in SDK stream-json mode: answers the SDK's
# version check, records how it was spawned, and in "models" mode replies to
# the initialize control request the way the real CLI does.
FAKE_CLAUDE = """#!{python}
import json, os, sys, time
if sys.argv[1:] in (["-v"], ["--version"]):
    print("2.1.283 (Claude Code)")
    sys.exit(0)
with open({log!r}, "a") as log:
    log.write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd()}}) + "\\n")
if {mode!r} == "exit":
    sys.exit(1)
for line in sys.stdin:
    frame = json.loads(line)
    if {mode!r} == "models" and frame.get("type") == "control_request" and frame["request"].get("subtype") == "initialize":
        time.sleep({delay})
        sys.stdout.write(json.dumps({{"type": "control_response", "response": {{
            "subtype": "success", "request_id": frame["request_id"], "response": {{"commands": [], "models": [
                {{"value": "default", "displayName": "Default (recommended)", "resolvedModel": "claude-opus-5-5",
                 "description": "Opus 5.5 · Best for everyday tasks"}},
                {{"value": "sonnet", "displayName": "Sonnet", "resolvedModel": "claude-sonnet-5", "description": "Sonnet 5 · Fast"}},
            ]}}}}}}) + "\\n")
        sys.stdout.flush()
"""


class ClaudeNativeProbeTests(unittest.IsolatedAsyncioTestCase):
    """The initialize-only probe uses a chat's SDK transport, a neutral cwd, and a hard deadline."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.log = self.tmp / "spawns.jsonl"
        self.store = self.tmp / "claude-native-models.json"
        previous_store = claude_model_catalog._STORE.path
        claude_model_catalog.configure_native_models_store(self.store)
        self.addCleanup(claude_model_catalog.configure_native_models_store, previous_store)
        claude_model_catalog.clear_native_models()
        self.addCleanup(claude_model_catalog.clear_native_models)
        self.neutral_cwd = self.tmp / "state" / "claude-native-probe"
        self.enterContext(patch.object(agent_server, "STATE_DIR", self.tmp / "state"))
        self.enterContext(patch.object(agent_server, "runner_env", return_value={
            "PATH": os.environ.get("PATH", ""), "HOME": str(self.tmp / "home"),
        }))
        self.enterContext(patch.object(agent_server, "CLAUDE_NATIVE_PROBE_LOCK", asyncio.Lock()))
        self.enterContext(patch.object(agent_server, "CLAUDE_NATIVE_PROBE_FINISHED_AT", None))
        self.enterContext(patch.object(agent_server, "CLAUDE_NATIVE_PROBE_FAILURE", ""))
        self.enterContext(patch.object(agent_server, "CLAUDE_NATIVE_PROBE_TIMEOUT_SECONDS", 5.0))
        token = agent_server.RUNTIME_CATALOG_DEADLINE.set(None)
        self.addCleanup(agent_server.RUNTIME_CATALOG_DEADLINE.reset, token)

    def fake_claude(self, mode, delay=0.0):
        path = self.tmp / f"claude-{mode}"
        path.write_text(FAKE_CLAUDE.format(python=sys.executable, log=str(self.log), mode=mode, delay=delay))
        path.chmod(0o755)
        self.enterContext(patch.object(agent_server, "CLAUDE_BIN", str(path)))

    def spawns(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def catalog(self):
        def run(cmd, **kwargs):
            return completed(cmd, "--effort <level> (low, medium, high)")
        with patch.object(agent_server.subprocess, "run", side_effect=run), patch.object(
            agent_server, "discover_claude_provider_models", return_value=([], "unavailable"),
        ):
            return agent_server.parse_claude_help_catalog()

    async def test_refresh_captures_the_picker_through_the_sdk_handshake(self):
        self.fake_claude("models")
        await agent_server.refresh_claude_native_models(explicit=True)
        self.assertEqual(agent_server.CLAUDE_NATIVE_PROBE_FAILURE, "")
        stored = json.loads(self.store.read_text())
        self.assertEqual([[row["value"] for row in rows] for rows in stored.values()], [["default", "sonnet"]])
        [spawn] = self.spawns()
        self.assertEqual(Path(spawn["cwd"]).resolve(), self.neutral_cwd.resolve())
        self.assertEqual(spawn["argv"][:3], ["--output-format", "stream-json", "--verbose"])
        self.assertIn("--setting-sources=user,project,local", spawn["argv"])
        self.assertEqual(spawn["argv"][-2:], ["--input-format", "stream-json"])
        result = self.catalog()
        self.assertEqual(result["model_source"], "Cached Claude SDK initialize")
        self.assertEqual(
            [(row["label"], row.get("description")) for row in result["models"] if row["value"]],
            [("Default — Opus 5.5", "Best for everyday tasks"), ("Sonnet 5", "Fast")],
        )

    async def test_silent_cli_keeps_the_static_list_and_names_the_failure(self):
        self.fake_claude("silent")
        self.enterContext(patch.object(agent_server, "CLAUDE_NATIVE_PROBE_TIMEOUT_SECONDS", 1.0))
        await agent_server.refresh_claude_native_models(explicit=True)
        self.assertEqual(agent_server.CLAUDE_NATIVE_PROBE_FAILURE, "initialize timed out after 1s")
        self.assertFalse(self.store.exists())
        result = self.catalog()
        self.assertTrue(result["models"])
        self.assertEqual(result["model_source"],
                         "claude --help + current fallback; probe failed: initialize timed out after 1s")

    async def test_exiting_cli_reports_the_failure_type_only(self):
        self.fake_claude("exit")
        await agent_server.refresh_claude_native_models(explicit=True)
        self.assertRegex(agent_server.CLAUDE_NATIVE_PROBE_FAILURE, r"^initialize failed \([A-Za-z]+\)$")
        self.assertFalse(self.store.exists())

    async def test_concurrent_refreshes_share_one_probe(self):
        self.fake_claude("models", delay=0.5)
        await asyncio.gather(*(agent_server.refresh_claude_native_models(explicit=True) for _ in range(3)))
        self.assertEqual(len(self.spawns()), 1)
        self.assertTrue(self.store.exists())

    async def test_plain_refresh_waits_for_the_retry_window_but_an_explicit_recheck_does_not(self):
        self.fake_claude("exit")
        await agent_server.refresh_claude_native_models()
        await agent_server.refresh_claude_native_models()
        self.assertEqual(len(self.spawns()), 1)
        await agent_server.refresh_claude_native_models(explicit=True)
        self.assertEqual(len(self.spawns()), 2)
        with patch.object(agent_server, "CLAUDE_NATIVE_PROBE_RETRY_SECONDS", 0.0):
            await agent_server.refresh_claude_native_models()
        self.assertEqual(len(self.spawns()), 3)

    async def test_probe_ignores_the_server_working_directory_settings(self):
        self.fake_claude("models")
        project = self.tmp / "project"
        (project / ".claude").mkdir(parents=True)
        (project / ".claude" / "settings.json").write_text('{"model": "opus"}')
        previous_cwd = os.getcwd()
        os.chdir(project)
        self.addCleanup(os.chdir, previous_cwd)
        consulted = []
        real_gate = claude_model_catalog._has_project_settings
        def recording_gate(cwd, env):
            consulted.append(cwd)
            return real_gate(cwd, env)
        with patch.object(claude_model_catalog, "_has_project_settings", recording_gate):
            await agent_server.refresh_claude_native_models(explicit=True)
        self.assertEqual(agent_server.CLAUDE_NATIVE_PROBE_FAILURE, "")
        self.assertTrue(self.store.exists())
        self.assertEqual(consulted, [str(self.neutral_cwd)])
        self.assertEqual(Path(self.spawns()[0]["cwd"]).resolve(), self.neutral_cwd.resolve())

    async def test_missing_cli_fails_fast_without_spawning(self):
        self.enterContext(patch.object(agent_server, "CLAUDE_BIN", str(self.tmp / "absent" / "claude")))
        await agent_server.refresh_claude_native_models(explicit=True)
        self.assertIn("was not found", agent_server.CLAUDE_NATIVE_PROBE_FAILURE)
        self.assertEqual(self.spawns(), [])


if __name__ == "__main__":
    unittest.main()
