#!/usr/bin/env bash
set -euo pipefail

required_vars=(
    ANTHROPIC_API_KEY
    GITHUB_TOKEN
    GITHUB_USERNAME
    GITHUB_REPO
    GITHUB_PROJECT_NUMBER
)
for var in "${required_vars[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: required environment variable $var is not set" >&2
        exit 1
    fi
done

source /app/scripts/setup_auth.sh

# Accept Claude Code's one-time trust prompt non-interactively
mkdir -p /home/agent/.claude
cat > /home/agent/.claude/settings.json <<'JSON'
{
  "dangerouslySkipPermissions": true
}
JSON

# Pull the latest ponytail on every startup and load it as global Claude context.
# We use CLAUDE.md rather than the plugin install because claude runs in -p
# (non-interactive) mode, which doesn't fire plugin lifecycle hooks.
PONYTAIL_DIR="/home/agent/.ponytail"
echo "Fetching latest ponytail..."
if [[ -d "$PONYTAIL_DIR/.git" ]]; then
    git -C "$PONYTAIL_DIR" pull --ff-only 2>&1 || true
else
    git clone --depth=1 https://github.com/DietrichGebert/ponytail.git "$PONYTAIL_DIR"
fi
cp "$PONYTAIL_DIR/AGENTS.md" /home/agent/.claude/CLAUDE.md

echo "Agent starting — polling every ${POLL_INTERVAL:-60}s"
exec python3 /app/scripts/poll_projects.py
