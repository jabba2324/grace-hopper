# 🤖 Grace Hopper

A platform for running and collaborating with autonomous software engineering agents. Grace watches GitHub Projects v2 boards, picks up tickets, and works through them — cloning repos, writing code, opening PRs, and iterating on CI failures — while keeping developers in control at every step.

The VS Code extension gives you a live view of every agent session across every repository. Pause a task, jump into its workspace and conversation context to steer it yourself, then hand it back. Multiple developers on the same team can share a single agent — anyone can pick up a paused session, review what the agent did, and resume from exactly where it left off.

---

## ✨ How it works

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GitHub Projects v2                           │
│                                                                     │
│   📋 Todo          ⚙️  In Progress         🔍 In Review            │
│  ┌─────────┐      ┌─────────────┐        ┌──────────────┐         │
│  │ Issue   │─────▶│  Agent      │───PR──▶│  CI checks   │         │
│  │ #42     │      │  working... │        │  running...  │         │
│  └─────────┘      └─────────────┘        └──────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
         │                  │                       │
         ▼                  ▼                       ▼
   Grace picks up     Streams events          Watches CI,
   the ticket,        to VS Code              fetches logs,
   clones repo,       extension               fixes failures
   starts Claude                              automatically


  👨‍💻 Developer                    🤝 Handoff
  ┌──────────────────┐            ┌──────────────────────────────┐
  │  Grace Hopper    │  Pause ──▶ │  claude --resume <session>   │
  │  VS Code Panel   │            │  Full conversation history    │
  │                  │  ◀── Hand  │  Same branch, same context   │
  │  ● repo-a  $4.20 │    back    └──────────────────────────────┘
  │    ⚙ issue #42   │
  │    ✓ issue #38   │  Any developer on the team can jump in,
  │  ● repo-b  $1.80 │  redirect, or complete the task — then
  │    ⚙ issue #11   │  hand it back for Grace to continue.
  └──────────────────┘
```

Every poll cycle Grace scans all board items and responds to their state:

- 📋 **Todo** → clone the repo, create a branch, run Claude, push, open a PR, move to **In Progress**
- ⚙️ **In Progress (idle)** → task was interrupted; Grace resumes it on the same branch with a full summary of what was already done
- 🔍 **In Review (CI failing)** → fetch the failure logs, run Claude to fix them, push, CI reruns. Grace iterates until CI is green.

The board is the interface. Move a card to **Todo** to assign it to Grace; move it back or pause it in the extension to take over. The agent and your developers share the same Claude conversation history — there's no context boundary between agent work and human work.

---

## 🚀 Setup

Grace Hopper runs in two modes — pick one:

| | 🐳 Docker | ☁️ GitHub Codespaces |
|---|---|---|
| **VS Code** | code-server in browser (`localhost:8080`) | Native Codespaces VS Code |
| **Agent** | Docker Compose | Background process in the Codespace |
| **Secrets** | `.env` file | Codespaces Secrets in GitHub settings |
| **Best for** | Self/cloud hosted, always-on | Occasional use, no infrastructure |

---

## Option A — 🐳 Local (Docker Compose)

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

Edit `.env` — see [Environment variables](#-environment-variables) below.

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

## Option B — ☁️ GitHub Codespaces

No infrastructure needed. The agent runs as a background process inside the Codespace, and the Grace Hopper extension appears in the native Codespaces VS Code sidebar.

### 1. Set Codespaces Secrets

Go to `github.com → Settings → Codespaces → Secrets` and add each secret below. When creating each one, set **Repository access** to include this repository (or "All repositories").

| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_ENVIRONMENT_KEY` | Managed Agents environment key (`sk-ant-oat01-...`) |
| `ANTHROPIC_ENVIRONMENT_ID` | Managed Agents environment ID (`env_...`) |
| `AGENT_ID` | Managed Agents agent ID (`agent_...`) |
| `GH_TOKEN` | Classic PAT with `repo` + `project` + `workflow` scopes. Codespaces auto-provides `GITHUB_TOKEN` but it's scoped to this repo only — Grace needs this to access all your repositories |
| `GH_USERNAME` | Your GitHub username — note: GitHub blocks secrets named `GITHUB_*`, so use `GH_USERNAME` here |

> Codespaces auto-provides `GITHUB_TOKEN` but it only covers the current repo. `GH_TOKEN` overrides it so Grace can clone, push, and manage PRs across all your repos.

If you haven't run the Managed Agents setup yet, see [step 3 above](#3-managed-agents-setup).

### 2. Open a Codespace

On the repository page, click **Code → Codespaces → Create codespace on main**.

On first launch, Codespaces will:
- Pull the pre-built `grace-hopper` image from GHCR
- Activate the Grace Hopper VS Code extension in the sidebar
- Start `poll_projects.py` and `environment_worker.py` in the background

> The GHCR image is rebuilt automatically on every push to `main` via the included GitHub Actions workflow.

### 3. Add repositories

Open the **Grace Hopper** panel in the VS Code activity bar and click **+** — same flow as the local setup.

---

