"""AgentsServer tests; run with unittest discovery from the server directory."""

import os
import tempfile

# load-bearing: agent_server resolves state/config dirs at import; without this, tests write
# fixtures over the real ~/.agentsdock sessions.json and read its tokens. Overwrite, not setdefault.
_ROOT = tempfile.mkdtemp(prefix="agentsdock-tests-")
os.environ["AGENTSDOCK_STATE_DIR"] = os.path.join(_ROOT, "state")
os.environ["AGENTS_SERVER_CONFIG_DIR"] = os.path.join(_ROOT, "config")
