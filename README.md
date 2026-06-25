# Grace Hopper

An autonomous software engineering agent that runs on Docker. It watches a GitHub Projects v2 board for tickets, clones the relevant repository, implements the changes using Claude Code, and raises a pull request — all without human intervention.

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

## VS Code in the browser

Grace Hopper ships a `code-server` service that runs VS Code in the browser, sharing the same `workspaces/` volume as the agent. This lets you jump into any active workspace, inspect what the agent has done, and make changes in the exact same environment — same Node.js, Python, `gh` CLI, and git credentials.

Access it at `http://<your-vps>:8080` using the password set in `.env`.

```bash
# Set in .env before starting
CODE_SERVER_PASSWORD=your-strong-password
CODE_SERVER_PORT=8080   # optional, defaults to 8080
```

The agent's workspaces appear as folders inside the VS Code file explorer. You can open a terminal and run the same tools the agent uses (`gh`, `git`, `pytest`, etc.).

> **Security:** For a production VPS, put code-server behind a reverse proxy with TLS (nginx, Caddy, Traefik) rather than exposing port 8080 directly. Alternatively, bind to localhost and access via SSH tunnel: `ssh -L 8080:localhost:8080 user@your-vps`.

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

Task logs are written to `./state/logs/` and also stream to Docker logs:

```bash
docker compose logs -f
tail -f state/logs/issue-<number>-*.log   # new task
tail -f state/logs/ci-fix-pr<number>-*.log  # CI fix
tail -f state/logs/resume-issue-<number>-*.log  # resumed task
```

State files in `./state/`:

| File | Purpose |
|---|---|
| `dispatched.json` | Issue IDs that have been dispatched to avoid double-processing |
| `ci_dispatched.json` | `pr:sha` pairs already handled by the CI fix loop |
| `resumed.json` | `item:sha` pairs already resumed to avoid re-triggering |
| `active/issue-<N>.lock` | PID lockfiles for running task processes |

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
│   └── update_state.py         # CLI wrapper for state.py (called from worker.sh)
├── workspaces/                 # Cloned repositories (Docker volume, gitignored)
└── state/                      # Dispatcher state, logs, lockfiles (Docker volume, gitignored)
```

## Stopping the agent

```bash
docker compose down
```

Workspaces and state are preserved in `./workspaces` and `./state` on the host.
