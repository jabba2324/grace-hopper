#!/usr/bin/env python3
"""
Polls a GitHub Projects v2 board for:
  - Todo items        → dispatches run_task.sh
  - In Review items   → checks PR CI status; dispatches fix_ci.sh on failure
"""
import json
import logging
import os
import subprocess
import time
from pathlib import Path

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [poll] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

GH_TOKEN           = os.environ["GITHUB_TOKEN"]
_GITHUB_REPO       = os.environ["GITHUB_REPO"]
REPO_OWNER, REPO_NAME = _GITHUB_REPO.split("/", 1)
PROJECT_NUMBER     = int(os.environ["GITHUB_PROJECT_NUMBER"])
STATUS_TODO        = os.environ.get("PROJECT_STATUS_TODO", "Todo")
STATUS_IN_PROGRESS = os.environ.get("PROJECT_STATUS_IN_PROGRESS", "In Progress")
STATUS_IN_REVIEW   = os.environ.get("PROJECT_STATUS_IN_REVIEW", "In Review")
POLL_INTERVAL      = int(os.environ.get("POLL_INTERVAL", "60"))
STATE_DIR          = Path("/app/state")
DISPATCHED_FILE    = STATE_DIR / "dispatched.json"
CI_DISPATCHED_FILE = STATE_DIR / "ci_dispatched.json"

GRAPHQL_URL = "https://api.github.com/graphql"
GQL_HEADERS = {
    "Authorization": f"Bearer {GH_TOKEN}",
    "Content-Type": "application/json",
}
GH_ENV = {**os.environ, "GH_TOKEN": GH_TOKEN}


