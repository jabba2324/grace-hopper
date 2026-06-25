#!/usr/bin/env python3
"""
Single polling loop. Handles all board states (Todo / In Progress / In Review)
in one pass. All state is tracked in state/tasks.json — no separate
dispatched.json or ci_dispatched.json.
"""
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, "/app/scripts")
import state as task_state

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [poll] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

GH_TOKEN          = os.environ["GITHUB_TOKEN"]
_GITHUB_REPO      = os.environ["GITHUB_REPO"]
REPO_OWNER, REPO_NAME = _GITHUB_REPO.split("/", 1)
PROJECT_NUMBER    = int(os.environ["GITHUB_PROJECT_NUMBER"])
STATUS_TODO       = os.environ.get("PROJECT_STATUS_TODO", "Todo")
STATUS_IN_PROGRESS = os.environ.get("PROJECT_STATUS_IN_PROGRESS", "In Progress")
STATUS_IN_REVIEW  = os.environ.get("PROJECT_STATUS_IN_REVIEW", "In Review")
POLL_INTERVAL     = int(os.environ.get("POLL_INTERVAL", "60"))
STATE_DIR         = Path("/app/state")
LOCK_DIR          = STATE_DIR / "active"

GRAPHQL_URL = "https://api.github.com/graphql"
GQL_HEADERS = {"Authorization": f"Bearer {GH_TOKEN}", "Content-Type": "application/json"}
GH_ENV      = {**os.environ, "GH_TOKEN": GH_TOKEN}


# ── GraphQL / gh helpers ──────────────────────────────────────────────────────

