/**
 * Note Content → Markdown Converter.
 *
 * Walks an ANNote's attributeRun[] array, slicing noteText by cumulative length,
 * and converts each fragment to Markdown based on its formatting attributes.
 *
 * Based on the obsidian-importer's convert-note.ts (MIT License).
 */

import type {
  ANNote,
  ANAttributeRun,
  ANParagraphStyle,
  ANAttachmentInfo,
} from './types.ts';
import {
  ANStyleType,
  ANFontWeight,
  ANBaseline,
  ANAlignment,
} from './types.ts';
import { colorToHex } from './utils.ts';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Options controlling converter behavior.
 */
export type ConverterOptions = {
  /** If true, omit the first line (Apple Notes uses it as the title). Default: true. */
  omitFirstLine?: boolean;
  /** Callback to resolve an attachment. Returns the markdown string for it. */
  resolveAttachment?: (info: ANAttachmentInfo) => Promise<string>;
  /** Callback to resolve an internal note link UUID to a note title. */
  resolveNoteLink?: (uuid: string) => string | undefined;
};

/**
 * Convert an ANNote (decoded protobuf) to a Markdown string.
 */
export async function convertNoteToMarkdown(
  note: ANNote,
  options: ConverterOptions = {},
): Promise<string> {
  const { omitFirstLine = true, resolveAttachment, resolveNoteLink } = options;

  const { noteText, attributeRun } = note;
  if (!noteText || !attributeRun?.length) return '';

  const lines: string[] = [];
  let pos = 0;
  let isFirstLine = true;
  let inCodeBlock = false;
  let listCounters: Record<number, number> = {};
  let prevIndent = -1;

  for (let i = 0; i < attributeRun.length; i++) {
    const run = attributeRun[i]!;
    const fragment = noteText.slice(pos, pos + run.length);
    pos += run.length;

    const style = run.paragraphStyle;
    const styleType = style?.styleType ?? ANStyleType.Default;

    // Split by newlines — each newline potentially starts a new paragraph/block
    const subFragments = fragment.split('\n');

    for (let j = 0; j < subFragments.length; j++) {
      const text = subFragments[j]!;
      const isNewlineBoundary = j > 0;

      // On newline boundary, handle end-of-line concerns
      if (isNewlineBoundary) {
        // Close code block if we're leaving monospaced
        if (inCodeBlock && styleType !== ANStyleType.Monospaced) {
          lines.push('```');
          inCodeBlock = false;
        }

        // Reset list counters when indent changes
        if (styleType !== ANStyleType.NumberedList) {
          listCounters = {};
          prevIndent = -1;
        }

        // Mark first line as consumed
        if (isFirstLine) {
          isFirstLine = false;
          if (omitFirstLine) continue;
        }

        // Push a blank line for paragraph breaks (empty text after newline)
        if (text === '') {
          lines.push('');
          continue;
        }
      }

      // Skip first line content if omitting
      if (isFirstLine && omitFirstLine && !isNewlineBoundary) {
        continue;
      }

      // Handle attachment
      if (run.attachmentInfo && text === '\ufffc') {
        if (resolveAttachment) {
          const attachmentMd = await resolveAttachment(run.attachmentInfo);
          if (attachmentMd) {
            // Append if previous line is not empty and not just starting, or else push new line
            if (lines.length > 0 && lines[lines.length - 1] !== '') {
              lines[lines.length - 1] += attachmentMd;
            } else {
              lines.push(attachmentMd);
            }
          }
        }
        continue;
      }

      if (text === '') continue;

      // ── Monospaced / code blocks ────────────────────────────────────
      if (styleType === ANStyleType.Monospaced) {
        if (!inCodeBlock) {
          lines.push('```');
          inCodeBlock = true;
        }
        lines.push(text);
        continue;
      }

      // Close code block if we somehow got here while in one
      if (inCodeBlock) {
        lines.push('```');
        inCodeBlock = false;
      }

      // ── Build the formatted text ────────────────────────────────────
      let md = formatInlineText(text, run, resolveNoteLink);

      // ── Paragraph-level formatting ──────────────────────────────────
      const indent = style?.indentAmount ?? 0;
      const indentPrefix = '\t'.repeat(indent);

      // Headings
      if (styleType === ANStyleType.Title) {
        md = `# ${md}`;
      } else if (styleType === ANStyleType.Heading) {
        md = `## ${md}`;
      } else if (styleType === ANStyleType.Subheading) {
        md = `### ${md}`;
      }

      // Lists
      if (
        styleType === ANStyleType.DottedList ||
        styleType === ANStyleType.DashedList
      ) {
        md = `${indentPrefix}- ${md}`;
      } else if (styleType === ANStyleType.NumberedList) {
        // Reset counter if indent changed
        if (indent !== prevIndent) {
          listCounters[indent] = 0;
          prevIndent = indent;
        }
        listCounters[indent] = (listCounters[indent] ?? 0) + 1;
        md = `${indentPrefix}${listCounters[indent]}. ${md}`;
      } else if (styleType === ANStyleType.Checkbox) {
        const checked = style?.checklist?.done ? 'x' : ' ';
        md = `${indentPrefix}- [${checked}] ${md}`;
      }

      // Blockquote
      if (style?.blockquote) {
        md = `> ${md}`;
      }

      // Alignment (non-left)
      if (style?.alignment) {
        const alignMap: Record<number, string> = {
          [ANAlignment.Centre]: 'center',
          [ANAlignment.Right]: 'right',
          [ANAlignment.Justify]: 'justify',
        };
        const align = alignMap[style.alignment];
        if (align) {
          md = `<p style="text-align:${align};margin:0">${md}</p>`;
        }
      }

      if (lines.length > 0 && !isNewlineBoundary) {
        // Append to the current line if it's not a new paragraph
        lines[lines.length - 1] += md;
      } else {
        lines.push(md);
      }
    }
  }

  // Close any open code block at the end
  if (inCodeBlock) {
    lines.push('```');
  }

  return lines.join('\n');
}

