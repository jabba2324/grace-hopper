#!/usr/bin/env python3
"""
One-time setup: creates a self-hosted Managed Agents environment and a
coding agent. Run this once, then add the printed IDs to your .env file.

Usage:
    ANTHROPIC_API_KEY=sk-ant-... python3 scripts/setup_agent.py

Optional:
    CLAUDE_MODEL=claude-opus-4-8  (default: claude-opus-4-8)
"""
import os
import sys
import anthropic

MODEL = os.environ.get('CLAUDE_MODEL', 'claude-opus-4-8')

client = anthropic.Anthropic()

print(f'Creating self-hosted environment...')
try:
    environment = client.beta.environments.create(
        name='grace-hopper',
        config={'type': 'self_hosted'},
    )
except Exception as exc:
    print(f'ERROR: {exc}', file=sys.stderr)
    sys.exit(1)
print(f'  Environment ID: {environment.id}')

print(f'Creating agent (model={MODEL})...')
try:
    agent = client.beta.agents.create(
        name='Grace Hopper',
        model=MODEL,
        system=(
            'You are an autonomous software engineer. '
            'Each task specifies a workspace path — start your work there. '
            'The gh CLI is authenticated; use it to inspect CI, PRs, and issues. '
            'Never create a pull request yourself — the orchestration system handles that. '
            'Work autonomously to completion without asking for confirmation.'
        ),
        tools=[
            {
                'type': 'agent_toolset_20260401',
                'default_config': {'enabled': True},
            }
        ],
    )
except Exception as exc:
    print(f'ERROR: {exc}', file=sys.stderr)
    sys.exit(1)
print(f'  Agent ID: {agent.id}')

print()
print('─' * 60)
print('Step 1 — add these to your .env file:')
print()
print(f'ANTHROPIC_ENVIRONMENT_ID={environment.id}')
print(f'AGENT_ID={agent.id}')
print()
print('Step 2 — generate an environment key:')
print('  Go to https://console.anthropic.com → Environments → grace-hopper')
print('  Click "Generate environment key", then add to your .env:')
print()
print('ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-...')
print('─' * 60)
