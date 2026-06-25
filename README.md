# Grace Hopper

An autonomous software engineering agent that runs on Docker. It watches a GitHub Projects v2 board for tickets, clones the relevant repository, implements the changes using Claude Code, and raises a pull request — all without human intervention.

## How it works

Every poll cycle Grace runs three sweeps:

**1. New tickets (Todo → In Progress)**
- Picks up tickets in the **Todo** column, moves them to **In Progress**, clones the repo, and creates a feature branch
- Claude Code implements the changes and commits them
- The branch is pushed, a PR is opened, the issue is commented with the PR link, and the ticket moves to **In Review**

**2. Interrupted tasks (In Progress, no active process)**
- If a task is still **In Progress** but the process died (crash, container restart), Grace detects the stale lockfile and resumes
- Claude is given the current git log, diff, and status so it can understand what was already done and continue from where it left off

**3. Failing CI (In Review → fix loop)**
- For every **In Review** ticket, Grace finds the open PR and checks for failing CI runs
- If CI is failing, it fetches the failure logs, checks out the branch, and asks Claude to fix the failures
- After pushing, CI reruns automatically; Grace keeps iterating until CI is green

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
│   ├── entrypoint.sh           # Startup: configures git/auth, fetches Ponytail, starts poller
│   ├── poll_projects.py        # Main polling loop (Todo / resume / CI fix)
│   ├── run_task.sh             # New ticket: clone → branch → Claude → push → PR
│   ├── resume_task.sh          # Interrupted task: checkout → summarise state → Claude → push → PR
│   └── fix_ci.sh               # Failing CI: fetch logs → Claude → push → rerun
├── workspaces/                 # Cloned repositories (Docker volume, gitignored)
└── state/                      # Dispatcher state, logs, lockfiles (Docker volume, gitignored)
```

## Stopping the agent

```bash
docker compose down
```

Workspaces and state are preserved in `./workspaces` and `./state` on the host.
