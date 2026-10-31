/**
 * Reads and writes TODO.md.
 *
 * Layout: an optional preamble ("# TODO"), then one "## <List name>" heading per ClickUp list.
 * A task is "- [ ] **Name** <!-- cu:taskId -->" followed by its description, indented two spaces.
 * Tasks above the first heading belong to the default list. Headings that match no list are kept as-is.
 *
 * Notes for ClickUp go in comment blocks in the task's body, after the description:
 *   <!-- comment -->
 *   text
 *   <!-- /comment -->
 * They are never part of the description. The sync posts each one as a ClickUp comment and then writes
 * the comment's id into the opening marker ("<!-- comment cu:123 -->") so it is never posted again.
 */

export interface Fields {
    name: string;
    desc: string;
    checked: boolean;
    listId: string;
}

export interface CommentBlock {
    /** The ClickUp comment id once posted. */
    id?: string;
    /** The lines between the markers, de-indented like the description. */
    lines: string[];
    /** False when the closing marker is missing: the block runs to the end of the task and is not posted. */
    closed: boolean;
    /** Whether a blank line separates the block from what comes before it. */
    blankBefore: boolean;
}

export interface LocalTask extends Fields {
    id?: string;
    /** 0-based line of the task's checkbox in the parsed text. */
    line: number;
    comments?: CommentBlock[];
}

export interface ListRef {
    id: string;
    name: string;
}

export interface TodoDoc {
    preamble: string[];
    /** Tasks per list ID, in file order. */
    sections: Map<string, LocalTask[]>;
    /** Sections whose heading matches no synced list, kept verbatim. */
    unknownSections: string[][];
}

export const MARKER =
    '<!-- Synced with ClickUp by the ClickUp TODO extension. One "## List" heading per ClickUp list; '
    + '[x] = "in review" (the admin sets complete). Keep the cu: comments. -->';

const HEADING = /^##\s+(.+?)\s*$/;
const TASK = /^[-*]\s+\[([ xX])\]\s?(.*)$/;
const TASK_ID = /\s*<!--\s*cu:([A-Za-z0-9_-]+)\s*-->\s*$/;
const BOLD = /^\*\*(.+)\*\*$/;
const COMMENT_OPEN = /^\s*<!--\s*comment(?:\s+cu:([A-Za-z0-9_-]+))?\s*-->\s*$/i;
const COMMENT_CLOSE = /^\s*<!--\s*\/comment\s*-->\s*$/i;

function dedent(line: string): string {
    return line.replace(/^ {1,2}|^\t/, '').replace(/\s+$/, '');
}

/** Splits a task's body into its description and its comment blocks. */
function splitBody(body: string[]): { desc: string; comments: CommentBlock[] } {
    const desc: string[] = [];
    const comments: CommentBlock[] = [];
    let open: CommentBlock | null = null;
    let blank = false;

    const closeUnfinished = (): void => {
        if (open) {
            while (open.lines.length && open.lines[open.lines.length - 1] === '') {
                open.lines.pop();
            }
            comments.push(open);
        }
        open = null;
    };

    for (const raw of body) {
        const opening = COMMENT_OPEN.exec(raw);
        if (opening) {
            // A new opening marker while a block is open: the earlier block was never closed.
            closeUnfinished();
            open = { id: opening[1], lines: [], closed: false, blankBefore: blank };
            blank = false;
            continue;
        }
        if (open && COMMENT_CLOSE.test(raw)) {
            open.closed = true;
            comments.push(open);
            open = null;
            blank = false;
            continue;
        }
        const line = dedent(raw);
        if (open) {
            open.lines.push(line);
            continue;
        }
        blank = line === '';
        desc.push(line);
    }
    closeUnfinished();

    return { desc: normalizeText(desc.join('\n')), comments };
}

/** The text a comment block posts: its inner lines, trimmed. Empty means nothing to post. */
export function commentText(block: CommentBlock): string {
    return block.lines.join('\n').trim();
}

export function normalizeText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/\s+$/, ''))
        .join('\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');
}

