#!/usr/bin/env python3
"""
CLI wrapper around state.upsert().  Called from shell scripts via env vars.

Required: TASK_ISSUE_NUMBER, TASK_TYPE, TASK_STATUS
Optional: TASK_TITLE, TASK_REPO, TASK_BRANCH, TASK_WORKSPACE,
          TASK_LOG, TASK_PID, TASK_PR_URL, TASK_PR_NUMBER,
          TASK_PR_BRANCH, TASK_FAILED_RUN_ID, TASK_SESSION_ID
"""
import os
import sys

sys.path.insert(0, "/app/scripts")
import state  # noqa: E402

def e(key: str):
    v = os.environ.get(key, "").strip()
    return v if v else None

issue_number = int(os.environ["TASK_ISSUE_NUMBER"])
repo         = e("TASK_REPO") or ""

entry: dict = {
    "issueNumber":   issue_number,
    "type":          os.environ["TASK_TYPE"],
    "status":        os.environ["TASK_STATUS"],
    "title":         e("TASK_TITLE") or f"Issue #{issue_number}",
    "repo":          repo,
    "issueUrl":      f"https://github.com/{repo}/issues/{issue_number}" if repo else None,
    "branch":        e("TASK_BRANCH") or e("TASK_PR_BRANCH"),
    "workspacePath": e("TASK_WORKSPACE"),
    "logPath":       e("TASK_LOG"),
    "pid":           int(e("TASK_PID")) if e("TASK_PID") else None,
    "prUrl":         e("TASK_PR_URL"),
    "prNumber":      int(e("TASK_PR_NUMBER")) if e("TASK_PR_NUMBER") else None,
    "failedRunId":   e("TASK_FAILED_RUN_ID"),
    "sessionId":     e("TASK_SESSION_ID"),
}

state.upsert(entry)
