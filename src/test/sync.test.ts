import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ListInfo, RemoteTask, TaskApi, TaskChanges } from '../clickup';
import { PostedComment, Snapshot, sync } from '../sync';
import { allTasks, parse } from '../todoFile';

const lists: ListInfo[] = [
    { id: 'misc', name: 'MISC TASKS', openStatus: 'to do' },
    { id: 'acc', name: 'ACCOUNTING MODULE', openStatus: 'to do' },
];

class FakeClickUp implements TaskApi {
    tasks = new Map<string, RemoteTask>();
    writes: string[] = [];
    clock = 1_000;
    nextId = 1;
    /** ClickUp reformats markdown it stores; simulate that. */
    reformat = (desc: string): string => desc.replace(/^- /gm, '* ');
    failUpdatesFor = new Set<string>();
    failCommentsFor = new Set<string>();
    comments: { taskId: string; text: string; id: string }[] = [];

    add(task: Partial<RemoteTask> & { name: string }): RemoteTask {
        const id = task.id ?? `t${this.nextId++}`;
        const full: RemoteTask = { id, desc: '', status: 'to do', closed: false, listId: 'misc', updatedAt: this.clock++, url: '', ...task };
        this.tasks.set(id, full);

        return full;
    }

    edit(id: string, changes: Partial<RemoteTask>): void {
        Object.assign(this.tasks.get(id)!, changes, { updatedAt: this.clock++ });
    }

    async listOpenTasks(listId: string): Promise<RemoteTask[]> {
        return [...this.tasks.values()].filter(task => task.listId === listId && !task.closed).map(task => ({ ...task }));
    }

    async getTask(id: string): Promise<RemoteTask | null> {
        const task = this.tasks.get(id);

        return task ? { ...task } : null;
    }

    async createTask(listId: string, task: { name: string; desc: string; status: string }): Promise<string> {
        this.writes.push(`create ${task.name} in ${listId} as ${task.status}`);

        return this.add({ name: task.name, desc: this.reformat(task.desc), status: task.status, listId }).id;
    }

    async updateTask(id: string, changes: TaskChanges): Promise<void> {
        if (this.failUpdatesFor.has(id)) {
            throw new Error('ClickUp said no');
        }
        this.writes.push(`update ${id} ${JSON.stringify(changes)}`);
        const task = this.tasks.get(id)!;
        if (changes.name !== undefined) {
            task.name = changes.name;
        }
        if (changes.desc !== undefined) {
            task.desc = this.reformat(changes.desc);
        }
        if (changes.status !== undefined) {
            task.status = changes.status;
        }
        task.updatedAt = this.clock++;
    }

    async moveTask(id: string, listId: string): Promise<void> {
        this.writes.push(`move ${id} to ${listId}`);
        this.edit(id, { listId });
    }

    async postComment(taskId: string, text: string): Promise<string> {
        if (this.failCommentsFor.has(taskId)) {
            throw new Error('ClickUp is down');
        }
        const id = `c${this.comments.length + 1}`;
        this.comments.push({ taskId, text, id });
        this.writes.push(`comment ${taskId} ${JSON.stringify(text)}`);

        return id;
    }
}

let api: FakeClickUp;
let snapshot: Snapshot;
let posted: PostedComment[];
let text: string;
let mtime: number;

async function run(): Promise<{ changes: string[]; errors: string[] }> {
    const result = await sync({ text, mtime, lists, defaultListId: 'misc', reviewStatus: 'in review', snapshot, posted, api });
    text = result.text;
    snapshot = result.snapshot;
    posted = result.posted;

    return result;
}

function edit(transform: (current: string) => string): void {
    text = transform(text);
    mtime = api.clock++;
}

function tasks(): { id?: string; name: string; desc: string; checked: boolean; listId: string }[] {
    return allTasks(parse(text, lists, 'misc')).map(({ id, name, desc, checked, listId }) => ({ id, name, desc, checked, listId }));
}

beforeEach(() => {
    api = new FakeClickUp();
    snapshot = {};
    posted = [];
    text = '# TODO\n\n- [ ] **Fix card top-ups**\n  - read the bank reply\n';
    mtime = 500;
});

