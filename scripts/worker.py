#!/usr/bin/env python3
"""
Unified worker — handles new tasks, resumes, and CI fixes.
Replaces worker.sh. Called by poll_projects.py via subprocess.Popen.

Required env vars (set by poll_projects.py):
  TASK_MODE               new | resume | ci-fix
  REPO_NAME_WITH_OWNER    owner/repo
  ISSUE_NUMBER            GitHub issue number
  ISSUE_TITLE             Issue title
  ISSUE_BODY              Issue body
  PROJECT_ID, ITEM_ID, STATUS_FIELD_ID   for board updates

Mode-specific:
  resume:  PR_BRANCH, PREV_SESSION_ID (optional)
  ci-fix:  PR_NUMBER, PR_BRANCH, FAILED_RUN_ID, PREV_SESSION_ID (optional)
"""
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from textwrap import dedent

sys.path.insert(0, '/app/scripts')
import state as task_state
from github import GH_ENV, GH_TOKEN, gql

# ── Config ────────────────────────────────────────────────────────────────────

MODE          = os.environ['TASK_MODE']
REPO_NWO      = os.environ['REPO_NAME_WITH_OWNER']
ISSUE_NUM     = int(os.environ['ISSUE_NUMBER'])
ISSUE_TITLE   = os.environ['ISSUE_TITLE']
ISSUE_BODY    = os.environ.get('ISSUE_BODY', '')
PR_BRANCH     = os.environ.get('PR_BRANCH', '')
PR_NUMBER_ENV = os.environ.get('PR_NUMBER', '')
FAILED_RUN    = os.environ.get('FAILED_RUN_ID', '')
PREV_SESSION  = os.environ.get('PREV_SESSION_ID', '')
PROJECT_ID    = os.environ.get('PROJECT_ID', '')
ITEM_ID       = os.environ.get('ITEM_ID', '')
STATUS_FIELD  = os.environ.get('STATUS_FIELD_ID', '')
IN_REVIEW     = os.environ.get('PROJECT_STATUS_IN_REVIEW', 'In Review')
CLAUDE_MODEL  = os.environ.get('CLAUDE_MODEL', 'claude-sonnet-4-6')
GH_USER       = os.environ.get('GITHUB_USERNAME', '')

REPO_NAME  = REPO_NWO.split('/')[-1]
WORKSPACE  = Path(f'/workspaces/{REPO_NAME}-{ISSUE_NUM}')
STATE_DIR  = Path('/app/state')
LOCK_DIR   = STATE_DIR / 'active'
LOG_DIR    = STATE_DIR / 'logs'
LOCKFILE   = LOCK_DIR / f'issue-{ISSUE_NUM}.lock'
STATE_TYPE = 'task' if MODE in ('new', 'resume') else MODE

ts = datetime.now().strftime('%Y%m%d-%H%M%S')
LOGFILE = LOG_DIR / f'{MODE}-issue-{ISSUE_NUM}-{ts}.log'

# ── Logging (file + stdout) ───────────────────────────────────────────────────

LOG_DIR.mkdir(parents=True, exist_ok=True)
LOCK_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(str(LOGFILE), mode='a'),
    ],
)
log = logging.getLogger(__name__)

# ── Mutable task context (updated as work progresses) ────────────────────────

ctx: dict = {
    'branch':     PR_BRANCH,
    'default_br': 'main',
    'pr_url':     '',
    'pr_number':  PR_NUMBER_ENV,
    'session_id': '',
}

# ── Git helper ────────────────────────────────────────────────────────────────

def git(*args: str, cwd: Path | None = None, check: bool = True, capture: bool = False) -> str:
    """Run a git command. Logs output unless capture=True. Raises on failure."""
    result = subprocess.run(
        ['git', *args],
        cwd=str(cwd or WORKSPACE),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True,
    )
    output = result.stdout.strip()
    if not capture and output:
        log.info(output)
    if check and result.returncode != 0:
        raise RuntimeError(f'git {" ".join(args)} exited {result.returncode}')
    return output


def gh(*args: str, check: bool = True) -> str:
    result = subprocess.run(['gh', *args], capture_output=True, text=True, env=GH_ENV)
    if check and result.returncode != 0:
        raise RuntimeError(f'gh {" ".join(args)} failed: {result.stderr.strip()}')
    return result.stdout.strip()


def get_default_branch() -> str:
    raw = git('symbolic-ref', 'refs/remotes/origin/HEAD', check=False, capture=True)
    return raw.replace('refs/remotes/origin/', '') if raw else 'main'

# ── State ─────────────────────────────────────────────────────────────────────

