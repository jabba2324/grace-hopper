import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const STATE_DIR  = '/app/state';
const TASKS_FILE = path.join(STATE_DIR, 'tasks.json');
const LOCK_DIR   = path.join(STATE_DIR, 'active');

type Status   = 'running' | 'dispatched' | 'stale' | 'completed' | 'failed' | 'unknown';
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

function isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function liveStatus(task: Task): Status {
    if (!task.pid) { return task.status; }
    const lockFile = path.join(LOCK_DIR, `issue-${task.issueNumber}.lock`);
    if (!fs.existsSync(lockFile)) { return task.status; }
    return isPidAlive(task.pid) ? 'running' : 'stale';
}

function getCurrentBranch(workspacePath: string): string | null {
    try {
        const head = fs.readFileSync(path.join(workspacePath, '.git', 'HEAD'), 'utf8').trim();
        const m = head.match(/^ref: refs\/heads\/(.+)$/);
        return m ? m[1] : null;
    } catch { return null; }
}

// ── Load tasks ────────────────────────────────────────────────────────────────

function loadTasks(): Task[] {
    try {
        const tasks: Task[] = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        out.appendLine(`tasks.json: ${tasks.length} record(s)`);
        return tasks.map(t => ({
            ...t,
            status: liveStatus(t),
            branch: t.branch ?? (t.workspacePath ? getCurrentBranch(t.workspacePath) ?? undefined : undefined),
        }));
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
        this.description  = task.status;
        this.tooltip      = `${task.title}\n${task.repo} · ${task.type}`;
        this.contextValue = 'task';
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
        const alive = isPidAlive(task.pid);
        items.push(new DetailNode('Process', `PID ${task.pid} · ${alive ? 'running' : 'exited'}`));
    }
    if (task.failedRunId) {
        items.push(new DetailNode('Failed Run', task.failedRunId));
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