test('first sync creates file tasks, pulls open ClickUp tasks, and skips completed ones', async () => {
    api.add({ id: 'r1', name: 'AGENT FOR WHATSAPP' });
    api.add({ id: 'r2', name: 'Closing', listId: 'acc', status: 'in review', desc: 'Close the books' });
    api.add({ id: 'r3', name: 'Done long ago', status: 'complete', closed: true });

    await run();

    assert.deepEqual(api.writes, ['create Fix card top-ups in misc as to do']);
    assert.deepEqual(tasks(), [
        { id: 't1', name: 'Fix card top-ups', desc: '- read the bank reply', checked: false, listId: 'misc' },
        { id: 'r1', name: 'AGENT FOR WHATSAPP', desc: '', checked: false, listId: 'misc' },
        { id: 'r2', name: 'Closing', desc: 'Close the books', checked: true, listId: 'acc' },
    ]);
});

test('a second sync with no changes writes nothing, even though ClickUp reformatted the description', async () => {
    await run();
    const before = text;
    api.writes = [];

    await run();
    await run();

    assert.deepEqual(api.writes, []);
    assert.equal(text, before);
    assert.equal(api.tasks.get('t1')!.desc, '* read the bank reply');
});

test('ticking sets "in review", unticking sets the list\'s open status', async () => {
    await run();

    edit(current => current.replace('- [ ] **Fix card top-ups**', '- [x] **Fix card top-ups**'));
    await run();
    assert.equal(api.tasks.get('t1')!.status, 'in review');
    assert.equal(tasks()[0].checked, true);

    edit(current => current.replace('- [x] **Fix card top-ups**', '- [ ] **Fix card top-ups**'));
    await run();
    assert.equal(api.tasks.get('t1')!.status, 'to do');
});

test('the admin completing a task removes it; sending it back unticks it', async () => {
    api.add({ id: 'r1', name: 'Review me', status: 'in review' });
    api.add({ id: 'r2', name: 'Not good yet', status: 'in review' });
    await run();

    api.edit('r1', { status: 'complete', closed: true });
    api.edit('r2', { status: 'to do' });
    const { changes } = await run();

    assert.deepEqual(tasks().map(task => [task.name, task.checked]), [['Fix card top-ups', false], ['Not good yet', false]]);
    assert.ok(changes.some(change => change.startsWith('Removed "Review me"')));
});

test('deleting a line in the file puts the task back; deleting it in ClickUp removes it', async () => {
    api.add({ id: 'r1', name: 'Keep me' });
    await run();

    edit(current => current.replace(/- \[ \] \*\*Keep me\*\*.*\n/, ''));
    await run();
    assert.ok(tasks().some(task => task.id === 'r1'));

    api.tasks.delete('r1');
    await run();
    assert.ok(!tasks().some(task => task.id === 'r1'));
    assert.equal(snapshot.r1, undefined);
});

test('a change on one side is copied to the other', async () => {
    api.add({ id: 'r1', name: 'Old name', desc: 'old' });
    await run();

    api.edit('r1', { desc: 'new from ClickUp' });
    await run();
    assert.equal(tasks().find(task => task.id === 'r1')!.desc, 'new from ClickUp');
    assert.equal(tasks().find(task => task.id === 'r1')!.name, 'Old name');

    edit(current => current.replace('**Old name**', '**New name**'));
    api.writes = [];
    await run();
    assert.deepEqual(api.writes, ['update r1 {"name":"New name"}']);
});

test('changed on both sides, the newest edit wins', async () => {
    api.add({ id: 'r1', name: 'Original' });
    await run();

    edit(current => current.replace('**Original**', '**Local edit**'));
    api.edit('r1', { name: 'ClickUp edit' });
    await run();
    assert.equal(tasks().find(task => task.id === 'r1')!.name, 'ClickUp edit');

    api.edit('r1', { name: 'ClickUp again' });
    edit(current => current.replace('**ClickUp edit**', '**Local is newer**'));
    await run();
    assert.equal(api.tasks.get('r1')!.name, 'Local is newer');
});

test('moving a task under another heading moves it in ClickUp, and the other way round', async () => {
    api.add({ id: 'r1', name: 'Movable' });
    await run();

    edit(current => current.replace(/(- \[ \] \*\*Movable\*\*.*\n)/, '').replace('## ACCOUNTING MODULE\n', '## ACCOUNTING MODULE\n\n- [ ] **Movable** <!-- cu:r1 -->\n'));
    await run();
    assert.equal(api.tasks.get('r1')!.listId, 'acc');
    assert.ok(api.writes.includes('move r1 to acc'));

    api.edit('r1', { listId: 'misc' });
    await run();
    assert.equal(tasks().find(task => task.id === 'r1')!.listId, 'misc');
});