def save_state(status: str) -> None:
    try:
        task_state.upsert({
            'issueNumber':   ISSUE_NUM,
            'type':          STATE_TYPE,
            'status':        status,
            'title':         ISSUE_TITLE,
            'repo':          REPO_NWO,
            'issueUrl':      f'https://github.com/{REPO_NWO}/issues/{ISSUE_NUM}',
            'branch':        ctx['branch'] or None,
            'workspacePath': str(WORKSPACE),
            'logPath':       str(LOGFILE),
            'pid':           os.getpid() if status == 'running' else None,
            'prUrl':         ctx['pr_url'] or None,
            'prNumber':      int(ctx['pr_number']) if ctx['pr_number'] else None,
            'failedRunId':   FAILED_RUN or None,
            'sessionId':     ctx['session_id'] or None,
        })
    except Exception as exc:
        log.warning('save_state failed: %s', exc)

# ── CLAUDE.md ─────────────────────────────────────────────────────────────────

def write_claude_md(status: str) -> None:
    if not (WORKSPACE / '.git').is_dir():
        return
    try:
        branch    = ctx['branch']
        def_br    = ctx['default_br']
        git_log   = git('log', f'{def_br}..HEAD', '--oneline', capture=True) or '  (none yet)'
        diff_stat = git('diff', f'{def_br}..HEAD', '--stat', capture=True) or '  (none yet)'
        uncommit  = git('status', '--short', capture=True) or '  (working tree is clean)'
        pr_line   = f'- **PR:** {ctx["pr_url"]}' if ctx['pr_url'] else ''

        claude_dir = WORKSPACE / '.claude'
        claude_dir.mkdir(exist_ok=True)

        exclude = WORKSPACE / '.git' / 'info' / 'exclude'
        if exclude.exists() and '.claude/CLAUDE.md' not in exclude.read_text():
            with exclude.open('a') as f:
                f.write('.claude/CLAUDE.md\n')

        updated = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        (claude_dir / 'CLAUDE.md').write_text(dedent(f"""\
            # Grace Hopper — Task Context

            > Auto-generated by the Grace Hopper agent. Do not commit this file.

            ## Goal

            **Issue #{ISSUE_NUM}: {ISSUE_TITLE}**

            {ISSUE_BODY}

            ## Status

            - **Outcome:** {status}
            - **Mode:** {MODE}
            - **Branch:** `{branch}`
            - **Updated:** {updated}
            {pr_line}

            ## Work done

            Commits ahead of `{def_br}`:
            ```
            {git_log}
            ```

            Files changed:
            ```
            {diff_stat}
            ```

            Uncommitted changes:
            ```
            {uncommit}
            ```

            ## Continuing this work

                claude --dangerously-skip-permissions
        """))
    except Exception as exc:
        log.warning('write_claude_md failed: %s', exc)

# ── Git setup (mode-specific) ─────────────────────────────────────────────────

def _clone() -> None:
    WORKSPACE.parent.mkdir(parents=True, exist_ok=True)
    clone_url = f'https://{GH_USER}:{GH_TOKEN}@github.com/{REPO_NWO}.git'
    git('clone', clone_url, str(WORKSPACE), cwd=WORKSPACE.parent)


def setup_new() -> None:
    slug = re.sub(r'-+', '-', re.sub(r'[^a-z0-9]', '-', ISSUE_TITLE.lower())).strip('-')[:40]
    ctx['branch'] = f'issue/{ISSUE_NUM}/{slug}'

    if (WORKSPACE / '.git').is_dir():
        log.info('Workspace exists — resetting to default branch')
        git('fetch', 'origin')
        def_br = get_default_branch()
        git('checkout', def_br)
        git('reset', '--hard', f'origin/{def_br}')
    else:
        _clone()

    ctx['default_br'] = get_default_branch()
    try:
        git('checkout', '-b', ctx['branch'])
    except RuntimeError:
        git('checkout', ctx['branch'])


def setup_resume() -> None:
    ctx['branch'] = PR_BRANCH
    if (WORKSPACE / '.git').is_dir():
        log.info('Workspace exists — syncing branch')
        git('fetch', 'origin')
        git('checkout', PR_BRANCH)
        if git('rev-parse', '--verify', f'origin/{PR_BRANCH}', check=False, capture=True):
            git('reset', '--hard', f'origin/{PR_BRANCH}')
        else:
            log.info('origin/%s not found — keeping local branch as-is', PR_BRANCH)
    else:
        log.info('No workspace — cloning')
        _clone()
        git('checkout', PR_BRANCH)
    ctx['default_br'] = get_default_branch()


