"""
Shared state management. Keeps state/tasks.json as the single source of
truth for task status, readable by both the polling loops and the
VS Code extension.
"""
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

TASKS_FILE = Path("/app/state/tasks.json")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load() -> list[dict]:
    try:
        return json.loads(TASKS_FILE.read_text()) if TASKS_FILE.exists() else []
    except Exception:
        return []


def _save(tasks: list[dict]) -> None:
    TASKS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        mode="w", dir=TASKS_FILE.parent, delete=False, suffix=".tmp"
    )
    json.dump(tasks, tmp, indent=2)
    tmp.flush()
    tmp.close()
    os.replace(tmp.name, TASKS_FILE)


def _key(issue_number: int, task_type: str) -> tuple:
    return (issue_number, task_type)


def upsert(entry: dict) -> None:
    """Insert or replace a task record, matched on (issueNumber, type)."""
    tasks = _load()
    k = _key(entry["issueNumber"], entry["type"])
    existing = next((t for t in tasks if _key(t["issueNumber"], t["type"]) == k), None)
    if existing:
        existing.update({k: v for k, v in entry.items() if v is not None})
        existing["updatedAt"] = _now()
    else:
        entry.setdefault("startedAt", _now())
        entry["updatedAt"] = _now()
        tasks.append(entry)
    tasks.sort(key=lambda t: (-t.get("issueNumber", 0), t.get("type", "")))
    _save(tasks)


def patch(issue_number: int, task_type: str, **fields) -> None:
    """Update specific fields on an existing record."""
    tasks = _load()
    k = _key(issue_number, task_type)
    for t in tasks:
        if _key(t["issueNumber"], t["type"]) == k:
            for fk, fv in fields.items():
                if fv is not None:
                    t[fk] = fv
                elif fk in t:
                    del t[fk]
            t["updatedAt"] = _now()
            break
    _save(tasks)