test('a task created while the file could not be written is not created twice', async () => {
    const result = await sync({ text, mtime, lists, defaultListId: 'misc', reviewStatus: 'in review', snapshot, api });
    snapshot = result.snapshotIfUnwritten;
    assert.equal(api.tasks.size, 1);

    await run();

    assert.equal(api.tasks.size, 1);
    assert.equal(tasks()[0].id, 't1');
});

test('a pull that could not be written is pulled again next time', async () => {
    api.add({ id: 'r1', name: 'Old' });
    await run();

    api.edit('r1', { name: 'Renamed in ClickUp' });
    const result = await sync({ text, mtime, lists, defaultListId: 'misc', reviewStatus: 'in review', snapshot, api });
    snapshot = result.snapshotIfUnwritten;
    edit(current => current.replace('**Fix card top-ups**', '**Fix card top-ups now**'));

    await run();

    assert.equal(tasks().find(task => task.id === 'r1')!.name, 'Renamed in ClickUp');
    assert.equal(api.tasks.get('t1')!.name, 'Fix card top-ups now');
});

test('a task written ticked is created as "in review"; tasks under the right heading land in that list', async () => {
    text = '# TODO\n\n## ACCOUNTING MODULE\n\n- [x] **Already done**\n';
    await run();

    assert.deepEqual(api.writes, ['create Already done in acc as in review']);
});

test('a failed update is reported and retried, without blocking the other tasks', async () => {
    api.add({ id: 'r1', name: 'Stubborn' });
    await run();

    api.failUpdatesFor.add('r1');
    edit(current => current.replace('**Stubborn**', '**Stubborn renamed**').replace('**Fix card top-ups**', '**Fix card top-ups now**'));
    const { errors } = await run();
    assert.equal(errors.length, 1);
    assert.equal(api.tasks.get('t1')!.name, 'Fix card top-ups now');
    assert.equal(tasks().find(task => task.id === 'r1')!.name, 'Stubborn renamed');

    api.failUpdatesFor.clear();
    await run();
    assert.equal(api.tasks.get('r1')!.name, 'Stubborn renamed');
});

// ── Comment blocks ───────────────────────────────────────────────────────

const NOTE = '  <!-- comment -->\n  Tested on prod.\n  Works.\n  <!-- /comment -->\n';

function addNote(name: string, note = NOTE): void {
    edit(current => current.replace(new RegExp(`(- \\[[ x]\\] \\*\\*${name}\\*\\*.*\\n(?:  .*\\n)*)`), `$1${note}`));
}

test('a comment block is posted once, its id is written back, and the next sync posts nothing', async () => {
    api.add({ id: 'r1', name: 'Closing', desc: 'Close the books' });
    await run();
    api.writes = [];

    addNote('Closing');
    const { changes, errors } = await run();

    assert.deepEqual(errors, []);
    assert.deepEqual(api.writes, ['comment r1 "Tested on prod.\\nWorks."']);
    assert.ok(changes.includes('Posted a comment on "Closing" in ClickUp'));
    assert.ok(text.includes('- [ ] **Closing** <!-- cu:r1 -->\n  Close the books\n  <!-- comment cu:c1 -->\n  Tested on prod.\n  Works.\n  <!-- /comment -->\n'));
    assert.equal(api.tasks.get('r1')!.desc, 'Close the books');

    const before = text;
    api.writes = [];
    await run();
    await run();
    assert.deepEqual(api.writes, []);
    assert.equal(text, before);
    assert.equal(api.comments.length, 1);
});

test('the description sent to ClickUp never includes comment blocks', async () => {
    api.add({ id: 'r1', name: 'Closing', desc: 'old' });
    await run();
    addNote('Closing');
    await run();
    api.writes = [];

    edit(current => current.replace('  old\n', '  new text\n'));
    await run();

    assert.deepEqual(api.writes, ['update r1 {"desc":"new text"}']);
    assert.equal(api.tasks.get('r1')!.desc, 'new text');
    assert.ok(text.includes('  new text\n  <!-- comment cu:c1 -->'));
});

test('a failed post is reported, left unposted, and retried on the next sync', async () => {
    api.add({ id: 'r1', name: 'Closing' });
    await run();
    addNote('Closing');

    api.failCommentsFor.add('r1');
    const { errors } = await run();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^Could not post a comment on "Closing" in ClickUp/);
    assert.ok(text.includes('  <!-- comment -->\n  Tested on prod.'));
    assert.equal(api.comments.length, 0);

    api.failCommentsFor.clear();
    const second = await run();
    assert.deepEqual(second.errors, []);
    assert.equal(api.comments.length, 1);
    assert.ok(text.includes('  <!-- comment cu:c1 -->\n  Tested on prod.'));
});

