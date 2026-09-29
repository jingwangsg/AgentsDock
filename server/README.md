# AgentsServer

![AgentsDock in action](assets/agentsdock-preview.png)

**AgentsServer is the self-hosted execution backend for
[AgentsDock](https://agentsdock.net).** AgentsDock provides
the polished desktop and mobile chat experience; AgentsServer runs on the
machine that owns your workspaces and agent CLI installations.
Together they provide persistent agent chats without routing private project
files through a third-party chat service.

The desktop and mobile client is also open source:
[ZhengyiLuo/AgentsDock](https://github.com/ZhengyiLuo/AgentsDock).

## Features

- Run agent chats from desktop and mobile, with persistent history.
- Work with files, images, videos, scheduled jobs, and persistent terminals.
- Use Claude Code, Codex, Cursor, or OpenCode where supported by your server
  release, client, and installed CLI.
- Run independent servers on the same machine.

## Get started

Use a Linux or Apple silicon macOS host with
[`uv`](https://docs.astral.sh/uv/getting-started/installation/) installed.
Install and authenticate the agent CLI you want to use on that host.
`tmux` is optional for terminal access and managed updates.

AgentsDock desktop can guide you through **Set up AgentsServer**. To install
from this repository instead:

```bash
git clone https://github.com/ZhengyiLuo/AgentsDock.git
cd AgentsDock/server
./install.sh
```

The installer starts the default server, normally on port **7850**, and prints
its URL and access token. Add that URL/token pair in AgentsDock. To show the token
again without restarting:

```bash
./install.sh --show-token
```

For access from another network, connect the server and your device through
Tailscale. Keep access tokens private and do not expose the agent port directly
to the public internet. See the [setup guide](https://agentsdock.net/setup.html)
for detailed instructions.

### Memory at launch

New agent turns require **2 GiB (2048 MiB) of available server RAM** by default;
scheduled jobs require **4 GiB (4096 MiB)**. This is a launch check, not total RAM or a
guarantee that every workload will fit. Low-memory errors show the available
amount, required minimum, and recovery advice. See [memory settings](docs/MEMORY_ADMISSION.md)
for operator overrides.

## Multiple servers on one machine

Add a separate server without replacing your original/default server:

```bash
# Create a server with an automatic name and free port
./instances.sh new

# Or choose its name and port
./instances.sh new --name work --port 7851

# List all servers and their connection URLs
./instances.sh list

# Uninstall one server (replace work with its name)
./uninstall.sh --instance work
```

Uninstall asks for confirmation and preserves history by default. Bare
`./uninstall.sh` selects all servers; use `--instance` to select just one.

Named instances retain separate legacy service units. The default server keeps
the current split service lifecycle; `--execution-mode split` is rejected for
named instances to avoid taking over the default gateway.

## Managed local SSH forwards

The SSH forward service (`ssh_forward_service.py`) reads a private `<state-dir>/ssh-forwards.json` registry at startup and retries a forward when its SSH process exits. Each entry names an SSH host, local and remote ports, an IPv4-only or dual-loopback bind, and an optional CA bundle path. Forwards to SSH port 22 also probe the forwarded channel and maintain a local ControlMaster for clients such as Zed. Run the service under a user service manager so it restarts after a crash or login. The SSH host may also be `oci@<sky-cluster>` or `osmo@<workflow>`, resolved as for remote servers; `oci@` sets Sky's CA bundle itself. For remote-server deploys to these hosts, `AGENTSDOCK_OCI_HOME` and `AGENTSDOCK_OSMO_HOME` in the hub's environment name the cluster's persistent home; a deploy that keeps the default install directory then installs to `<home>/.agentsdock-server-<cluster or workflow>`, which outlives the cluster container. Each target gets its own install, so chats never mix between clusters and two servers never share one state directory; the Codex login in the home stays shared. `AGENTSDOCK_OCI_TUNNEL_SSH_ARGS` adds ssh arguments to the long-lived tunnel of `oci@` servers only, for example a `-R` reverse forward to a git server that only the hub's machine can reach. For each `-R <port>:<host>:<hostport>` there, the tunnel also points git on the host at the forward (`url.ssh://git@127.0.0.1:<port>/.insteadOf ssh://git@<host>:<hostport>/` in the server HOME's global git config) every time it connects, so repository URLs stay unchanged and a new cluster or home needs no setup.

A long-lived Claude token (from `claude setup-token`) in the hub's `CLAUDE_CODE_OAUTH_TOKEN` authenticates the hub's own Claude chats and is written into every remote install's env under the same name whenever the hub deploys or attaches it. It travels at the head of the bootstrap script on ssh stdin, never in argv or logs; a new or changed token restarts that server. A shared token avoids the logouts that OAuth refresh rotation causes when several hosts share one home.

The SSH forward registry is separate from `remote-servers.json`: a forwarded service is never treated as an AgentsServer install or started by its tunnel manager. When a remote cluster is recreated under another SSH host name, update that entry's host in the private registry and restart the SSH forward service. There is no admin API or desktop UI for these forwards yet.

## Updating

For the default server installed from a checkout:

```bash
git pull --ff-only
./install.sh
```

Updates preserve its token and chat history. AgentsDock Settings also supports
signed server updates. See the [update guide](https://agentsdock.net/update.html).

## Documentation and support

- [Detailed API, configuration, and lifecycle reference](docs/SERVER_REFERENCE.md)

- [Setup and connection help](https://agentsdock.net/setup.html)
- [AgentsDock features](https://agentsdock.net/features.html)
- [Server releases](https://github.com/ZhengyiLuo/AgentsServer/releases)
- [Report a server issue](https://github.com/ZhengyiLuo/AgentsServer/issues)
- [Contributing and tests](CONTRIBUTING.md)

Features in this checkout may not yet be in a published release. The maintained server source is this repository's `server/` directory. The
standalone AgentsServer repository remains a compatibility distribution during
the update migration.

## License

AgentsServer's original code and documentation are licensed under the
[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
Third-party components retain their respective copyrights and licenses.
