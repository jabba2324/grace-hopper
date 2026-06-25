import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR    = '/app/state';
const LOCK_DIR     = path.join(STATE_DIR, 'active');
const LOG_DIR      = path.join(STATE_DIR, 'logs');
const WORKSPACES   = '/workspaces';

type Status   = 'running' | 'stale' | 'completed' | 'failed' | 'unknown';
type TaskType = 'task' | 'resume' | 'ci-fix';

interface Task {
    key:           string;       // unique id for the tree item
    issueNumber:   number;
    prNumber?:     number;       // set for ci-fix tasks
    type:          TaskType;
    status:        Status;
    workspacePath: string | null;
    logPath:       string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

function readTail(filePath: string, lines: number): string {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content.split('\n').slice(-lines).join('\n');
    } catch { return ''; }
}

function getStatus(issueNumber: number, logPath: string): Status {
    const lockFile = path.join(LOCK_DIR, `issue-${issueNumber}.lock`);
    if (fs.existsSync(lockFile)) {
        try {
            const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
            return isPidAlive(pid) ? 'running' : 'stale';
        } catch { return 'stale'; }
    }
    const tail = readTail(logPath, 8);
    if (/=== (Implementation complete|Resume complete|CI fix complete|Pushed\.|Moved issue|Commented on|PR created)/.test(tail)) {
        return 'completed';
    }
    if (/=== ERROR/.test(tail)) { return 'failed'; }
    return 'unknown';
}

function findWorkspace(issueNumber: number): string | null {
    try {
        const dirs = fs.readdirSync(WORKSPACES);
        const match = dirs.find(d => d.endsWith(`-${issueNumber}`) && fs.statSync(path.join(WORKSPACES, d)).isDirectory());
        return match ? path.join(WORKSPACES, match) : null;
    } catch { return null; }
}

// ── Task discovery ────────────────────────────────────────────────────────────

function discoverTasks(): Task[] {
    const tasks = new Map<string, Task>();

    let logFiles: string[] = [];
    try { logFiles = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')); }
    catch { return []; }

    // Group log files by key (most recent wins)
    const latestLog = new Map<string, string>();
    for (const file of logFiles.sort()) {
        // issue-{N}-{ts}.log
        const taskMatch = file.match(/^issue-(\d+)-\d+\.log$/);
        if (taskMatch) {
            latestLog.set(`task-${taskMatch[1]}`, file);
            continue;
        }
        // resume-issue-{N}-{ts}.log
        const resumeMatch = file.match(/^resume-issue-(\d+)-\d+\.log$/);
        if (resumeMatch) {
            latestLog.set(`resume-${resumeMatch[1]}`, file);
            continue;
        }
        // ci-fix-pr{PR}-{ts}.log
        const ciMatch = file.match(/^ci-fix-pr(\d+)-\d+\.log$/);
        if (ciMatch) {
            latestLog.set(`ci-fix-${ciMatch[1]}`, file);
        }
    }

    for (const [key, file] of latestLog) {
        const logPath = path.join(LOG_DIR, file);

        if (key.startsWith('task-') || key.startsWith('resume-')) {
            const type: TaskType  = key.startsWith('resume-') ? 'resume' : 'task';
            const issueNumber = parseInt(key.split('-').pop()!, 10);
            tasks.set(key, {
                key,
                issueNumber,
                type,
                status:        getStatus(issueNumber, logPath),
                workspacePath: findWorkspace(issueNumber),
                logPath,
            });
        } else if (key.startsWith('ci-fix-')) {
            const prNumber = parseInt(key.replace('ci-fix-', ''), 10);
            // Parse issue number from first log line:
            // "=== CI fix for PR #N (issue #M) — run ..."
            let issueNumber = 0;
            try {
                const firstLine = fs.readFileSync(logPath, 'utf8').split('\n')[0];
                const m = firstLine.match(/issue #(\d+)/);
                if (m) { issueNumber = parseInt(m[1], 10); }
            } catch {}

            tasks.set(key, {
                key,
                issueNumber,
                prNumber,
                type:          'ci-fix',
                status:        getStatus(issueNumber || prNumber, logPath),
                workspacePath: issueNumber ? findWorkspace(issueNumber) : null,
                logPath,
            });
        }
    }

    // Sort: running first, then by issue number desc
    const order: Record<Status, number> = { running: 0, stale: 1, failed: 2, unknown: 3, completed: 4 };
    return [...tasks.values()].sort((a, b) => {
        const s = order[a.status] - order[b.status];
        return s !== 0 ? s : b.issueNumber - a.issueNumber;
    });
}

// ── Tree item ─────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<Status, string> = {
    running:   '$(sync~spin)',
    stale:     '$(warning)',
    completed: '$(check)',
    failed:    '$(error)',
    unknown:   '$(question)',
};

const TYPE_LABEL: Record<TaskType, string> = {
    'task':    'new task',
    'resume':  'resume',
    'ci-fix':  'ci fix',
};

class TaskItem extends vscode.TreeItem {
    constructor(public readonly task: Task) {
        const icon    = STATUS_ICON[task.status];
        const typeStr = TYPE_LABEL[task.type];
        const ref     = task.type === 'ci-fix' && task.prNumber
            ? `PR #${task.prNumber}`
            : `#${task.issueNumber}`;

        super(`${icon}  ${ref} · ${typeStr}`, vscode.TreeItemCollapsibleState.None);

        this.description = task.workspacePath ?? '(no workspace yet)';
        this.tooltip     = [
            `Status: ${task.status}`,
            `Type: ${task.type}`,
            task.workspacePath ? `Workspace: ${task.workspacePath}` : '',
            `Log: ${task.logPath}`,
        ].filter(Boolean).join('\n');

        if (task.workspacePath) {
            this.command = {
                command:   'graceHopper.openWorkspace',
                title:     'Open Workspace',
                arguments: [task.workspacePath],
            };
        }
    }
}

// ── Provider ──────────────────────────────────────────────────────────────────

class GraceHopperProvider implements vscode.TreeDataProvider<TaskItem> {
    private readonly _onChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onChange.event;

    refresh(): void { this._onChange.fire(); }

    getTreeItem(el: TaskItem): vscode.TreeItem { return el; }

    getChildren(): TaskItem[] {
        const tasks = discoverTasks();
        if (tasks.length === 0) {
            const empty = new TaskItem({
                key: 'empty', issueNumber: 0, type: 'task',
                status: 'unknown', workspacePath: null,
                logPath: '',
            });
            empty.label       = 'No tasks found';
            empty.description = '';
            empty.tooltip     = 'Waiting for Grace Hopper to pick up a ticket';
            return [empty];
        }
        return tasks.map(t => new TaskItem(t));
    }
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    const provider = new GraceHopperProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('graceHopper', provider),

        vscode.commands.registerCommand('graceHopper.refresh', () => provider.refresh()),

        vscode.commands.registerCommand('graceHopper.openWorkspace', (wsPath: string) => {
            vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.file(wsPath),
                { forceNewWindow: false },
            );
        }),
    );

    // Auto-refresh when state files change
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(STATE_DIR, '**/*'),
    );
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    context.subscriptions.push(watcher);

    // Fallback poll every 15s
    const timer = setInterval(() => provider.refresh(), 15_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {}
