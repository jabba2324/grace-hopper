"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const STATE_DIR = '/app/state';
const TASKS_FILE = path.join(STATE_DIR, 'tasks.json');
const REPOS_FILE = path.join(STATE_DIR, 'repos.json');
const LOCK_DIR = path.join(STATE_DIR, 'active');
const CLAUDE_HOME = '/home/agent/.claude';
const PENDING_CLAUDE = path.join(STATE_DIR, 'pending-claude.json');
let out;
// ── Helpers ───────────────────────────────────────────────────────────────────
function lockExists(issueNumber) {
    return fs.existsSync(path.join(LOCK_DIR, `issue-${issueNumber}.lock`));
}
function liveStatus(task) {
    if (lockExists(task.issueNumber)) {
        return 'running';
    }
    if (task.status === 'running') {
        return 'stale';
    }
    return task.status;
}
function latestSessionId(task) {
    if (task.sessionId)
        return task.sessionId;
    const workspacePath = task.workspacePath;
    if (!workspacePath)
        return undefined;
    const slug = workspacePath.replace(/\//g, '-');
    const dir = path.join(CLAUDE_HOME, 'projects', slug);
    try {
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        return files[0]?.name.replace('.jsonl', '');
    }
    catch {
        return undefined;
    }
}
function getCurrentBranch(workspacePath) {
    try {
        const head = fs.readFileSync(path.join(workspacePath, '.git', 'HEAD'), 'utf8').trim();
        const m = head.match(/^ref: refs\/heads\/(.+)$/);
        return m ? m[1] : null;
    }
    catch {
        return null;
    }
}
// ── Config ────────────────────────────────────────────────────────────────────
function readReposFile() {
    try {
        if (fs.existsSync(REPOS_FILE)) {
            return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
        }
    }
    catch { }
    return [];
}
function loadRepos() {
    const fromFile = readReposFile();
    if (fromFile.length > 0)
        return fromFile;
    // Fall back to env vars for single-repo setups that haven't migrated
    const repo = process.env['GITHUB_REPO'];
    const num = process.env['GITHUB_PROJECT_NUMBER'];
    if (repo && num) {
        return [{ repo, projectNumber: parseInt(num, 10) }];
    }
    return [];
}
// ── Load tasks ────────────────────────────────────────────────────────────────
const STATUS_ORDER = {
    running: 0,
    failed: 1,
    paused: 2,
    completed: 3,
    stale: 4,
    dispatched: 5,
    unknown: 6,
};
const STATUS_LABEL = {
    running: 'In Progress',
    dispatched: 'In Progress',
    stale: 'In Progress',
    failed: 'Failed',
    completed: 'In Review',
    paused: 'Paused',
    unknown: 'In Progress',
};
function mergeByIssue(tasks) {
    const byIssue = new Map();
    for (const t of tasks) {
        const existing = byIssue.get(t.issueNumber);
        if (!existing) {
            byIssue.set(t.issueNumber, { ...t });
        }
        else {
            const merged = { ...existing };
            for (const [k, v] of Object.entries(t)) {
                if (v != null && !merged[k]) {
                    merged[k] = v;
                }
            }
            merged.status = STATUS_ORDER[t.status] < STATUS_ORDER[existing.status]
                ? t.status : existing.status;
            if (t.title && !t.title.startsWith('CI fix')) {
                merged.title = t.title;
            }
            byIssue.set(t.issueNumber, merged);
        }
    }
    return [...byIssue.values()];
}
function loadTasks() {
    try {
        const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        out.appendLine(`tasks.json: ${raw.length} record(s)`);
        const withLiveStatus = raw.map(t => ({
            ...t,
            status: liveStatus(t),
            branch: t.branch ?? (t.workspacePath ? getCurrentBranch(t.workspacePath) ?? undefined : undefined),
        }));
        const merged = mergeByIssue(withLiveStatus);
        out.appendLine(`After merge: ${merged.length} issue(s)`);
        return merged.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.issueNumber - a.issueNumber);
    }
    catch (e) {
        out.appendLine(`Cannot read tasks.json: ${e}`);
        return [];
    }
}
class RepoNode extends vscode.TreeItem {
    constructor(config, tasks) {
        super(config.repo, vscode.TreeItemCollapsibleState.Expanded);
        this.config = config;
        this.tasks = tasks;
        this.description = `project #${config.projectNumber} · ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
        this.tooltip = `${config.repo}\nProject #${config.projectNumber}`;
        this.contextValue = 'repo';
    }
}
class TaskNode extends vscode.TreeItem {
    constructor(task) {
        super(task.title, vscode.TreeItemCollapsibleState.Collapsed);
        this.task = task;
        this.description = STATUS_LABEL[task.status];
        this.tooltip = `${task.title}\n${task.repo} · ${task.type}`;
        this.contextValue = task.status === 'running' ? 'runningTask'
            : task.status === 'paused' ? 'pausedTask'
                : task.status === 'failed' ? 'failedTask'
                    : task.logPath ? 'completedTask'
                        : 'task';
    }
}
class DetailNode extends vscode.TreeItem {
    constructor(label, value, url) {
        super(`${label}:`, vscode.TreeItemCollapsibleState.None);
        this.description = value;
        if (url) {
            this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(url)] };
            this.tooltip = url;
        }
    }
}
function buildDetails(task) {
    const items = [];
    if (task.issueUrl && task.issueNumber) {
        items.push(new DetailNode('Ticket', `#${task.issueNumber} · ${task.title}`, task.issueUrl));
    }
    if (task.branch) {
        const branchUrl = task.repo
            ? `https://github.com/${task.repo}/tree/${task.branch}`
            : undefined;
        items.push(new DetailNode('Branch', task.branch, branchUrl));
    }
    if (task.prUrl) {
        items.push(new DetailNode('Pull Request', task.prNumber ? `#${task.prNumber}` : task.prUrl, task.prUrl));
    }
    if (task.workspacePath) {
        const node = new DetailNode('Workspace', task.workspacePath);
        node.command = {
            command: 'graceHopper.openWorkspace',
            title: 'Open Workspace',
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
            command: 'graceHopper.tailLogs',
            title: 'Tail Logs',
            arguments: [task.logPath, task.title],
        };
        node.tooltip = task.logPath;
        items.push(node);
    }
    if (task.status === 'running') {
        const node = new DetailNode('Pause', 'stop Claude and pause this task');
        node.command = {
            command: 'graceHopper.pauseTask',
            title: 'Pause',
            arguments: [task.issueNumber, task.title],
        };
        items.push(node);
    }
    if (task.status === 'paused' || task.status === 'failed') {
        const label = task.status === 'paused' ? 'Resume' : 'Retry';
        const node = new DetailNode(label, 'allow Grace to pick this up again');
        node.command = {
            command: 'graceHopper.resumeTask',
            title: label,
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
class GraceHopperProvider {
    constructor() {
        this._onChange = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onChange.event;
        this.repos = [];
        this.tasks = [];
    }
    refresh() {
        this.repos = loadRepos();
        this.tasks = loadTasks();
        this._onChange.fire();
    }
    getTreeItem(el) { return el; }
    getChildren(element) {
        if (!element) {
            if (this.repos.length === 0) {
                return [new DetailNode('No repositories configured', 'click + to add one')];
            }
            return this.repos.map(cfg => new RepoNode(cfg, this.tasks.filter(t => t.repo === cfg.repo)));
        }
        if (element instanceof RepoNode) {
            if (element.tasks.length === 0) {
                return [new DetailNode('No tasks yet', 'waiting for issues…')];
            }
            return element.tasks.map(t => new TaskNode(t));
        }
        if (element instanceof TaskNode) {
            return buildDetails(element.task);
        }
        return [];
    }
}
// ── GitHub quickpick helpers ──────────────────────────────────────────────────
function runGh(...args) {
    return new Promise((resolve, reject) => {
        cp.exec(['gh', ...args].join(' '), { encoding: 'utf8', env: { ...process.env, GH_TOKEN: process.env['GITHUB_TOKEN'] ?? '' }, timeout: 15000 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
    });
}
async function pickableRepos() {
    const raw = await runGh('repo', 'list', '--json', 'nameWithOwner,description', '--limit', '100');
    const repos = JSON.parse(raw);
    return repos.map(r => ({ label: r.nameWithOwner, description: r.description || '', repoName: r.nameWithOwner }));
}
async function pickableProjects(owner) {
    const raw = await runGh('project', 'list', '--owner', owner, '--format', 'json', '--limit', '50');
    const data = JSON.parse(raw);
    return (data.projects ?? []).map(p => ({
        label: p.title,
        description: `#${p.number}`,
        projectNumber: p.number,
    }));
}
async function fetchStatusOptions(owner, projectNumber) {
    const raw = await runGh('project', 'field-list', String(projectNumber), '--owner', owner, '--format', 'json', '--limit', '30');
    const data = JSON.parse(raw);
    const field = data.fields?.find(f => f.name === 'Status' && Array.isArray(f.options));
    return field?.options?.map(o => o.name) ?? [];
}
// ── Activation ────────────────────────────────────────────────────────────────
function activate(context) {
    out = vscode.window.createOutputChannel('Grace Hopper');
    out.appendLine(`Activated — tasks file: ${TASKS_FILE}`);
    // Open a Claude terminal if a session was queued before a workspace reload
    if (fs.existsSync(PENDING_CLAUDE)) {
        try {
            const { workspacePath, sessionId } = JSON.parse(fs.readFileSync(PENDING_CLAUDE, 'utf8'));
            fs.unlinkSync(PENDING_CLAUDE);
            const cmd = sessionId ? `claude --resume ${sessionId}` : `claude`;
            const terminal = vscode.window.createTerminal({
                name: `Claude — ${path.basename(workspacePath)}`,
                location: vscode.TerminalLocation.Panel,
                cwd: workspacePath,
            });
            terminal.sendText(cmd);
            terminal.show();
        }
        catch (e) {
            out.appendLine(`Failed to resume pending Claude session: ${e}`);
        }
    }
    const provider = new GraceHopperProvider();
    provider.refresh();
    context.subscriptions.push(out, vscode.window.registerTreeDataProvider('graceHopper', provider), vscode.commands.registerCommand('graceHopper.refresh', () => provider.refresh()), vscode.commands.registerCommand('graceHopper.addRepo', async () => {
        // Step 1 — pick a repo (spinner shows while gh fetches)
        const repoItem = await vscode.window.showQuickPick(pickableRepos().catch(e => { out.appendLine(`fetchRepos: ${e}`); return []; }), { title: 'Add Repository — Select GitHub repository', placeHolder: 'Select a repository to monitor…', matchOnDescription: true });
        if (!repoItem) {
            return;
        }
        const repo = repoItem.repoName;
        const owner = repo.split('/')[0];
        // Step 2 — pick a project board (spinner shows while gh fetches)
        const projectItem = await vscode.window.showQuickPick(pickableProjects(owner).catch(e => { out.appendLine(`fetchProjects: ${e}`); return []; }), { title: `Add Repository · ${repo} — Select project board`, placeHolder: 'Select the GitHub Projects v2 board to watch…' });
        if (!projectItem) {
            return;
        }
        const projectNumber = projectItem.projectNumber;
        // Steps 3–5 — map the project's actual Status column names to Grace's roles.
        // These only show when the project has a Status single-select field; if the
        // fetch fails or the field is absent the defaults ("Todo" / "In Progress" /
        // "In Review") are used silently.
        let statusTodo = 'Todo';
        let statusInProgress = 'In Progress';
        let statusInReview = 'In Review';
        const statusOptions = await fetchStatusOptions(owner, projectNumber)
            .catch(e => { out.appendLine(`fetchStatusOptions: ${e}`); return []; });
        if (statusOptions.length > 0) {
            const todoStatus = await vscode.window.showQuickPick(statusOptions, {
                title: `Add Repository · ${repo} — Map Status: To Do`,
                placeHolder: 'Which column should Grace pick new tasks from?',
            });
            if (!todoStatus) {
                return;
            }
            statusTodo = todoStatus;
            const inProgressStatus = await vscode.window.showQuickPick(statusOptions, {
                title: `Add Repository · ${repo} — Map Status: In Progress`,
                placeHolder: 'Which column means the task is being worked on (or is resumable)?',
            });
            if (!inProgressStatus) {
                return;
            }
            statusInProgress = inProgressStatus;
            const inReviewStatus = await vscode.window.showQuickPick(statusOptions, {
                title: `Add Repository · ${repo} — Map Status: In Review`,
                placeHolder: 'Which column means a PR is open and Grace should watch CI?',
            });
            if (!inReviewStatus) {
                return;
            }
            statusInReview = inReviewStatus;
        }
        // Seed from env-var repo so we don't silently drop existing single-repo setup
        const existing = readReposFile();
        if (existing.length === 0) {
            const envRepo = process.env['GITHUB_REPO'];
            const envNum = process.env['GITHUB_PROJECT_NUMBER'];
            if (envRepo && envNum && envRepo !== repo) {
                existing.push({ repo: envRepo, projectNumber: parseInt(envNum, 10) });
            }
        }
        const repos = existing.filter(r => r.repo !== repo);
        repos.push({ repo, projectNumber, statusTodo, statusInProgress, statusInReview });
        fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
        provider.refresh();
        vscode.window.showInformationMessage(`Now monitoring ${repo} (project #${projectNumber})`);
    }), vscode.commands.registerCommand('graceHopper.removeRepo', (node) => {
        const repo = node.config.repo;
        const repos = readReposFile().filter(r => r.repo !== repo);
        fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
        provider.refresh();
        vscode.window.showInformationMessage(`Stopped monitoring ${repo}`);
    }), vscode.commands.registerCommand('graceHopper.rebuildState', () => {
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rebuilding state from GitHub…', cancellable: false }, () => new Promise(resolve => {
            try {
                const result = cp.execSync('python3 /app/scripts/rebuild_state.py', {
                    encoding: 'utf8',
                    env: { ...process.env, GH_TOKEN: process.env['GITHUB_TOKEN'] ?? '' },
                    timeout: 30000,
                });
                const { fixed } = JSON.parse(result.trim() || '{"fixed":[]}');
                provider.refresh();
                vscode.window.showInformationMessage(fixed.length > 0
                    ? `Rebuilt — ${fixed.length} task(s) corrected:\n${fixed.join('\n')}`
                    : 'State is consistent with GitHub — nothing to fix');
            }
            catch (e) {
                vscode.window.showErrorMessage(`Rebuild failed: ${e}`);
            }
            resolve();
        }));
    }), vscode.commands.registerCommand('graceHopper.openWorkspace', (wsPath) => {
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), { forceNewWindow: false });
    }), vscode.commands.registerCommand('graceHopper.pauseTask', (arg, title) => {
        const n = arg instanceof TaskNode ? arg.task.issueNumber : arg;
        const t = arg instanceof TaskNode ? arg.task.title : (title ?? `#${n}`);
        fs.writeFileSync(path.join(STATE_DIR, `pause-${n}`), '');
        vscode.window.showInformationMessage(`Pausing "${t}" — Claude will stop within ~5 seconds`);
    }), vscode.commands.registerCommand('graceHopper.resumeTask', (arg, title) => {
        const n = arg instanceof TaskNode ? arg.task.issueNumber : arg;
        const t = arg instanceof TaskNode ? arg.task.title : (title ?? `#${n}`);
        try {
            const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
            for (const entry of tasks) {
                if (entry['issueNumber'] === n && (entry['status'] === 'paused' || entry['status'] === 'failed')) {
                    entry['status'] = 'dispatched';
                    delete entry['pid'];
                }
            }
            fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
            vscode.window.showInformationMessage(`"${t}" resumed — Grace will pick it up on the next poll`);
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to resume: ${e}`);
        }
    }), vscode.commands.registerCommand('graceHopper.tailLogs', (arg, title) => {
        const logPath = arg instanceof TaskNode ? arg.task.logPath : arg;
        const name = arg instanceof TaskNode ? arg.task.title : (title ?? 'Logs');
        if (!logPath) {
            return;
        }
        const terminal = vscode.window.createTerminal({
            name,
            location: vscode.TerminalLocation.Panel,
        });
        terminal.sendText(`tail -f "${logPath}"`);
        terminal.show();
    }), vscode.commands.registerCommand('graceHopper.openClaude', (arg) => {
        const task = arg instanceof TaskNode ? arg.task : undefined;
        const workspacePath = task?.workspacePath;
        if (!workspacePath || !task) {
            vscode.window.showErrorMessage('No workspace path for this task');
            return;
        }
        const sessionId = latestSessionId(task);
        fs.writeFileSync(PENDING_CLAUDE, JSON.stringify({ workspacePath, sessionId }));
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspacePath), { forceNewWindow: false });
    }));
    try {
        const tasksWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), 'tasks.json'));
        tasksWatcher.onDidChange(() => provider.refresh());
        tasksWatcher.onDidCreate(() => provider.refresh());
        const reposWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), 'repos.json'));
        reposWatcher.onDidChange(() => provider.refresh());
        reposWatcher.onDidCreate(() => provider.refresh());
        const lockWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(STATE_DIR, 'active')), '*.lock'));
        lockWatcher.onDidCreate(() => provider.refresh());
        lockWatcher.onDidDelete(() => provider.refresh());
        context.subscriptions.push(tasksWatcher, reposWatcher, lockWatcher);
    }
    catch (e) {
        out.appendLine(`Watcher error: ${e}`);
    }
    const timer = setInterval(() => provider.refresh(), 2000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
function deactivate() { }
//# sourceMappingURL=extension.js.map