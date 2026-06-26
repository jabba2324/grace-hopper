# Grace Hopper

An autonomous software engineering agent that runs on Docker. It watches a GitHub Projects v2 board for tickets, clones the relevant repository, implements the changes using Claude Code, and raises a pull request — all without human intervention.

Runs anywhere Docker runs: your laptop, a VPS, a cloud VM, or CI.

## How it works

Every poll cycle Grace scans all board items and responds to their state:

**Todo** → clone the repo, create a branch, run Claude, push, open a PR, move to **In Progress → In Review**

**In Progress (no active process)** → task was interrupted; Grace resumes it by checking out the branch and giving Claude a summary of what was already done

**In Review (CI failing)** → fetch the failure logs, run Claude to fix them, push, CI reruns automatically. Grace keeps iterating until CI is green.

## Prerequisites

- Docker and Docker Compose
- A [GitHub Personal Access Token](#github-token) (classic)
- An [Anthropic API key](https://console.anthropic.com)
- A GitHub Projects v2 board linked to a repository, with a **Status** field containing: `Todo`, `In Progress`, `In Review`

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/jabba2324/grace-hopper
cd grace-hopper
cp .env.example .env
```

Edit `.env` with your credentials (see [Configuration](#configuration) below).

### 2. GitHub Token

Create a **classic** Personal Access Token at `github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)`.

Required scopes:

| Scope | Purpose |
|---|---|
| `repo` | Clone repositories, push branches, open PRs |
| `project` | Read and update project board status |
| `workflow` | Push branches that contain GitHub Actions workflows |

> Fine-grained tokens do not support GitHub Projects v2 and will not work.

### 3. Build and run

```bash
docker compose up -d --build
docker compose logs -f
```

## Configuration

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `GITHUB_TOKEN` | Yes | Classic PAT with `repo` + `project` + `workflow` scopes |
| `GITHUB_USERNAME` | Yes | Your GitHub username |
| `GITHUB_REPO` | Yes | Repository linked to the project board (`owner/repo`) |
| `GITHUB_PROJECT_NUMBER` | Yes | Project number from the board URL |
| `CLAUDE_MODEL` | No | Model to use (default: `claude-sonnet-4-6`) |
| `PONYTAIL_DEFAULT_MODE` | No | Ponytail mode: `lite`, `full` (default), `ultra`, `off` |
| `PROJECT_STATUS_TODO` | No | Name of the todo column (default: `Todo`) |
| `PROJECT_STATUS_IN_PROGRESS` | No | Name of the in-progress column (default: `In Progress`) |
| `PROJECT_STATUS_IN_REVIEW` | No | Name of the in-review column (default: `In Review`) |
| `POLL_INTERVAL` | No | Seconds between board checks (default: `60`) |
| `CODE_SERVER_PASSWORD` | No | Password for the VS Code browser UI (default: `changeme`) |
| `CODE_SERVER_PORT` | No | Port for the VS Code browser UI (default: `8080`) |
| `GIT_AUTHOR_NAME` | No | Git commit author name (default: `Agent`) |
| `GIT_AUTHOR_EMAIL` | No | Git commit author email |

### Choosing a model

| Model | Best for |
|---|---|
| `claude-haiku-4-5-20251001` | Simple tasks, test coverage, documentation |
| `claude-sonnet-4-6` | Most coding tasks (default) |
| `claude-opus-4-8` | Complex architecture, security audits |

## Project board setup

Your GitHub Projects v2 board must have a **Status** single-select field with at least these columns (names are configurable via `.env`):

```
Todo → In Progress → In Review
```

Write issues clearly — the title and body are passed directly to Claude as the task goal.

## VS Code

Grace Hopper ships two ways to interact with the agent from VS Code.

### Browser UI (code-server)

The `code-server` service runs VS Code in the browser, sharing the same `workspaces/` volume as the agent. When running locally, access it at:

```
http://localhost:8080
```

Use the password set in `CODE_SERVER_PASSWORD` in your `.env`.

The agent's workspaces appear as folders in the file explorer. You can open a terminal and run the same tools the agent uses (`gh`, `git`, `pytest`, etc.).

> **Running on a remote machine?** Either bind to localhost and SSH tunnel (`ssh -L 8080:localhost:8080 user@host`), or put code-server behind a reverse proxy with TLS (nginx, Caddy, Traefik) rather than exposing port 8080 directly.

### Grace Hopper extension

The Grace Hopper VS Code extension is automatically installed in code-server and provides a live task panel in the VS Code activity bar.

**What it shows:**
- All tasks from the project board, sorted by status
- Per-task details: ticket link, branch, PR link, workspace path, log file

**Inline controls on each task row:**
- **Pause** (running tasks) — gracefully stops the Claude process; task can be resumed
- **Resume** (paused or failed tasks) — re-dispatches the task from where it left off
- **Tail Logs** — opens a live log stream for that task in an output panel

**Panel toolbar:**
- **Rebuild State** — reconciles `tasks.json` against the live GitHub board, correcting any stale or mismatched statuses
- **Refresh** — manually re-reads `tasks.json`

The panel auto-refreshes every 5 seconds and watches for lock file changes so running/stale status updates appear immediately.

## Ponytail integration

Grace Hopper uses [Ponytail](https://github.com/DietrichGebert/ponytail) to enforce a "lazy senior developer" philosophy on every task — favouring the simplest solution that works over unnecessary abstraction or verbosity.

On each container start, the agent pulls the latest Ponytail from GitHub and writes its instruction set (`AGENTS.md`) to `~/.claude/CLAUDE.md`. Claude Code reads this file as global context in every session, so the Ponytail decision ladder is always active without any plugin installation or slash commands.

The coding ladder Ponytail enforces (in priority order):

1. Skip — do nothing if the problem doesn't need code
2. Reuse — use something that already exists
3. Standard library — prefer built-ins
4. Native platform feature
5. Existing dependency
6. One-liner
7. Minimal new code as a last resort

## Logs and state

Task logs are written to `./state/logs/` and stream to Docker logs:

```bash
docker compose logs -f
tail -f state/logs/new-issue-<N>-*.log      # new task
tail -f state/logs/resume-issue-<N>-*.log   # resumed task
tail -f state/logs/ci-fix-issue-<N>-*.log   # CI fix
```

State in `./state/`:

| File / Directory | Purpose |
|---|---|
| `tasks.json` | Single source of truth — status for every task, updated by the poller and worker |
| `active/issue-<N>.lock` | Lock file written while a worker is running; used to detect live vs. stale processes |
| `logs/` | Per-task log files |

## Repository layout

```
.
├── Dockerfile                  # Ubuntu 24.04 + Node 22 + Python + gh CLI + Claude Code
├── docker-compose.yml
├── requirements.txt
├── scripts/
│   ├── setup_auth.sh           # Shared git/gh auth setup (sourced by both services)
│   ├── entrypoint.sh           # Agent startup: auth + Ponytail + poller
│   ├── code_server.sh          # code-server startup: auth + VS Code web server
│   ├── poll_projects.py        # Single polling loop — handles Todo/In Progress/In Review
│   ├── worker.sh               # Unified worker: TASK_MODE=new|resume|ci-fix
│   ├── state.py                # tasks.json read/write module
│   ├── update_state.py         # CLI wrapper for state.py (called from worker.sh)
│   └── rebuild_state.py        # Reconciles tasks.json against live GitHub board (used by VS Code extension)
├── extension/                  # Grace Hopper VS Code extension (auto-installed in code-server)
├── workspaces/                 # Cloned repositories (Docker volume, gitignored)
└── state/                      # Task state, logs, lockfiles (Docker volume, gitignored)
```

## Stopping the agent

```bash
docker compose down
```

Workspaces and state are preserved in `./workspaces` and `./state` on the host.