def gql(query: str, variables: dict | None = None) -> dict:
    resp = requests.post(
        GRAPHQL_URL,
        headers=GQL_HEADERS,
        json={"query": query, "variables": variables or {}},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if "errors" in data:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data["data"]


def gh(*args: str) -> str:
    result = subprocess.run(
        ["gh", *args],
        capture_output=True, text=True, env=GH_ENV,
    )
    return result.stdout.strip()


GET_PROJECT = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $number) { ...ProjectFields }
  }
}
fragment ProjectFields on ProjectV2 {
  id
  fields(first: 20) {
    nodes {
      ... on ProjectV2SingleSelectField {
        id
        name
        options { id name }
      }
    }
  }
  items(first: 50) {
    nodes {
      id
      fieldValues(first: 20) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
            optionId
            field { ... on ProjectV2SingleSelectField { name } }
          }
        }
      }
      content {
        ... on Issue {
          number
          title
          body
          url
          repository { name nameWithOwner url }
        }
      }
    }
  }
}
"""

UPDATE_STATUS = """
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}
"""


def load_dispatched() -> set:
    if DISPATCHED_FILE.exists():
        return set(json.loads(DISPATCHED_FILE.read_text()))
    return set()


def save_dispatched(ids: set) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DISPATCHED_FILE.write_text(json.dumps(list(ids)))


def load_ci_dispatched() -> set:
    if CI_DISPATCHED_FILE.exists():
        return set(json.loads(CI_DISPATCHED_FILE.read_text()))
    return set()


def save_ci_dispatched(ids: set) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    CI_DISPATCHED_FILE.write_text(json.dumps(list(ids)))


def fetch_project() -> tuple[dict, dict] | tuple[None, None]:
    """Returns (project_data, status_field) or (None, None) on error."""
    try:
        data = gql(GET_PROJECT, {"owner": REPO_OWNER, "repo": REPO_NAME, "number": PROJECT_NUMBER})
    except Exception as exc:
        log.error("Failed to fetch project: %s", exc)
        return None, None

    project = data["repository"]["projectV2"]
    status_field = next(
        (f for f in project["fields"]["nodes"]
         if isinstance(f, dict) and f.get("name") == "Status"),
        None,
    )
    if not status_field:
        log.warning("No 'Status' single-select field found in project")
        return None, None

    return project, status_field


def item_status(item: dict) -> str | None:
    for fv in item["fieldValues"]["nodes"]:
        if isinstance(fv, dict) and fv.get("field", {}).get("name") == "Status":
            return fv.get("name")
    return None


# ── Todo polling ─────────────────────────────────────────────────────────────

def dispatch_task(item: dict, project_id: str, status_field_id: str, in_progress_option_id: str) -> None:
    content = item["content"]
    repo_nwo      = content["repository"]["nameWithOwner"]
    issue_number  = content["number"]
    issue_title   = content["title"]
    issue_body    = content.get("body") or ""
    issue_url     = content["url"]

    log.info("Dispatching issue #%s from %s: %s", issue_number, repo_nwo, issue_title)

    gql(UPDATE_STATUS, {
        "projectId": project_id,
        "itemId":    item["id"],
        "fieldId":   status_field_id,
        "optionId":  in_progress_option_id,
    })

    subprocess.Popen(
        ["/app/scripts/run_task.sh"],
        env={
            **os.environ,
            "REPO_NAME_WITH_OWNER": repo_nwo,
            "ISSUE_NUMBER":         str(issue_number),
            "ISSUE_TITLE":          issue_title,
            "ISSUE_BODY":           issue_body,
            "ISSUE_URL":            issue_url,
            "PROJECT_ID":           project_id,
            "ITEM_ID":              item["id"],
            "STATUS_FIELD_ID":      status_field_id,
        },
    )


def poll_once(dispatched: set) -> set:
    project, status_field = fetch_project()
    if project is None:
        return dispatched

    project_id         = project["id"]
    status_field_id    = status_field["id"]
    options_by_name    = {opt["name"]: opt["id"] for opt in status_field["options"]}

    if STATUS_TODO not in options_by_name:
        log.warning("Status option %r not found (available: %s)", STATUS_TODO, list(options_by_name))
        return dispatched
    if STATUS_IN_PROGRESS not in options_by_name:
        log.warning("Status option %r not found", STATUS_IN_PROGRESS)
        return dispatched

    in_progress_option_id = options_by_name[STATUS_IN_PROGRESS]
    items = project["items"]["nodes"]
    log.info("Found %d item(s) in project", len(items))

    for item in items:
        item_id = item["id"]
        content = item.get("content") or {}
        issue_ref = f"#{content.get('number', '?')} {content.get('title', '(no content)')!r}"

        if item_id in dispatched:
            log.debug("Skipping %s — already dispatched", issue_ref)
            continue

        status = item_status(item)
        log.info("Item %s — status: %r", issue_ref, status)

        if status != STATUS_TODO:
            log.info("Skipping %s — status is %r, want %r", issue_ref, status, STATUS_TODO)
            continue

        if not content:
            log.warning("Skipping item %s — no issue content attached", item_id)
            continue

        dispatched.add(item_id)
        save_dispatched(dispatched)

        try:
            dispatch_task(item, project_id, status_field_id, in_progress_option_id)
        except Exception as exc:
            log.error("Failed to dispatch item %s: %s", item_id, exc)

    return dispatched


# ── CI fix polling ────────────────────────────────────────────────────────────

def find_pr_for_issue(repo_nwo: str, issue_number: int) -> dict | None:
    """Find the open PR whose branch matches issue/{number}/..."""
    raw = gh("pr", "list", "--repo", repo_nwo, "--state", "open",
             "--json", "number,headRefName,headRefOid")
    if not raw:
        return None
    for pr in json.loads(raw):
        if pr["headRefName"].startswith(f"issue/{issue_number}/"):
            return pr
    return None


def get_failing_run_id(repo_nwo: str, branch: str) -> str | None:
    """Return the databaseId of the most recent failed run on this branch, or None."""
    raw = gh("run", "list", "--repo", repo_nwo, "--branch", branch,
             "--status", "failure", "--limit", "1", "--json", "databaseId")
    if not raw:
        return None
    runs = json.loads(raw)
    return str(runs[0]["databaseId"]) if runs else None


def dispatch_ci_fix(repo_nwo: str, issue_number: int, issue_title: str,
                    issue_body: str, pr_number: int, pr_branch: str,
                    failed_run_id: str) -> None:
    log.info("Dispatching CI fix for PR #%s (issue #%s, run %s)",
             pr_number, issue_number, failed_run_id)
    subprocess.Popen(
        ["/app/scripts/fix_ci.sh"],
        env={
            **os.environ,
            "REPO_NAME_WITH_OWNER": repo_nwo,
            "ISSUE_NUMBER":         str(issue_number),
            "ISSUE_TITLE":          issue_title,
            "ISSUE_BODY":           issue_body,
            "PR_NUMBER":            str(pr_number),
            "PR_BRANCH":            pr_branch,
            "FAILED_RUN_ID":        failed_run_id,
        },
    )


def poll_ci(ci_dispatched: set) -> set:
    project, status_field = fetch_project()
    if project is None:
        return ci_dispatched

    for item in project["items"]["nodes"]:
        content = item.get("content") or {}
        if not content:
            continue
        if item_status(item) != STATUS_IN_REVIEW:
            continue

        issue_number  = content["number"]
        issue_title   = content["title"]
        issue_body    = content.get("body") or ""
        repo_nwo      = content["repository"]["nameWithOwner"]

        pr = find_pr_for_issue(repo_nwo, issue_number)
        if not pr:
            log.debug("Issue #%s is In Review but no open PR found", issue_number)
            continue

        pr_number  = pr["number"]
        pr_branch  = pr["headRefName"]
        head_sha   = pr["headRefOid"]

        # Key on pr+sha so a new commit after a fix is treated as a fresh failure
        dispatch_key = f"{pr_number}:{head_sha}"
        if dispatch_key in ci_dispatched:
            continue

        failed_run_id = get_failing_run_id(repo_nwo, pr_branch)
        if not failed_run_id:
            log.debug("PR #%s — no failing runs", pr_number)
            continue

        log.info("PR #%s (issue #%s) has a failing CI run (%s)",
                 pr_number, issue_number, failed_run_id)

        ci_dispatched.add(dispatch_key)
        save_ci_dispatched(ci_dispatched)

        try:
            dispatch_ci_fix(repo_nwo, issue_number, issue_title, issue_body,
                            pr_number, pr_branch, failed_run_id)
        except Exception as exc:
            log.error("Failed to dispatch CI fix for PR #%s: %s", pr_number, exc)

    return ci_dispatched


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    dispatched    = load_dispatched()
    ci_dispatched = load_ci_dispatched()
    log.info(
        "Watching project #%s on %s/%s — polling every %ss",
        PROJECT_NUMBER, REPO_OWNER, REPO_NAME, POLL_INTERVAL,
    )
    while True:
        dispatched    = poll_once(dispatched)
        ci_dispatched = poll_ci(ci_dispatched)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
