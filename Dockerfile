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

COPY requirements.txt /app/requirements.txt
RUN pip3 install --break-system-packages -r /app/requirements.txt

COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh /app/scripts/*.py

RUN mkdir -p /workspaces /app/state \
    && chown -R agent:agent /workspaces /app/state /app/scripts

USER agent
WORKDIR /workspaces

CMD ["/app/scripts/entrypoint.sh"]
