import { commentToRichText } from './richText';
import { normalizeText } from './todoFile';

const BASE = 'https://api.clickup.com/api';

/** Error codes ClickUp answers with for a task that no longer exists (or we can't see). */
const TASK_GONE_CODES = new Set(['OAUTH_027', 'ITEM_013', 'ITEM_015']);

export interface ListInfo {
    id: string;
    name: string;
    /** The list's first "open" status, used when a task is unticked. */
    openStatus: string;
}

export interface RemoteTask {
    id: string;
    name: string;
    desc: string;
    /** The raw ClickUp status name. */
    status: string;
    closed: boolean;
    listId: string;
    updatedAt: number;
    url: string;
}

export interface TaskChanges {
    name?: string;
    desc?: string;
    status?: string;
}

/** What the sync needs from ClickUp; the tests swap in a fake. */
export interface TaskApi {
    listOpenTasks(listId: string): Promise<RemoteTask[]>;
    /** Null when the task is gone (deleted, or not visible to this token). */
    getTask(id: string): Promise<RemoteTask | null>;
    createTask(listId: string, task: { name: string; desc: string; status: string }): Promise<string>;
    updateTask(id: string, changes: TaskChanges): Promise<void>;
    moveTask(id: string, listId: string): Promise<void>;
    /** Posts a comment on a task and returns the comment's id. */
    postComment(taskId: string, text: string): Promise<string>;
}

export class ClickUpError extends Error {
    constructor(public readonly status: number, public readonly code: string | undefined, message: string) {
        super(message);
    }
}

interface RawTask {
    id: string;
    name: string;
    markdown_description?: string | null;
    description?: string | null;
    status: { status: string; type: string };
    list: { id: string };
    date_updated: string;
    url: string;
    archived?: boolean;
}

function toRemoteTask(raw: RawTask): RemoteTask {
    return {
        id: raw.id,
        name: raw.name.trim(),
        desc: normalizeText(raw.markdown_description ?? raw.description ?? ''),
        status: raw.status.status,
        closed: raw.status.type === 'closed' || raw.status.type === 'done' || raw.archived === true,
        listId: raw.list.id,
        updatedAt: Number(raw.date_updated),
        url: raw.url,
    };
}

export class ClickUpClient implements TaskApi {
    private workspaceId?: string;

    constructor(private readonly token: string, workspaceId?: string) {
        this.workspaceId = workspaceId || undefined;
    }

    private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
        const response = await fetch(BASE + path, {
            method,
            headers: { Authorization: this.token, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        if (response.status === 429 && !retried) {
            const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
            const wait = Math.min(Math.max(reset - Date.now(), 1000), 60_000);
            await new Promise(resolve => setTimeout(resolve, wait));

            return this.request<T>(method, path, body, true);
        }

        const text = await response.text();
        if (!response.ok) {
            let code: string | undefined;
            let message = text;
            try {
                const parsed = JSON.parse(text) as { err?: string; ECODE?: string };
                code = parsed.ECODE;
                message = parsed.err ?? text;
            } catch {
                // Not JSON; keep the raw text.
            }
            throw new ClickUpError(response.status, code, `ClickUp ${method} ${path}: ${response.status} ${message}`);
        }

        return (text ? JSON.parse(text) : {}) as T;
    }

    async me(): Promise<string> {
        const data = await this.request<{ user: { username: string } }>('GET', '/v2/user');

        return data.user.username;
    }

    async getWorkspaceId(): Promise<string> {
        if (!this.workspaceId) {
            const data = await this.request<{ teams: { id: string }[] }>('GET', '/v2/team');
            if (!data.teams.length) {
                throw new Error('This ClickUp token has no workspace.');
            }
            this.workspaceId = data.teams[0].id;
        }

        return this.workspaceId;
    }

    /** Every list in the workspace (folderless lists first, then folders), in ClickUp's order. */
    async discoverLists(): Promise<ListInfo[]> {
        const workspaceId = await this.getWorkspaceId();
        const { spaces } = await this.request<{ spaces: { id: string }[] }>('GET', `/v2/team/${workspaceId}/space?archived=false`);
        const refs: { id: string; name: string }[] = [];
        for (const space of spaces) {
            const { lists } = await this.request<{ lists: { id: string; name: string }[] }>('GET', `/v2/space/${space.id}/list?archived=false`);
            const { folders } = await this.request<{ folders: { lists: { id: string; name: string }[] }[] }>('GET', `/v2/space/${space.id}/folder?archived=false`);
            refs.push(...lists, ...folders.flatMap(folder => folder.lists));
        }

        const result: ListInfo[] = [];
        for (const ref of refs) {
            const list = await this.request<{ statuses: { status: string; type: string; orderindex: number }[] }>('GET', `/v2/list/${ref.id}`);
            const open = [...list.statuses].sort((a, b) => a.orderindex - b.orderindex).find(status => status.type === 'open');
            result.push({ id: ref.id, name: ref.name.trim(), openStatus: open?.status ?? 'to do' });
        }

        return result;
    }

    async listOpenTasks(listId: string): Promise<RemoteTask[]> {
        const tasks: RemoteTask[] = [];
        for (let page = 0; page < 50; page++) {
            const data = await this.request<{ tasks: RawTask[]; last_page?: boolean }>(
                'GET',
                `/v2/list/${listId}/task?include_markdown_description=true&archived=false&page=${page}`,
            );
            tasks.push(...data.tasks.map(toRemoteTask));
            if (data.tasks.length === 0 || (data.last_page ?? data.tasks.length < 100)) {
                break;
            }
        }

        return tasks;
    }

    async getTask(id: string): Promise<RemoteTask | null> {
        try {
            return toRemoteTask(await this.request<RawTask>('GET', `/v2/task/${id}?include_markdown_description=true`));
        } catch (error) {
            if (error instanceof ClickUpError && (error.status === 404 || (error.code && TASK_GONE_CODES.has(error.code)))) {
                return null;
            }
            throw error;
        }
    }

    async createTask(listId: string, task: { name: string; desc: string; status: string }): Promise<string> {
        const body: Record<string, unknown> = { name: task.name, status: task.status };
        if (task.desc) {
            body.markdown_content = task.desc;
        }
        const created = await this.request<{ id: string }>('POST', `/v2/list/${listId}/task`, body);

        return created.id;
    }

    async updateTask(id: string, changes: TaskChanges): Promise<void> {
        const body: Record<string, unknown> = {};
        if (changes.name !== undefined) {
            body.name = changes.name;
        }
        if (changes.status !== undefined) {
            body.status = changes.status;
        }
        if (changes.desc !== undefined) {
            if (changes.desc) {
                body.markdown_content = changes.desc;
            } else {
                // ClickUp's documented way to clear a description.
                body.description = ' ';
            }
        }
        await this.request('PUT', `/v2/task/${id}`, body);
    }

    async moveTask(id: string, listId: string): Promise<void> {
        const workspaceId = await this.getWorkspaceId();
        await this.request('PUT', `/v3/workspaces/${workspaceId}/tasks/${id}/home_list/${listId}`, {});
    }

    async postComment(taskId: string, text: string): Promise<string> {
        // Rich text only: with "comment_text" as well, ClickUp shows the text twice, once unformatted.
        const created = await this.request<{ id?: string | number }>('POST', `/v2/task/${taskId}/comment`, {
            comment: commentToRichText(text),
            notify_all: false,
        });

        // The comment exists now; without an id it must still be marked posted so it is never sent twice.
        return created.id === undefined || created.id === null ? 'posted' : String(created.id);
    }
}