def gql(query: str, variables: dict | None = None) -> dict:
    resp = requests.post(
        GRAPHQL_URL, headers=GQL_HEADERS,
        json={"query": query, "variables": variables or {}}, timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if "errors" in data:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data["data"]


def gh(*args: str) -> str:
    result = subprocess.run(["gh", *args], capture_output=True, text=True, env=GH_ENV)
    return result.stdout.strip()


GET_PROJECT = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $number) {
      id
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
      items(first: 50) {
        nodes {
          id
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
          content {
            ... on Issue {
              number title body url
              repository { name nameWithOwner url }
            }
          }
        }
      }
    }
  }
}
"""

UPDATE_STATUS = """
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId itemId: $itemId fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}
"""


# ── State helpers ─────────────────────────────────────────────────────────────

def _write_state(entry: dict) -> None:
    try:
        task_state.upsert(entry)
    except Exception as exc:
        log.error("Failed to write tasks.json: %s", exc)


def get_entry(issue_number: int, entry_type: str | None = None) -> dict | None:
    """Return the tasks.json record for this issue (optionally filtered by type)."""
    try:
        tasks = json.loads((STATE_DIR / "tasks.json").read_text())
        for t in tasks:
            if t.get("issueNumber") == issue_number:
                if entry_type is None or t.get("type") == entry_type:
                    return t
    except Exception:
        pass
    return None


def is_active(issue_number: int) -> tuple[bool, bool]:
    """Return (is_running, had_stale_lock)."""
    lockfile = LOCK_DIR / f"issue-{issue_number}.lock"
    if not lockfile.exists():
        return False, False
    try:
        pid = int(lockfile.read_text().strip())
        os.kill(pid, 0)
        return True, False
    except (ValueError, ProcessLookupError, PermissionError):
        lockfile.unlink(missing_ok=True)
        return False, True


def item_status(item: dict) -> str | None:
    for fv in item["fieldValues"]["nodes"]:
        if isinstance(fv, dict) and fv.get("field", {}).get("name") == "Status":
            return fv.get("name")
    return None


def find_pr_for_issue(repo_nwo: str, issue_number: int) -> dict | None:
    raw = gh("pr", "list", "--repo", repo_nwo, "--state", "open",
             "--json", "number,headRefName,headRefOid")
    if not raw:
        return None
    for pr in json.loads(raw):
        if pr["headRefName"].startswith(f"issue/{issue_number}/"):
            return pr
    return None


def get_failing_run_id(repo_nwo: str, branch: str) -> str | None:
    raw = gh("run", "list", "--repo", repo_nwo, "--branch", branch,
             "--status", "failure", "--limit", "1", "--json", "databaseId")
    if not raw:
        return None
    runs = json.loads(raw)
    return str(runs[0]["databaseId"]) if runs else None


def get_branch_sha(repo_nwo: str, issue_number: int) -> str | None:
    raw = gh("api", f"repos/{repo_nwo}/git/matching-refs/heads/issue/{issue_number}/",
             "--jq", ".[0].object.sha")
    return raw if raw and raw != "null" else None


def resolve_branch(repo_nwo: str, issue_number: int, issue_title: str) -> str:
    """Return the remote branch name, falling back to reconstructing it from title."""
    raw = gh("api", f"repos/{repo_nwo}/git/matching-refs/heads/issue/{issue_number}/",
             "--jq", ".[0].ref")
    if raw and raw != "null":
        return raw.removeprefix("refs/heads/")
    import re
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]", "-", issue_title.lower())).strip("-")[:40]
    return f"issue/{issue_number}/{slug}"


def dispatch(mode: str, base_env: dict, **extra: str) -> None:
    log.info("Dispatching %s for issue #%s", mode, base_env["ISSUE_NUMBER"])
    subprocess.Popen(
        ["/app/scripts/worker.sh"],
        env={**os.environ, "TASK_MODE": mode, **base_env, **extra},
    )


# ── Main poll ─────────────────────────────────────────────────────────────────

def poll(project: dict, status_field: dict) -> None:
    project_id      = project["id"]
    status_field_id = status_field["id"]
    options         = {opt["name"]: opt["id"] for opt in status_field["options"]}

    in_progress_id = options.get(STATUS_IN_PROGRESS)
    if not in_progress_id:
        log.warning("Status option %r not found", STATUS_IN_PROGRESS)
        return

    items = project["items"]["nodes"]
    log.info("Poll: %d item(s)", len(items))

    for item in items:
        content = item.get("content") or {}
        if not content:
            continue

        board_status  = item_status(item)
        issue_number  = content["number"]
        issue_title   = content["title"]
        issue_body    = content.get("body") or ""
        issue_url     = content.get("url") or ""
        repo_nwo      = content["repository"]["nameWithOwner"]
        repo_name     = repo_nwo.split("/")[-1]
        workspace     = f"/workspaces/{repo_name}-{issue_number}"

        base_env = {
            "REPO_NAME_WITH_OWNER": repo_nwo,
            "ISSUE_NUMBER":         str(issue_number),
            "ISSUE_TITLE":          issue_title,
            "ISSUE_BODY":           issue_body,
            "ISSUE_URL":            issue_url,
            "PROJECT_ID":           project_id,
            "ITEM_ID":              item["id"],
            "STATUS_FIELD_ID":      status_field_id,
        }

        # ── Todo ──────────────────────────────────────────────────────────────
        if board_status == STATUS_TODO:
            entry = get_entry(issue_number, "task")
            if entry and entry.get("status") not in ("failed",):
                log.debug("Issue #%s — already dispatched (%s)", issue_number, entry.get("status"))
                continue
            log.info("Issue #%s — new task: %s", issue_number, issue_title)
            _write_state({
                "issueNumber": issue_number, "type": "task", "status": "dispatched",
                "title": issue_title, "repo": repo_nwo,
                "issueUrl": f"https://github.com/{repo_nwo}/issues/{issue_number}",
                "workspacePath": workspace,
            })
            try:
                gql(UPDATE_STATUS, {
                    "projectId": project_id, "itemId": item["id"],
                    "fieldId": status_field_id, "optionId": in_progress_id,
                })
            except Exception as exc:
                log.error("Failed to move issue #%s to In Progress: %s", issue_number, exc)
            dispatch("new", base_env)

        # ── In Progress ───────────────────────────────────────────────────────
        elif board_status == STATUS_IN_PROGRESS:
            entry = get_entry(issue_number)
            if entry and entry.get("status") == "paused":
                log.info("Issue #%s — paused by user, skipping", issue_number)
                continue
            running, stale = is_active(issue_number)
            if running:
                log.info("Issue #%s — actively running", issue_number)
                continue
            action = "stale lock, resuming" if stale else "idle, resuming"
            log.info("Issue #%s — %s", issue_number, action)
            pr_branch = resolve_branch(repo_nwo, issue_number, issue_title)
            dispatch("resume", base_env, PR_BRANCH=pr_branch)

        # ── In Review ─────────────────────────────────────────────────────────
        elif board_status == STATUS_IN_REVIEW:
            pr = find_pr_for_issue(repo_nwo, issue_number)
            if not pr:
                log.info("Issue #%s — In Review, no open PR found", issue_number)
                continue

            pr_number     = pr["number"]
            pr_branch     = pr["headRefName"]
            head_sha      = pr["headRefOid"]
            failed_run_id = get_failing_run_id(repo_nwo, pr_branch)

            if not failed_run_id:
                log.info("PR #%s (issue #%s) — CI passing", pr_number, issue_number)
                _write_state({
                    "issueNumber": issue_number, "type": "ci-fix", "status": "completed",
                    "title": issue_title, "repo": repo_nwo,
                    "issueUrl": f"https://github.com/{repo_nwo}/issues/{issue_number}",
                    "prNumber": pr_number, "branch": pr_branch,
                    "prUrl": f"https://github.com/{repo_nwo}/pull/{pr_number}",
                    "workspacePath": workspace,
                })
                continue

            running, stale = is_active(issue_number)
            if running:
                log.info("PR #%s — CI fix actively running", pr_number)
                continue

            # Deduplicate: skip if we already dispatched a fix for this exact run
            ci_entry = get_entry(issue_number, "ci-fix")
            already_fixed = (
                ci_entry and
                ci_entry.get("failedRunId") == failed_run_id and
                ci_entry.get("status") not in ("failed",) and
                not stale
            )
            if already_fixed:
                log.info("PR #%s — run %s already dispatched", pr_number, failed_run_id)
                continue

            log.info("PR #%s (issue #%s) — failing CI run %s, dispatching fix",
                     pr_number, issue_number, failed_run_id)
            _write_state({
                "issueNumber": issue_number, "type": "ci-fix", "status": "dispatched",
                "title": issue_title, "repo": repo_nwo,
                "issueUrl": f"https://github.com/{repo_nwo}/issues/{issue_number}",
                "prNumber": pr_number, "branch": pr_branch,
                "prUrl": f"https://github.com/{repo_nwo}/pull/{pr_number}",
                "workspacePath": workspace, "failedRunId": failed_run_id,
            })
            dispatch("ci-fix", base_env,
                     PR_NUMBER=str(pr_number),
                     PR_BRANCH=pr_branch,
                     FAILED_RUN_ID=failed_run_id)


def main() -> None:
    log.info("Watching project #%s on %s/%s — polling every %ss",
             PROJECT_NUMBER, REPO_OWNER, REPO_NAME, POLL_INTERVAL)
    while True:
        try:
            data = gql(GET_PROJECT, {"owner": REPO_OWNER, "repo": REPO_NAME,
                                      "number": PROJECT_NUMBER})
            project = data["repository"]["projectV2"]
            status_field = next(
                (f for f in project["fields"]["nodes"]
                 if isinstance(f, dict) and f.get("name") == "Status"),
                None,
            )
            if not status_field:
                log.warning("No 'Status' field found in project")
            else:
                poll(project, status_field)
        except Exception as exc:
            log.error("Poll error: %s", exc)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