## 🔧 Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `ANTHROPIC_ENVIRONMENT_KEY` | Yes | Managed Agents environment key |
| `ANTHROPIC_ENVIRONMENT_ID` | Yes | Managed Agents environment ID |
| `AGENT_ID` | Yes | Managed Agents agent ID |
| `GH_TOKEN` | Yes | Classic PAT with `repo` + `project` + `workflow` scopes |
| `GH_USERNAME` | Yes | Your GitHub username |
| `CLAUDE_MODEL` | No | Model to use (default: `claude-opus-4-8`) |
| `PONYTAIL_DEFAULT_MODE` | No | Ponytail mode: `lite`, `full` (default), `ultra`, `off` |
| `POLL_INTERVAL` | No | Seconds between board checks (default: `5`) |
| `CODE_SERVER_PASSWORD` | No | Password for the browser VS Code UI (default: `changeme`) — local only |
| `CODE_SERVER_PORT` | No | Port for the browser VS Code UI (default: `8080`) — local only |
| `GIT_AUTHOR_NAME` | No | Git commit author name (default: `Agent`) |
| `GIT_AUTHOR_EMAIL` | No | Git commit author email |

---

## 🧩 Grace Hopper extension

The extension is the control plane for all agent sessions. It runs in VS Code — both local (code-server) and Codespaces — and gives any developer on the team a live view of what every agent is doing across every monitored repository.

### Finding the panel

Look for the robot icon in the VS Code activity bar (the vertical icon strip on the left):

<img src="extension/media/icon.svg" width="48" alt="Grace Hopper icon" />

Click it to open the **Grace Hopper** panel. If you don't see it, make sure the extension is installed — in Codespaces it activates automatically; locally it's built into the Docker image and served via code-server.

### Adding your first repository

Click the **＋** button in the panel toolbar and follow the three-step flow:

```
Step 1 — Pick a GitHub repository
         ↓
Step 2 — Pick the GitHub Projects v2 board linked to it
         ↓
Step 3 — Map your board's Status column names to Grace's three roles:
         [ Todo column ]  →  Grace picks up new tickets
         [ In Progress ]  →  Grace is working / can be resumed
         [ In Review   ]  →  Grace watches CI and fixes failures
```

Once added, the repo appears as a top-level node in the panel and Grace starts polling immediately.

**What it shows:**
- 📁 Monitored repositories as top-level nodes, each showing task count and **total token spend**
- ✅ Tasks grouped under their repository, sorted by status
- 🔍 Per-task details: ticket, branch, PR, workspace path, **live token cost**, timestamps

**Inline controls:**
- ⏸️ **Pause** — gracefully stops the Claude session; the task stays on the board and can be resumed by anyone
- ▶️ **Resume / Retry** — re-dispatches the task on the next poll
- ✦ **Watch** — loads the task's workspace and opens an interactive `claude --resume` session with the full agent conversation history; pick up exactly where the agent left off
- **−** on a repository node — stops monitoring that repo

**Panel toolbar:**
- ➕ **Add Repository** — guided setup: pick repo, pick project board, map Status columns
- 🔄 **Rebuild State** — reconciles `tasks.json` against the live GitHub board
- **Refresh** — manually re-reads `tasks.json`

The panel auto-refreshes every 2 seconds. Token spend updates live while a task is running.

### 👥 Multi-developer workflow

Because agent conversation history is stored in the shared workspace, any developer with access to the same Grace Hopper instance can:

- 👀 **Monitor** all active agent sessions from their own VS Code
- ⏸️ **Pause** a task and **jump in** via Watch (✦) to review, redirect, or complete it themselves
- 🔁 **Hand back** by closing the session — Grace will resume automatically on the next poll
- 🤝 **Share context** across the team without handing off files or summarising — the agent's full reasoning is there in the conversation history

This makes Grace a natural fit for small teams: a developer can review the agent's approach mid-task, course-correct, and let the agent carry on — or take it to the finish line themselves.

### 💰 Token spend

Grace tracks input and output token usage per task via the Managed Agents API and displays the dollar cost inline:

- **Per task**: `In Progress · $0.42` shown in the task row
- **Per repo**: `project #2 · 18 tasks · $12.50` rolled up in the repo row
- **Expanded view**: `Cost: $0.42 · 180k in / 42k out`

Costs are calculated client-side using Anthropic's published per-model rates. Previously completed sessions are backfilled automatically on the next poll cycle.

---

## 🤝 Human handoff

Clicking **✦** on any task:
1. Reloads VS Code into the task's workspace folder
2. Opens a terminal with `claude --resume <session-id>` — the full agent conversation history is available, so you land in context immediately

Grace writes `.claude/CLAUDE.md` to the workspace root at the start and end of every run containing: the original issue goal, current branch and PR link, all commits on the branch, files changed, and uncommitted work. This gives full context without replaying conversation history.

Conversation history is persisted in `./claude-home/` (local) or `~/.claude/` (Codespaces). The agent and VS Code share the same Claude state — history written by an agent run is readable from an interactive developer session.

---

## 🐴 Ponytail

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

## 📋 Project board setup

Your GitHub Projects v2 board needs a **Status** single-select field with three columns representing the todo, in-progress, and in-review stages. The column names can be anything — you map them to Grace's roles when adding the repo in the VS Code panel.

Write issues clearly — the title and body are passed directly to Claude as the task goal.

---

## 📊 Logs and state

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

## 📁 Repository layout

```
.
├── Dockerfile                  # Ubuntu 24.04 + Node 22 + Python + gh CLI + Claude
├── docker-compose.yml          # Local: code-server + agent services
├── .devcontainer/
│   ├── devcontainer.json       # Codespaces config: GHCR image + extension install
│   └── start.sh                # Startup: auth + Ponytail + agent processes
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

## ⏹️ Stopping

```bash
# Local
docker compose down
```

Workspaces, state, and Claude conversation history are preserved in `./workspaces`, `./state`, and `./claude-home` across restarts.

For Codespaces, stopping or deleting the Codespace does not affect any repositories or PRs Grace has already created.
