#!/usr/bin/env python3
"""
Always-on Managed Agents environment worker.

Polls Anthropic's work queue and executes agent tool calls (bash, read,
write, edit, glob, grep, web_fetch) locally inside this container.
Must run alongside poll_projects.py — started by entrypoint.sh.

Required env vars:
  ANTHROPIC_ENVIRONMENT_KEY   sk-ant-oat01-... (from Console)
  ANTHROPIC_ENVIRONMENT_ID    env_... (from setup_agent.py)
"""
import asyncio
import logging
import os
import signal
import sys

from anthropic import AsyncAnthropic
from anthropic.lib.environments import EnvironmentWorker

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [env-worker] %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%S',
)
log = logging.getLogger(__name__)


async def main() -> None:
    environment_key = os.environ['ANTHROPIC_ENVIRONMENT_KEY']
    environment_id  = os.environ['ANTHROPIC_ENVIRONMENT_ID']

    log.info('Starting (environment=%s, workdir=/workspaces)', environment_id)

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    async with AsyncAnthropic(auth_token=environment_key) as client:
        worker = EnvironmentWorker(
            client,
            environment_id=environment_id,
            environment_key=environment_key,
            workdir='/workspaces',
        )
        worker_task = asyncio.create_task(worker.run())
        await asyncio.wait(
            [worker_task, asyncio.create_task(stop.wait())],
            return_when=asyncio.FIRST_COMPLETED,
        )
        if not worker_task.done():
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass

    log.info('Stopped')


if __name__ == '__main__':
    asyncio.run(main())
