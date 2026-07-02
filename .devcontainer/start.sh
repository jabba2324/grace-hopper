#!/usr/bin/env bash
# Starts the Grace Hopper agent processes in a Codespaces environment.
# Runs on every Codespace start (including resume from suspension).
# Equivalent to entrypoint.sh but backgrounded so VS Code can open.
set -euo pipefail

# GITHUB_TOKEN is provided automatically by Codespaces but is scoped to this repo only.
# GRACE_GITHUB_TOKEN should be a classic PAT with repo+project+workflow scopes — it
# overrides the auto-token for git auth and gh CLI so Grace can access all your repos.
export GITHUB_TOKEN="${GRACE_GITHUB_TOKEN:-$GITHUB_TOKEN}"
export GITHUB_USERNAME="${GH_USERNAME:-${GITHUB_USER:-}}"

echo "[grace-hopper] Setting up git auth..."
source /app/scripts/setup_auth.sh

echo "[grace-hopper] Fetching latest ponytail..."
PONYTAIL_DIR="/home/agent/.ponytail"
if [[ -d "$PONYTAIL_DIR/.git" ]]; then
    git -C "$PONYTAIL_DIR" pull --ff-only 2>&1 || true
else
    git clone --depth=1 https://github.com/DietrichGebert/ponytail.git "$PONYTAIL_DIR"
fi
mkdir -p /home/agent/.claude
cp "$PONYTAIL_DIR/AGENTS.md" /home/agent/.claude/CLAUDE.md

mkdir -p /app/state/active /app/state/logs

echo "[grace-hopper] Starting environment worker..."
nohup python3 /app/scripts/environment_worker.py >> /tmp/grace-env-worker.log 2>&1 &

echo "[grace-hopper] Starting project poller..."
nohup python3 /app/scripts/poll_projects.py >> /tmp/grace-poll.log 2>&1 &

echo "[grace-hopper] Agent running. Logs: /tmp/grace-*.log"
