#!/usr/bin/env python3
"""
Single polling loop. Handles all board states (Todo / In Progress / In Review)
in one pass. All state is tracked in state/tasks.json — no separate
dispatched.json or ci_dispatched.json.
"""
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "/app/scripts")
import state as task_state
from github import GH_ENV, gql, gh

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [poll] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

_GITHUB_REPO      = os.environ["GITHUB_REPO"]
REPO_OWNER, REPO_NAME = _GITHUB_REPO.split("/", 1)
PROJECT_NUMBER    = int(os.environ["GITHUB_PROJECT_NUMBER"])
STATUS_TODO       = os.environ.get("PROJECT_STATUS_TODO", "Todo")
STATUS_IN_PROGRESS = os.environ.get("PROJECT_STATUS_IN_PROGRESS", "In Progress")
STATUS_IN_REVIEW  = os.environ.get("PROJECT_STATUS_IN_REVIEW", "In Review")
POLL_INTERVAL     = int(os.environ.get("POLL_INTERVAL", "5"))
STATE_DIR         = Path("/app/state")
LOCK_DIR          = STATE_DIR / "active"


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


def _fetch_open_prs(repo_nwo: str) -> list[dict]:
    """All open PRs for the repo — fetched once per poll cycle."""
    raw = gh("pr", "list", "--repo", repo_nwo, "--state", "open",
             "--json", "number,headRefName")
    return json.loads(raw) if raw else []


def _fetch_failing_runs(repo_nwo: str) -> dict[str, str]:
    """Latest failing run ID per branch — fetched once per poll cycle."""
    raw = gh("run", "list", "--repo", repo_nwo, "--status", "failure",
             "--limit", "50", "--json", "databaseId,headBranch")
    if not raw:
        return {}
    result: dict[str, str] = {}
    for run in json.loads(raw):
        branch = run.get("headBranch", "")
        if branch and branch not in result:
            result[branch] = str(run["databaseId"])
    return result


def _fetch_issue_branches(repo_nwo: str) -> dict[int, str]:
    """All remote issue/* branches → {issue_number: branch_name}, fetched once per poll cycle."""
    raw = gh("api", f"repos/{repo_nwo}/git/matching-refs/heads/issue/",
             "--jq", "[.[].ref]")
    if not raw or raw == "[]":
        return {}
    result: dict[int, str] = {}
    for ref in json.loads(raw):
        branch = ref.removeprefix("refs/heads/")
        parts = branch.split("/")
        if len(parts) >= 3:
            try:
                result[int(parts[1])] = branch
            except ValueError:
                pass
    return result


def dispatch(mode: str, base_env: dict, **extra: str) -> None:
    log.info("Dispatching %s for issue #%s", mode, base_env["ISSUE_NUMBER"])
    subprocess.Popen(
        ["python3", "/app/scripts/worker.py"],
        env={**os.environ, "TASK_MODE": mode, **base_env, **extra},
    )


# ── Main poll ─────────────────────────────────────────────────────────────────

def poll(project: dict, status_field: dict) -> None:
    project_id      = project["id"]
    status_field_id = status_field["id"]
    options         = {opt["name"]: opt["id"] for opt in status_field["options"]}

    in_progress_id = options.get(STATUS_IN_PROGRESS)
    in_review_id   = options.get(STATUS_IN_REVIEW)
    if not in_progress_id:
        log.warning("Status option %r not found", STATUS_IN_PROGRESS)
        return

    items = project["items"]["nodes"]
    log.info("Poll: %d item(s)", len(items))

    # Pre-fetch per-repo data once to avoid O(n) gh CLI calls in the loop below.
    active_repos: set[str] = set()
    for item in items:
        content = item.get("content") or {}
        if content and item_status(item) in (STATUS_IN_PROGRESS, STATUS_IN_REVIEW):
            active_repos.add(content["repository"]["nameWithOwner"])

    open_prs:       dict[str, list[dict]]     = {r: _fetch_open_prs(r)       for r in active_repos}
    failing_runs:   dict[str, dict[str, str]] = {r: _fetch_failing_runs(r)   for r in active_repos}
    issue_branches: dict[str, dict[int, str]] = {r: _fetch_issue_branches(r) for r in active_repos}

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
            # Check any entry type for paused/failed — don't auto-resume
            any_entry = get_entry(issue_number, "task") or get_entry(issue_number, "ci-fix")
            if any_entry:
                entry_status = any_entry.get("status")
                if entry_status in ("paused", "failed"):
                    log.info("Issue #%s — %s, waiting for user action", issue_number, entry_status)
                    continue
                if entry_status == "completed" and in_review_id:
                    # Board hasn't caught up after PR creation — sync it rather than re-running.
                    log.info("Issue #%s — completed, syncing board to In Review", issue_number)
                    try:
                        gql(UPDATE_STATUS, {
                            "projectId": project_id, "itemId": item["id"],
                            "fieldId": status_field_id, "optionId": in_review_id,
                        })
                    except Exception as exc:
                        log.warning("Failed to sync issue #%s to In Review: %s", issue_number, exc)
                    continue
            running, stale = is_active(issue_number)
            if running:
                log.info("Issue #%s — actively running", issue_number)
                continue
            action = "stale lock, resuming" if stale else "idle, resuming"
            log.info("Issue #%s — %s", issue_number, action)
            pr_branch = issue_branches.get(repo_nwo, {}).get(issue_number)
            if not pr_branch:
                slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]", "-", issue_title.lower())).strip("-")[:40]
                pr_branch = f"issue/{issue_number}/{slug}"
            task_entry = get_entry(issue_number, "task")
            prev_session_id = (task_entry or {}).get("sessionId") or ""
            dispatch("resume", base_env, PR_BRANCH=pr_branch, PREV_SESSION_ID=prev_session_id)

        # ── In Review ─────────────────────────────────────────────────────────
        elif board_status == STATUS_IN_REVIEW:
            pr = next(
                (p for p in open_prs.get(repo_nwo, [])
                 if p["headRefName"].startswith(f"issue/{issue_number}/")),
                None,
            )
            if not pr:
                log.info("Issue #%s — In Review, no open PR found", issue_number)
                continue

            pr_number     = pr["number"]
            pr_branch     = pr["headRefName"]
            failed_run_id = failing_runs.get(repo_nwo, {}).get(pr_branch)

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
            task_entry = get_entry(issue_number, "task")
            prev_session_id = (
                (ci_entry or {}).get("sessionId") or
                (task_entry or {}).get("sessionId") or
                ""
            )
            dispatch("ci-fix", base_env,
                     PR_NUMBER=str(pr_number),
                     PR_BRANCH=pr_branch,
                     FAILED_RUN_ID=failed_run_id,
                     PREV_SESSION_ID=prev_session_id)


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
