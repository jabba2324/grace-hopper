import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const STATE_DIR  = '/app/state';
const TASKS_FILE = path.join(STATE_DIR, 'tasks.json');
const LOCK_DIR   = path.join(STATE_DIR, 'active');

type Status   = 'running' | 'dispatched' | 'stale' | 'completed' | 'failed' | 'paused' | 'unknown';
type TaskType = 'task' | 'resume' | 'ci-fix';

interface Task {
    issueNumber:   number;
    prNumber?:     number;
    type:          TaskType;
    status:        Status;
    title:         string;
    repo:          string;
    branch?:       string;
    issueUrl?:     string;
    prUrl?:        string;
    workspacePath?: string;
    logPath?:      string;
    pid?:          number;
    failedRunId?:  string;
    skipReason?:   string;
    startedAt?:    string;
    updatedAt?:    string;
}

let out: vscode.OutputChannel;

// ── Helpers ──────────────────────────────────────────────────────────────────

function lockExists(issueNumber: number): boolean {
    return fs.existsSync(path.join(LOCK_DIR, `issue-${issueNumber}.lock`));
}

function liveStatus(task: Task): Status {
    // Use lock file existence — PIDs are from the agent container and can't
    // be checked from code-server (different PID namespace).
    if (lockExists(task.issueNumber)) { return 'running'; }
    if (task.status === 'running' || task.status === 'dispatched') { return 'stale'; }
    return task.status;
}

function getCurrentBranch(workspacePath: string): string | null {
    try {
        const head = fs.readFileSync(path.join(workspacePath, '.git', 'HEAD'), 'utf8').trim();
        const m = head.match(/^ref: refs\/heads\/(.+)$/);
        return m ? m[1] : null;
    } catch { return null; }
}

// ── Load tasks ────────────────────────────────────────────────────────────────

const STATUS_ORDER: Record<Status, number> = {
    running:    0,
    stale:      1,
    failed:     2,
    completed:  3,
    dispatched: 4,
    paused:     5,
    unknown:    6,
};

const STATUS_LABEL: Record<Status, string> = {
    running:    'In Progress',
    dispatched: 'In Progress',
    stale:      'In Progress',
    failed:     'Failed',
    completed:  'In Review',
    paused:     'Paused',
    unknown:    'In Progress',
};

function mergeByIssue(tasks: Task[]): Task[] {
    const byIssue = new Map<number, Task>();
    for (const t of tasks) {
        const existing = byIssue.get(t.issueNumber);
        if (!existing) {
            byIssue.set(t.issueNumber, { ...t });
        } else {
            // Merge: keep best status, accumulate non-null fields
            const merged: Task = { ...existing };
            for (const [k, v] of Object.entries(t) as [keyof Task, unknown][]) {
                if (v != null && !merged[k]) { (merged as unknown as Record<string, unknown>)[k] = v; }
            }
            merged.status = STATUS_ORDER[t.status] < STATUS_ORDER[existing.status]
                ? t.status : existing.status;
            // Always prefer the most informative title (non-generic)
            if (t.title && !t.title.startsWith('CI fix')) { merged.title = t.title; }
            byIssue.set(t.issueNumber, merged);
        }
    }
    return [...byIssue.values()];
}

function loadTasks(): Task[] {
    try {
        const raw: Task[] = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        out.appendLine(`tasks.json: ${raw.length} record(s)`);
        const withLiveStatus = raw.map(t => ({
            ...t,
            status: liveStatus(t),
            branch: t.branch ?? (t.workspacePath ? getCurrentBranch(t.workspacePath) ?? undefined : undefined),
        }));
        const merged = mergeByIssue(withLiveStatus);
        out.appendLine(`After merge: ${merged.length} issue(s)`);
        return merged.sort((a, b) =>
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.issueNumber - a.issueNumber
        );
    } catch (e) {
        out.appendLine(`Cannot read tasks.json: ${e}`);
        return [];
    }
}

// ── Tree nodes ────────────────────────────────────────────────────────────────

type Node = TaskNode | DetailNode;

class TaskNode extends vscode.TreeItem {
    constructor(public readonly task: Task) {
        super(task.title, vscode.TreeItemCollapsibleState.Collapsed);
        this.description  = STATUS_LABEL[task.status];
        this.tooltip      = `${task.title}\n${task.repo} · ${task.type}`;
        // contextValue drives the inline button visibility in package.json menus
        this.contextValue = task.status === 'running' ? 'runningTask'
                          : task.status === 'paused'  ? 'pausedTask'
                          : task.logPath              ? 'completedTask'
                          : 'task';
    }
}

class DetailNode extends vscode.TreeItem {
    constructor(label: string, value: string, url?: string) {
        super(`${label}:`, vscode.TreeItemCollapsibleState.None);
        this.description = value;
        if (url) {
            this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(url)] };
            this.tooltip = url;
        }
    }
}

