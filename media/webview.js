// The sidebar page: renders the task cards and sends user actions to the extension.
(function () {
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const saved = vscode.getState() || {};

    const ui = {
        expanded: new Set(saved.expanded || []),
        collapsed: new Set(saved.collapsed || ['review']),
        search: saved.search || '',
        /** @type {{ key: string, name: string, newName: string, desc: string } | null} */
        editing: null,
        /** @type {{ name: string, desc: string } | null} */
        adding: null,
    };
    let state = null;

    const ICONS = {
        check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        sync: '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 0 1-9.9 3.3M2.5 8a5.5 5.5 0 0 1 9.9-3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12.6 1.8v3h-3M3.4 14.2v-3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        edit: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
        external: '<svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3.5H3V4h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        file: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5l3.5 3.5v9.5h-8.5zM9 1.5V5h3.5M6 8.5h4.5M6 11h4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
        chevron: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    };

    function post(message) {
        vscode.postMessage(message);
    }

    function persist() {
        vscode.setState({ expanded: [...ui.expanded], collapsed: [...ui.collapsed], search: ui.search });
    }

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        for (const [name, value] of Object.entries(attrs || {})) {
            if (value === undefined || value === null || value === false) {
                continue;
            }
            if (name === 'class') {
                node.className = value;
            } else if (name === 'html') {
                node.innerHTML = value;
            } else if (name === 'value') {
                node.value = value;
            } else if (name.startsWith('on')) {
                node.addEventListener(name.slice(2), value);
            } else {
                node.setAttribute(name, value === true ? '' : String(value));
            }
        }
        for (const child of children.flat()) {
            if (child !== null && child !== undefined && child !== false) {
                node.append(child instanceof Node ? child : document.createTextNode(String(child)));
            }
        }

        return node;
    }

    function icon(name, extra) {
        return el('span', { class: `icon ${extra || ''}`, 'aria-hidden': 'true', html: ICONS[name] });
    }

    // Re-rendering replaces the DOM; keep focus and caret in whichever field had them.
    function captureFocus() {
        const active = document.activeElement;
        if (!active || !active.dataset || !active.dataset.focus) {
            return null;
        }

        return { focus: active.dataset.focus, start: active.selectionStart, end: active.selectionEnd };
    }

    function restoreFocus(saved) {
        if (!saved) {
            return;
        }
        const node = app.querySelector(`[data-focus="${saved.focus}"]`);
        if (node) {
            node.focus();
            if (typeof saved.start === 'number' && node.setSelectionRange) {
                node.setSelectionRange(saved.start, saved.end);
            }
        }
    }

    function focusField(name) {
        requestAnimationFrame(() => {
            const node = app.querySelector(`[data-focus="${name}"]`);
            if (node) {
                node.focus();
                if (node.setSelectionRange) {
                    node.setSelectionRange(node.value.length, node.value.length);
                }
            }
        });
    }

    function autosize(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 420)}px`;
    }

    function render() {
        const focus = captureFocus();
        app.replaceChildren(!state ? el('p', { class: 'empty' }, 'Loading…') : state.connected ? main() : connectScreen());
        app.querySelectorAll('textarea').forEach(autosize);
        restoreFocus(focus);
    }

    function connectScreen() {
        return el('div', { class: 'connect' },
            el('p', {}, 'Sync this workspace’s TODO.md with ClickUp.'),
            el('button', { class: 'button primary', onclick: () => post({ type: 'connect' }) }, 'Connect to ClickUp'));
    }

    function main() {
        const query = ui.search.trim().toLowerCase();
        const tasks = state.tasks.filter(task => !query
            || task.name.toLowerCase().includes(query)
            || task.desc.toLowerCase().includes(query));
        const todo = tasks.filter(task => !task.checked);
        const review = tasks.filter(task => task.checked);

        return el('div', { class: 'layout' },
            header(),
            ui.adding ? addForm() : el('button', {
                class: 'new-task',
                onclick: () => {
                    ui.adding = { name: '', desc: '' };
                    render();
                    focusField('add-name');
                },
            }, icon('plus'), 'New task'),
            group('todo', 'To do', todo, query ? 'No matching tasks.' : 'Nothing to do in this list.'),
            group('review', 'In review', review, query ? 'No matching tasks.' : 'Nothing waiting for review.'),
            statusLine());
    }

    function header() {
        const busy = state.status.kind === 'busy';

        return el('div', { class: 'header' },
            el('div', { class: 'row' },
                el('select', {
                    class: 'select',
                    'data-focus': 'list',
                    'aria-label': 'ClickUp list',
                    onchange: event => post({ type: 'selectList', id: event.target.value }),
                }, state.lists.map(list => el('option', { value: list.id, selected: list.id === state.selectedListId },
                    `${list.name}  ·  ${list.count}`))),
                el('button', {
                    class: `icon-button ${busy ? 'busy' : ''}`,
                    title: 'Sync now',
                    'aria-label': 'Sync now',
                    onclick: () => post({ type: 'sync' }),
                }, icon('sync'))),
            el('label', { class: 'search' },
                icon('search'),
                el('input', {
                    type: 'search',
                    placeholder: 'Search tasks',
                    'data-focus': 'search',
                    value: ui.search,
                    oninput: event => {
                        ui.search = event.target.value;
                        persist();
                        render();
                    },
                })));
    }

    function group(id, title, tasks, emptyText) {
        const collapsed = ui.collapsed.has(id);

        return el('section', { class: `group ${collapsed ? 'collapsed' : ''}` },
            el('button', {
                class: 'group-header',
                'aria-expanded': String(!collapsed),
                onclick: () => {
                    collapsed ? ui.collapsed.delete(id) : ui.collapsed.add(id);
                    persist();
                    render();
                },
            }, icon('chevron', 'chevron'), el('span', {}, title), el('span', { class: 'count' }, tasks.length)),
            collapsed ? null : tasks.length
                ? el('div', { class: 'cards' }, tasks.map(card))
                : el('p', { class: 'empty' }, emptyText));
    }

    function card(task) {
        if (ui.editing && ui.editing.key === task.key) {
            return el('article', { class: 'card editing' }, editForm());
        }

        const expanded = ui.expanded.has(task.key);
        const toggleExpanded = () => {
            expanded ? ui.expanded.delete(task.key) : ui.expanded.add(task.key);
            persist();
            render();
        };

        return el('article', { class: `card ${task.checked ? 'checked' : ''} ${expanded ? 'open' : ''}` },
            el('button', {
                class: 'tick',
                title: task.checked ? 'Untick (back to to do)' : 'Tick (sends it to review)',
                'aria-label': task.checked ? `Untick ${task.name}` : `Tick ${task.name}`,
                'aria-pressed': String(task.checked),
                onclick: () => {
                    task.checked = !task.checked;
                    post({ type: 'toggle', key: task.key, name: task.name, checked: task.checked });
                    render();
                },
            }, task.checked ? icon('check') : null),
            el('div', { class: 'content' },
                el('div', {
                    class: 'summary',
                    role: 'button',
                    tabindex: '0',
                    'aria-expanded': String(expanded),
                    onclick: toggleExpanded,
                    onkeydown: event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleExpanded();
                        }
                    },
                },
                el('div', { class: 'title' }, task.name || '(no name)'),
                (task.checked || !task.id) ? el('div', { class: 'pills' },
                    task.checked ? el('span', { class: 'pill review' }, 'In review') : null,
                    !task.id ? el('span', { class: 'pill pending' }, 'Not synced yet') : null) : null,
                !expanded && task.preview ? el('div', { class: 'preview' }, task.preview) : null),
                expanded ? details(task) : null));
    }

    function details(task) {
        const description = task.html
            ? el('div', { class: 'description markdown', html: task.html })
            : task.desc
                ? el('div', { class: 'description plain' }, task.desc)
                : el('div', { class: 'description none' }, 'No description.');

        return el('div', { class: 'details' },
            description,
            el('div', { class: 'actions' },
                el('button', {
                    class: 'action',
                    onclick: () => {
                        ui.editing = { key: task.key, name: task.name, newName: task.name, desc: task.desc };
                        render();
                        focusField('edit-name');
                    },
                }, icon('edit'), 'Edit'),
                task.id ? el('button', { class: 'action', onclick: () => post({ type: 'openInClickUp', id: task.id }) }, icon('external'), 'ClickUp') : null,
                el('button', { class: 'action', onclick: () => post({ type: 'openInFile', key: task.key, name: task.name }) }, icon('file'), 'TODO.md')));
    }

    function formKeys(save, cancel) {
        return event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                save();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
            }
        };
    }

    function taskForm(prefix, values, onName, onDesc, save, cancel, saveLabel) {
        const keys = formKeys(save, cancel);

        return el('form', {
            class: 'form',
            onsubmit: event => {
                event.preventDefault();
                save();
            },
        },
        el('input', {
            class: 'input',
            placeholder: 'Task name',
            'data-focus': `${prefix}-name`,
            value: values.name,
            oninput: event => onName(event.target.value),
            onkeydown: event => {
                if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
                    event.preventDefault();
                    save();
                } else {
                    keys(event);
                }
            },
        }),
        el('textarea', {
            class: 'input',
            rows: '3',
            placeholder: 'Description (optional, Markdown)',
            'data-focus': `${prefix}-desc`,
            value: values.desc,
            oninput: event => {
                onDesc(event.target.value);
                autosize(event.target);
            },
            onkeydown: keys,
        }),
        el('div', { class: 'form-footer' },
            el('span', { class: 'hint' }, 'Ctrl+Enter saves · Esc cancels'),
            el('div', { class: 'buttons' },
                el('button', { type: 'button', class: 'button secondary', onclick: cancel }, 'Cancel'),
                el('button', { type: 'submit', class: 'button primary', disabled: !values.name.trim() }, saveLabel))));
    }

    function addForm() {
        const list = state.lists.find(item => item.id === state.selectedListId);
        const save = () => {
            const { name, desc } = ui.adding;
            if (!name.trim()) {
                return;
            }
            post({ type: 'add', name, desc });
            state.tasks.push({ key: `pending:${Date.now()}`, name: name.trim(), desc: desc.trim(), preview: '', checked: false });
            ui.adding = null;
            render();
        };
        const cancel = () => {
            ui.adding = null;
            render();
        };

        return el('div', { class: 'card adding' },
            el('div', { class: 'form-title' }, `New task in ${list ? list.name : 'this list'}`),
            taskForm('add', ui.adding,
                value => {
                    ui.adding.name = value;
                    syncSaveButton(value);
                },
                value => {
                    ui.adding.desc = value;
                },
                save, cancel, 'Add task'));
    }

    function editForm() {
        const save = () => {
            const { key, name, newName, desc } = ui.editing;
            if (!newName.trim()) {
                return;
            }
            post({ type: 'edit', key, name, newName, desc });
            const task = state.tasks.find(item => item.key === key);
            if (task) {
                task.name = newName.trim();
                task.desc = desc.trim();
                task.html = null;
            }
            ui.editing = null;
            render();
        };
        const cancel = () => {
            ui.editing = null;
            render();
        };

        return taskForm('edit', { name: ui.editing.newName, desc: ui.editing.desc },
            value => {
                ui.editing.newName = value;
                syncSaveButton(value);
            },
            value => {
                ui.editing.desc = value;
            },
            save, cancel, 'Save');
    }

    function syncSaveButton(name) {
        const button = app.querySelector('.form button[type="submit"]');
        if (button) {
            button.disabled = !name.trim();
        }
    }

    function statusLine() {
        const { kind, text, detail } = state.status;

        return el('div', { class: `status ${kind}`, title: detail || text },
            el('span', { class: 'dot' }),
            el('span', {}, text),
            kind === 'error' ? el('button', { class: 'link', onclick: () => post({ type: 'sync' }) }, 'Retry') : null);
    }

    window.addEventListener('message', event => {
        if (event.data.type !== 'state') {
            return;
        }
        state = event.data.state;
        if (ui.editing && !state.tasks.some(task => task.key === ui.editing.key)) {
            ui.editing = null;
        }
        render();
    });

    render();
    post({ type: 'ready' });
}());
