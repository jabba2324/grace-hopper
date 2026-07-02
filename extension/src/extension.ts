import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const STATE_DIR      = '/app/state';
const TASKS_FILE     = path.join(STATE_DIR, 'tasks.json');
const REPOS_FILE     = path.join(STATE_DIR, 'repos.json');
const LOCK_DIR       = path.join(STATE_DIR, 'active');
const CLAUDE_HOME    = '/home/agent/.claude';
const PENDING_CLAUDE = path.join(STATE_DIR, 'pending-claude.json');

type Status   = 'running' | 'dispatched' | 'stale' | 'completed' | 'failed' | 'paused' | 'unknown';
type TaskType = 'task' | 'resume' | 'ci-fix';

interface Task {
    issueNumber:    number;
    prNumber?:      number;
    type:           TaskType;
    status:         Status;
    title:          string;
    repo:           string;
    branch?:        string;
    issueUrl?:      string;
    prUrl?:         string;
    workspacePath?: string;
    logPath?:       string;
    pid?:           number;
    failedRunId?:   string;
    sessionId?:     string;
    skipReason?:    string;
    startedAt?:     string;
    updatedAt?:     string;
    inputTokens?:   number;
    outputTokens?:  number;
    model?:         string;
}

interface RepoConfig {
    repo:               string;
    projectNumber:      number;
    statusTodo?:        string;
    statusInProgress?:  string;
    statusInReview?:    string;
}

let out: vscode.OutputChannel;

// ── Helpers ───────────────────────────────────────────────────────────────────

function lockExists(issueNumber: number): boolean {
    return fs.existsSync(path.join(LOCK_DIR, `issue-${issueNumber}.lock`));
}

function liveStatus(task: Task): Status {
    if (lockExists(task.issueNumber)) { return 'running'; }
    if (task.status === 'running') { return 'stale'; }
    return task.status;
}

function latestSessionId(task: Task): string | undefined {
    return task.sessionId;
}

function getCurrentBranch(workspacePath: string): string | null {
    try {
        const head = fs.readFileSync(path.join(workspacePath, '.git', 'HEAD'), 'utf8').trim();
        const m = head.match(/^ref: refs\/heads\/(.+)$/);
        return m ? m[1] : null;
    } catch { return null; }
}

// ── Config ────────────────────────────────────────────────────────────────────

function readReposFile(): RepoConfig[] {
    try {
        if (fs.existsSync(REPOS_FILE)) {
            return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8')) as RepoConfig[];
        }
    } catch { }
    return [];
}

function loadRepos(): RepoConfig[] {
    const fromFile = readReposFile();
    if (fromFile.length > 0) return fromFile;
    // Fall back to env vars for single-repo setups that haven't migrated
    const repo = process.env['GITHUB_REPO'];
    const num  = process.env['GITHUB_PROJECT_NUMBER'];
    if (repo && num) {
        return [{ repo, projectNumber: parseInt(num, 10) }];
    }
    return [];
}

// ── Load tasks ────────────────────────────────────────────────────────────────

