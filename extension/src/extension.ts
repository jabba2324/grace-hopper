import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const STATE_DIR  = '/app/state';
const LOCK_DIR   = path.join(STATE_DIR, 'active');
const LOG_DIR    = path.join(STATE_DIR, 'logs');
const WORKSPACES = '/workspaces';
const GITHUB_REPO = process.env.GITHUB_REPO ?? '';

type Status   = 'running' | 'stale' | 'completed' | 'failed' | 'unknown';
type TaskType = 'task' | 'resume' | 'ci-fix';

interface Task {
    key:           string;
    issueNumber:   number;
    prNumber?:     number;
    type:          TaskType;
    status:        Status;
    title:         string;
    repo:          string;       // owner/repo
    branch?:       string;
    issueUrl?:     string;
    prUrl?:        string;
    workspacePath: string | null;
    logPath:       string;
    pid?:          number;
}

let out: vscode.OutputChannel;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLines(filePath: string): string[] {
    try { return fs.readFileSync(filePath, 'utf8').split('\n'); } catch { return []; }
}

function ghJson<T>(args: string[]): T | null {
    try {
        const result = cp.execSync(`gh ${args.join(' ')}`, {
            encoding: 'utf8',
            env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN ?? '' },
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(result) as T;
    } catch { return null; }
}

function getCurrentBranch(workspacePath: string): string | null {
    try {
        const head = fs.readFileSync(path.join(workspacePath, '.git', 'HEAD'), 'utf8').trim();
        const m = head.match(/^ref: refs\/heads\/(.+)$/);
        return m ? m[1] : null;
    } catch { return null; }
}

function findWorkspace(issueNumber: number): string | null {
    try {
        const match = fs.readdirSync(WORKSPACES)
            .find(d => d.endsWith(`-${issueNumber}`) &&
                  fs.statSync(path.join(WORKSPACES, d)).isDirectory());
        return match ? path.join(WORKSPACES, match) : null;
    } catch { return null; }
}

function issueUrl(repo: string, n: number): string | undefined {
    return repo ? `https://github.com/${repo}/issues/${n}` : undefined;
}

function prUrl(repo: string, n: number): string | undefined {
    return repo ? `https://github.com/${repo}/pull/${n}` : undefined;
}

// ── Parse log files ───────────────────────────────────────────────────────────

interface LogInfo {
    title:       string;
    repo:        string;
    branch?:     string;
    prUrl?:      string;
    issueNumber: number;
    prNumber?:   number;
    status:      Status;
    pid?:        number;
}

function parseLog(logPath: string, type: TaskType, issueNum: number, prNum?: number): LogInfo {
    const lines = readLines(logPath);
    let title = type === 'ci-fix' ? `PR #${prNum}` : `Issue #${issueNum}`;
    let repo  = GITHUB_REPO;
    let branch: string | undefined;
    let foundPrUrl: string | undefined;
    let pid: number | undefined;

    for (const line of lines) {
        // "=== Starting task for issue #3: Perform test coverage report ==="
        const titleM = line.match(/=== (?:Starting task for|Resuming) issue #\d+: (.+?) ===/);
        if (titleM) { title = titleM[1]; }

        // "=== Repo: jabba2324/cardy-api ==="
        // "=== Repo: jabba2324/cardy-api | Branch: issue/... ==="
        const repoM = line.match(/=== Repo: ([^\s|]+)/);
        if (repoM) { repo = repoM[1]; }

        // "=== Repo: ... | Branch: issue/... ==="
        const branchM = line.match(/Branch: ([^\s]+) ===/);
        if (branchM) { branch = branchM[1]; }

        // "=== PR created: https://... ==="
        const prM = line.match(/=== PR created: (https:\/\/github\.com\/[^\s]+) ===/);
        if (prM) { foundPrUrl = prM[1]; }
    }

    // PID from lock file
    const lockFile = path.join(LOCK_DIR, `issue-${issueNum}.lock`);
    if (fs.existsSync(lockFile)) {
        try { pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10); } catch {}
    }

    // Status
    let status: Status = 'unknown';
    if (pid !== undefined) {
        status = isPidAlive(pid) ? 'running' : 'stale';
    } else {
        const tail = lines.slice(-8).join('\n');
        if (/=== (Implementation complete|Resume complete|Pushed\.|Moved issue|Commented on|PR created)/.test(tail)) {
            status = 'completed';
        } else if (/=== ERROR/.test(tail)) {
            status = 'failed';
        }
    }

    return { title, repo, branch, prUrl: foundPrUrl, issueNumber: issueNum, prNumber: prNum, status, pid };
}

// ── Task discovery ────────────────────────────────────────────────────────────

function discoverTasks(): Task[] {
    out.appendLine('--- refresh ---');
    const tasks = new Map<string, Task>();

    // 1. Log files
    let logFiles: string[] = [];
    try {
        logFiles = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
        out.appendLine(`Logs: ${logFiles.length} file(s)`);
    } catch (e) {
        out.appendLine(`Cannot read ${LOG_DIR}: ${e}`);
    }

    const latestLog = new Map<string, string>();
    for (const file of logFiles.sort()) {
        const t = file.match(/^issue-(\d+)-\d+\.log$/);
        if (t) { latestLog.set(`task-${t[1]}`, file); continue; }
        const r = file.match(/^resume-issue-(\d+)-\d+\.log$/);
        if (r) { latestLog.set(`resume-${r[1]}`, file); continue; }
        const c = file.match(/^ci-fix-pr(\d+)-\d+\.log$/);
        if (c) { latestLog.set(`ci-fix-${c[1]}`, file); }
    }

    for (const [key, file] of latestLog) {
        const logPath = path.join(LOG_DIR, file);
        if (key.startsWith('task-') || key.startsWith('resume-')) {
            const type: TaskType = key.startsWith('resume-') ? 'resume' : 'task';
            const issueNumber    = parseInt(key.split('-').pop()!, 10);
            const info           = parseLog(logPath, type, issueNumber);
            const workspace      = findWorkspace(issueNumber);
            tasks.set(key, {
                key, issueNumber, type,
                status:        info.status,
                title:         info.title,
                repo:          info.repo,
                branch:        info.branch ?? (workspace ? getCurrentBranch(workspace) ?? undefined : undefined),
                issueUrl:      issueUrl(info.repo, issueNumber),
                prUrl:         info.prUrl,
                workspacePath: workspace,
                logPath,
                pid:           info.pid,
            });
        } else if (key.startsWith('ci-fix-')) {
            const prNumber = parseInt(key.replace('ci-fix-', ''), 10);
            // parse issue number from first matching line
            const lines = readLines(logPath);
            let issueNumber = 0;
            for (const l of lines) {
                const m = l.match(/issue #(\d+)/);
                if (m) { issueNumber = parseInt(m[1], 10); break; }
            }
            const info      = parseLog(logPath, 'ci-fix', issueNumber || prNumber, prNumber);
            const workspace = issueNumber ? findWorkspace(issueNumber) : null;
            tasks.set(key, {
                key, issueNumber, prNumber, type: 'ci-fix',
                status:        info.status,
                title:         info.title,
                repo:          info.repo,
                branch:        info.branch ?? (workspace ? getCurrentBranch(workspace) ?? undefined : undefined),
                issueUrl:      issueNumber ? issueUrl(info.repo, issueNumber) : undefined,
                prUrl:         prUrl(info.repo, prNumber),
                workspacePath: workspace,
                logPath,
                pid:           info.pid,
            });
        }
    }

    // 2. Active lock files with no log entry yet
    try {
        for (const file of fs.readdirSync(LOCK_DIR)) {
            const m = file.match(/^issue-(\d+)\.lock$/);
            if (!m) { continue; }
            const issueNumber = parseInt(m[1], 10);
            if ([...tasks.values()].some(t => t.issueNumber === issueNumber)) { continue; }
            try {
                const pid     = parseInt(fs.readFileSync(path.join(LOCK_DIR, file), 'utf8').trim(), 10);
                const status: Status = isPidAlive(pid) ? 'running' : 'stale';
                const workspace = findWorkspace(issueNumber);
                tasks.set(`lock-${issueNumber}`, {
                    key: `lock-${issueNumber}`, issueNumber, type: 'task', status,
                    title: `Issue #${issueNumber}`,
                    repo: GITHUB_REPO,
                    branch: workspace ? getCurrentBranch(workspace) ?? undefined : undefined,
                    issueUrl: issueUrl(GITHUB_REPO, issueNumber),
                    workspacePath: workspace,
                    logPath: '',
                    pid,
                });
            } catch {}
        }
    } catch {}

    // 3. CI dispatched entries with no log file
    const ciFile = path.join(STATE_DIR, 'ci_dispatched.json');
    try {
        const entries: string[] = JSON.parse(fs.readFileSync(ciFile, 'utf8'));
        const byPr = new Map<number, string>();
        for (const e of entries) { byPr.set(parseInt(e.split(':')[0], 10), e); }

        for (const [prNumber] of byPr) {
            if ([...tasks.values()].some(t => t.prNumber === prNumber)) { continue; }
            // Fetch PR title via gh
            const detail = ghJson<{ title: string; headRefName: string; url: string }>(
                ['pr', 'view', String(prNumber), '--repo', GITHUB_REPO,
                 '--json', 'title,headRefName,url']
            );
            tasks.set(`ci-dispatched-${prNumber}`, {
                key:           `ci-dispatched-${prNumber}`,
                issueNumber:   0,
                prNumber,
                type:          'ci-fix',
                status:        'completed',
                title:         detail?.title ?? `PR #${prNumber}`,
                repo:          GITHUB_REPO,
                branch:        detail?.headRefName,
                prUrl:         detail?.url ?? prUrl(GITHUB_REPO, prNumber),
                workspacePath: null,
                logPath:       '',
            });
        }
    } catch (e) { out.appendLine(`ci_dispatched: ${e}`); }

    const order: Record<Status, number> =
        { running: 0, stale: 1, failed: 2, unknown: 3, completed: 4 };
    const result = [...tasks.values()].sort((a, b) => {
        const s = order[a.status] - order[b.status];
        return s !== 0 ? s : b.issueNumber - a.issueNumber;
    });
    out.appendLine(`Total: ${result.length} task(s)`);
    return result;
}

// ── Tree nodes ────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<Status, string> = {
    running:   '$(sync~spin)',
    stale:     '$(warning)',
    completed: '$(check)',
    failed:    '$(error)',
    unknown:   '$(circle-outline)',
};

type Node = TaskNode | DetailNode;

class TaskNode extends vscode.TreeItem {
    constructor(public readonly task: Task) {
        super(
            `${STATUS_ICON[task.status]}  ${task.title}`,
            vscode.TreeItemCollapsibleState.Collapsed,
        );
        this.description = task.status;
        this.tooltip     = `${task.title}\n${task.repo} · ${task.type}`;
        this.contextValue = 'task';
    }
}

class DetailNode extends vscode.TreeItem {
    constructor(icon: string, label: string, value: string, url?: string) {
        super(`${icon}  ${label}`, vscode.TreeItemCollapsibleState.None);
        this.description = value;
        if (url) {
            this.command = {
                command:   'vscode.open',
                title:     'Open',
                arguments: [vscode.Uri.parse(url)],
            };
            this.tooltip = url;
        }
    }
}

function buildDetails(task: Task): DetailNode[] {
    const items: DetailNode[] = [];

    if (task.issueUrl) {
        items.push(new DetailNode('$(issues)', 'Ticket', `#${task.issueNumber} ${task.title}`, task.issueUrl));
    }
    if (task.branch) {
        const branchUrl = task.repo
            ? `https://github.com/${task.repo}/tree/${task.branch}`
            : undefined;
        items.push(new DetailNode('$(git-branch)', 'Branch', task.branch, branchUrl));
    }
    if (task.prUrl) {
        const label = task.prNumber ? `#${task.prNumber}` : task.prUrl;
        items.push(new DetailNode('$(git-pull-request)', 'Pull Request', label, task.prUrl));
    }
    if (task.workspacePath) {
        items.push(new DetailNode('$(folder)', 'Workspace', task.workspacePath));
    }
    if (task.pid !== undefined) {
        const alive  = isPidAlive(task.pid);
        const detail = alive ? `${task.pid} (running)` : `${task.pid} (exited)`;
        items.push(new DetailNode('$(terminal)', 'Process', detail));
    }

    return items;
}

// ── Provider ──────────────────────────────────────────────────────────────────

class GraceHopperProvider implements vscode.TreeDataProvider<Node> {
    private readonly _onChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onChange.event;
    private cache: Task[] = [];

    refresh(): void {
        this.cache = discoverTasks();
        this._onChange.fire();
    }

    getTreeItem(el: Node): vscode.TreeItem { return el; }

    getChildren(element?: Node): Node[] {
        if (!element) {
            if (this.cache.length === 0) {
                const empty = new DetailNode('$(circle-slash)', 'No tasks found', STATE_DIR);
                return [empty];
            }
            return this.cache.map(t => new TaskNode(t));
        }
        if (element instanceof TaskNode) {
            return buildDetails(element.task);
        }
        return [];
    }
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    out = vscode.window.createOutputChannel('Grace Hopper');
    out.appendLine(`Activated — GITHUB_REPO=${GITHUB_REPO}`);
    out.appendLine(`STATE_DIR exists: ${fs.existsSync(STATE_DIR)}`);
    out.appendLine(`LOG_DIR   exists: ${fs.existsSync(LOG_DIR)}`);

    const provider = new GraceHopperProvider();
    provider.refresh();

    context.subscriptions.push(
        out,
        vscode.window.registerTreeDataProvider('graceHopper', provider),
        vscode.commands.registerCommand('graceHopper.refresh', () => provider.refresh()),
        vscode.commands.registerCommand('graceHopper.openWorkspace', (wsPath: string) => {
            vscode.commands.executeCommand(
                'vscode.openFolder', vscode.Uri.file(wsPath), { forceNewWindow: false },
            );
        }),
    );

    try {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), '**/*'),
        );
        watcher.onDidChange(() => provider.refresh());
        watcher.onDidCreate(() => provider.refresh());
        watcher.onDidDelete(() => provider.refresh());
        context.subscriptions.push(watcher);
    } catch (e) { out.appendLine(`Watcher error: ${e}`); }

    const timer = setInterval(() => provider.refresh(), 15_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {}
