/**
 * Block markdown: paragraphs, ATX headings, fenced code, block quotes, bullet, numbered and task lists (nested by
 * indent), GitHub tables and rules. Tolerant of text that is still streaming: a fence that hasn't closed yet is an
 * open code block holding everything after it.
 */
import type { MdAlign, MdBlock, MdListItem } from './ast.ts';
import { parseInline } from './inline.ts';

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+/;
const LEVELS = [1, 2, 3, 4, 5, 6] as const;

const isBlank = (line: string): boolean => line.trim() === '';
const indentOf = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;

/** Split a table row into its cells, honouring escaped pipes. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function alignOf(cell: string): MdAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** Whether a line starts a block other than a paragraph (so it ends a paragraph above it). */
function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line)
    || (line.includes('|') && next !== undefined && TABLE_DELIMITER.test(next) && next.includes('-'));
}

class BlockReader {
  #at = 0;
  readonly #lines: readonly string[];

  constructor(lines: readonly string[]) {
    this.#lines = lines;
  }

  read(): MdBlock[] {
    const blocks: MdBlock[] = [];
    while (this.#at < this.#lines.length) {
      const line = this.#lines[this.#at] ?? '';
      if (isBlank(line)) { this.#at++; continue; }
      blocks.push(this.#block(line));
    }
    return blocks;
  }

  #block(line: string): MdBlock {
    const fence = FENCE.exec(line);
    if (fence) { return this.#code(fence[1] ?? '```', fence[2] ?? ''); }
    const heading = HEADING.exec(line);
    if (heading) {
      this.#at++;
      return { type: 'heading', level: LEVELS[(heading[1]?.length ?? 1) - 1] ?? 6, children: parseInline(heading[2] ?? '') };
    }
    if (RULE.test(line)) { this.#at++; return { type: 'rule' }; }
    if (QUOTE.test(line)) { return this.#quote(); }
    if (LIST.test(line)) { return this.#list(); }
    const next = this.#lines[this.#at + 1];
    if (line.includes('|') && next !== undefined && TABLE_DELIMITER.test(next) && next.includes('-')) { return this.#table(); }
    return this.#paragraph();
  }

  #code(marker: string, lang: string): MdBlock {
    const fenceChar = marker[0] ?? '`';
    this.#at++;
    const body: string[] = [];
    while (this.#at < this.#lines.length) {
      const line = this.#lines[this.#at] ?? '';
      const close = new RegExp(`^ {0,3}\\${fenceChar}{${marker.length},}\\s*$`).test(line);
      this.#at++;
      if (close) { return { type: 'code', lang, text: body.join('\n'), open: false }; }
      body.push(line);
    }
    return { type: 'code', lang, text: body.join('\n'), open: true };
  }

  #quote(): MdBlock {
    const inner: string[] = [];
    while (this.#at < this.#lines.length) {
      const line = this.#lines[this.#at] ?? '';
      const quoted = QUOTE.exec(line);
      if (quoted) { inner.push(quoted[1] ?? ''); this.#at++; continue; }
      // a lazy continuation line of a quoted paragraph
      if (!isBlank(line) && inner.length > 0 && !isBlank(inner.at(-1) ?? '') && !startsBlock(line, this.#lines[this.#at + 1])) { inner.push(line); this.#at++; continue; }
      break;
    }
    return { type: 'quote', children: new BlockReader(inner).read() };
  }

  #list(): MdBlock {
    const first = LIST.exec(this.#lines[this.#at] ?? '');
    const ordered = /\d/.test(first?.[2] ?? '');
    const start = ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1;
    const items: MdListItem[] = [];
    while (this.#at < this.#lines.length) {
      const line = this.#lines[this.#at] ?? '';
      const marker = LIST.exec(line);
      if (!marker || /\d/.test(marker[2] ?? '') !== ordered) { break; }
      const width = (marker[1] ?? '').length + (marker[2] ?? '').length + Math.min((marker[3] ?? ' ').length || 1, 4);
      const body = [marker[4] ?? ''];
      this.#at++;
      while (this.#at < this.#lines.length) {
        const next = this.#lines[this.#at] ?? '';
        if (isBlank(next)) {
          const after = this.#lines[this.#at + 1];
          if (after !== undefined && indentOf(after) >= width) { body.push(''); this.#at++; continue; }
          break;
        }
        if (indentOf(next) >= width) { body.push(next.slice(width)); this.#at++; continue; }
        if (LIST.test(next) || startsBlock(next, this.#lines[this.#at + 1])) { break; }
        body.push(next.trimStart());
        this.#at++;
      }
      const task = TASK.exec(body[0] ?? '');
      if (task) { body[0] = (body[0] ?? '').slice(task[0].length); }
      items.push({ checked: task ? task[1] !== ' ' : undefined, children: new BlockReader(body).read() });
      // a blank line between items keeps the list going
      if (isBlank(this.#lines[this.#at] ?? 'x') && LIST.test(this.#lines[this.#at + 1] ?? '')) { this.#at++; }
    }
    return { type: 'list', ordered, start, items };
  }

  #table(): MdBlock {
    const head = cells(this.#lines[this.#at] ?? '');
    const align = cells(this.#lines[this.#at + 1] ?? '').map(alignOf);
    this.#at += 2;
    const rows: string[][] = [];
    while (this.#at < this.#lines.length) {
      const line = this.#lines[this.#at] ?? '';
      if (isBlank(line) || !line.includes('|')) { break; }
      rows.push(cells(line));
      this.#at++;
    }
    const width = head.length;
    const fit = (row: readonly string[]): string[] => Array.from({ length: width }, (_, i) => row[i] ?? '');
    return { type: 'table', align: Array.from({ length: width }, (_, i) => align[i] ?? null), head: head.map(parseInline), rows: rows.map((row) => fit(row).map(parseInline)) };
  }

  #paragraph(): MdBlock {
    const text: string[] = [];
    while (this.#at < this.#lines.length) {
      const line = this.#lines[this.#at] ?? '';
      if (isBlank(line) || (text.length > 0 && startsBlock(line, this.#lines[this.#at + 1]))) { break; }
      text.push(text.length === 0 ? line.trimStart() : line);
      this.#at++;
    }
    return { type: 'paragraph', children: parseInline(text.join('\n').trimEnd()) };
  }
}

/** Parse a markdown document into blocks. */
export function parseMarkdown(source: string): MdBlock[] {
  return new BlockReader(source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')).read();
}
