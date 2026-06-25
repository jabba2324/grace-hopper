import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const STATE_DIR  = '/app/state';
const LOCK_DIR   = path.join(STATE_DIR, 'active');
const LOG_DIR    = path.join(STATE_DIR, 'logs');
const WORKSPACES = '/workspaces';

type Status   = 'running' | 'stale' | 'completed' | 'failed' | 'unknown';
type TaskType = 'task' | 'resume' | 'ci-fix';

interface Task {
    key:           string;
    issueNumber:   number;
    prNumber?:     number;
    type:          TaskType;
    status:        Status;
    label:         string;
    workspacePath: string | null;
    logPath:       string;
}

let out: vscode.OutputChannel;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function readTail(filePath: string, lines: number): string {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content.split('\n').slice(-lines).join('\n');
    } catch { return ''; }
}

function readFirstLine(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf8').split('\n')[0] ?? '';
    } catch { return ''; }
}

function getLockStatus(issueNumber: number): Status | null {
    const lockFile = path.join(LOCK_DIR, `issue-${issueNumber}.lock`);
    if (!fs.existsSync(lockFile)) { return null; }
    try {
        const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
        return isPidAlive(pid) ? 'running' : 'stale';
    } catch { return 'stale'; }
}

function getLogStatus(logPath: string): Status {
    if (!logPath) { return 'unknown'; }
    const tail = readTail(logPath, 8);
    if (/=== (Implementation complete|Resume complete|CI fix complete|Pushed\.|Moved issue|Commented on|PR created)/.test(tail)) {
        return 'completed';
    }
    if (/=== ERROR/.test(tail)) { return 'failed'; }
    return 'unknown';
}

function findWorkspace(issueNumber: number): string | null {
    try {
        const match = fs.readdirSync(WORKSPACES)
            .find(d => d.endsWith(`-${issueNumber}`) &&
                  fs.statSync(path.join(WORKSPACES, d)).isDirectory());
        return match ? path.join(WORKSPACES, match) : null;
    } catch { return null; }
}

// ── Task discovery ────────────────────────────────────────────────────────────

function discoverFromLogs(): Task[] {
    const tasks = new Map<string, Task>();

    let logFiles: string[] = [];
    try {
        logFiles = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
        out.appendLine(`Log dir OK — ${logFiles.length} file(s)`);
    } catch (e) {
        out.appendLine(`Cannot read log dir ${LOG_DIR}: ${e}`);
        return [];
    }

    // Group by key, keep most recent (files sort by timestamp in name)
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
        const firstLine = readFirstLine(logPath);

        if (key.startsWith('task-') || key.startsWith('resume-')) {
            const type: TaskType = key.startsWith('resume-') ? 'resume' : 'task';
            const issueNumber = parseInt(key.split('-').pop()!, 10);
            const titleMatch = firstLine.match(/issue #\d+: (.+) ===/);
            const label = titleMatch ? titleMatch[1] : `Issue #${issueNumber}`;
            const lockStatus = getLockStatus(issueNumber);
            const status = lockStatus ?? getLogStatus(logPath);
            tasks.set(key, {
                key, issueNumber, type, status, label,
                workspacePath: findWorkspace(issueNumber),
                logPath,
            });
        } else if (key.startsWith('ci-fix-')) {
            const prNumber = parseInt(key.replace('ci-fix-', ''), 10);
            const m = firstLine.match(/PR #\d+ \(issue #(\d+)\)/);
            const issueNumber = m ? parseInt(m[1], 10) : 0;
            const lockStatus = issueNumber ? getLockStatus(issueNumber) : null;
            const status = lockStatus ?? getLogStatus(logPath);
            tasks.set(key, {
                key, issueNumber, prNumber, type: 'ci-fix', status,
                label: `PR #${prNumber}`,
                workspacePath: issueNumber ? findWorkspace(issueNumber) : null,
                logPath,
            });
        }
    }
    return [...tasks.values()];
}

function discoverActiveLocks(): Task[] {
    // Show any running lock that has no log entry yet
    const active: Task[] = [];
    try {
        for (const file of fs.readdirSync(LOCK_DIR)) {
            const m = file.match(/^issue-(\d+)\.lock$/);
            if (!m) { continue; }
            const issueNumber = parseInt(m[1], 10);
            const lockPath = path.join(LOCK_DIR, file);
            try {
                const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
                const status: Status = isPidAlive(pid) ? 'running' : 'stale';
                active.push({
                    key: `lock-${issueNumber}`,
                    issueNumber,
                    type: 'task',
                    status,
                    label: `Issue #${issueNumber}`,
                    workspacePath: findWorkspace(issueNumber),
                    logPath: '',
                });
            } catch { /* skip bad lock file */ }
        }
    } catch { /* lock dir may not exist yet */ }
    return active;
}

function discoverCIDispatched(): Task[] {
    const ciFile = path.join(STATE_DIR, 'ci_dispatched.json');
    try {
        const entries: string[] = JSON.parse(fs.readFileSync(ciFile, 'utf8'));
        out.appendLine(`ci_dispatched: ${entries.length} entry(s)`);
        // Group by PR number, keep most recent entry per PR
        const byPr = new Map<number, string>();
        for (const entry of entries) {
            const prNumber = parseInt(entry.split(':')[0], 10);
            byPr.set(prNumber, entry);
        }
        return [...byPr.entries()].map(([prNumber, entry]) => {
            const [, sha] = entry.split(':');
            return {
                key:           `ci-dispatched-${prNumber}`,
                issueNumber:   0,
                prNumber,
                type:          'ci-fix' as TaskType,
                status:        'completed' as Status,
                label:         `PR #${prNumber}`,
                workspacePath: null,
                logPath:       '',
            };
        });
    } catch (e) {
        out.appendLine(`ci_dispatched.json not readable: ${e}`);
        return [];
    }
}

function discoverTasks(): Task[] {
    out.appendLine('--- refresh ---');
    const logTasks   = discoverFromLogs();
    const lockTasks  = discoverActiveLocks();
    const ciTasks    = discoverCIDispatched();

    // Merge: log entries take precedence over lock-only and ci-dispatched entries
    const merged = new Map<string, Task>();

    // CI dispatched entries (lowest priority — log entries will override)
    for (const t of ciTasks) {
        const logKey = `ci-fix-${t.prNumber}`;
        if (!logTasks.some(lt => lt.prNumber === t.prNumber)) {
            merged.set(t.key, t);
        }
    }
    // Lock-only tasks (no log file yet)
    for (const t of lockTasks) {
        if (!logTasks.some(lt => lt.issueNumber === t.issueNumber)) {
            merged.set(t.key, t);
        }
    }
    // Log tasks (highest priority)
    for (const t of logTasks) { merged.set(t.key, t); }

    const order: Record<Status, number> =
        { running: 0, stale: 1, failed: 2, unknown: 3, completed: 4 };
    const result = [...merged.values()].sort((a, b) => {
        const s = order[a.status] - order[b.status];
        return s !== 0 ? s : b.issueNumber - a.issueNumber;
    });

    out.appendLine(`Total tasks: ${result.length}`);
    return result;
}

// ── Tree item ─────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<Status, string> = {
    running:   '$(sync~spin)',
    stale:     '$(warning)',
    completed: '$(check)',
    failed:    '$(error)',
    unknown:   '$(circle-outline)',
};