function buildDetails(task: Task): DetailNode[] {
    const items: DetailNode[] = [];

    if (task.issueUrl && task.issueNumber) {
        items.push(new DetailNode('Ticket',
            `#${task.issueNumber} · ${task.title}`, task.issueUrl));
    }
    if (task.branch) {
        const branchUrl = task.repo
            ? `https://github.com/${task.repo}/tree/${task.branch}`
            : undefined;
        items.push(new DetailNode('Branch', task.branch, branchUrl));
    }
    if (task.prUrl) {
        items.push(new DetailNode('Pull Request',
            task.prNumber ? `#${task.prNumber}` : task.prUrl, task.prUrl));
    }
    if (task.workspacePath) {
        const node = new DetailNode('Workspace', task.workspacePath);
        node.command = {
            command:   'graceHopper.openWorkspace',
            title:     'Open Workspace',
            arguments: [task.workspacePath],
        };
        items.push(node);
    }
    if (task.pid !== undefined) {
        const running = lockExists(task.issueNumber);
        items.push(new DetailNode('Process', `PID ${task.pid} · ${running ? 'running' : 'exited'}`));
    }
    if (task.failedRunId) {
        items.push(new DetailNode('Failed Run', task.failedRunId));
    }
    if (task.logPath && fs.existsSync(task.logPath)) {
        const node = new DetailNode('Tail Logs', path.basename(task.logPath));
        node.command = {
            command:   'graceHopper.tailLogs',
            title:     'Tail Logs',
            arguments: [task.logPath, task.title],
        };
        node.tooltip = task.logPath;
        items.push(node);
    }
    if (task.status === 'running') {
        const node = new DetailNode('Pause', 'stop Claude and pause this task');
        node.command = {
            command:   'graceHopper.pauseTask',
            title:     'Pause',
            arguments: [task.issueNumber, task.title],
        };
        items.push(node);
    }
    if (task.status === 'paused') {
        const node = new DetailNode('Resume', 'allow Grace to pick this up again');
        node.command = {
            command:   'graceHopper.resumeTask',
            title:     'Resume',
            arguments: [task.issueNumber, task.title],
        };
        items.push(node);
    }
    if (task.updatedAt) {
        items.push(new DetailNode('Updated', task.updatedAt));
    }

    return items;
}

// ── Provider ──────────────────────────────────────────────────────────────────

class GraceHopperProvider implements vscode.TreeDataProvider<Node> {
    private readonly _onChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onChange.event;
    private cache: Task[] = [];

    refresh(): void {
        this.cache = loadTasks();
        this._onChange.fire();
    }

    getTreeItem(el: Node): vscode.TreeItem { return el; }

    getChildren(element?: Node): Node[] {
        if (!element) {
            if (this.cache.length === 0) {
                return [new DetailNode('No tasks yet', STATE_DIR)];
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
    out.appendLine(`Activated — tasks file: ${TASKS_FILE}`);
    out.appendLine(`tasks.json exists: ${fs.existsSync(TASKS_FILE)}`);

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

        vscode.commands.registerCommand('graceHopper.pauseTask',
            (arg: TaskNode | number, title?: string) => {
                const n = arg instanceof TaskNode ? arg.task.issueNumber : arg;
                const t = arg instanceof TaskNode ? arg.task.title : (title ?? `#${n}`);
                fs.writeFileSync(path.join(STATE_DIR, `pause-${n}`), '');
                vscode.window.showInformationMessage(
                    `Pausing "${t}" — Claude will stop within ~5 seconds`
                );
            }),

        vscode.commands.registerCommand('graceHopper.resumeTask',
            (arg: TaskNode | number, title?: string) => {
                const n = arg instanceof TaskNode ? arg.task.issueNumber : arg;
                const t = arg instanceof TaskNode ? arg.task.title : (title ?? `#${n}`);
                try {
                    const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) as Record<string, unknown>[];
                    for (const entry of tasks) {
                        if (entry['issueNumber'] === n && entry['status'] === 'paused') {
                            entry['status'] = 'dispatched';
                            delete entry['pid'];
                        }
                    }
                    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
                    vscode.window.showInformationMessage(
                        `"${t}" resumed — Grace will pick it up on the next poll`
                    );
                } catch (e) {
                    vscode.window.showErrorMessage(`Failed to resume: ${e}`);
                }
            }),

        vscode.commands.registerCommand('graceHopper.tailLogs',
            (arg: TaskNode | string, title?: string) => {
                const logPath = arg instanceof TaskNode ? arg.task.logPath : arg;
                const name    = arg instanceof TaskNode ? arg.task.title   : (title ?? 'Logs');
                if (!logPath) { return; }
                const terminal = vscode.window.createTerminal({
                    name,
                    location: vscode.TerminalLocation.Panel,
                });
                terminal.sendText(`tail -f "${logPath}"`);
                terminal.show();
            }),

    );

    try {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), 'tasks.json'),
        );
        watcher.onDidChange(() => provider.refresh());
        watcher.onDidCreate(() => provider.refresh());
        context.subscriptions.push(watcher);
    } catch (e) { out.appendLine(`Watcher error: ${e}`); }

    const timer = setInterval(() => provider.refresh(), 15_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {}
