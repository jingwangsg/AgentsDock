"""A timed-out app-server request names what app-server last said on stderr."""

import unittest

from codex_app_server import CodexAppServerTimeout


class TimeoutMessageTests(unittest.TestCase):
    def test_stderr_line_is_part_of_the_message(self) -> None:
        error = CodexAppServerTimeout("initialize", 30, stderr="state db backfill is running at /home/.codex")
        self.assertEqual(str(error), "initialize timed out after 30s; app-server stderr: state db backfill is running at /home/.codex")
        self.assertEqual(str(CodexAppServerTimeout("initialize", 30)), "initialize timed out after 30s")
