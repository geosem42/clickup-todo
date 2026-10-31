import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ClickUpClient, ListInfo } from './clickup';
import { PostedComment, Snapshot, sync } from './sync';
import { allTasks, LocalTask, normalizeText, parse, previewOf, render, TodoDoc } from './todoFile';

const TOKEN_KEY = 'clickupTodo.token';
const CONNECTED_KEY = 'connected';
const SNAPSHOT_KEY = 'snapshot';
const POSTED_KEY = 'postedComments';
const LISTS_KEY = 'lists';
const SELECTED_KEY = 'selectedListId';
const LISTS_MAX_AGE = 60 * 60 * 1000;

type StatusKind = 'ok' | 'busy' | 'error' | 'dirty';

interface ViewTask {
    key: string;
    id?: string;
    name: string;
    desc: string;
    html?: string;
    preview: string;
    checked: boolean;
}

interface ViewState {
    connected: boolean;
    lists: { id: string; name: string; count: number }[];
    selectedListId?: string;
    tasks: ViewTask[];
    status: { kind: StatusKind; text: string; detail: string };
}

/** Messages the sidebar page sends. */
type ViewMessage =
    | { type: 'ready' | 'sync' | 'connect' }
    | { type: 'selectList'; id: string }
    | { type: 'toggle'; key: string; name: string; checked: boolean }
    | { type: 'edit'; key: string; name: string; newName: string; desc: string }
    | { type: 'add'; name: string; desc: string }
    | { type: 'openInClickUp'; id: string }
    | { type: 'openInFile'; key: string; name: string };

const STATUS_ICONS: Record<StatusKind, string> = { ok: 'checklist', busy: 'sync~spin', error: 'warning', dirty: 'circle-filled' };

class Controller implements vscode.WebviewViewProvider {
    private readonly output = vscode.window.createOutputChannel('ClickUp TODO');
    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    private readonly markdownCache = new Map<string, string>();
    private view?: vscode.WebviewView;
    private stateVersion = 0;
    private status: ViewState['status'] = { kind: 'ok', text: 'Not synced yet', detail: '' };
    private listsFetchedAt = 0;
    private syncing = false;
    private syncAgain = false;
    private lastWritten?: string;
    private lastNotifiedError?: string;
    private timer?: NodeJS.Timeout;
    private debounce?: NodeJS.Timeout;

    constructor(private readonly context: vscode.ExtensionContext) {}

