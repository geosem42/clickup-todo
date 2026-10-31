import { ListInfo, RemoteTask, TaskApi, TaskChanges } from './clickup';
import { allTasks, commentText, Fields, LocalTask, parse, render } from './todoFile';

/**
 * Two-way sync between TODO.md and ClickUp.
 *
 * For every task the snapshot keeps the last synced value of each field, once as written in the file
 * and once as ClickUp returned it (ClickUp reformats markdown, so the two can differ). A field changed
 * on one side only is copied to the other; changed on both, the newest edit wins (file save time vs
 * ClickUp's date_updated).
 *
 * Comment blocks are posted last. Every posted comment is also returned in `posted`, which the caller
 * saves even when it can't write the file; the next sync then writes the id instead of posting again.
 */

type FieldName = keyof Fields;

const FIELDS: FieldName[] = ['name', 'desc', 'checked', 'listId'];

export interface SnapshotEntry {
    local: Partial<Fields>;
    remote: Partial<Fields>;
}

export type Snapshot = Record<string, SnapshotEntry>;

/** A comment posted to ClickUp whose id may not be in TODO.md yet. */
export interface PostedComment {
    taskId: string;
    text: string;
    commentId: string;
}

export interface SyncOptions {
    text: string;
    /** When the file was last saved (ms). */
    mtime: number;
    /** Synced lists, default list first. */
    lists: ListInfo[];
    defaultListId: string;
    reviewStatus: string;
    snapshot: Snapshot;
    /** Comments posted by earlier syncs whose ids may not have reached the file. */
    posted?: PostedComment[];
    api: TaskApi;
}

export interface SyncResult {
    text: string;
    /** Save this when `text` was written to the file. */
    snapshot: Snapshot;
    /** Save this instead when the file changed during the sync and `text` was not written. */
    snapshotIfUnwritten: Snapshot;
    /** Save this whether or not `text` was written. */
    posted: PostedComment[];
    changes: string[];
    errors: string[];
}

function pick(task: Fields): Fields {
    return { name: task.name, desc: task.desc, checked: task.checked, listId: task.listId };
}

