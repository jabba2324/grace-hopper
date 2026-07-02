FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl wget git python3 python3-pip python3-venv \
    build-essential ca-certificates gnupg lsb-release \
    jq unzip zip openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Non-root user that Claude Code requires for --dangerously-skip-permissions
RUN useradd -m -s /bin/bash agent

# Bun (installed as agent user)
USER agent
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/agent/.bun/bin:$PATH"
USER root

# Claude Code (global, accessible to agent user)
RUN npm install -g @anthropic-ai/claude-code

# code-server — VS Code in the browser
RUN curl -fsSL https://code-server.dev/install.sh | sh \
    && rm -rf /usr/lib/code-server/lib/vscode/extensions/copilot

COPY requirements.txt /app/requirements.txt
RUN pip3 install --break-system-packages -r /app/requirements.txt

COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh /app/scripts/*.py

COPY extension/ /app/extension/

RUN mkdir -p /workspaces /app/state /home/agent/.claude \
    && chown -R agent:agent /workspaces /app/state /app/scripts /app/extension /home/agent/.claude

USER agent
WORKDIR /workspaces

# Build and pre-install the Grace Hopper VS Code extension.
# VSIX is kept at /home/agent/grace-hopper.vsix so Codespaces can install it too.
RUN cd /app/extension \
    && npm install \
    && npm run compile \
    && npx vsce package --no-dependencies -o /home/agent/grace-hopper.vsix \
    && code-server --install-extension /home/agent/grace-hopper.vsix

CMD ["/app/scripts/entrypoint.sh"]
