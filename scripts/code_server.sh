#!/usr/bin/env bash
set -euo pipefail

source /app/scripts/setup_auth.sh

mkdir -p /home/agent/.config/code-server
cat > /home/agent/.config/code-server/config.yaml <<YAML
bind-addr: 0.0.0.0:8080
auth: password
password: ${CODE_SERVER_PASSWORD}
cert: false
YAML

echo "Installing extensions..."
code-server --install-extension anthropic.claude-code 2>&1 || true

echo "code-server starting on port 8080"
exec code-server /workspaces
