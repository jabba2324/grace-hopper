# Grace Hopper

An autonomous software engineering agent that watches GitHub Projects v2 boards for tickets, clones the relevant repositories, implements the changes using Claude, and raises pull requests — all without human intervention.

## How it works

Every poll cycle Grace scans all board items and responds to their state:

**Todo** → clone the repo, create a branch, run Claude, push, open a PR, move to **In Progress → In Review**

**In Progress (idle)** → task was interrupted; Grace resumes it on the same branch with a summary of what was already done

**In Review (CI failing)** → fetch the failure logs, run Claude to fix them, push, CI reruns. Grace iterates until CI is green.

---

## Setup

Grace Hopper runs in two modes — pick one:

| | Local (self-hosted) | GitHub Codespaces |
|---|---|---|
| **VS Code** | code-server in browser (`localhost:8080`) | Native Codespaces VS Code |
| **Agent** | Docker Compose | Background process in the Codespace |
| **Secrets** | `.env` file | Codespaces Secrets in GitHub settings |
| **Best for** | VPS, home server, always-on | Occasional use, no infrastructure |

---

## Option A — Local (Docker Compose)

### Prerequisites

- Docker and Docker Compose
- A GitHub Personal Access Token (classic)
- An Anthropic API key
- A GitHub Projects v2 board with a **Status** single-select field

### 1. Clone and configure

```bash
git clone https://github.com/jabba2324/grace-hopper
cd grace-hopper
cp .env.example .env
```

