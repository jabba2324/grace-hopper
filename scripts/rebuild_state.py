#!/usr/bin/env python3
"""
Reconciles tasks.json against the live GitHub project board.
Called by the VS Code extension's Rebuild State button.

For each board item it determines the correct status by checking:
  - Is a process actively holding a lock file?
  - What does the board column say (Todo / In Progress / In Review)?
  - Does an open PR exist, and is its CI passing?

Prints a JSON summary so the extension can show a notification.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "/app/scripts")
import state as task_state

GH_TOKEN  = os.environ.get("GITHUB_TOKEN", "")
STATE_DIR = Path("/app/state")
LOCK_DIR  = STATE_DIR / "active"
CONFIG_FILE = STATE_DIR / "repos.json"

GH_ENV = {**os.environ, "GH_TOKEN": GH_TOKEN}


def load_config() -> list[dict]:
    try:
        if CONFIG_FILE.exists():
            repos = json.loads(CONFIG_FILE.read_text())
            if repos:
                return repos
    except Exception:
        pass
    repo        = os.environ.get("GITHUB_REPO", "")
    project_num = os.environ.get("GITHUB_PROJECT_NUMBER", "")
    if repo and project_num:
        return [{
            "repo":             repo,
            "projectNumber":    int(project_num),
            "statusTodo":       os.environ.get("PROJECT_STATUS_TODO",        "Todo"),
            "statusInProgress": os.environ.get("PROJECT_STATUS_IN_PROGRESS", "In Progress"),
            "statusInReview":   os.environ.get("PROJECT_STATUS_IN_REVIEW",   "In Review"),
        }]
    return []


def gh(*args: str) -> str:
    r = subprocess.run(["gh", *args], capture_output=True, text=True, env=GH_ENV)
    return r.stdout.strip()


def is_active(issue_number: int) -> bool:
    lock = LOCK_DIR / f"issue-{issue_number}.lock"
    if not lock.exists():
        return False
    try:
        pid = int(lock.read_text().strip())
        os.kill(pid, 0)
        return True
    except Exception:
        lock.unlink(missing_ok=True)
        return False


def find_pr(repo_nwo: str, issue_number: int) -> dict | None:
    raw = gh("pr", "list", "--repo", repo_nwo, "--state", "open",
             "--json", "number,headRefName,url")
    if not raw:
        return None
    for pr in json.loads(raw):
        if pr["headRefName"].startswith(f"issue/{issue_number}/"):
            return pr
    return None


def get_failing_run(repo_nwo: str, branch: str) -> str | None:
    raw = gh("run", "list", "--repo", repo_nwo, "--branch", branch,
             "--status", "failure", "--limit", "1", "--json", "databaseId")
    if not raw:
        return None
    runs = json.loads(raw)
    return str(runs[0]["databaseId"]) if runs else None


def fetch_board(repo_nwo: str, project_number: int) -> list[dict]:
    owner, repo = repo_nwo.split("/", 1)
    query = """
    query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        projectV2(number:$number){
          items(first:50){
            nodes{
              fieldValues(first:20){
                nodes{
                  ...on ProjectV2ItemFieldSingleSelectValue{
                    name field{...on ProjectV2SingleSelectField{name}}
                  }
                }
              }
              content{
                ...on Issue{
                  number title body url
                  repository{nameWithOwner}
                }
              }
            }
          }
        }
      }
    }
    """
    raw = gh("api", "graphql",
             "-f", f"query={query}",
             "-f", f"owner={owner}",
             "-f", f"repo={repo}",
             "-F", f"number={project_number}")
    if not raw:
        return []
    data = json.loads(raw)
    return (data.get("data", {})
                .get("repository", {})
                .get("projectV2", {})
                .get("items", {})
                .get("nodes", []))


def board_status(item: dict) -> str | None:
    for fv in item.get("fieldValues", {}).get("nodes", []):
        if isinstance(fv, dict) and fv.get("field", {}).get("name") == "Status":
            return fv.get("name")
    return None


def rebuild_one(cfg: dict, fixed: list[str]) -> None:
    repo_nwo       = cfg["repo"]
    project_number = int(cfg["projectNumber"])
    status_in_progress = cfg.get("statusInProgress", "In Progress")
    status_in_review   = cfg.get("statusInReview",   "In Review")
    status_todo        = cfg.get("statusTodo",        "Todo")

    items = fetch_board(repo_nwo, project_number)
    for item in items:
        content = item.get("content") or {}
        if not content:
            continue

        issue_number = content["number"]
        issue_title  = content["title"]
        item_repo    = content["repository"]["nameWithOwner"]
        repo_name    = item_repo.split("/")[-1]
        workspace    = f"/workspaces/{repo_name}-{issue_number}"
        col          = board_status(item)

        if is_active(issue_number):
            correct_status = "running"
        elif col == status_in_review:
            pr = find_pr(item_repo, issue_number)
            if pr:
                failing = get_failing_run(item_repo, pr["headRefName"])
                correct_status = "dispatched" if failing else "completed"
            else:
                correct_status = "completed"
        elif col == status_in_progress:
            correct_status = "failed"
        else:
            correct_status = "dispatched" if col == status_todo else "completed"

        pr = find_pr(item_repo, issue_number)
        entry: dict = {
            "issueNumber":   issue_number,
            "type":          "task",
            "status":        correct_status,
            "title":         issue_title,
            "repo":          item_repo,
            "issueUrl":      f"https://github.com/{item_repo}/issues/{issue_number}",
            "workspacePath": workspace,
        }
        if pr:
            entry["prNumber"] = pr["number"]
            entry["prUrl"]    = pr["url"]
            entry["branch"]   = pr["headRefName"]

        existing = task_state.get_entry(issue_number)
        if existing:
            if existing.get("logPath"):
                entry["logPath"] = existing["logPath"]
            if existing.get("status") != correct_status:
                fixed.append(f"#{issue_number} {issue_title!r}: {existing.get('status')} → {correct_status}")

        task_state.upsert(entry)


def main() -> None:
    fixed: list[str] = []
    for cfg in load_config():
        try:
            rebuild_one(cfg, fixed)
        except Exception as exc:
            fixed.append(f"Error rebuilding {cfg.get('repo', '?')}: {exc}")
    print(json.dumps({"fixed": fixed}))


if __name__ == "__main__":
    main()