    start(): void {
        const { context } = this;
        this.statusBar.command = 'clickupTodo.sync';

        context.subscriptions.push(
            this.output,
            this.statusBar,
            vscode.window.registerWebviewViewProvider('clickupTodo.tasks', this),
            vscode.commands.registerCommand('clickupTodo.connect', () => this.connect()),
            vscode.commands.registerCommand('clickupTodo.disconnect', () => this.disconnect()),
            vscode.commands.registerCommand('clickupTodo.setToken', () => this.promptToken()),
            vscode.commands.registerCommand('clickupTodo.sync', () => this.runSync(true)),
            vscode.commands.registerCommand('clickupTodo.switchList', () => this.switchList()),
            vscode.commands.registerCommand('clickupTodo.addTask', () => this.addTaskFromInputBox()),
            vscode.commands.registerCommand('clickupTodo.openFile', () => this.openFile()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('clickupTodo')) {
                    this.listsFetchedAt = 0;
                    this.startTimer();
                    this.runSync();
                }
            }),
            { dispose: () => this.stopTimers() },
        );

        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, this.config().file));
            context.subscriptions.push(
                watcher,
                watcher.onDidChange(() => this.onFileChanged()),
                watcher.onDidCreate(() => this.onFileChanged()),
            );
        }

        this.updateConnectedState();
        this.startTimer();
        this.runSync();
    }

    private config(): { file: string; defaultListId: string; excludedListIds: string[]; reviewStatus: string; syncIntervalMinutes: number; workspaceId: string } {
        const config = vscode.workspace.getConfiguration('clickupTodo');

        return {
            file: config.get('file', 'TODO.md'),
            defaultListId: config.get('defaultListId', ''),
            excludedListIds: config.get('excludedListIds', []),
            reviewStatus: config.get('reviewStatus', 'in review'),
            syncIntervalMinutes: Math.max(1, config.get('syncIntervalMinutes', 3)),
            workspaceId: config.get('workspaceId', ''),
        };
    }

    private get connected(): boolean {
        return this.context.workspaceState.get(CONNECTED_KEY, false);
    }

    private fileUri(): vscode.Uri | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0];

        return folder ? vscode.Uri.joinPath(folder.uri, this.config().file) : undefined;
    }

    private isDirty(uri: vscode.Uri): boolean {
        return vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty);
    }

    private async readFile(uri: vscode.Uri): Promise<{ text: string; mtime: number }> {
        try {
            const [bytes, stat] = await Promise.all([vscode.workspace.fs.readFile(uri), vscode.workspace.fs.stat(uri)]);

            return { text: Buffer.from(bytes).toString('utf8'), mtime: stat.mtime };
        } catch {
            return { text: '', mtime: 0 };
        }
    }

    private async writeFile(uri: vscode.Uri, text: string): Promise<void> {
        this.lastWritten = text;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    }

    private log(message: string): void {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    private setStatus(kind: StatusKind, text: string, detail: string): void {
        this.status = { kind, text, detail };
        this.statusBar.text = `$(${STATUS_ICONS[kind]}) ClickUp`;
        this.statusBar.tooltip = detail || text;
        this.statusBar.show();
        this.refreshView();
    }

    private updateConnectedState(): void {
        vscode.commands.executeCommand('setContext', 'clickupTodo.connected', this.connected);
        if (!this.connected) {
            this.statusBar.hide();
        }
        this.refreshView();
    }

    private startTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = setInterval(() => this.runSync(), this.config().syncIntervalMinutes * 60_000);
    }

    private stopTimers(): void {
        clearInterval(this.timer);
        clearTimeout(this.debounce);
    }

    private scheduleSync(delay: number): void {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.runSync(), delay);
    }

    private async onFileChanged(): Promise<void> {
        this.refreshView();
        const uri = this.fileUri();
        if (!uri) {
            return;
        }
        const { text } = await this.readFile(uri);
        if (text !== this.lastWritten) {
            this.scheduleSync(1500);
        }
    }

    // ── Lists ────────────────────────────────────────────────────────────

    /** Synced lists, default list first. Cached for an hour; also kept for offline start-up. */
    private async getLists(client: ClickUpClient, force = false): Promise<ListInfo[]> {
        const cached = this.context.workspaceState.get<ListInfo[]>(LISTS_KEY);
        if (cached && !force && Date.now() - this.listsFetchedAt < LISTS_MAX_AGE) {
            return cached;
        }

        const { defaultListId, excludedListIds } = this.config();
        const all = (await client.discoverLists()).filter(list => !excludedListIds.includes(list.id));
        const defaultList = defaultListId ? all.find(list => list.id === defaultListId) : all[0];
        if (!defaultList) {
            throw new Error(defaultListId
                ? `The default list ${defaultListId} was not found in ClickUp (setting clickupTodo.defaultListId).`
                : 'This ClickUp workspace has no lists to sync.');
        }
        const lists = [defaultList, ...all.filter(list => list !== defaultList)];
        await this.context.workspaceState.update(LISTS_KEY, lists);
        this.listsFetchedAt = Date.now();

        return lists;
    }

    private cachedLists(): ListInfo[] {
        return this.context.workspaceState.get<ListInfo[]>(LISTS_KEY, []);
    }

    /** The configured default list, or else the workspace's first list (always first in the cached lists). */
    private defaultListId(): string {
        return this.cachedLists()[0]?.id ?? this.config().defaultListId;
    }

    private selectedList(): ListInfo | undefined {
        const lists = this.cachedLists();
        const id = this.context.workspaceState.get<string>(SELECTED_KEY) ?? this.defaultListId();

        return lists.find(list => list.id === id) ?? lists[0];
    }

    // ── Sync ─────────────────────────────────────────────────────────────

    async runSync(manual = false): Promise<void> {
        if (!this.connected) {
            if (manual) {
                vscode.window.showInformationMessage('Run "ClickUp TODO: Connect this workspace" first.');
            }

            return;
        }
        if (this.syncing) {
            this.syncAgain = true;

            return;
        }

        this.syncing = true;
        this.setStatus('busy', 'Syncing…', 'Syncing with ClickUp…');
        try {
            for (let attempt = 0; attempt < 3 && !(await this.syncOnce()); attempt++) {
                this.log('TODO.md changed during the sync; syncing again.');
            }
        } catch (error) {
            const message = (error as Error).message;
            this.log(`Sync failed: ${message}`);
            this.setStatus('error', 'Sync failed', `ClickUp sync failed: ${message}\nClick to retry.`);
            if (message !== this.lastNotifiedError || manual) {
                this.lastNotifiedError = message;
                vscode.window.showErrorMessage(`ClickUp TODO: ${message}`, 'Show log').then(choice => {
                    if (choice) {
                        this.output.show();
                    }
                });
            }
        } finally {
            this.syncing = false;
            this.refreshView();
            if (this.syncAgain) {
                this.syncAgain = false;
                this.scheduleSync(500);
            }
        }
    }

    /** One sync pass. False when the file changed meanwhile and the pass must be redone. */
    private async syncOnce(): Promise<boolean> {
        const token = await this.context.secrets.get(TOKEN_KEY);
        if (!token) {
            throw new Error('No ClickUp API token. Run "ClickUp TODO: Set API token".');
        }
        const uri = this.fileUri();
        if (!uri) {
            throw new Error('Open a folder to sync its TODO.md.');
        }
        if (this.isDirty(uri)) {
            this.setStatus('dirty', 'Unsaved changes in TODO.md', 'TODO.md has unsaved changes; syncs after you save.');

            return true;
        }

        const config = this.config();
        const client = new ClickUpClient(token, config.workspaceId);
        const { text, mtime } = await this.readFile(uri);
        const lists = await this.getLists(client);
        const result = await sync({
            text,
            mtime,
            lists,
            defaultListId: lists[0].id,
            reviewStatus: config.reviewStatus,
            snapshot: this.context.workspaceState.get<Snapshot>(SNAPSHOT_KEY, {}),
            posted: this.context.workspaceState.get<PostedComment[]>(POSTED_KEY, []),
            api: client,
        });
        // Saved first: if the file isn't written, the next sync writes these ids instead of posting again.
        await this.context.workspaceState.update(POSTED_KEY, result.posted);

        const now = await this.readFile(uri);
        if (now.text !== text || this.isDirty(uri)) {
            await this.context.workspaceState.update(SNAPSHOT_KEY, result.snapshotIfUnwritten);
            result.changes.filter(change => change.includes(' in ClickUp')).forEach(change => this.log(change));

            return false;
        }

        if (result.text !== text) {
            await this.writeFile(uri, result.text);
        }
        await this.context.workspaceState.update(SNAPSHOT_KEY, result.snapshot);
        result.changes.forEach(change => this.log(change));
        result.errors.forEach(error => this.log(`Error: ${error}`));

        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (result.errors.length) {
            this.setStatus('error', `Synced ${time} with ${result.errors.length} error(s)`, `Synced at ${time} with ${result.errors.length} error(s). Click to retry; see the "ClickUp TODO" output.`);
        } else {
            this.lastNotifiedError = undefined;
            this.setStatus('ok', `Synced ${time}`, `Synced with ClickUp at ${time}. Click to sync now.`);
        }

        return true;
    }

    // ── Commands ─────────────────────────────────────────────────────────

    private async promptToken(): Promise<string | undefined> {
        const token = await vscode.window.showInputBox({
            title: 'ClickUp API token',
            prompt: 'Your ClickUp personal API token (ClickUp → Settings → Apps). Stored in VS Code\'s secret storage.',
            placeHolder: 'pk_…',
            password: true,
            ignoreFocusOut: true,
        });
        if (!token) {
            return undefined;
        }

        try {
            const user = await new ClickUpClient(token.trim(), this.config().workspaceId).me();
            await this.context.secrets.store(TOKEN_KEY, token.trim());
            vscode.window.showInformationMessage(`ClickUp token saved (${user}).`);

            return token.trim();
        } catch (error) {
            vscode.window.showErrorMessage(`ClickUp rejected that token: ${(error as Error).message}`);

            return undefined;
        }
    }

    private async connect(): Promise<void> {
        if (!this.fileUri()) {
            vscode.window.showErrorMessage('Open a folder first.');

            return;
        }
        const token = (await this.context.secrets.get(TOKEN_KEY)) ?? (await this.promptToken());
        if (!token) {
            return;
        }

        await this.context.workspaceState.update(CONNECTED_KEY, true);
        this.listsFetchedAt = 0;
        this.updateConnectedState();
        await this.runSync(true);
        if (this.connected) {
            vscode.window.showInformationMessage(`${this.config().file} now syncs with ClickUp.`);
        }
    }

    private async disconnect(): Promise<void> {
        await this.context.workspaceState.update(CONNECTED_KEY, false);
        this.updateConnectedState();
        vscode.window.showInformationMessage(`${this.config().file} no longer syncs with ClickUp. Nothing was deleted.`);
    }

    private async switchList(): Promise<void> {
        const counts = await this.taskCounts();
        const selected = this.selectedList();
        const choice = await vscode.window.showQuickPick(
            this.cachedLists().map(list => ({
                label: list.name,
                description: list.id === selected?.id ? '(shown)' : undefined,
                detail: `${counts.get(list.id) ?? 0} task(s)`,
                list,
            })),
            { title: 'Show which ClickUp list?' },
        );
        if (choice) {
            await this.selectList(choice.list.id);
        }
    }

    private async selectList(id: string): Promise<void> {
        await this.context.workspaceState.update(SELECTED_KEY, id);
        this.refreshView();
    }

    private async taskCounts(): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        const uri = this.fileUri();
        if (uri) {
            const doc = parse((await this.readFile(uri)).text, this.cachedLists(), this.defaultListId());
            for (const [id, tasks] of doc.sections) {
                counts.set(id, tasks.length);
            }
        }

        return counts;
    }

    private async addTaskFromInputBox(): Promise<void> {
        const list = this.selectedList();
        if (!list) {
            return;
        }
        const name = await vscode.window.showInputBox({ title: `New task in ${list.name}`, prompt: 'Task name', ignoreFocusOut: true });
        if (name?.trim()) {
            await this.addTask(name, '');
        }
    }

    private async addTask(name: string, desc: string): Promise<void> {
        const list = this.selectedList();
        if (!list || !name.trim()) {
            return;
        }
        await this.changeFile(doc => {
            const tasks = doc.sections.get(list.id) ?? [];
            tasks.push({ name: name.trim(), desc: normalizeText(desc), checked: false, listId: list.id, line: -1 });
            doc.sections.set(list.id, tasks);

            return true;
        });
    }

    /** Applies a change to TODO.md, writes it, and syncs. */
    private async changeFile(change: (doc: TodoDoc) => boolean): Promise<void> {
        const uri = this.fileUri();
        if (!uri) {
            return;
        }
        if (this.isDirty(uri)) {
            vscode.window.showWarningMessage(`Save ${this.config().file} first.`);
            this.refreshView();

            return;
        }

        const lists = this.cachedLists();
        const doc = parse((await this.readFile(uri)).text, lists, this.defaultListId());
        if (!change(doc)) {
            vscode.window.showWarningMessage(`${this.config().file} changed meanwhile; try again.`);
            this.refreshView();

            return;
        }
        await this.writeFile(uri, render(doc, lists));
        this.refreshView();
        this.runSync();
    }

    /** Finds a sidebar task in the file: by ClickUp ID, or (not synced yet) by line, then by name. */
    private findTask(doc: TodoDoc, key: string, name: string): LocalTask | undefined {
        const tasks = allTasks(doc);
        if (key.startsWith('id:')) {
            return tasks.find(task => task.id === key.slice(3));
        }
        const line = key.startsWith('line:') ? Number(key.slice(5)) : -1;

        return tasks.find(task => !task.id && task.line === line && task.name === name)
            ?? tasks.find(task => !task.id && task.name === name);
    }

    private async openFile(line?: number): Promise<void> {
        const uri = this.fileUri();
        if (uri) {
            const selection = line !== undefined && line >= 0 ? new vscode.Range(line, 0, line, 0) : undefined;
            await vscode.window.showTextDocument(uri, { selection });
        }
    }

    // ── Sidebar ──────────────────────────────────────────────────────────

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        view.webview.html = this.html(view.webview, media);
        view.webview.onDidReceiveMessage((message: ViewMessage) => this.onMessage(message));
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.refreshView();
            }
        });
        view.onDidDispose(() => {
            this.view = undefined;
        });
    }

    private html(webview: vscode.Webview, media: vscode.Uri): string {
        const nonce = randomBytes(16).toString('base64');
        const asset = (file: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(media, file));

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Tasks</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
    }

    private async onMessage(message: ViewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.refreshView();
                break;
            case 'sync':
                this.runSync(true);
                break;
            case 'connect':
                this.connect();
                break;
            case 'selectList':
                await this.selectList(message.id);
                break;
            case 'add':
                await this.addTask(message.name, message.desc);
                break;
            case 'toggle':
                await this.changeFile(doc => {
                    const task = this.findTask(doc, message.key, message.name);
                    if (task) {
                        task.checked = message.checked;
                    }

                    return task !== undefined;
                });
                break;
            case 'edit':
                if (!message.newName.trim()) {
                    break;
                }
                await this.changeFile(doc => {
                    const task = this.findTask(doc, message.key, message.name);
                    if (task) {
                        task.name = message.newName.trim();
                        task.desc = normalizeText(message.desc);
                    }

                    return task !== undefined;
                });
                break;
            case 'openInClickUp':
                vscode.env.openExternal(vscode.Uri.parse(`https://app.clickup.com/t/${encodeURIComponent(message.id)}`));
                break;
            case 'openInFile': {
                const uri = this.fileUri();
                if (uri) {
                    const doc = parse((await this.readFile(uri)).text, this.cachedLists(), this.defaultListId());
                    await this.openFile(this.findTask(doc, message.key, message.name)?.line);
                }
                break;
            }
        }
    }

    private async renderMarkdown(desc: string): Promise<string | undefined> {
        if (!desc) {
            return undefined;
        }
        const cached = this.markdownCache.get(desc);
        if (cached !== undefined) {
            return cached;
        }
        try {
            const html = await vscode.commands.executeCommand<string>('markdown.api.render', desc);
            if (this.markdownCache.size > 500) {
                this.markdownCache.clear();
            }
            this.markdownCache.set(desc, html);

            return html;
        } catch {
            return undefined;
        }
    }

    private async buildState(): Promise<ViewState> {
        const uri = this.fileUri();
        const lists = this.cachedLists();
        const selected = this.selectedList();
        const state: ViewState = { connected: this.connected, lists: [], selectedListId: selected?.id, tasks: [], status: this.status };
        if (!this.connected || !uri) {
            return state;
        }

        const doc = parse((await this.readFile(uri)).text, lists, this.defaultListId());
        state.lists = lists.map(list => ({ id: list.id, name: list.name, count: doc.sections.get(list.id)?.length ?? 0 }));
        const tasks = selected ? doc.sections.get(selected.id) ?? [] : [];
        state.tasks = await Promise.all(tasks.map(async task => ({
            key: task.id ? `id:${task.id}` : `line:${task.line}`,
            id: task.id,
            name: task.name,
            desc: task.desc,
            html: await this.renderMarkdown(task.desc),
            preview: previewOf(task.desc),
            checked: task.checked,
        })));

        return state;
    }

    refreshView(): void {
        if (!this.view?.visible) {
            return;
        }
        const version = ++this.stateVersion;
        this.buildState().then(state => {
            if (version === this.stateVersion) {
                this.view?.webview.postMessage({ type: 'state', state });
            }
        });
    }
}

export function activate(context: vscode.ExtensionContext): void {
    new Controller(context).start();
}

export function deactivate(): void {}
