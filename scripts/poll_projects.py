#!/usr/bin/env python3
"""
Polls a GitHub Projects v2 board for Todo items and dispatches them
to run_task.sh for autonomous completion.
"""
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [poll] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

GH_TOKEN             = os.environ["GITHUB_TOKEN"]
_GITHUB_REPO         = os.environ["GITHUB_REPO"]          # owner/repo
REPO_OWNER, REPO_NAME = _GITHUB_REPO.split("/", 1)
PROJECT_NUMBER       = int(os.environ["GITHUB_PROJECT_NUMBER"])
STATUS_TODO          = os.environ.get("PROJECT_STATUS_TODO", "Todo")
STATUS_IN_PROGRESS   = os.environ.get("PROJECT_STATUS_IN_PROGRESS", "In Progress")
POLL_INTERVAL        = int(os.environ.get("POLL_INTERVAL", "60"))
STATE_DIR            = Path("/app/state")
DISPATCHED_FILE      = STATE_DIR / "dispatched.json"

GRAPHQL_URL = "https://api.github.com/graphql"
HEADERS = {
    "Authorization": f"Bearer {GH_TOKEN}",
    "Content-Type": "application/json",
}


def gql(query: str, variables: dict | None = None) -> dict:
    resp = requests.post(
        GRAPHQL_URL,
        headers=HEADERS,
        json={"query": query, "variables": variables or {}},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if "errors" in data:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data["data"]


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


def dispatch(item: dict, project_id: str, status_field_id: str, in_progress_option_id: str) -> None:
    content = item.get("content")
    if not content:
        return

    repo_name_with_owner = content["repository"]["nameWithOwner"]
    issue_number         = content["number"]
    issue_title          = content["title"]
    issue_body           = content.get("body") or ""
    issue_url            = content["url"]

    log.info("Dispatching issue #%s from %s: %s", issue_number, repo_name_with_owner, issue_title)

    # Mark as In Progress before we start so a restart doesn't double-dispatch
    gql(UPDATE_STATUS, {
        "projectId":  project_id,
        "itemId":     item["id"],
        "fieldId":    status_field_id,
        "optionId":   in_progress_option_id,
    })

    env = {
        **os.environ,
        "REPO_NAME_WITH_OWNER": repo_name_with_owner,
        "ISSUE_NUMBER":         str(issue_number),
        "ISSUE_TITLE":          issue_title,
        "ISSUE_BODY":           issue_body,
        "ISSUE_URL":            issue_url,
        "PROJECT_ID":           project_id,
        "ITEM_ID":              item["id"],
        "STATUS_FIELD_ID":      status_field_id,
    }

    subprocess.Popen(
        ["/app/scripts/run_task.sh"],
        env=env,
    )


def poll_once(dispatched: set) -> set:
    try:
        data = gql(GET_PROJECT, {"owner": REPO_OWNER, "repo": REPO_NAME, "number": PROJECT_NUMBER})
    except Exception as exc:
        log.error("Failed to fetch project: %s", exc)
        return dispatched

    project = data["repository"]["projectV2"]
    project_id = project["id"]

    # Locate the Status single-select field
    status_field = None
    for field in project["fields"]["nodes"]:
        if isinstance(field, dict) and field.get("name") == "Status":
            status_field = field
            break

    if not status_field:
        log.warning("No 'Status' single-select field found in project")
        return dispatched

    status_field_id = status_field["id"]
    options_by_name = {opt["name"]: opt["id"] for opt in status_field["options"]}

    if STATUS_TODO not in options_by_name:
        log.warning("Status option '%s' not found (available: %s)", STATUS_TODO, list(options_by_name))
        return dispatched

    if STATUS_IN_PROGRESS not in options_by_name:
        log.warning("Status option '%s' not found", STATUS_IN_PROGRESS)
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

        # Find the Status field value for this item
        item_status = None
        for fv in item["fieldValues"]["nodes"]:
            if isinstance(fv, dict) and fv.get("field", {}).get("name") == "Status":
                item_status = fv.get("name")
                break

        log.info("Item %s — status: %r", issue_ref, item_status)

        if item_status != STATUS_TODO:
            log.info("Skipping %s — status is %r, want %r", issue_ref, item_status, STATUS_TODO)
            continue

        if not content:
            log.warning("Skipping item %s — no issue content attached", item_id)
            continue

        dispatched.add(item_id)
        save_dispatched(dispatched)

        try:
            dispatch(item, project_id, status_field_id, in_progress_option_id)
        except Exception as exc:
            log.error("Failed to dispatch item %s: %s", item_id, exc)

    return dispatched


def main() -> None:
    dispatched = load_dispatched()
    log.info(
        "Watching project #%s on %s/%s — polling every %ss",
        PROJECT_NUMBER, REPO_OWNER, REPO_NAME, POLL_INTERVAL,
    )
    while True:
        dispatched = poll_once(dispatched)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
