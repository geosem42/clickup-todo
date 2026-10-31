import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allTasks, commentText, MARKER, parse, previewOf, render, renderTask } from '../todoFile';

const lists = [
    { id: 'misc', name: 'MISC TASKS' },
    { id: 'acc', name: 'ACCOUNTING MODULE' },
];

test('tasks above any heading go to the default list, sub-bullets become the description', () => {
    const doc = parse([
        '# TODO',
        '',
        '- [ ] **Card top-ups: accented name**',
        '  - The bank sends the name in an old encoding.',
        '  - Fix: read it anyway.',
        '',
        '- [x] **Void a top-up**',
        '  - Add a "Tx ID" column.',
        '',
    ].join('\n'), lists, 'misc');

    const tasks = allTasks(doc);
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks.map(task => [task.name, task.listId, task.checked]), [
        ['Card top-ups: accented name', 'misc', false],
        ['Void a top-up', 'misc', true],
    ]);
    assert.equal(tasks[0].desc, '- The bank sends the name in an old encoding.\n- Fix: read it anyway.');
    assert.deepEqual(doc.preamble, ['# TODO', '']);
});

test('render gives every list a heading, keeps ids, and parses back to the same tasks', () => {
    const doc = parse([
        '# TODO',
        '',
        '## accounting module',
        '',
        '- [ ] **Closing** <!-- cu:abc123 -->',
        '  First paragraph.',
        '',
        '  Second paragraph.',
        '',
        '## Someone\'s notes',
        'free text stays',
    ].join('\n'), lists, 'misc');

    const text = render(doc, lists);
    assert.equal(text, [
        '# TODO',
        '',
        MARKER,
        '',
        '## MISC TASKS',
        '',
        '## ACCOUNTING MODULE',
        '',
        '- [ ] **Closing** <!-- cu:abc123 -->',
        '  First paragraph.',
        '',
        '  Second paragraph.',
        '',
        '## Someone\'s notes',
        'free text stays',
        '',
    ].join('\n'));

    const again = allTasks(parse(text, lists, 'misc'));
    assert.deepEqual(again.map(task => [task.id, task.name, task.desc, task.listId]), [
        ['abc123', 'Closing', 'First paragraph.\n\nSecond paragraph.', 'acc'],
    ]);
    assert.equal(render(parse(text, lists, 'misc'), lists), text);
});

test('a copied id is only kept on its first task', () => {
    const tasks = allTasks(parse('- [ ] **A** <!-- cu:x1 -->\n- [ ] **B** <!-- cu:x1 -->\n', lists, 'misc'));
    assert.deepEqual(tasks.map(task => task.id), ['x1', undefined]);
});

test('card previews drop markdown and ClickUp\'s backslash escapes', () => {
    assert.equal(
        previewOf('\\# ACME – Request Form\n\\\\Objective:\\\\ Restructure the **form**\n*   see [the wiki](https://example.com) and `code`'),
        'ACME – Request Form · Objective: Restructure the form · see the wiki and code',
    );
});

const withComments = [
    '# TODO',
    '',
    MARKER,
    '',
    '## MISC TASKS',
    '',
    '- [ ] **Closing** <!-- cu:abc123 -->',
    '  First paragraph.',
    '',
    '  Second paragraph.',
    '  <!-- comment cu:90150 -->',
    '  Posted already.',
    '  <!-- /comment -->',
    '',
    '  <!-- comment -->',
    '',
    '  Not posted yet,',
    '    over two lines.',
    '',
    '  <!-- /comment -->',
    '',
    '- [x] **No description** <!-- cu:def456 -->',
    '  <!-- comment -->',
    '  Only a note.',
    '  <!-- /comment -->',
    '',
    '## ACCOUNTING MODULE',
];

test('comment blocks, posted and unposted, survive parse and render exactly', () => {
    const text = withComments.join('\n') + '\n';
    const doc = parse(text, lists, 'misc');

    assert.equal(render(doc, lists), text);
    const [closing, other] = allTasks(doc);
    assert.deepEqual(closing.comments!.map(block => [block.id, commentText(block), block.closed, block.blankBefore]), [
        ['90150', 'Posted already.', true, false],
        [undefined, 'Not posted yet,\n  over two lines.', true, true],
    ]);
    assert.deepEqual(other.comments!.map(block => commentText(block)), ['Only a note.']);
});

test('the description never holds comment blocks, and a new description keeps them', () => {
    const text = withComments.join('\n') + '\n';
    const doc = parse(text, lists, 'misc');
    const [closing, other] = allTasks(doc);
    assert.equal(closing.desc, 'First paragraph.\n\nSecond paragraph.');
    assert.equal(other.desc, '');

    // A description pulled from ClickUp or edited in the sidebar replaces only the description.
    closing.desc = 'Replaced.';
    other.desc = 'Now described.';
    const again = allTasks(parse(render(doc, lists), lists, 'misc'));
    assert.deepEqual(again.map(task => [task.desc, task.comments!.map(block => [block.id, commentText(block)])]), [
        ['Replaced.', [['90150', 'Posted already.'], [undefined, 'Not posted yet,\n  over two lines.']]],
        ['Now described.', [[undefined, 'Only a note.']]],
    ]);
    assert.deepEqual(renderTask({ ...again[1], desc: '' }), [
        '- [x] **No description** <!-- cu:def456 -->',
        '  <!-- comment -->',
        '  Only a note.',
        '  <!-- /comment -->',
    ]);
});

test('an unclosed block ends with its task: the next tasks and headings stay intact', () => {
    const text = [
        '- [ ] **A** <!-- cu:a1 -->',
        '  Description of A.',
        '  <!-- comment -->',
        '  still typing',
        '',
        '- [ ] **B** <!-- cu:b1 -->',
        '  Description of B.',
        '',
        '## ACCOUNTING MODULE',
        '',
        '- [ ] **C**',
        '',
    ].join('\n');
    const doc = parse(text, lists, 'misc');
    const tasks = allTasks(doc);

    assert.deepEqual(tasks.map(task => [task.name, task.desc, task.listId]), [
        ['A', 'Description of A.', 'misc'],
        ['B', 'Description of B.', 'misc'],
        ['C', '', 'acc'],
    ]);
    assert.deepEqual(tasks[0].comments!.map(block => [block.closed, commentText(block)]), [[false, 'still typing']]);
    assert.equal(tasks[1].comments, undefined);

    const rendered = render(doc, lists);
    assert.ok(rendered.includes('  Description of A.\n  <!-- comment -->\n  still typing\n\n- [ ] **B** <!-- cu:b1 -->\n'));
    assert.equal(render(parse(rendered, lists, 'misc'), lists), rendered);
});

test('a second opening marker leaves the first block unclosed', () => {
    const [task] = allTasks(parse('- [ ] **A**\n  <!-- comment -->\n  one\n  <!-- comment -->\n  two\n  <!-- /comment -->\n', lists, 'misc'));
    assert.deepEqual(task.comments!.map(block => [block.closed, commentText(block)]), [[false, 'one'], [true, 'two']]);
    assert.equal(task.desc, '');
});
