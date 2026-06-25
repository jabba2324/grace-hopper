#!/usr/bin/env bash
# Resumes an interrupted in-progress task.
# Expected env vars (set by poll_projects.py):
#   REPO_NAME_WITH_OWNER, ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY,
#   ISSUE_URL, PROJECT_ID, ITEM_ID, STATUS_FIELD_ID, PR_BRANCH
set -euo pipefail

LOG_DIR="/app/state/logs"
LOCK_DIR="/app/state/active"
mkdir -p "$LOG_DIR" "$LOCK_DIR"
LOGFILE="$LOG_DIR/resume-issue-${ISSUE_NUMBER}-$(date +%Y%m%d-%H%M%S).log"
LOCKFILE="$LOCK_DIR/issue-${ISSUE_NUMBER}.lock"

log() { echo "$*" | tee -a "$LOGFILE"; }

PR_URL=""
PR_NUMBER=""

save_state() {
    TASK_ISSUE_NUMBER="$ISSUE_NUMBER" \
    TASK_TYPE="resume" \
    TASK_STATUS="${1}" \
    TASK_TITLE="$ISSUE_TITLE" \
    TASK_REPO="$REPO_NAME_WITH_OWNER" \
    TASK_PR_BRANCH="${PR_BRANCH:-}" \
    TASK_WORKSPACE="${WORKSPACE:-}" \
    TASK_LOG="$LOGFILE" \
    TASK_PID="${2:-}" \
    TASK_PR_URL="${PR_URL:-}" \
    TASK_PR_NUMBER="${PR_NUMBER:-}" \
    python3 /app/scripts/update_state.py 2>/dev/null || true
}

echo $$ > "$LOCKFILE"
trap "save_state failed; rm -f '$LOCKFILE'" EXIT

log "=== Resuming issue #${ISSUE_NUMBER}: ${ISSUE_TITLE} ==="
log "=== Repo: ${REPO_NAME_WITH_OWNER} | Branch: ${PR_BRANCH} ==="

REPO_NAME="${REPO_NAME_WITH_OWNER##*/}"
WORKSPACE="/workspaces/${REPO_NAME}-${ISSUE_NUMBER}"

save_state running $$

# ── Workspace ────────────────────────────────────────────────────────────────
if [[ -d "$WORKSPACE/.git" ]]; then
    log "Existing workspace found — syncing branch"
    git -C "$WORKSPACE" fetch origin 2>&1 | tee -a "$LOGFILE"
    git -C "$WORKSPACE" checkout "$PR_BRANCH" 2>&1 | tee -a "$LOGFILE"
    git -C "$WORKSPACE" reset --hard "origin/${PR_BRANCH}" 2>/dev/null \
        || git -C "$WORKSPACE" reset --hard HEAD 2>&1 | tee -a "$LOGFILE"
else
    log "No workspace found — cloning and checking out branch"
    git clone "https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${REPO_NAME_WITH_OWNER}.git" \
        "$WORKSPACE" 2>&1 | tee -a "$LOGFILE"
    git -C "$WORKSPACE" checkout "$PR_BRANCH" 2>&1 | tee -a "$LOGFILE"
fi

cd "$WORKSPACE"
DEFAULT_BRANCH="$(git remote show origin | awk '/HEAD branch/{print $NF}')"

# ── Understand current state ──────────────────────────────────────────────────
GIT_LOG="$(git log "${DEFAULT_BRANCH}..HEAD" --oneline 2>/dev/null || git log --oneline -10)"
GIT_STATUS="$(git status --short)"
GIT_DIFF_STAT="$(git diff "${DEFAULT_BRANCH}..HEAD" --stat 2>/dev/null || true)"

# ── Build resume prompt ───────────────────────────────────────────────────────
GOAL_FILE="$(mktemp)"
cat > "$GOAL_FILE" <<GOAL
You are resuming an in-progress software engineering task that was interrupted.
A previous session was working on this but did not complete it.

## Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}

## Work already completed on branch \`${PR_BRANCH}\`

Commits ahead of ${DEFAULT_BRANCH}:
\`\`\`
${GIT_LOG:-  (none — branch has no commits yet)}
\`\`\`

Files changed so far:
\`\`\`
${GIT_DIFF_STAT:-  (none)}
\`\`\`

Uncommitted changes:
\`\`\`
${GIT_STATUS:-  (working tree is clean)}
\`\`\`

## Tools available

- \`gh\` CLI is authenticated for inspecting CI, PRs, and issues
- \`git log\`, \`git diff\`, \`git status\` to understand the current state in depth

## Instructions

1. Review the work already done carefully — read the changed files to understand
   what was implemented and what is still missing.
2. Determine what remains to fully resolve the issue.
3. Continue from where the previous session left off — do not redo completed work.
4. If there are uncommitted changes, decide whether to keep, amend, or discard them.
5. Ensure all tests pass.
6. Stage and commit all remaining changes with a clear descriptive message.

Do NOT create a pull request — the system will handle that automatically.
Do not ask for confirmation — work autonomously to completion.
GOAL

log "=== Claude version: $(claude --version 2>&1) ==="
log "=== Resuming with Claude Code ==="

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

log "=== Resume complete for issue #${ISSUE_NUMBER} ==="

# ── Push ──────────────────────────────────────────────────────────────────────
git push -u origin "$PR_BRANCH" 2>&1 | tee -a "$LOGFILE"

# ── PR — create if it doesn't exist yet ──────────────────────────────────────
EXISTING_PR="$(gh pr view "$PR_BRANCH" --repo "$REPO_NAME_WITH_OWNER" --json url --jq '.url' 2>/dev/null || true)"
if [[ -n "$EXISTING_PR" ]]; then
    log "=== PR already exists: ${EXISTING_PR} ==="
    PR_URL="$EXISTING_PR"
else
    PR_URL="$(gh pr create \
        --repo "$REPO_NAME_WITH_OWNER" \
        --title "$ISSUE_TITLE" \
        --body "Closes #${ISSUE_NUMBER}" \
        --base "$DEFAULT_BRANCH" \
        --head "$PR_BRANCH" 2>&1 | tee -a "$LOGFILE" | tail -1)"
    log "=== PR created: ${PR_URL} ==="

    gh issue comment "$ISSUE_NUMBER" \
        --repo "$REPO_NAME_WITH_OWNER" \
        --body "Pull request raised: ${PR_URL}" 2>&1 | tee -a "$LOGFILE"
fi

PR_NUMBER="${PR_URL##*/}"
save_state running $$

# ── Move to In Review ─────────────────────────────────────────────────────────
if [[ -n "${STATUS_FIELD_ID:-}" && -n "${ITEM_ID:-}" && -n "${PROJECT_ID:-}" ]]; then
    IN_REVIEW_OPTION_ID="$(
        gh api graphql \
          -f query='query($id:ID!){node(id:$id){...on ProjectV2SingleSelectField{options{id name}}}}' \
          -f id="$STATUS_FIELD_ID" \
          --jq ".data.node.options[] | select(.name == \"${PROJECT_STATUS_IN_REVIEW:-In Review}\") | .id" \
          2>/dev/null || true
    )"
    if [[ -n "$IN_REVIEW_OPTION_ID" ]]; then
        gh api graphql \
          -f query='mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}){projectV2Item{id}}}' \
          -f p="$PROJECT_ID" -f i="$ITEM_ID" -f f="$STATUS_FIELD_ID" -f v="$IN_REVIEW_OPTION_ID" \
          > /dev/null 2>&1 || true
        log "=== Moved issue #${ISSUE_NUMBER} to In Review ==="
    fi
fi

save_state completed
trap "rm -f '$LOCKFILE'" EXIT
log "=== Resume task complete ==="