// ─── Inline Formatting ───────────────────────────────────────────────────────

/**
 * Apply inline formatting (bold, italic, strikethrough, underline, links, etc.)
 * to a text fragment based on its AttributeRun attributes.
 */
function formatInlineText(
  text: string,
  run: ANAttributeRun,
  resolveNoteLink?: (uuid: string) => string | undefined,
): string {
  let md = escapeMarkdown(text);

  // Bold / Italic / BoldItalic
  if (run.fontWeight === ANFontWeight.BoldItalic) {
    md = `***${md}***`;
  } else if (run.fontWeight === ANFontWeight.Bold) {
    md = `**${md}**`;
  } else if (run.fontWeight === ANFontWeight.Italic) {
    md = `*${md}*`;
  }

  // Strikethrough
  if (run.strikethrough) {
    md = `~~${md}~~`;
  }

  // Underline
  if (run.underlined) {
    md = `<u>${md}</u>`;
  }

  // Superscript / Subscript
  if (run.superscript === ANBaseline.Super) {
    md = `<sup>${md}</sup>`;
  } else if (run.superscript === ANBaseline.Sub) {
    md = `<sub>${md}</sub>`;
  }

  // Link
  if (run.link) {
    if (run.link.startsWith('applenotes:note/')) {
      // Internal Apple Notes link
      const uuid = run.link.replace('applenotes:note/', '');
      const noteTitle = resolveNoteLink?.(uuid);
      if (noteTitle) {
        md = `[[${noteTitle}]]`;
      } else {
        md = `[[${uuid}]]`;
      }
    } else {
      // External link
      md = `[${md}](${run.link})`;
    }
  }

  // Color (non-default / non-black)
  if (run.color) {
    const { red, green, blue } = run.color;
    // Skip if it's effectively black (default)
    if (red > 0.01 || green > 0.01 || blue > 0.01) {
      const hex = colorToHex(red, green, blue);
      md = `<span style="color:${hex}">${md}</span>`;
    }
  }

  return md;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Escape Markdown special characters that could cause unintended formatting.
 * We escape square brackets to prevent accidental link/image syntax.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
