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

# Disable built-in VS Code Chat / Copilot UI (baked into VS Code 1.90+)
mkdir -p /home/agent/.local/share/code-server/User
cat > /home/agent/.local/share/code-server/User/settings.json <<'JSON'
{
    "chat.enabled": false,
    "workbench.panel.chat.enabled": false,
    "inlineChat.enabled": false
}
JSON

echo "code-server starting on port 8080"
exec code-server /workspaces
