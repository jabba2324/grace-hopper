# Grace Hopper

An autonomous software engineering agent that runs on docker. It watches a GitHub Projects v2 board for tickets, clones the relevant repository, implements the changes using Claude Code, and raises a pull request — all without human intervention.

## How it works

1. A ticket is created (or moved to **Todo**) on your GitHub project board
2. The agent picks it up within the poll interval, moves it to **In Progress**, and clones the repository
3. Claude Code works autonomously to implement the changes and commit them
4. The agent pushes the branch, opens a pull request, and comments on the issue with the PR link
5. The ticket is moved to **In Review**

## Prerequisites

- Docker and Docker Compose
- A [GitHub Personal Access Token](#github-token) (classic)
- An [Anthropic API key](https://console.anthropic.com)
- A GitHub Projects v2 board linked to a repository, with a **Status** field containing at minimum: `Todo`, `In Progress`, `In Review`

## Setup

### 1. Clone and configure

```bash
git clone <this-repo>
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
| `GITHUB_TOKEN` | Yes | Classic PAT with `repo` + `project` scopes |
| `GITHUB_USERNAME` | Yes | Your GitHub username |
| `GITHUB_REPO` | Yes | Repository linked to the project board (`owner/repo`) |
| `GITHUB_PROJECT_NUMBER` | Yes | Project number from the board URL |
| `CLAUDE_MODEL` | No | Model to use (default: `claude-sonnet-4-6`) |
| `PROJECT_STATUS_TODO` | No | Name of the "todo" column (default: `Todo`) |
| `PROJECT_STATUS_IN_PROGRESS` | No | Name of the "in progress" column (default: `In Progress`) |
| `PROJECT_STATUS_IN_REVIEW` | No | Name of the "in review" column (default: `In Review`) |
| `POLL_INTERVAL` | No | Seconds between board checks (default: `60`) |
| `GIT_AUTHOR_NAME` | No | Git commit author name (default: `Agent`) |
| `GIT_AUTHOR_EMAIL` | No | Git commit author email |

### Choosing a model

Set `CLAUDE_MODEL` in `.env` to balance cost and capability:

| Model | Best for |
|---|---|
| `claude-haiku-4-5-20251001` | Simple tasks, test coverage, documentation |
| `claude-sonnet-4-6` | Most coding tasks (default) |
| `claude-opus-4-8` | Complex architecture, security audits |

## Project board setup

Your GitHub Projects v2 board must have a **Status** single-select field. The agent expects these columns to exist (names are configurable via `.env`):

```
Todo → In Progress → In Review
```

The agent reads the ticket title and body as the task description, so write your issues clearly — they are passed directly to Claude as the goal.

## Ponytail integration

Grace Hopper uses [Ponytail](https://github.com/DietrichGebert/ponytail) to enforce a "lazy senior developer" philosophy on every task — favouring the simplest solution that works over unnecessary abstraction or verbosity.

On each container start, the agent pulls the latest Ponytail from GitHub and writes its instruction set (`AGENTS.md`) to `~/.claude/CLAUDE.md`. Claude Code reads this file as global context in every session, including non-interactive (`-p`) mode, so the Ponytail decision ladder is always active without any plugin installation or slash commands.

The coding ladder Ponytail enforces (in priority order):

1. Skip — do nothing if the problem doesn't need code
2. Reuse — use something that already exists
3. Standard library — prefer built-ins
4. Native platform feature
5. Existing dependency
6. One-liner
7. Minimal new code as a last resort

Set `PONYTAIL_DEFAULT_MODE` in `.env` to adjust enforcement: `lite`, `full` (default), or `ultra`.

## Logs

Task logs are written to `./state/logs/issue-<number>-<timestamp>.log` and also stream to Docker logs:

```bash
docker compose logs -f
tail -f state/logs/issue-1-*.log
```

## Repository layout

```
.
├── Dockerfile              # Ubuntu 24.04 + Node 22 + Python + gh CLI + Claude Code
├── docker-compose.yml
├── requirements.txt        # Python deps for the poller
├── scripts/
│   ├── entrypoint.sh       # Container startup: configures git/auth, starts poller
│   ├── poll_projects.py    # GitHub Projects v2 poller
│   └── run_task.sh         # Per-issue: clone → branch → Claude → push → PR
├── workspaces/             # Cloned repositories (Docker volume, gitignored)
└── state/                  # Dispatcher state and task logs (Docker volume, gitignored)
```

## Stopping the agent

```bash
docker compose down
```

Workspaces and state are preserved in `./workspaces` and `./state` on the host.