export function parse(text: string, lists: ListRef[], defaultListId: string): TodoDoc {
    const byName = new Map(lists.map(list => [list.name.trim().toLowerCase(), list.id]));
    const doc: TodoDoc = { preamble: [], sections: new Map(), unknownSections: [] };
    const seenIds = new Set<string>();

    let listId: string | null = null;
    let unknown: string[] | null = null;
    let task: LocalTask | null = null;
    let body: string[] = [];

    const closeTask = (): void => {
        if (task) {
            const { desc, comments } = splitBody(body);
            task.desc = desc;
            if (comments.length) {
                task.comments = comments;
            }
            const tasks = doc.sections.get(task.listId) ?? [];
            tasks.push(task);
            doc.sections.set(task.listId, tasks);
        }
        task = null;
        body = [];
    };

    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
        const heading = HEADING.exec(line);
        if (heading) {
            closeTask();
            const id = byName.get(heading[1].toLowerCase());
            if (id) {
                listId = id;
                unknown = null;
                if (!doc.sections.has(id)) {
                    doc.sections.set(id, []);
                }
            } else {
                listId = null;
                unknown = [line];
                doc.unknownSections.push(unknown);
            }

            return;
        }

        if (unknown) {
            unknown.push(line);

            return;
        }

        const match = TASK.exec(line);
        if (match) {
            closeTask();
            let title = match[2];
            let id: string | undefined;
            const idMatch = TASK_ID.exec(title);
            if (idMatch) {
                title = title.slice(0, idMatch.index);
                id = seenIds.has(idMatch[1]) ? undefined : idMatch[1];
            }
            if (id) {
                seenIds.add(id);
            }
            title = title.trim();
            const bold = BOLD.exec(title);
            task = {
                id,
                name: (bold ? bold[1] : title).trim(),
                desc: '',
                checked: match[1] !== ' ',
                listId: listId ?? defaultListId,
                line: index,
            };

            return;
        }

        if (task) {
            body.push(line);
        } else if (listId === null && line !== MARKER) {
            doc.preamble.push(line);
        }
    });
    closeTask();

    return doc;
}

export function renderTask(task: Fields & { id?: string; comments?: CommentBlock[] }): string[] {
    const id = task.id ? ` <!-- cu:${task.id} -->` : '';
    const title = task.name ? `**${task.name}**` : '';
    const lines = [`- [${task.checked ? 'x' : ' '}] ${title}${id}`.trimEnd()];
    if (task.desc) {
        for (const line of task.desc.split('\n')) {
            lines.push(line ? `  ${line}` : '');
        }
    }
    for (const block of task.comments ?? []) {
        if (block.blankBefore) {
            lines.push('');
        }
        lines.push(`  <!-- comment${block.id ? ` cu:${block.id}` : ''} -->`);
        for (const line of block.lines) {
            lines.push(line ? `  ${line}` : '');
        }
        if (block.closed) {
            lines.push('  <!-- /comment -->');
        }
    }

    return lines;
}

/** Renders the document with one heading per list, in the given order (default list first). */
export function render(doc: TodoDoc, lists: ListRef[]): string {
    const out: string[] = [];
    const preamble = [...doc.preamble];
    while (preamble.length && preamble[preamble.length - 1].trim() === '') {
        preamble.pop();
    }
    if (preamble.length === 0) {
        preamble.push('# TODO');
    }
    out.push(...preamble, '', MARKER);

    for (const list of lists) {
        out.push('', `## ${list.name}`);
        for (const task of doc.sections.get(list.id) ?? []) {
            out.push('', ...renderTask(task));
        }
    }

    for (const section of doc.unknownSections) {
        const lines = [...section];
        while (lines.length && lines[lines.length - 1].trim() === '') {
            lines.pop();
        }
        out.push('', ...lines);
    }

    return out.join('\n') + '\n';
}

/** A one-line, markdown-free preview of a description for the sidebar cards. */
export function previewOf(desc: string): string {
    return desc
        .split('\n')
        .map(line => line
            .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
            .replace(/\\/g, '')
            .replace(/^\s*(?:[*+-]|\d+[.)])\s+/, '')
            .replace(/^#+\s+/, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/[*_`]+/g, '')
            .trim())
        .filter(Boolean)
        .join(' · ');
}

export function allTasks(doc: TodoDoc): LocalTask[] {
    return [...doc.sections.values()].flat();
}
