#!/usr/bin/env bash
# Runs inside a background subshell for each dispatched issue.
# Expected env vars (set by poll_projects.py):
#   REPO_NAME_WITH_OWNER, ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY,
#   ISSUE_URL, PROJECT_ID, ITEM_ID, STATUS_FIELD_ID
set -euo pipefail

LOG_DIR="/app/state/logs"
LOCK_DIR="/app/state/active"
mkdir -p "$LOG_DIR" "$LOCK_DIR"
LOGFILE="$LOG_DIR/issue-${ISSUE_NUMBER}-$(date +%Y%m%d-%H%M%S).log"
LOCKFILE="$LOCK_DIR/issue-${ISSUE_NUMBER}.lock"

log() { echo "$*" | tee -a "$LOGFILE"; }

echo $$ > "$LOCKFILE"
trap "rm -f '$LOCKFILE'" EXIT

log "=== Starting task for issue #${ISSUE_NUMBER}: ${ISSUE_TITLE} ==="
log "=== Repo: ${REPO_NAME_WITH_OWNER} ==="

REPO_NAME="${REPO_NAME_WITH_OWNER##*/}"
BRANCH_SLUG="$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-40 | sed 's/-$//')"
BRANCH="issue/${ISSUE_NUMBER}/${BRANCH_SLUG}"
WORKSPACE="/workspaces/${REPO_NAME}-${ISSUE_NUMBER}"

# ── Clone ────────────────────────────────────────────────────────────────────
if [[ -d "$WORKSPACE/.git" ]]; then
    log "Workspace already exists, resetting to default branch"
    git -C "$WORKSPACE" fetch origin
    DEFAULT_BRANCH="$(git -C "$WORKSPACE" remote show origin | awk '/HEAD branch/{print $NF}')"
    git -C "$WORKSPACE" checkout "$DEFAULT_BRANCH"
    git -C "$WORKSPACE" reset --hard "origin/$DEFAULT_BRANCH"
else
    git clone "https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${REPO_NAME_WITH_OWNER}.git" "$WORKSPACE" \
        2>&1 | tee -a "$LOGFILE"
fi

cd "$WORKSPACE"
DEFAULT_BRANCH="$(git remote show origin | awk '/HEAD branch/{print $NF}')"

# ── Branch ───────────────────────────────────────────────────────────────────
git checkout -b "$BRANCH" 2>&1 | tee -a "$LOGFILE" || git checkout "$BRANCH" 2>&1 | tee -a "$LOGFILE"

# ── Build goal prompt ────────────────────────────────────────────────────────
GOAL_FILE="$(mktemp)"
cat > "$GOAL_FILE" <<GOAL
You are an autonomous software engineer. Your task is described in a GitHub issue.

## Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}

## Tools available

- \`gh\` CLI is authenticated — use it freely to inspect CI runs, PRs, and issues:
    gh run list --repo ${REPO_NAME_WITH_OWNER} --status failure
    gh run view <run-id> --log-failed
    gh pr checks <pr-number>

## Instructions

1. Understand the issue thoroughly before making any changes.
2. If the issue relates to failing tests or CI, inspect the logs above and use
   \`gh run view\` to dig deeper before writing any code.
3. Implement the required changes in this repository.
4. Write or update tests where appropriate.
5. Ensure all existing tests pass.
6. Stage and commit all changes with a clear, descriptive commit message.

Do NOT create a pull request — the system will handle that automatically after you finish.
Do not ask for confirmation — work autonomously to completion.
GOAL

# ── Sanity-check Claude is reachable ─────────────────────────────────────────
log "=== Claude version: $(claude --version 2>&1) ==="

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

log "=== Implementation complete for issue #${ISSUE_NUMBER} ==="

# ── Push branch ───────────────────────────────────────────────────────────────
git push -u origin "$BRANCH" 2>&1 | tee -a "$LOGFILE"

# ── Create PR ────────────────────────────────────────────────────────────────
PR_URL="$(gh pr create \
    --repo "$REPO_NAME_WITH_OWNER" \
    --title "$ISSUE_TITLE" \
    --body "Closes #${ISSUE_NUMBER}" \
    --base "$DEFAULT_BRANCH" \
    --head "$BRANCH" 2>&1 | tee -a "$LOGFILE" | tail -1)"

log "=== PR created: ${PR_URL} ==="

# ── Comment on issue ─────────────────────────────────────────────────────────
gh issue comment "$ISSUE_NUMBER" \
    --repo "$REPO_NAME_WITH_OWNER" \
    --body "Pull request raised: ${PR_URL}" 2>&1 | tee -a "$LOGFILE"

log "=== Commented on issue #${ISSUE_NUMBER} ==="

# ── Move ticket to In Review (best-effort) ────────────────────────────────────
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
    else
        log "=== WARNING: 'In Review' status not found in project board — ticket left as-is ==="
    fi
fi