test('a comment posted while the file could not be written is not posted twice', async () => {
    api.add({ id: 'r1', name: 'Closing' });
    await run();
    addNote('Closing');

    const result = await sync({ text, mtime, lists, defaultListId: 'misc', reviewStatus: 'in review', snapshot, posted, api });
    snapshot = result.snapshotIfUnwritten;
    posted = result.posted;
    assert.equal(api.comments.length, 1);

    await run();
    assert.equal(api.comments.length, 1);
    assert.ok(text.includes('  <!-- comment cu:c1 -->'));

    // Once the id is in the file, the ledger lets it go.
    await run();
    assert.deepEqual(posted, []);
});

test('two identical blocks are two comments', async () => {
    api.add({ id: 'r1', name: 'Closing' });
    await run();
    addNote('Closing', NOTE + NOTE);

    const result = await sync({ text, mtime, lists, defaultListId: 'misc', reviewStatus: 'in review', snapshot, posted, api });
    snapshot = result.snapshotIfUnwritten;
    posted = result.posted;
    await run();

    assert.equal(api.comments.length, 2);
    assert.ok(text.includes('<!-- comment cu:c1 -->') && text.includes('<!-- comment cu:c2 -->'));
});

test('an empty block is skipped and left as it is', async () => {
    api.add({ id: 'r1', name: 'Closing' });
    await run();
    addNote('Closing', '  <!-- comment -->\n\n  <!-- /comment -->\n');
    const before = text;

    const { errors } = await run();

    assert.deepEqual(errors, []);
    assert.equal(api.comments.length, 0);
    assert.equal(text, before);
});

test('a new task is created without its blocks in the description, then its blocks are posted', async () => {
    text = '# TODO\n\n- [ ] **Brand new**\n  The description.\n\n  <!-- comment -->\n  First note.\n  <!-- /comment -->\n';
    await run();

    assert.deepEqual(api.writes, ['create Brand new in misc as to do', 'comment t1 "First note."']);
    assert.equal(api.tasks.get('t1')!.desc, 'The description.');
    assert.ok(text.includes('- [ ] **Brand new** <!-- cu:t1 -->\n  The description.\n\n  <!-- comment cu:c1 -->\n  First note.\n  <!-- /comment -->\n'));
});

test('a description changed in ClickUp keeps the blocks; ticking, renaming and moving do too', async () => {
    api.add({ id: 'r1', name: 'Closing', desc: 'old' });
    await run();
    addNote('Closing');
    await run();
    const block = '  <!-- comment cu:c1 -->\n  Tested on prod.\n  Works.\n  <!-- /comment -->\n';

    api.edit('r1', { desc: 'rewritten in ClickUp' });
    await run();
    assert.ok(text.includes('  rewritten in ClickUp\n' + block));

    edit(current => current.replace('- [ ] **Closing**', '- [x] **Closing renamed**'));
    await run();
    api.edit('r1', { listId: 'acc' });
    await run();

    const task = allTasks(parse(text, lists, 'misc')).find(candidate => candidate.id === 'r1')!;
    assert.deepEqual([task.name, task.checked, task.listId, task.desc], ['Closing renamed', true, 'acc', 'rewritten in ClickUp']);
    assert.ok(text.includes(block));
    assert.equal(api.comments.length, 1);
});

test('an unclosed block is reported and never posted, and the tasks after it stay tasks', async () => {
    api.add({ id: 'r1', name: 'Closing' });
    api.add({ id: 'r2', name: 'Next task', desc: 'its own text' });
    await run();
    edit(current => current.replace('- [ ] **Closing** <!-- cu:r1 -->\n', '- [ ] **Closing** <!-- cu:r1 -->\n  <!-- comment -->\n  half a thought\n'));
    const before = text;
    api.writes = [];

    const { errors } = await run();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /without <!-- \/comment -->/);
    assert.deepEqual(api.writes, []);
    assert.equal(text, before);
    assert.deepEqual(tasks().map(task => [task.name, task.desc]), [['Fix card top-ups', '- read the bank reply'], ['Closing', ''], ['Next task', 'its own text']]);
});
