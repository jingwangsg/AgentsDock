"""Run AgentsDock's persisted SSH forwards under a user service."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
from logging.handlers import RotatingFileHandler
from pathlib import Path

from remote_servers import RemoteServerManager


async def main(state_dir: Path) -> None:
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[RotatingFileHandler(state_dir / "ssh-forwards.log", maxBytes=1_000_000,
                                      backupCount=2, encoding="utf-8")],
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)

    manager = RemoteServerManager(state_dir, source_dir=Path(__file__).resolve().parent)
    try:
        await manager.start()
        logging.info("AgentsDock SSH forwards started: %d", len(manager.forwards))
        await stop.wait()
    finally:
        await manager.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AgentsDock SSH forward service")
    parser.add_argument("--state-dir", type=Path, required=True)
    arguments = parser.parse_args()
    asyncio.run(main(arguments.state_dir.expanduser()))