def setup_ci_fix() -> str:
    ctx['branch'] = PR_BRANCH
    if (WORKSPACE / '.git').is_dir():
        log.info('Workspace exists — switching to PR branch')
        git('fetch', 'origin')
        git('checkout', PR_BRANCH)
        git('reset', '--hard', f'origin/{PR_BRANCH}')
    else:
        log.info('No workspace — cloning')
        _clone()
        git('checkout', PR_BRANCH)
    ctx['default_br'] = get_default_branch()
    log.info('Fetching CI failure logs for run %s...', FAILED_RUN)
    result = subprocess.run(
        ['gh', 'run', 'view', FAILED_RUN, '--repo', REPO_NWO, '--log-failed'],
        capture_output=True, text=True, env=GH_ENV,
    )
    return '\n'.join(result.stdout.splitlines()[:400])

# ── Prompt building ───────────────────────────────────────────────────────────

def build_prompt(failed_logs: str = '') -> str:
    if MODE == 'new':
        return dedent(f"""\
            You are an autonomous software engineer. Your task is described in a GitHub issue.

            ## Issue #{ISSUE_NUM}: {ISSUE_TITLE}

            {ISSUE_BODY}

            ## Tools available

            `gh` CLI is authenticated — use it to inspect CI, PRs, and issues:
                gh run list --repo {REPO_NWO} --status failure
                gh run view <id> --log-failed
                gh pr checks <pr>

            ## Instructions

            1. Understand the issue thoroughly before making changes.
            2. Implement the required changes.
            3. Write or update tests where appropriate.
            4. Ensure all existing tests pass.
            5. Stage and commit all changes with a clear descriptive message.

            Do NOT create a pull request — the system handles that automatically.
            Do not ask for confirmation — work autonomously to completion.
        """)

    if MODE == 'resume':
        if PREV_SESSION:
            return dedent(f"""\
                You are resuming issue #{ISSUE_NUM}: {ISSUE_TITLE}. You were interrupted — continue from where you left off. If the work is already complete, verify tests pass and ensure everything is committed.

                Do NOT create a pull request — the system handles that automatically.
                Do not ask for confirmation — work autonomously to completion.
            """)
        branch  = ctx['branch']
        def_br  = ctx['default_br']
        git_log = git('log', f'{def_br}..HEAD', '--oneline', capture=True) or '  (none)'
        diff    = git('diff', f'{def_br}..HEAD', '--stat', capture=True) or '  (none)'
        status  = git('status', '--short', capture=True) or '  (working tree is clean)'
        return dedent(f"""\
            You are resuming an in-progress task that was interrupted.

            ## Issue #{ISSUE_NUM}: {ISSUE_TITLE}

            {ISSUE_BODY}

            ## Work already completed on branch `{branch}`

            Commits ahead of {def_br}:
            ```
            {git_log}
            ```

            Files changed so far:
            ```
            {diff}
            ```

            Uncommitted changes:
            ```
            {status}
            ```

            ## Instructions

            1. Read the changed files to understand what was already implemented.
            2. Determine what remains to fully resolve the issue.
            3. Continue without redoing completed work.
            4. Ensure all tests pass.
            5. Stage and commit remaining changes.

            Do NOT create a pull request — the system handles that automatically.
            Do not ask for confirmation — work autonomously to completion.
        """)

    if MODE == 'ci-fix':
        pr_num = ctx['pr_number']
        if PREV_SESSION:
            return dedent(f"""\
                CI is failing on PR #{pr_num} (run {FAILED_RUN}). Fix the failures.

                ```
                {failed_logs}
                ```

                Do NOT create a new pull request — one already exists as PR #{pr_num}.
                Do not ask for confirmation — work autonomously to completion.
            """)
        return dedent(f"""\
            You are fixing a failing CI pipeline on PR #{pr_num}.

            ## Issue #{ISSUE_NUM}: {ISSUE_TITLE}

            {ISSUE_BODY}

            ## Failing CI logs (run {FAILED_RUN})

            ```
            {failed_logs}
            ```

            ## Tools available

                gh run view {FAILED_RUN} --repo {REPO_NWO} --log-failed
                gh run list --repo {REPO_NWO} --branch {ctx['branch']}
                gh pr checks {pr_num} --repo {REPO_NWO}

            ## Instructions

            1. Read the failure logs carefully to understand what is failing and why.
            2. Fix the failing tests or build errors only — do not change unrelated code.
            3. Ensure all tests pass.
            4. Stage and commit your fixes with a clear message explaining what was fixed.

            Do NOT create a pull request — one already exists as PR #{pr_num}.
            Do not ask for confirmation — work autonomously to completion.
        """)

    raise ValueError(f'Unknown MODE: {MODE!r}')

