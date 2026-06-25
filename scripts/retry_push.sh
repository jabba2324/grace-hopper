#!/usr/bin/env bash
# Retry the post-Claude steps (push → PR → comment → board update) for an
# issue whose implementation is already committed in the workspace.
#
# Usage (from inside the container):
#   /app/scripts/retry_push.sh <issue-number>
#
# Example:
#   docker exec grace-hopper-agent-1 /app/scripts/retry_push.sh 4
set -euo pipefail

ISSUE_NUMBER="${1:?Usage: retry_push.sh <issue-number>}"
REPO_NAME_WITH_OWNER="${GITHUB_REPO}"
REPO_NAME="${REPO_NAME_WITH_OWNER##*/}"

LOG_DIR="/app/state/logs"
mkdir -p "$LOG_DIR"
LOGFILE="$LOG_DIR/retry-issue-${ISSUE_NUMBER}-$(date +%Y%m%d-%H%M%S).log"

log() { echo "$*" | tee -a "$LOGFILE"; }

log "=== Retry push for issue #${ISSUE_NUMBER} ==="

# Find the workspace — look for any dir matching the repo+issue pattern
WORKSPACE="$(find /workspaces -maxdepth 1 -type d -name "${REPO_NAME}-${ISSUE_NUMBER}" | head -1)"
if [[ -z "$WORKSPACE" ]]; then
    log "ERROR: no workspace found matching ${REPO_NAME}-${ISSUE_NUMBER} under /workspaces"
    exit 1
fi
log "Workspace: $WORKSPACE"

cd "$WORKSPACE"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DEFAULT_BRANCH="$(git remote show origin | awk '/HEAD branch/{print $NF}')"
log "Branch: $BRANCH  →  base: $DEFAULT_BRANCH"

# ── Push ─────────────────────────────────────────────────────────────────────
log "=== Pushing branch ==="
git push -u origin "$BRANCH" 2>&1 | tee -a "$LOGFILE"

# ── PR — skip if one already exists ──────────────────────────────────────────
EXISTING_PR="$(gh pr view "$BRANCH" --repo "$REPO_NAME_WITH_OWNER" --json url --jq '.url' 2>/dev/null || true)"
if [[ -n "$EXISTING_PR" ]]; then
    PR_URL="$EXISTING_PR"
    log "=== PR already exists: ${PR_URL} ==="
else
    ISSUE_TITLE="$(gh issue view "$ISSUE_NUMBER" --repo "$REPO_NAME_WITH_OWNER" --json title --jq '.title')"
    PR_URL="$(gh pr create \
        --repo "$REPO_NAME_WITH_OWNER" \
        --title "$ISSUE_TITLE" \
        --body "Closes #${ISSUE_NUMBER}" \
        --base "$DEFAULT_BRANCH" \
        --head "$BRANCH" 2>&1 | tee -a "$LOGFILE" | tail -1)"
    log "=== PR created: ${PR_URL} ==="
fi

# ── Comment on issue ─────────────────────────────────────────────────────────
gh issue comment "$ISSUE_NUMBER" \
    --repo "$REPO_NAME_WITH_OWNER" \
    --body "Pull request raised: ${PR_URL}" 2>&1 | tee -a "$LOGFILE"
log "=== Commented on issue #${ISSUE_NUMBER} ==="

# ── Move ticket to In Review ─────────────────────────────────────────────────
OWNER="${REPO_NAME_WITH_OWNER%%/*}"
PROJECT_NUMBER="${GITHUB_PROJECT_NUMBER}"
IN_REVIEW_LABEL="${PROJECT_STATUS_IN_REVIEW:-In Review}"

# Look up the project and field IDs dynamically
PROJECT_DATA="$(gh api graphql \
    -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){projectV2(number:$number){id,fields(first:20){nodes{...on ProjectV2SingleSelectField{id,name,options{id,name}}}}}}}' \
    -f owner="$OWNER" -f repo="$REPO_NAME" -F number="$PROJECT_NUMBER")"

PROJECT_ID="$(echo "$PROJECT_DATA" | jq -r '.data.repository.projectV2.id')"
STATUS_FIELD_ID="$(echo "$PROJECT_DATA" | jq -r '.data.repository.projectV2.fields.nodes[] | select(.name=="Status") | .id')"
IN_REVIEW_OPTION_ID="$(echo "$PROJECT_DATA" | jq -r ".data.repository.projectV2.fields.nodes[] | select(.name==\"Status\") | .options[] | select(.name==\"${IN_REVIEW_LABEL}\") | .id")"

if [[ -z "$IN_REVIEW_OPTION_ID" ]]; then
    log "=== WARNING: '${IN_REVIEW_LABEL}' status not found — skipping board update ==="
else
    ITEM_ID="$(gh api graphql \
        -f query='query($id:ID!){node(id:$id){...on ProjectV2{items(first:50){nodes{id,content{...on Issue{number}}}}}}}' \
        -f id="$PROJECT_ID" \
        --jq ".data.node.items.nodes[] | select(.content.number==${ISSUE_NUMBER}) | .id")"

    if [[ -z "$ITEM_ID" ]]; then
        log "=== WARNING: issue #${ISSUE_NUMBER} not found in project board ==="
    else
        gh api graphql \
            -f query='mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}){projectV2Item{id}}}' \
            -f p="$PROJECT_ID" -f i="$ITEM_ID" -f f="$STATUS_FIELD_ID" -f v="$IN_REVIEW_OPTION_ID" \
            > /dev/null 2>&1
        log "=== Moved issue #${ISSUE_NUMBER} to In Review ==="
    fi
fi

log "=== Retry complete ==="
