#!/usr/bin/env bash
# Fixes failing CI on an existing PR branch.
# Expected env vars (set by poll_projects.py):
#   REPO_NAME_WITH_OWNER, ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY,
#   PR_NUMBER, PR_BRANCH, FAILED_RUN_ID
set -euo pipefail

LOG_DIR="/app/state/logs"
LOCK_DIR="/app/state/active"
mkdir -p "$LOG_DIR" "$LOCK_DIR"
LOGFILE="$LOG_DIR/ci-fix-pr${PR_NUMBER}-$(date +%Y%m%d-%H%M%S).log"
LOCKFILE="$LOCK_DIR/issue-${ISSUE_NUMBER}.lock"

log() { echo "$*" | tee -a "$LOGFILE"; }

save_state() {
    TASK_ISSUE_NUMBER="${ISSUE_NUMBER:-0}" \
    TASK_TYPE="ci-fix" \
    TASK_STATUS="${1}" \
    TASK_TITLE="${ISSUE_TITLE:-PR #${PR_NUMBER}}" \
    TASK_REPO="${REPO_NAME_WITH_OWNER:-}" \
    TASK_PR_BRANCH="${PR_BRANCH:-}" \
    TASK_WORKSPACE="${WORKSPACE:-}" \
    TASK_LOG="$LOGFILE" \
    TASK_PID="${2:-}" \
    TASK_PR_NUMBER="${PR_NUMBER:-}" \
    TASK_PR_URL="https://github.com/${REPO_NAME_WITH_OWNER}/pull/${PR_NUMBER}" \
    TASK_FAILED_RUN_ID="${FAILED_RUN_ID:-}" \
    python3 /app/scripts/update_state.py 2>/dev/null || true
}

echo $$ > "$LOCKFILE"
trap "save_state failed; rm -f '$LOCKFILE'" EXIT

log "=== CI fix for PR #${PR_NUMBER} (issue #${ISSUE_NUMBER}) — run ${FAILED_RUN_ID} ==="
log "=== Repo: ${REPO_NAME_WITH_OWNER} | Branch: ${PR_BRANCH} ==="

REPO_NAME="${REPO_NAME_WITH_OWNER##*/}"
WORKSPACE="/workspaces/${REPO_NAME}-${ISSUE_NUMBER}"

save_state running $$

# ── Workspace — reuse existing or clone ──────────────────────────────────────
if [[ -d "$WORKSPACE/.git" ]]; then
    log "Using existing workspace, switching to PR branch"
    git -C "$WORKSPACE" fetch origin 2>&1 | tee -a "$LOGFILE"
    git -C "$WORKSPACE" checkout "$PR_BRANCH" 2>&1 | tee -a "$LOGFILE"
    git -C "$WORKSPACE" reset --hard "origin/${PR_BRANCH}" 2>&1 | tee -a "$LOGFILE"
else
    log "Cloning repository"
    git clone "https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${REPO_NAME_WITH_OWNER}.git" \
        "$WORKSPACE" 2>&1 | tee -a "$LOGFILE"
    git -C "$WORKSPACE" checkout "$PR_BRANCH" 2>&1 | tee -a "$LOGFILE"
fi

cd "$WORKSPACE"

# ── Fetch CI failure logs ─────────────────────────────────────────────────────
log "Fetching failure logs for run ${FAILED_RUN_ID}..."
FAILED_LOGS="$(gh run view "$FAILED_RUN_ID" \
    --repo "$REPO_NAME_WITH_OWNER" \
    --log-failed 2>/dev/null | head -400 || true)"

# ── Build goal prompt ────────────────────────────────────────────────────────
GOAL_FILE="$(mktemp)"
cat > "$GOAL_FILE" <<GOAL
You are an autonomous software engineer fixing a failing CI pipeline.

## Context

This is PR #${PR_NUMBER} for issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}

## Failing CI logs (run ${FAILED_RUN_ID})

The CI pipeline is currently failing. Here are the logs from the failed jobs:

\`\`\`
${FAILED_LOGS}
\`\`\`

## Tools available

You have the \`gh\` CLI authenticated. Use it to inspect CI runs in more detail:
    gh run view ${FAILED_RUN_ID} --repo ${REPO_NAME_WITH_OWNER} --log-failed
    gh run list --repo ${REPO_NAME_WITH_OWNER} --branch ${PR_BRANCH}
    gh pr checks ${PR_NUMBER} --repo ${REPO_NAME_WITH_OWNER}

## Instructions

1. Read the failure logs carefully to understand exactly what is failing and why.
2. Use \`gh run view\` if you need more detail from the logs.
3. Fix the failing tests or build errors. Do not change passing tests or unrelated code.
4. Ensure all tests pass locally if possible before committing.
5. Stage and commit your fixes with a clear message explaining what was fixed.

Do NOT create a pull request — one already exists as PR #${PR_NUMBER}.
Do not ask for confirmation — work autonomously to completion.
GOAL

# ── Run Claude Code ───────────────────────────────────────────────────────────
log "=== Running Claude Code ==="
export CLAUDE_PROMPT
CLAUDE_PROMPT="$(cat "$GOAL_FILE")"
rm -f "$GOAL_FILE"

claude --dangerously-skip-permissions --model "${CLAUDE_MODEL:-claude-sonnet-4-6}" -p "$CLAUDE_PROMPT" \
    < /dev/null \
    2>&1 \
    | tee -a "$LOGFILE"

CLAUDE_EXIT="${PIPESTATUS[0]}"

if [[ "$CLAUDE_EXIT" -ne 0 ]]; then
    log "=== ERROR: Claude exited with code ${CLAUDE_EXIT} — aborting ==="
    exit 1
fi

log "=== Fix implemented — pushing to trigger CI rerun ==="

# ── Push — CI reruns automatically ───────────────────────────────────────────
git push origin "$PR_BRANCH" 2>&1 | tee -a "$LOGFILE"

log "=== Pushed. CI will rerun on PR #${PR_NUMBER}. ==="
log "=== Poller will pick up any remaining failures on the next cycle. ==="

save_state completed
trap "rm -f '$LOCKFILE'" EXIT
