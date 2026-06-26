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

# Ensure dangerouslySkipPermissions is set without overwriting other prefs
# (theme choices etc. are stored here and should survive container restarts)
mkdir -p /home/agent/.claude
python3 - <<'PY'
import json, pathlib
f = pathlib.Path('/home/agent/.claude/settings.json')
s = json.loads(f.read_text()) if f.exists() else {}
s['dangerouslySkipPermissions'] = True
f.write_text(json.dumps(s, indent=2))
PY

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
