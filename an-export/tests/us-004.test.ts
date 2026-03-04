/**
 * Unit tests for US-004: Note Content to Markdown Converter.
 *
 * Each test provides a mock ANNote (noteText + attributeRun[])
 * and asserts the correct Markdown output.
 */

import { describe, it, expect } from 'bun:test';
import { convertNoteToMarkdown } from '../src/converter.ts';
import type { ANNote, ANAttributeRun } from '../src/types.ts';
import { ANStyleType, ANFontWeight, ANBaseline, ANAlignment } from '../src/types.ts';

/** Helper: build a minimal ANNote from text and runs. */
function makeNote(noteText: string, attributeRun: ANAttributeRun[]): ANNote {
  return { noteText, attributeRun };
}

/** Helper: build a simple run with just a length. */
function run(length: number, attrs: Partial<ANAttributeRun> = {}): ANAttributeRun {
  return { length, ...attrs };
}

// ── First Line Omission ──────────────────────────────────────────────────────

describe('first line omission', () => {
  it('omits the first line (title) by default', async () => {
    const note = makeNote('My Title\nSome body text\n', [
      run(9),  // "My Title\n"
      run(15), // "Some body text\n"
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).not.toContain('My Title');
    expect(md).toContain('Some body text');
  });

  it('keeps the first line when omitFirstLine is false', async () => {
    const note = makeNote('My Title\nBody\n', [
      run(9),  // "My Title\n"
      run(5),  // "Body\n"
    ]);
    const md = await convertNoteToMarkdown(note, { omitFirstLine: false });
    expect(md).toContain('My Title');
    expect(md).toContain('Body');
  });
});

// ── Bold / Italic / BoldItalic ───────────────────────────────────────────────

describe('inline formatting', () => {
  it('converts bold text', async () => {
    const note = makeNote('Title\nHello bold world\n', [
      run(6),  // "Title\n"
      run(6),  // "Hello "
      run(4, { fontWeight: ANFontWeight.Bold }), // "bold"
      run(7),  // " world\n"
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('**bold**');
  });

  it('converts italic text', async () => {
    const note = makeNote('Title\nsome italic text\n', [
      run(6),
      run(5),  // "some "
      run(6, { fontWeight: ANFontWeight.Italic }),  // "italic"
      run(6),  // " text\n"
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('*italic*');
  });

  it('converts bold-italic text', async () => {
    const note = makeNote('Title\nbolditalic\n', [
      run(6),
      run(10, { fontWeight: ANFontWeight.BoldItalic }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('***bolditalic***');
  });

  it('converts strikethrough text', async () => {
    const note = makeNote('Title\nstruck\n', [
      run(6),
      run(6, { strikethrough: 1 }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('~~struck~~');
  });

  it('converts underlined text', async () => {
    const note = makeNote('Title\nunderlined\n', [
      run(6),
      run(10, { underlined: 1 }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('<u>underlined</u>');
  });

  it('converts superscript', async () => {
    const note = makeNote('Title\nsuper\n', [
      run(6),
      run(5, { superscript: ANBaseline.Super }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('<sup>super</sup>');
  });

  it('converts subscript', async () => {
    const note = makeNote('Title\nsub\n', [
      run(6),
      run(3, { superscript: ANBaseline.Sub }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('<sub>sub</sub>');
  });
});

// ── Inline Attachments ───────────────────────────────────────────────────────

describe('inline attachments', () => {
  it('resolves attachments using the callback', async () => {
    const note = makeNote('Title\nHere is an image: \ufffc\n', [
      run(6), // "Title\n"
      run(18), // "Here is an image: "
      run(1, { attachmentInfo: { attachmentIdentifier: '123', typeUti: 'public.png' } }), // "\ufffc"
      run(1), // "\n"
    ]);

    const md = await convertNoteToMarkdown(note, {
      resolveAttachment: async (info) => {
        if (info.attachmentIdentifier === '123') {
          return '![image](attachments/123.png)';
        }
        return '';
      },
    });

    expect(md).toContain('Here is an image:');
    expect(md).toContain('![image](attachments/123.png)');
  });
});

// ── Headings ─────────────────────────────────────────────────────────────────

describe('headings', () => {
  it('converts Title to h1', async () => {
    const note = makeNote('Title\nSection Title\n', [
      run(6),
      run(14, { paragraphStyle: { styleType: ANStyleType.Title } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('# Section Title');
  });

  it('converts Heading to h2', async () => {
    const note = makeNote('Title\nHeading Text\n', [
      run(6),
      run(13, { paragraphStyle: { styleType: ANStyleType.Heading } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('## Heading Text');
  });

  it('converts Subheading to h3', async () => {
    const note = makeNote('Title\nSubheading\n', [
      run(6),
      run(11, { paragraphStyle: { styleType: ANStyleType.Subheading } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('### Subheading');
  });
});

// ── Lists ────────────────────────────────────────────────────────────────────

describe('lists', () => {
  it('converts dotted list items', async () => {
    const note = makeNote('Title\nItem A\nItem B\n', [
      run(6),
      run(7, { paragraphStyle: { styleType: ANStyleType.DottedList } }),
      run(7, { paragraphStyle: { styleType: ANStyleType.DottedList } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('- Item A');
    expect(md).toContain('- Item B');
  });

  it('converts dashed list items', async () => {
    const note = makeNote('Title\nDash item\n', [
      run(6),
      run(10, { paragraphStyle: { styleType: ANStyleType.DashedList } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('- Dash item');
  });

  it('converts numbered list with auto-incrementing', async () => {
    const note = makeNote('Title\nFirst\nSecond\nThird\n', [
      run(6),
      run(6, { paragraphStyle: { styleType: ANStyleType.NumberedList } }),
      run(7, { paragraphStyle: { styleType: ANStyleType.NumberedList } }),
      run(6, { paragraphStyle: { styleType: ANStyleType.NumberedList } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('1. First');
    expect(md).toContain('2. Second');
    expect(md).toContain('3. Third');
  });

  it('converts unchecked checkbox items', async () => {
    const note = makeNote('Title\nTodo\n', [
      run(6),
      run(5, {
        paragraphStyle: {
          styleType: ANStyleType.Checkbox,
          checklist: { done: 0, uuid: new Uint8Array(16) },
        },
      }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('- [ ] Todo');
  });

  it('converts checked checkbox items', async () => {
    const note = makeNote('Title\nDone\n', [
      run(6),
      run(5, {
        paragraphStyle: {
          styleType: ANStyleType.Checkbox,
          checklist: { done: 1, uuid: new Uint8Array(16) },
        },
      }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('- [x] Done');
  });
});

// ── Indentation ──────────────────────────────────────────────────────────────

describe('indentation', () => {
  it('indents list items with tab characters', async () => {
    const note = makeNote('Title\nNested item\n', [
      run(6),
      run(12, {
        paragraphStyle: { styleType: ANStyleType.DottedList, indentAmount: 2 },
      }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('\t\t- Nested item');
  });
});

// ── Paragraphs ───────────────────────────────────────────────────────────────

describe('paragraphs', () => {
  it('maintains empty lines between paragraphs', async () => {
    const note = makeNote('Title\nPara 1\n\nPara 2\n', [
      run(6),
      run(7), // "Para 1\n"
      run(1), // "\n"
      run(7), // "Para 2\n"
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('Para 1\n\nPara 2');
  });
});

// ── Blockquotes ──────────────────────────────────────────────────────────────

describe('blockquotes', () => {
  it('prefixes blockquoted text with >', async () => {
    const note = makeNote('Title\nQuoted text\n', [
      run(6),
      run(12, { paragraphStyle: { blockquote: 1 } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('> Quoted text');
  });
});

// ── Code Blocks ──────────────────────────────────────────────────────────────

describe('code blocks', () => {
  it('wraps monospaced text in fenced code blocks', async () => {
    const note = makeNote('Title\nconst x = 1;\nconst y = 2;\n', [
      run(6),
      run(13, { paragraphStyle: { styleType: ANStyleType.Monospaced } }),
      run(13, { paragraphStyle: { styleType: ANStyleType.Monospaced } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
    expect(md).toContain('const y = 2;');
  });

  it('closes code blocks when style changes back to default', async () => {
    const note = makeNote('Title\ncode line\nnormal text\n', [
      run(6),
      run(10, { paragraphStyle: { styleType: ANStyleType.Monospaced } }),
      run(12),
    ]);
    const md = await convertNoteToMarkdown(note);
    const parts = md.split('```');
    // Should have: before code, code content, after code
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(md).toContain('normal text');
  });
});

// ── Links ────────────────────────────────────────────────────────────────────

describe('links', () => {
  it('converts external links to markdown links', async () => {
    const note = makeNote('Title\nClick here\n', [
      run(6),
      run(10, { link: 'https://example.com' }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('[Click here](https://example.com)');
  });

  it('resolves internal Apple Notes links', async () => {
    const note = makeNote('Title\nOther Note\n', [
      run(6),
      run(10, { link: 'applenotes:note/ABC-123' }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note, {
      resolveNoteLink: (uuid) => (uuid === 'ABC-123' ? 'My Other Note' : undefined),
    });
    expect(md).toContain('[[My Other Note]]');
  });

  it('falls back to UUID if note link cannot be resolved', async () => {
    const note = makeNote('Title\nLinked\n', [
      run(6),
      run(6, { link: 'applenotes:note/UNKNOWN-UUID' }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('[[UNKNOWN-UUID]]');
  });
});

// ── Alignment ────────────────────────────────────────────────────────────────

describe('alignment', () => {
  it('wraps center-aligned text in a styled p tag', async () => {
    const note = makeNote('Title\nCentered\n', [
      run(6),
      run(9, { paragraphStyle: { alignment: ANAlignment.Centre } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('<p style="text-align:center;margin:0">Centered</p>');
  });

  it('wraps right-aligned text', async () => {
    const note = makeNote('Title\nRight\n', [
      run(6),
      run(6, { paragraphStyle: { alignment: ANAlignment.Right } }),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('<p style="text-align:right;margin:0">Right</p>');
  });
});

// ── Markdown Escaping ────────────────────────────────────────────────────────

describe('markdown escaping', () => {
  it('escapes square brackets in body text', async () => {
    const note = makeNote('Title\nSee [this] link\n', [
      run(6),
      run(16),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('\\[this\\]');
  });
});

// ── Color ────────────────────────────────────────────────────────────────────

describe('color', () => {
  it('wraps colored text in a span with inline style', async () => {
    const note = makeNote('Title\nred text\n', [
      run(6),
      run(8, { color: { red: 1, green: 0, blue: 0, alpha: 1 } }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).toContain('<span style="color:#ff0000">red text</span>');
  });

  it('does not wrap black (default) text in color span', async () => {
    const note = makeNote('Title\nblack text\n', [
      run(6),
      run(10, { color: { red: 0, green: 0, blue: 0, alpha: 1 } }),
      run(1),
    ]);
    const md = await convertNoteToMarkdown(note);
    expect(md).not.toContain('<span style="color');
    expect(md).toContain('black text');
  });
});

// ── Empty / Edge Cases ───────────────────────────────────────────────────────

describe('edge cases', () => {
  it('returns empty string for empty note', async () => {
    const note = makeNote('', []);
    const md = await convertNoteToMarkdown(note);
    expect(md).toBe('');
  });

  it('handles note with only a title and no body', async () => {
    const note = makeNote('Just a Title\n', [run(13)]);
    const md = await convertNoteToMarkdown(note);
    expect(md.trim()).toBe('');
  });
});