# ── Claude runner ─────────────────────────────────────────────────────────────

def run_claude(prompt: str) -> int:
    session_file = Path(tempfile.mktemp())
    env = {
        **os.environ,
        'CLAUDE_PROMPT':         prompt,
        'CLAUDE_LOGFILE':        str(LOGFILE),
        'CLAUDE_MODEL':          CLAUDE_MODEL,
        'CLAUDE_CWD':            str(WORKSPACE),
        'CLAUDE_RESUME_SESSION': PREV_SESSION,
        'CLAUDE_PAUSE_FILE':     f'/app/state/pause-{ISSUE_NUM}',
        'CLAUDE_SESSION_FILE':   str(session_file),
    }
    result = subprocess.run(['node', '/app/scripts/run_claude.js'], env=env)
    if session_file.exists():
        ctx['session_id'] = session_file.read_text().strip()
        session_file.unlink(missing_ok=True)
    return result.returncode

# ── Push + PR + board update ──────────────────────────────────────────────────

_GET_OPTIONS = """
query($id:ID!){node(id:$id){...on ProjectV2SingleSelectField{options{id name}}}}
"""
_MOVE_STATUS = """
mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){
  updateProjectV2ItemFieldValue(
    input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}
  ){projectV2Item{id}}
}
"""


def push_and_pr() -> None:
    git('push', '-u', 'origin', ctx['branch'])

    if MODE == 'ci-fix':
        ctx['pr_url'] = gh('pr', 'view', ctx['branch'], '--repo', REPO_NWO,
                           '--json', 'url', '--jq', '.url', check=False)
        log.info('=== CI fix pushed — CI will rerun on PR #%s ===', ctx['pr_number'])
        return

    existing = gh('pr', 'view', ctx['branch'], '--repo', REPO_NWO,
                  '--json', 'url,number', check=False)
    if existing:
        data = json.loads(existing)
        ctx['pr_url']    = data['url']
        ctx['pr_number'] = str(data['number'])
        log.info('=== PR already exists: %s ===', ctx['pr_url'])
        return

    pr_out = gh('pr', 'create',
                '--repo', REPO_NWO,
                '--title', ISSUE_TITLE,
                '--body', f'Closes #{ISSUE_NUM}',
                '--base', ctx['default_br'],
                '--head', ctx['branch'])
    ctx['pr_url']    = pr_out.splitlines()[-1].strip()
    ctx['pr_number'] = ctx['pr_url'].split('/')[-1]
    log.info('=== PR created: %s ===', ctx['pr_url'])

    gh('issue', 'comment', str(ISSUE_NUM), '--repo', REPO_NWO,
       '--body', f'Pull request raised: {ctx["pr_url"]}', check=False)

    if not (STATUS_FIELD and ITEM_ID and PROJECT_ID):
        return
    try:
        options = gql(_GET_OPTIONS, {'id': STATUS_FIELD})
        in_review_id = next(
            (o['id'] for o in options['node']['options'] if o['name'] == IN_REVIEW),
            None,
        )
        if in_review_id:
            gql(_MOVE_STATUS, {'p': PROJECT_ID, 'i': ITEM_ID,
                               'f': STATUS_FIELD, 'v': in_review_id})
            log.info('=== Moved to In Review ===')
    except Exception as exc:
        log.warning('Failed to move board status: %s', exc)

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    log.info('=== [%s] issue #%s: %s ===', MODE, ISSUE_NUM, ISSUE_TITLE)
    log.info('=== Repo: %s ===', REPO_NWO)

    LOCKFILE.write_text(str(os.getpid()))
    status = 'failed'
    try:
        failed_logs = ''
        if MODE == 'new':
            setup_new()
        elif MODE == 'resume':
            setup_resume()
        elif MODE == 'ci-fix':
            failed_logs = setup_ci_fix()
        else:
            raise ValueError(f'Unknown TASK_MODE: {MODE!r}')

        save_state('running')
        write_claude_md('running')

        prompt = build_prompt(failed_logs)
        log.info('=== Running Claude ===')
        runner_exit = run_claude(prompt)

        if runner_exit == 2:
            log.info('=== Paused ===')
            status = 'paused'
            return

        if runner_exit != 0:
            raise RuntimeError(f'Claude runner exited with code {runner_exit}')

        log.info('=== Implementation complete ===')
        push_and_pr()
        status = 'completed'
        log.info('=== Done ===')

    except Exception as exc:
        log.error('=== ERROR: %s ===', exc)
    finally:
        write_claude_md(status)
        save_state(status)
        LOCKFILE.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
