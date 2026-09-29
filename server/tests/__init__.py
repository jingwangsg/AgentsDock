"""AgentsServer tests; run with unittest discovery from the server directory."""

import os
import tempfile

# load-bearing: agent_server resolves its state and config directories at import. Tests
# that fall back to the real ~/.agentsdock overwrite the running server's sessions.json
# with fixtures (a suite run once replaced every hub chat), and the real config env
# leaks its tokens into the tests. Override any inherited value on purpose.
_ROOT = tempfile.mkdtemp(prefix="agentsdock-tests-")
os.environ["AGENTSDOCK_STATE_DIR"] = os.path.join(_ROOT, "state")
os.environ["AGENTS_SERVER_CONFIG_DIR"] = os.path.join(_ROOT, "config")
