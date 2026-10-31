/**
 * Turns a comment block's text into ClickUp's rich-text comment format (Quill-style).
 *
 * Each line becomes its text pieces followed by a "\n" piece that carries the line's format:
 * "## Heading" → bold pieces + header 3, "- item" → bullet list, "1. step" → ordered list,
 * anything else → a plain line. "**x**" inside a line is bold.
 */

export interface RichTextPiece {
    text: string;
    attributes: Record<string, unknown>;
}

const HEADING = /^\s*#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

/** Splits a line on "**bold**" runs; an unmatched "**" stays as text. */
function inlinePieces(line: string, bold: boolean): RichTextPiece[] {
    const pieces: RichTextPiece[] = [];
    const push = (text: string, isBold: boolean): void => {
        if (text) {
            pieces.push({ text, attributes: isBold ? { bold: true } : {} });
        }
    };

    let rest = line;
    let match: RegExpExecArray | null;
    while ((match = /\*\*(.+?)\*\*/.exec(rest)) !== null) {
        push(rest.slice(0, match.index), bold);
        push(match[1], true);
        rest = rest.slice(match.index + match[0].length);
    }
    push(rest, bold);

    return pieces;
}

export function commentToRichText(text: string): RichTextPiece[] {
    const pieces: RichTextPiece[] = [];
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        let match: RegExpExecArray | null;
        if ((match = HEADING.exec(line)) !== null) {
            pieces.push(...inlinePieces(match[1], true), { text: '\n', attributes: { header: 3 } });
        } else if ((match = BULLET.exec(line)) !== null) {
            pieces.push(...inlinePieces(match[1], false), { text: '\n', attributes: { list: { list: 'bullet' } } });
        } else if ((match = ORDERED.exec(line)) !== null) {
            pieces.push(...inlinePieces(match[1], false), { text: '\n', attributes: { list: { list: 'ordered' } } });
        } else {
            pieces.push(...inlinePieces(line, false), { text: '\n', attributes: {} });
        }
    }

    return pieces;
}