const STATUS_ORDER: Record<Status, number> = {
    running:    0,
    failed:     1,
    paused:     2,
    completed:  3,
    stale:      4,
    dispatched: 5,
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
            const merged: Task = { ...existing };
            for (const [k, v] of Object.entries(t) as [keyof Task, unknown][]) {
                if (v != null && !merged[k]) { (merged as unknown as Record<string, unknown>)[k] = v; }
            }
            merged.status = STATUS_ORDER[t.status] < STATUS_ORDER[existing.status]
                ? t.status : existing.status;
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

// ── Token cost ────────────────────────────────────────────────────────────────

function tokenCost(task: Task): string | undefined {
    if (!task.inputTokens && !task.outputTokens) { return undefined; }
    const model = task.model ?? '';
    let inputPer1M  = 5.00;
    let outputPer1M = 25.00;
    if (model.includes('haiku')) {
        inputPer1M  = 1.00;
        outputPer1M = 5.00;
    } else if (model.includes('sonnet')) {
        inputPer1M  = 3.00;
        outputPer1M = 15.00;
    }
    const cost = ((task.inputTokens  ?? 0) / 1_000_000) * inputPer1M
               + ((task.outputTokens ?? 0) / 1_000_000) * outputPer1M;
    if (cost < 0.01) { return '<$0.01'; }
    return `$${cost.toFixed(2)}`;
}

// ── Tree nodes ────────────────────────────────────────────────────────────────

type Node = RepoNode | TaskNode | DetailNode;

class RepoNode extends vscode.TreeItem {
    constructor(
        public readonly config: RepoConfig,
        public readonly tasks: Task[],
    ) {
        super(config.repo, vscode.TreeItemCollapsibleState.Expanded);
        this.description  = `project #${config.projectNumber} · ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
        this.tooltip      = `${config.repo}\nProject #${config.projectNumber}`;
        this.contextValue = 'repo';
    }
}

class TaskNode extends vscode.TreeItem {
    constructor(public readonly task: Task) {
        super(task.title, vscode.TreeItemCollapsibleState.Collapsed);
        const cost = tokenCost(task);
        this.description  = cost ? `${STATUS_LABEL[task.status]} · ${cost}` : STATUS_LABEL[task.status];
        this.tooltip      = `${task.title}\n${task.repo} · ${task.type}`;
        const base = task.status === 'running' ? 'runningTask'
                   : task.status === 'paused'  ? 'pausedTask'
                   : task.status === 'failed'  ? 'failedTask'
                   : task.logPath              ? 'completedTask'
                   : 'task';
        this.contextValue = base + (task.sessionId ? 'WithSession' : '');
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
    if (task.sessionId) {
        const node = new DetailNode('Watch', 'stream the live agent conversation');
        node.command = {
            command:   'graceHopper.openClaude',
            title:     'Watch',
            arguments: [new TaskNode(task)],
        };
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
    if (task.status === 'paused' || task.status === 'failed') {
        const label = task.status === 'paused' ? 'Resume' : 'Retry';
        const node  = new DetailNode(label, 'allow Grace to pick this up again');
        node.command = {
            command:   'graceHopper.resumeTask',
            title:     label,
            arguments: [task.issueNumber, task.title],
        };
        items.push(node);
    }
    const cost = tokenCost(task);
    if (cost) {
        const tokens = `${((task.inputTokens ?? 0) / 1000).toFixed(0)}k in / ${((task.outputTokens ?? 0) / 1000).toFixed(0)}k out`;
        items.push(new DetailNode('Cost', `${cost} · ${tokens}`));
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
    private repos: RepoConfig[] = [];
    private tasks: Task[] = [];

    refresh(): void {
        this.repos = loadRepos();
        this.tasks = loadTasks();
        this._onChange.fire();
    }

    getTasks(): Task[] { return this.tasks; }

    getTreeItem(el: Node): vscode.TreeItem { return el; }

    getChildren(element?: Node): Node[] {
        if (!element) {
            if (this.repos.length === 0) {
                return [new DetailNode('No repositories configured', 'click + to add one')];
            }
            return this.repos.map(cfg =>
                new RepoNode(cfg, this.tasks.filter(t => t.repo === cfg.repo))
            );
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

// VS Code strips GITHUB_TOKEN from the extension host process (security policy).
// GRACE_GITHUB_TOKEN is the same value passed under a name that isn't filtered.
function ghEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GH_TOKEN: process.env['GRACE_GITHUB_TOKEN'] || process.env['GITHUB_TOKEN'] || '' };
}

// Shell-joined exec — fine for simple commands with no special characters in args.
function runGh(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(['gh', ...args].join(' '),
            { encoding: 'utf8', env: ghEnv(), timeout: 15_000 },
            (err, stdout) => err ? reject(err) : resolve(stdout.trim()),
        );
    });
}

// execFile-based exec — safe for args that may contain spaces/special chars (e.g. GraphQL queries).
function runGhFile(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile('gh', args,
            { encoding: 'utf8', env: ghEnv(), timeout: 15_000 },
            (err, stdout) => err ? reject(err) : resolve(stdout.trim()),
        );
    });
}

interface RepoItem extends vscode.QuickPickItem { repoName: string; }
interface ProjectItem extends vscode.QuickPickItem { projectNumber: number; }

async function pickableRepos(): Promise<readonly RepoItem[]> {
    const raw   = await runGh('repo', 'list', '--json', 'nameWithOwner,description', '--limit', '100');
    const repos = JSON.parse(raw) as { nameWithOwner: string; description: string }[];
    return repos.map(r => ({ label: r.nameWithOwner, description: r.description || '', repoName: r.nameWithOwner }));
}

// Fetch only projects linked to the specific repository.
// gh project list requires read:org scope; repository.projectsV2 works with project scope.
async function pickableProjects(owner: string, repo: string): Promise<readonly ProjectItem[]> {
    const q = 'query($o:String!,$r:String!){repository(owner:$o,name:$r){projectsV2(first:50){nodes{number title}}}}';
    const raw   = await runGhFile('api', 'graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `r=${repo}`);
    const nodes = JSON.parse(raw)?.data?.repository?.projectsV2?.nodes as Array<{ number: number; title: string }> ?? [];
    return nodes.map(p => ({ label: p.title, description: `#${p.number}`, projectNumber: p.number }));
}

async function fetchStatusOptions(owner: string, projectNumber: number): Promise<string[]> {
    const userQ = 'query($l:String!,$n:Int!){user(login:$l){projectV2(number:$n){fields(first:20){nodes{...on ProjectV2SingleSelectField{name options{name}}}}}}}';
    const orgQ  = 'query($l:String!,$n:Int!){organization(login:$l){projectV2(number:$n){fields(first:20){nodes{...on ProjectV2SingleSelectField{name options{name}}}}}}}';
    let nodes: Array<{ name?: string; options?: Array<{ name: string }> }> = [];
    try {
        const raw = await runGhFile('api', 'graphql', '-f', `query=${userQ}`, '-f', `l=${owner}`, '-F', `n=${projectNumber}`);
        nodes = JSON.parse(raw)?.data?.user?.projectV2?.fields?.nodes ?? [];
    } catch { /* fall through */ }
    if (nodes.length === 0) {
        const raw = await runGhFile('api', 'graphql', '-f', `query=${orgQ}`, '-f', `l=${owner}`, '-F', `n=${projectNumber}`);
        nodes = JSON.parse(raw)?.data?.organization?.projectV2?.fields?.nodes ?? [];
    }
    const statusField = nodes.find(f => f?.name === 'Status' && Array.isArray(f?.options));
    return statusField?.options?.map(o => o.name) ?? [];
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    out = vscode.window.createOutputChannel('Grace Hopper');
    out.appendLine(`Activated — tasks file: ${TASKS_FILE}`);

    // Open a session terminal if one was queued before a workspace reload
    if (fs.existsSync(PENDING_CLAUDE)) {
        try {
            const { workspacePath, sessionId } = JSON.parse(fs.readFileSync(PENDING_CLAUDE, 'utf8'));
            fs.unlinkSync(PENDING_CLAUDE);
            const cmd = sessionId
                ? `python3 /app/scripts/attach_session.py ${sessionId}`
                : `claude`;
            const terminal = vscode.window.createTerminal({
                name: `Agent — ${path.basename(workspacePath)}`,
                location: vscode.TerminalLocation.Panel,
                cwd: workspacePath,
            });
            terminal.sendText(cmd);
            terminal.show();
        } catch (e) { out.appendLine(`Failed to open session terminal: ${e}`); }
    }

    const pauseBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    pauseBar.command  = 'graceHopper.pauseRunning';
    pauseBar.text     = '$(debug-pause) Pause Agent';
    pauseBar.tooltip  = 'Pause the running Grace Hopper agent';
    pauseBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    context.subscriptions.push(pauseBar);

    function updatePauseBar(tasks: Task[]): void {
        const running = tasks.filter(t => liveStatus(t) === 'running');
        if (running.length > 0) { pauseBar.show(); } else { pauseBar.hide(); }
    }

    const provider = new GraceHopperProvider();
    provider.refresh();

    context.subscriptions.push(
        out,
        vscode.window.registerTreeDataProvider('graceHopper', provider),

        vscode.commands.registerCommand('graceHopper.refresh', () => provider.refresh()),

        vscode.commands.registerCommand('graceHopper.pauseRunning', async () => {
            const tasks = loadTasks().filter(t => liveStatus(t) === 'running');
            if (tasks.length === 0) {
                vscode.window.showInformationMessage('No agent is currently running.');
                return;
            }
            const task = tasks.length === 1 ? tasks[0] : await vscode.window.showQuickPick(
                tasks.map(t => ({ label: t.title || `#${t.issueNumber}`, description: t.repo, task: t })),
                { title: 'Pause which agent?' },
            ).then(item => item?.task);
            if (!task) { return; }
            fs.writeFileSync(path.join(STATE_DIR, `pause-${task.issueNumber}`), '');
            vscode.window.showInformationMessage(`Pausing "${task.title || `#${task.issueNumber}`}" — agent will stop within ~5 seconds`);
        }),

        vscode.commands.registerCommand('graceHopper.addRepo', async () => {
            // Step 1 — pick a repo (spinner shows while gh fetches)
            const repoItem = await vscode.window.showQuickPick(
                pickableRepos().catch(e => { out.appendLine(`fetchRepos: ${e}`); return []; }),
                { title: 'Add Repository — Select GitHub repository', placeHolder: 'Select a repository to monitor…', matchOnDescription: true },
            );
            if (!repoItem) { return; }
            const repo     = repoItem.repoName;
            const [owner, repoName] = repo.split('/');

            // Step 2 — pick a project board (spinner shows while gh fetches)
            const projectItem = await vscode.window.showQuickPick(
                pickableProjects(owner, repoName).catch(e => { out.appendLine(`fetchProjects: ${e}`); return []; }),
                { title: `Add Repository · ${repo} — Select project board`, placeHolder: 'Select the GitHub Projects v2 board to watch…' },
            );
            if (!projectItem) { return; }
            const projectNumber = projectItem.projectNumber;

            // Steps 3–5 — map the project's actual Status column names to Grace's roles.
            // These only show when the project has a Status single-select field; if the
            // fetch fails or the field is absent the defaults ("Todo" / "In Progress" /
            // "In Review") are used silently.
            let statusTodo       = 'Todo';
            let statusInProgress = 'In Progress';
            let statusInReview   = 'In Review';

            const statusOptions = await fetchStatusOptions(owner, projectNumber)
                .catch(e => { out.appendLine(`fetchStatusOptions: ${e}`); return [] as string[]; });

            if (statusOptions.length > 0) {
                const todoStatus = await vscode.window.showQuickPick(statusOptions, {
                    title: `Add Repository · ${repo} — Map Status: To Do`,
                    placeHolder: 'Which column should Grace pick new tasks from?',
                });
                if (!todoStatus) { return; }
                statusTodo = todoStatus;

                const inProgressStatus = await vscode.window.showQuickPick(statusOptions, {
                    title: `Add Repository · ${repo} — Map Status: In Progress`,
                    placeHolder: 'Which column means the task is being worked on (or is resumable)?',
                });
                if (!inProgressStatus) { return; }
                statusInProgress = inProgressStatus;

                const inReviewStatus = await vscode.window.showQuickPick(statusOptions, {
                    title: `Add Repository · ${repo} — Map Status: In Review`,
                    placeHolder: 'Which column means a PR is open and Grace should watch CI?',
                });
                if (!inReviewStatus) { return; }
                statusInReview = inReviewStatus;
            }

            // Seed from env-var repo so we don't silently drop existing single-repo setup
            const existing = readReposFile();
            if (existing.length === 0) {
                const envRepo = process.env['GITHUB_REPO'];
                const envNum  = process.env['GITHUB_PROJECT_NUMBER'];
                if (envRepo && envNum && envRepo !== repo) {
                    existing.push({ repo: envRepo, projectNumber: parseInt(envNum, 10) });
                }
            }
            const repos = existing.filter(r => r.repo !== repo);
            repos.push({ repo, projectNumber, statusTodo, statusInProgress, statusInReview });
            fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
            provider.refresh();
            vscode.window.showInformationMessage(`Now monitoring ${repo} (project #${projectNumber})`);
        }),

        vscode.commands.registerCommand('graceHopper.removeRepo', (node: RepoNode) => {
            const repo  = node.config.repo;
            const repos = readReposFile().filter(r => r.repo !== repo);
            fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
            provider.refresh();
            vscode.window.showInformationMessage(`Stopped monitoring ${repo}`);
        }),

        vscode.commands.registerCommand('graceHopper.rebuildState', () => {
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Rebuilding state from GitHub…', cancellable: false },
                () => new Promise<void>(resolve => {
                    try {
                        const result = cp.execSync('python3 /app/scripts/rebuild_state.py', {
                            encoding: 'utf8',
                            env: { ...process.env, GH_TOKEN: process.env['GITHUB_TOKEN'] ?? '' },
                            timeout: 30_000,
                        });
                        const { fixed } = JSON.parse(result.trim() || '{"fixed":[]}') as { fixed: string[] };
                        provider.refresh();
                        vscode.window.showInformationMessage(
                            fixed.length > 0
                                ? `Rebuilt — ${fixed.length} task(s) corrected:\n${fixed.join('\n')}`
                                : 'State is consistent with GitHub — nothing to fix'
                        );
                    } catch (e) {
                        vscode.window.showErrorMessage(`Rebuild failed: ${e}`);
                    }
                    resolve();
                })
            );
        }),

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
                        if (entry['issueNumber'] === n && (entry['status'] === 'paused' || entry['status'] === 'failed')) {
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
                // -n +1 starts from line 1 so the full history is always visible,
                // not just the last 10 lines.
                terminal.sendText(`tail -n +1 -f "${logPath}"`);
                terminal.show();
            }),

        vscode.commands.registerCommand('graceHopper.openClaude',
            (arg: TaskNode) => {
                const task          = arg instanceof TaskNode ? arg.task : undefined;
                const workspacePath = task?.workspacePath;
                if (!workspacePath || !task) {
                    vscode.window.showErrorMessage('No workspace path for this task');
                    return;
                }
                const sessionId = latestSessionId(task);
                if (!sessionId) {
                    const label = task.title || `#${task.issueNumber}`;
                    vscode.window.showWarningMessage(`No agent session found for "${label}" — the task may not have started yet.`);
                    return;
                }
                const cmd = `python3 /app/scripts/attach_session.py ${sessionId} ${task.issueNumber}`;
                const alreadyOpen = (vscode.workspace.workspaceFolders ?? [])
                    .some(f => f.uri.fsPath === workspacePath);
                if (alreadyOpen) {
                    const terminal = vscode.window.createTerminal({
                        name: `Agent — ${path.basename(workspacePath)}`,
                        location: vscode.TerminalLocation.Panel,
                        cwd: workspacePath,
                    });
                    terminal.sendText(cmd);
                    terminal.show();
                    vscode.commands.executeCommand('workbench.view.explorer');
                } else {
                    fs.writeFileSync(PENDING_CLAUDE, JSON.stringify({ workspacePath, sessionId }));
                    vscode.commands.executeCommand(
                        'vscode.openFolder', vscode.Uri.file(workspacePath), { forceNewWindow: false }
                    );
                }
            }),
    );

    try {
        const tasksWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), 'tasks.json'),
        );
        tasksWatcher.onDidChange(() => provider.refresh());
        tasksWatcher.onDidCreate(() => provider.refresh());

        const reposWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), 'repos.json'),
        );
        reposWatcher.onDidChange(() => provider.refresh());
        reposWatcher.onDidCreate(() => provider.refresh());

        const lockWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.join(STATE_DIR, 'active')), '*.lock'),
        );
        lockWatcher.onDidCreate(() => provider.refresh());
        lockWatcher.onDidDelete(() => provider.refresh());

        context.subscriptions.push(tasksWatcher, reposWatcher, lockWatcher);
    } catch (e) { out.appendLine(`Watcher error: ${e}`); }

    const refreshAll = () => { provider.refresh(); updatePauseBar(provider.getTasks()); };
    const timer = setInterval(refreshAll, 2_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    refreshAll();
}

export function deactivate(): void {}
