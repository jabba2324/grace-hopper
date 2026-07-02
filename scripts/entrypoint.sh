#!/usr/bin/env bash
set -euo pipefail

required_vars=(
    ANTHROPIC_API_KEY
    ANTHROPIC_ENVIRONMENT_KEY
    ANTHROPIC_ENVIRONMENT_ID
    AGENT_ID
    GITHUB_TOKEN
    GH_USERNAME
)
for var in "${required_vars[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: required environment variable $var is not set" >&2
        exit 1
    fi
done

source /app/scripts/setup_auth.sh

# Pull the latest ponytail on every startup and load it as global Claude context.
PONYTAIL_DIR="/home/agent/.ponytail"
echo "Fetching latest ponytail..."
if [[ -d "$PONYTAIL_DIR/.git" ]]; then
    git -C "$PONYTAIL_DIR" pull --ff-only 2>&1 || true
else
    git clone --depth=1 https://github.com/DietrichGebert/ponytail.git "$PONYTAIL_DIR"
fi
mkdir -p /home/agent/.claude
cp "$PONYTAIL_DIR/AGENTS.md" /home/agent/.claude/CLAUDE.md

# Start the Managed Agents environment worker (handles bash/file tool calls).
echo "Starting environment worker..."
python3 /app/scripts/environment_worker.py &
ENV_WORKER_PID=$!

cleanup() {
    kill "$ENV_WORKER_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "Agent starting — polling every ${POLL_INTERVAL:-60}s"
exec python3 /app/scripts/poll_projects.py