Edit `.env` — see [Environment variables](#environment-variables) below.

### 2. GitHub Token

Create a **classic** Personal Access Token at `github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)`.

Required scopes:

| Scope | Purpose |
|---|---|
| `repo` | Clone repositories, push branches, open PRs |
| `project` | Read and update project board status |
| `workflow` | Push branches containing GitHub Actions workflows |

> Fine-grained tokens do not support GitHub Projects v2.

### 3. Managed Agents setup

Grace uses the [Anthropic Managed Agents API](https://docs.anthropic.com/en/docs/agents) to run Claude sessions. Run the setup script once to create an agent and environment:

```bash
pip install anthropic
ANTHROPIC_API_KEY=your-key python3 scripts/setup_agent.py
```

Copy the output values (`AGENT_ID`, `ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_ENVIRONMENT_KEY`) into `.env`.

### 4. Build and run

```bash
docker compose up -d --build
docker compose logs -f
```

### 5. Add repositories

Open `http://localhost:8080`, then open the **Grace Hopper** panel in the activity bar.

Click **+** and follow the three-step flow:
1. Select a GitHub repository
2. Select the project board linked to it
3. Map the board's Status column names to Grace's three roles (Todo / In Progress / In Review)

---

## Option B — GitHub Codespaces

No infrastructure needed. The agent runs as a background process inside the Codespace, and the Grace Hopper extension appears in the native Codespaces VS Code sidebar.

### 1. Set Codespaces Secrets

Go to `github.com → Settings → Codespaces → Secrets` and add each secret below. When creating each one, set **Repository access** to include this repository (or "All repositories").

| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_ENVIRONMENT_KEY` | Managed Agents environment key (`sk-ant-oat01-...`) |
| `ANTHROPIC_ENVIRONMENT_ID` | Managed Agents environment ID (`env_...`) |
| `AGENT_ID` | Managed Agents agent ID (`agent_...`) |
| `GH_USERNAME` | Your GitHub username — note: GitHub blocks secrets named `GITHUB_*`, so use `GH_USERNAME` here |

> `GITHUB_TOKEN` is provided automatically by Codespaces — you do not need to set it.

If you haven't run the Managed Agents setup yet, see [step 3 above](#3-managed-agents-setup).

### 2. Open a Codespace

On the repository page, click **Code → Codespaces → Create codespace on main**.

On first launch, Codespaces will:
- Pull the pre-built `grace-hopper` image from GHCR
- Install the Grace Hopper VS Code extension into the sidebar
- Start `poll_projects.py` and `environment_worker.py` in the background

> The GHCR image is rebuilt automatically on every push to `main` via the included GitHub Actions workflow.

### 3. Add repositories

Open the **Grace Hopper** panel in the VS Code activity bar and click **+** — same flow as the local setup.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `ANTHROPIC_ENVIRONMENT_KEY` | Yes | Managed Agents environment key |
| `ANTHROPIC_ENVIRONMENT_ID` | Yes | Managed Agents environment ID |
| `AGENT_ID` | Yes | Managed Agents agent ID |
| `GITHUB_TOKEN` | Yes | Classic PAT with `repo` + `project` + `workflow` scopes |
| `GITHUB_USERNAME` | Yes | Your GitHub username |
| `CLAUDE_MODEL` | No | Model to use (default: `claude-opus-4-8`) |
| `PONYTAIL_DEFAULT_MODE` | No | Ponytail mode: `lite`, `full` (default), `ultra`, `off` |
| `POLL_INTERVAL` | No | Seconds between board checks (default: `5`) |
| `CODE_SERVER_PASSWORD` | No | Password for the browser VS Code UI (default: `changeme`) — local only |
| `CODE_SERVER_PORT` | No | Port for the browser VS Code UI (default: `8080`) — local only |
| `GIT_AUTHOR_NAME` | No | Git commit author name (default: `Agent`) |
| `GIT_AUTHOR_EMAIL` | No | Git commit author email |

---

## Grace Hopper extension

The extension provides a live task panel in the VS Code activity bar, available in both local (code-server) and Codespaces modes.

**What it shows:**
- Monitored repositories as top-level nodes, each showing task count and **total token spend**
- Tasks grouped under their repository, sorted by status
- Per-task details: ticket, branch, PR, workspace path, **live token cost**, timestamps

**Inline controls:**
- **Pause** — gracefully stops the Claude session; task can be resumed
- **Resume / Retry** — re-dispatches the task on the next poll
- **Watch (✦)** — opens an interactive Claude session resuming from the agent's last conversation
- **− (Remove)** on a repository node — stops monitoring that repo

**Panel toolbar:**
- **+ (Add Repository)** — guided setup: pick repo, pick project board, map Status columns
- **Rebuild State** — reconciles `tasks.json` against the live GitHub board
- **Refresh** — manually re-reads `tasks.json`

The panel auto-refreshes every 2 seconds. Token spend updates live while a task is running.

### Token spend

Grace tracks input and output token usage per task via the Managed Agents API and displays the dollar cost inline:

- **Per task**: `In Progress · $0.42` shown in the task row
- **Per repo**: `project #2 · 18 tasks · $12.50` rolled up in the repo row
- **Expanded view**: `Cost: $0.42 · 180k in / 42k out`

Costs are calculated client-side using Anthropic's published per-model rates. Previously completed sessions are backfilled automatically on the next poll cycle.

---

## Human handoff

Clicking **✦** on any task:
1. Reloads VS Code into the task's workspace folder
2. Opens a terminal with `claude --resume <session-id>` if history exists, or plain `claude` for a fresh session

Grace writes `.claude/CLAUDE.md` to the workspace root at the start and end of every run containing: the original issue goal, current branch and PR link, all commits on the branch, files changed, and uncommitted work. This gives full context without replaying conversation history.

Conversation history is persisted in `./claude-home/` (local) or `~/.claude/` (Codespaces). The agent and VS Code share the same Claude state — history written by an agent run is readable from an interactive developer session.

---

## Ponytail

Grace uses [Ponytail](https://github.com/DietrichGebert/ponytail) to enforce a "lazy senior developer" philosophy on every task. On each startup, the agent pulls the latest Ponytail and writes its instruction set to `~/.claude/CLAUDE.md`, which Claude reads as global context.

The coding ladder (in priority order):
1. Skip — do nothing if it doesn't need code
2. Reuse — use something that already exists
3. Standard library
4. Native platform feature
5. Existing dependency
6. One-liner
7. Minimal new code as a last resort

---

## Project board setup

Your GitHub Projects v2 board needs a **Status** single-select field with three columns representing the todo, in-progress, and in-review stages. The column names can be anything — you map them to Grace's roles when adding the repo in the VS Code panel.

Write issues clearly — the title and body are passed directly to Claude as the task goal.

---

## Logs and state

```bash
# Local
docker compose logs -f
tail -f state/logs/issue-<N>.log
```

```bash
# Codespaces
tail -f /tmp/grace-poll.log
tail -f /tmp/grace-env-worker.log
tail -f /app/state/logs/issue-<N>.log
```

State directory (`./state/` local, `/app/state/` Codespaces):

| File / Directory | Purpose |
|---|---|
| `repos.json` | Monitored repos and project boards — written by the extension |
| `tasks.json` | Single source of truth for all task status, tokens, and metadata |
| `active/issue-<N>.lock` | Lock file while a worker is running |
| `logs/` | Per-task log files |

---

## Repository layout

```
.
├── Dockerfile                  # Ubuntu 24.04 + Node 22 + Python + gh CLI + Claude
├── docker-compose.yml          # Local: code-server + agent services
├── .devcontainer/
│   ├── devcontainer.json       # Codespaces config: GHCR image + extension install
│   └── start.sh                # Codespaces startup: auth + Ponytail + agent processes
├── .github/
│   └── workflows/
│       └── publish.yml         # Builds and pushes image to GHCR on push to main
├── requirements.txt
├── scripts/
│   ├── setup_auth.sh           # Shared git/gh auth setup
│   ├── entrypoint.sh           # Local agent startup
│   ├── code_server.sh          # Local code-server startup
│   ├── setup_agent.py          # One-time Managed Agents setup
│   ├── poll_projects.py        # Main polling loop
│   ├── worker.py               # Task worker (new / resume / ci-fix modes)
│   ├── environment_worker.py   # Managed Agents environment worker
│   ├── github.py               # GitHub API helpers
│   ├── state.py                # tasks.json read/write
│   ├── rebuild_state.py        # Reconcile tasks.json against GitHub
│   └── attach_session.py       # Interactive Claude session attachment
├── extension/                  # Grace Hopper VS Code extension source
├── workspaces/                 # Cloned repos (gitignored)
├── state/                      # Task state, logs, lockfiles (gitignored)
└── claude-home/                # Shared ~/.claude (gitignored)
```

---

## Stopping

```bash
# Local
docker compose down
```

Workspaces, state, and Claude conversation history are preserved in `./workspaces`, `./state`, and `./claude-home` across restarts.

For Codespaces, stopping or deleting the Codespace does not affect any repositories or PRs Grace has already created.