export async function sync(options: SyncOptions): Promise<SyncResult> {
    const { lists, reviewStatus, api } = options;
    const changes: string[] = [];
    const errors: string[] = [];
    const listIds = new Set(lists.map(list => list.id));
    const listName = (id: string): string => lists.find(list => list.id === id)?.name ?? id;
    const openStatus = (id: string): string => lists.find(list => list.id === id)?.openStatus ?? 'to do';
    const remoteFields = (task: RemoteTask): Fields => ({
        name: task.name,
        desc: task.desc,
        checked: task.status.toLowerCase() === reviewStatus.toLowerCase(),
        listId: task.listId,
    });

    const doc = parse(options.text, lists, options.defaultListId);
    const local = allTasks(doc);
    const original = new Map(local.filter(task => task.id).map(task => [task.id!, pick(task)]));
    // Comment ids already in the file are recorded there; the rest of the ledger is still needed.
    const commentIdsInFile = new Set(local.flatMap(task => (task.comments ?? []).map(block => block.id).filter(Boolean)));
    const posted = (options.posted ?? []).filter(entry => !commentIdsInFile.has(entry.commentId));

    // ClickUp's open tasks in every synced list.
    const remote = new Map<string, RemoteTask>();
    for (const list of lists) {
        for (const task of await api.listOpenTasks(list.id)) {
            if (!task.closed) {
                remote.set(task.id, task);
            }
        }
    }

    // Linked tasks missing from those lists: completed, deleted, or moved away.
    const gone = new Map<string, string>();
    const unknown = new Set<string>();
    const linked = new Set([...original.keys(), ...Object.keys(options.snapshot)]);
    for (const id of linked) {
        if (remote.has(id)) {
            continue;
        }
        try {
            const task = await api.getTask(id);
            if (!task) {
                gone.set(id, 'deleted in ClickUp');
            } else if (task.closed) {
                gone.set(id, `set to "${task.status}" in ClickUp`);
            } else if (!listIds.has(task.listId)) {
                gone.set(id, 'moved to a list that is not synced');
            } else {
                remote.set(id, task);
            }
        } catch (error) {
            unknown.add(id);
            errors.push(`Could not check task ${id}: ${(error as Error).message}`);
        }
    }

    // A new file task with the same name as an unlinked ClickUp task in its list is that task.
    const fileIds = new Set(original.keys());
    for (const task of local) {
        if (task.id) {
            continue;
        }
        const match = [...remote.values()].find(candidate => !fileIds.has(candidate.id)
            && candidate.listId === task.listId
            && candidate.name.toLowerCase() === task.name.toLowerCase());
        if (match) {
            task.id = match.id;
            fileIds.add(match.id);
        }
    }

    // Merge linked tasks field by field.
    const removed = new Set<LocalTask>();
    const pushes = new Map<string, { task: LocalTask; fields: Partial<Fields> }>();
    for (const task of local) {
        if (!task.id || unknown.has(task.id)) {
            continue;
        }
        const reason = gone.get(task.id);
        if (reason) {
            removed.add(task);
            changes.push(`Removed "${task.name}": ${reason}`);
            continue;
        }

        const remoteTask = remote.get(task.id)!;
        const theirs = remoteFields(remoteTask);
        const base = options.snapshot[task.id];
        const push: Partial<Fields> = {};
        const pulled: FieldName[] = [];
        for (const field of FIELDS) {
            const mine = task[field];
            if (mine === theirs[field]) {
                continue;
            }
            const localChanged = base?.local[field] === undefined || base.local[field] !== mine;
            const remoteChanged = base?.remote[field] === undefined || base.remote[field] !== theirs[field];
            if (!localChanged && !remoteChanged) {
                continue;
            }
            if (localChanged && (!remoteChanged || options.mtime >= remoteTask.updatedAt)) {
                (push as Record<FieldName, unknown>)[field] = mine;
            } else {
                (task as unknown as Record<FieldName, unknown>)[field] = theirs[field];
                pulled.push(field);
            }
        }
        if (Object.keys(push).length) {
            pushes.set(task.id, { task, fields: push });
        }
        if (pulled.length) {
            changes.push(`Updated "${task.name}" from ClickUp: ${describe(pulled, task, listName)}`);
        }
    }

    // Tasks deleted from the file but still open in ClickUp come back; deleting happens in ClickUp.
    const addFromRemote = (task: RemoteTask): void => {
        const tasks = doc.sections.get(task.listId) ?? [];
        tasks.push({ id: task.id, ...remoteFields(task), line: -1 });
        doc.sections.set(task.listId, tasks);
        fileIds.add(task.id);
    };
    for (const id of Object.keys(options.snapshot)) {
        const task = remote.get(id);
        if (!fileIds.has(id) && task) {
            addFromRemote(task);
            changes.push(`Put back "${task.name}" (delete tasks in ClickUp, not in TODO.md)`);
        }
    }
    for (const task of remote.values()) {
        if (!fileIds.has(task.id)) {
            addFromRemote(task);
            changes.push(`Added "${task.name}" from ClickUp (${listName(task.listId)})`);
        }
    }

    // Send local changes to ClickUp, then read each task back as ClickUp stores it.
    const fresh = new Map<string, RemoteTask>();
    const failed = new Set<string>();
    for (const [id, { task, fields }] of pushes) {
        try {
            if (fields.listId !== undefined) {
                await api.moveTask(id, fields.listId);
            }
            const update: TaskChanges = {};
            if (fields.name !== undefined) {
                update.name = fields.name;
            }
            if (fields.desc !== undefined) {
                update.desc = fields.desc;
            }
            if (fields.checked !== undefined) {
                update.status = fields.checked ? reviewStatus : openStatus(task.listId);
            }
            if (Object.keys(update).length) {
                await api.updateTask(id, update);
            }
            const after = await api.getTask(id);
            if (!after) {
                throw new Error('task not found after the update');
            }
            fresh.set(id, after);
            changes.push(`Updated "${task.name}" in ClickUp: ${describe(Object.keys(fields) as FieldName[], task, listName)}`);
        } catch (error) {
            failed.add(id);
            errors.push(`Could not update "${task.name}" in ClickUp: ${(error as Error).message}`);
        }
    }

    const created: LocalTask[] = [];
    for (const task of local) {
        if (task.id || !task.name) {
            continue;
        }
        try {
            const id = await api.createTask(task.listId, {
                name: task.name,
                desc: task.desc,
                status: task.checked ? reviewStatus : openStatus(task.listId),
            });
            task.id = id;
            created.push(task);
            const after = await api.getTask(id);
            if (after) {
                fresh.set(id, after);
            }
            changes.push(`Created "${task.name}" in ClickUp (${listName(task.listId)})`);
        } catch (error) {
            errors.push(`Could not create "${task.name}" in ClickUp: ${(error as Error).message}`);
        }
    }

    // Put each task under its list's heading.
    const sections = new Map<string, LocalTask[]>(lists.map(list => [list.id, []]));
    for (const task of allTasks(doc)) {
        if (!removed.has(task)) {
            const tasks = sections.get(task.listId) ?? [];
            tasks.push(task);
            sections.set(task.listId, tasks);
        }
    }
    doc.sections = sections;

    // Post new comment blocks, last, so nothing after a post can fail before its id is returned.
    const usedCommentIds = new Set(commentIdsInFile);
    for (const task of allTasks(doc)) {
        for (const block of task.comments ?? []) {
            if (block.id) {
                continue;
            }
            if (!block.closed) {
                errors.push(`"${task.name}" has a <!-- comment --> without <!-- /comment -->; it is posted once closed.`);
                continue;
            }
            const text = commentText(block);
            if (!text || !task.id || unknown.has(task.id)) {
                continue;
            }
            const earlier = posted.find(entry => entry.taskId === task.id && entry.text === text && !usedCommentIds.has(entry.commentId));
            if (earlier) {
                block.id = earlier.commentId;
                usedCommentIds.add(earlier.commentId);
                continue;
            }
            try {
                const commentId = await api.postComment(task.id, text);
                block.id = commentId;
                usedCommentIds.add(commentId);
                posted.push({ taskId: task.id, text, commentId });
                changes.push(`Posted a comment on "${task.name}" in ClickUp`);
            } catch (error) {
                errors.push(`Could not post a comment on "${task.name}" in ClickUp: ${(error as Error).message}`);
            }
        }
    }

    const snapshot: Snapshot = {};
    for (const task of allTasks(doc)) {
        if (!task.id) {
            continue;
        }
        if (unknown.has(task.id) || failed.has(task.id)) {
            if (options.snapshot[task.id]) {
                snapshot[task.id] = options.snapshot[task.id];
            }
            continue;
        }
        const theirs = fresh.get(task.id) ?? remote.get(task.id);
        if (theirs) {
            snapshot[task.id] = { local: pick(task), remote: remoteFields(theirs) };
        }
    }
    for (const id of unknown) {
        if (!snapshot[id] && options.snapshot[id]) {
            snapshot[id] = options.snapshot[id];
        }
    }

    // If the file can't be written, only what reached ClickUp counts as synced.
    const snapshotIfUnwritten: Snapshot = JSON.parse(JSON.stringify(options.snapshot));
    for (const [id, { fields }] of pushes) {
        const after = fresh.get(id);
        if (!after) {
            continue;
        }
        const entry = snapshotIfUnwritten[id] ?? { local: {}, remote: {} };
        const before = original.get(id) ?? {};
        for (const field of Object.keys(fields) as FieldName[]) {
            (entry.local as Record<FieldName, unknown>)[field] = (before as Fields)[field] ?? fields[field];
            (entry.remote as Record<FieldName, unknown>)[field] = remoteFields(after)[field];
        }
        snapshotIfUnwritten[id] = entry;
    }
    for (const task of created) {
        const after = fresh.get(task.id!);
        if (after) {
            snapshotIfUnwritten[task.id!] = { local: pick(task), remote: remoteFields(after) };
        }
    }

    return { text: render(doc, lists), snapshot, snapshotIfUnwritten, posted, changes, errors };
}

function describe(fields: FieldName[], task: Fields, listName: (id: string) => string): string {
    return fields.map(field => {
        switch (field) {
            case 'checked':
                return task.checked ? 'ticked (in review)' : 'unticked (to do)';
            case 'listId':
                return `moved to ${listName(task.listId)}`;
            case 'desc':
                return 'description';
            default:
                return 'name';
        }
    }).join(', ');
}