const TYPE_BADGE: Record<TaskType, string> = {
    'task':   'task',
    'resume': 'resume',
    'ci-fix': 'ci fix',
};

class TaskItem extends vscode.TreeItem {
    constructor(public readonly task: Task) {
        super(
            `${STATUS_ICON[task.status]}  ${task.label}`,
            vscode.TreeItemCollapsibleState.None,
        );

        this.description = task.workspacePath
            ? task.workspacePath
            : `(${TYPE_BADGE[task.type]})`;

        this.tooltip = [
            `Status:    ${task.status}`,
            `Type:      ${task.type}`,
            task.prNumber   ? `PR:        #${task.prNumber}`   : '',
            task.issueNumber ? `Issue:     #${task.issueNumber}` : '',
            task.workspacePath ? `Workspace: ${task.workspacePath}` : '',
            task.logPath       ? `Log:       ${task.logPath}`       : '',
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
                status: 'unknown', label: 'No tasks found',
                workspacePath: null, logPath: '',
            });
            empty.description = `state dir: ${STATE_DIR}`;
            empty.tooltip = 'Check the Grace Hopper output channel for diagnostics';
            return [empty];
        }
        return tasks.map(t => new TaskItem(t));
    }
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    out = vscode.window.createOutputChannel('Grace Hopper');
    out.appendLine(`Grace Hopper extension activated — state dir: ${STATE_DIR}`);
    out.appendLine(`Log dir: ${LOG_DIR}`);
    out.appendLine(`Log dir exists: ${fs.existsSync(LOG_DIR)}`);
    out.appendLine(`State dir exists: ${fs.existsSync(STATE_DIR)}`);

    const provider = new GraceHopperProvider();

    context.subscriptions.push(
        out,
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

    // Watch state dir for changes
    try {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), '**/*'),
        );
        watcher.onDidChange(() => provider.refresh());
        watcher.onDidCreate(() => provider.refresh());
        watcher.onDidDelete(() => provider.refresh());
        context.subscriptions.push(watcher);
    } catch (e) {
        out.appendLine(`File watcher failed: ${e}`);
    }

    // Fallback poll every 15s
    const timer = setInterval(() => provider.refresh(), 15_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {}
