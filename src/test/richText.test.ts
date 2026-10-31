import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ClickUpClient } from '../clickup';
import { commentToRichText } from '../richText';

const newline = (attributes: Record<string, unknown> = {}) => ({ text: '\n', attributes });

test('a heading is bold with header 3 on its newline', () => {
    assert.deepEqual(commentToRichText('## What changed'), [
        { text: 'What changed', attributes: { bold: true } },
        newline({ header: 3 }),
    ]);
});

test('bullets and numbered steps carry their list type on the newline', () => {
    assert.deepEqual(commentToRichText('- first\n* second\n1. step one\n2) step two'), [
        { text: 'first', attributes: {} },
        newline({ list: { list: 'bullet' } }),
        { text: 'second', attributes: {} },
        newline({ list: { list: 'bullet' } }),
        { text: 'step one', attributes: {} },
        newline({ list: { list: 'ordered' } }),
        { text: 'step two', attributes: {} },
        newline({ list: { list: 'ordered' } }),
    ]);
});

test('**bold** inside a line is split into its own bold piece', () => {
    assert.deepEqual(commentToRichText('Run **npm run build** on prod, then **reload**.'), [
        { text: 'Run ', attributes: {} },
        { text: 'npm run build', attributes: { bold: true } },
        { text: ' on prod, then ', attributes: {} },
        { text: 'reload', attributes: { bold: true } },
        { text: '.', attributes: {} },
        newline(),
    ]);
});

test('plain lines, blank lines and an unmatched ** stay as they are', () => {
    assert.deepEqual(commentToRichText('Tested on prod.\n\nCosts 2 ** 3 dollars'), [
        { text: 'Tested on prod.', attributes: {} },
        newline(),
        newline(),
        { text: 'Costs 2 ** 3 dollars', attributes: {} },
        newline(),
    ]);
});

test('a bullet with bold text and a heading with bold text', () => {
    assert.deepEqual(commentToRichText('## **Before** vs now\n- **Now:** it works'), [
        { text: 'Before', attributes: { bold: true } },
        { text: ' vs now', attributes: { bold: true } },
        newline({ header: 3 }),
        { text: 'Now:', attributes: { bold: true } },
        { text: ' it works', attributes: {} },
        newline({ list: { list: 'bullet' } }),
    ]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

test('posting a comment sends only the rich-text "comment" array, quietly', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url: string, init: { body: string }) => {
        sent.push({ url, body: JSON.parse(init.body) });

        return new Response(JSON.stringify({ id: 90150 }), { status: 200 });
    }) as unknown as typeof fetch;

    const id = await new ClickUpClient('pk_test').postComment('abc123', '## Done\n- **Tested** on prod');

    assert.equal(id, '90150');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.clickup.com/api/v2/task/abc123/comment');
    assert.deepEqual(Object.keys(sent[0].body).sort(), ['comment', 'notify_all']);
    assert.equal(sent[0].body.notify_all, false);
    assert.deepEqual(sent[0].body.comment, commentToRichText('## Done\n- **Tested** on prod'));
});
