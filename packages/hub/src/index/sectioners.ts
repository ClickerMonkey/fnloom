/**
 * The hub's own sectioners (`hub/whole`, `hub/headings`, `hub/symbols`, `hub/pages`, `hub/paragraphs`, `hub/tables`,
 * declared in the hub's contract), and how sectioners are matched to resources. Each cuts a resource's primary form
 * (its markdown for a web page or a document, its pages for a pdf, its tables for a spreadsheet; the raw text when
 * it has no converted form), so offsets are into that form's text and each section says which form it is of.
 *
 * Headings and symbols are found by `@aeye/resources` (`splitMarkdownSections`, `splitCodeBlocks`: fenced code
 * skipped, the text before the first heading or declaration kept as its own section, doc comments kept with their
 * declaration); tables by the library's version sections, split into row groups of `TABLE_SECTION_ROWS` with the
 * header repeated in each group's embed text. Every key comes from structure (a heading path, a symbol name, a page
 * number, a table name and row range, a paragraph's opening words) through the SDK's `sectionKeys`, so a key survives
 * content moving around it.
 */
import { inferTypeFromLocation, sectionVersion, splitCodeBlocks, splitMarkdownSections, versionText } from '@aeye/resources';
import { PAGE_BREAK } from '@aeye/resources/versions';
import { qualify, type ConvertedVersion, type FormKind, type QualifiedName, type ResourceStat, type Section, type SectionMatch } from '@harness/core';
import { hub, sectionKeys } from '@harness/sdk';

/** What a sectioner cuts: a resource's text in one form, and that form's converted version when it has one. */
export interface SectionInput {
  readonly text: string;
  readonly stat: ResourceStat;
  /** The form `text` is of; the raw text when absent. */
  readonly form?: FormKind;
  readonly version?: ConvertedVersion;
}

/** Cuts a resource's text into sections. */
export interface Sectioner {
  readonly name: QualifiedName;
  readonly match: SectionMatch;
  sections(input: SectionInput): Section[];
}

/**
 * Rows per section of a large table. Part of every table section's key (`Sheet > rows 201-400`), so it is a fixed
 * fact of the key scheme rather than a tunable: changing it would re-key every table.
 */
export const TABLE_SECTION_ROWS = 200;

/** A piece of text with its place in the outline, before keys are made. */
interface Piece {
  readonly path: readonly string[];
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly embedText?: string;
}

/** Key pieces from their paths, in order, marked with the form they are of. */
function keyed(pieces: readonly Piece[], form: FormKind | undefined): Section[] {
  const keys = sectionKeys(pieces.map((p) => p.path));
  return pieces.flatMap((piece, i) => {
    const key = keys[i];
    return key === undefined ? [] : [{
      key, path: [...piece.path], title: piece.title, start: piece.start, end: piece.end,
      ...(piece.embedText === undefined ? {} : { embedText: piece.embedText }), ...(form === undefined ? {} : { form }),
    }];
  });
}

/** The language a resource's code is in: its format when known, else what its URI's extension says (`text` if nothing). */
function codeType(stat: ResourceStat): string {
  return stat.format ?? inferTypeFromLocation(stat.uri) ?? 'text';
}

/** The whole text as one piece. */
function whole(input: SectionInput): Piece[] {
  return [{ path: [], title: input.stat.name, start: 0, end: input.text.length }];
}

/** The lines of `text` between `start` and `end`, each with its offsets (the line break not included). */
function lines(text: string, start: number, end: number): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let at = start;
  while (at < end) {
    const brk = text.indexOf('\n', at);
    const stop = brk === -1 || brk >= end ? end : brk;
    found.push({ start: at, end: stop });
    at = stop + 1;
  }
  return found;
}

/** Whether a markdown line is a table's header separator (`| --- | --- |`). */
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/**
 * A table section of a table version's text, as row groups: one piece when it has at most `TABLE_SECTION_ROWS`
 * rows, else one per group, each group's embed text starting with the table's heading and header rows.
 */
function rowGroups(text: string, section: { path: readonly string[]; title: string; start: number; end: number }, name: string): Piece[] {
  const all = lines(text, section.start, section.end);
  const separator = all.findIndex((line) => SEPARATOR.test(text.slice(line.start, line.end)));
  const rows = separator === -1 ? [] : all.slice(separator + 1).filter((line) => line.end > line.start);
  if (separator === -1 || rows.length <= TABLE_SECTION_ROWS) { return [section]; }
  const header = text.slice(section.start, all[separator]?.end ?? section.start).trimEnd();
  const pieces: Piece[] = [];
  for (let from = 0; from < rows.length; from += TABLE_SECTION_ROWS) {
    const group = rows.slice(from, from + TABLE_SECTION_ROWS);
    const first = group[0];
    const last = group.at(-1);
    if (first === undefined || last === undefined) { continue; }
    const label = `rows ${from + 1}-${from + TABLE_SECTION_ROWS}`;
    pieces.push({
      path: [...section.path, label], title: `${section.title}, ${label}`, start: from === 0 ? section.start : first.start, end: last.end,
      embedText: `${[name, ...section.path].join(' > ')}\n\n${header}\n${text.slice(first.start, last.end)}`,
    });
  }
  return pieces;
}

/** The hub's sectioners, by name. */
export function hubSectioners(): Sectioner[] {
  const defs = hub.defs.sectioners;
  const name = (local: keyof typeof defs) => qualify(hub.name, local);
  return [
    { name: name('whole'), match: defs.whole.match, sections: (input) => keyed(whole(input), input.form) },
    {
      name: name('headings'),
      match: defs.headings.match,
      sections: (input) => keyed(splitMarkdownSections(input.text).map((section) => ({
        path: section.headings, title: section.headings.at(-1) ?? input.stat.name, start: section.start, end: section.end,
      })), input.form),
    },
    {
      name: name('symbols'),
      match: defs.symbols.match,
      sections: (input) => keyed(splitCodeBlocks(input.text, codeType(input.stat)).map((block) => ({
        path: block.path, title: block.declaration ?? input.stat.name, start: block.start, end: block.end,
      })), input.form),
    },
    {
      name: name('pages'),
      match: defs.pages.match,
      sections: (input) => {
        const pieces: Piece[] = [];
        let start = 0;
        input.text.split(PAGE_BREAK).forEach((page, i) => {
          pieces.push({ path: [`Page ${i + 1}`], title: `Page ${i + 1}`, start, end: start + page.length });
          start += page.length + 1;
        });
        return keyed(pieces, input.form);
      },
    },
    {
      name: name('paragraphs'),
      match: defs.paragraphs.match,
      sections: (input) => {
        const pieces: Piece[] = [];
        for (const match of input.text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g)) {
          const body = match[0];
          if (body.trim() === '') { continue; }
          const opening = body.trim().split(/\s+/).slice(0, 6).join(' ');
          pieces.push({ path: [opening], title: opening, start: match.index, end: match.index + body.trimEnd().length });
        }
        return keyed(pieces.length === 0 ? [{ path: [], title: '', start: 0, end: input.text.length }] : pieces, input.form);
      },
    },
    {
      name: name('tables'),
      match: defs.tables.match,
      sections: (input) => {
        const version = input.version;
        // offsets are into the version's text, so the text given must be it
        if (version?.kind !== 'table' || versionText(version) !== input.text) { return keyed(whole(input), input.form); }
        return keyed(sectionVersion(version).flatMap((section) => rowGroups(input.text, section, input.stat.name)), input.form);
      },
    },
  ];
}

/** A glob over a URI as a regular expression: `**` any path, `*` within a segment, `?` one character, `{a,b}` either. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') { out += '[^/]*'; }
    else if (char === '?') { out += '[^/]'; }
    else if (char === '{') { out += '(?:'; }
    else if (char === '}') { out += ')'; }
    else if (char === ',') { out += '|'; }
    else { out += char.replace(/[.+^$()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp(`(?:^|/)${out}$`);
}

/**
 * The format a form's text is in, for matching: a markdown form is markdown whatever the resource was (a web page,
 * a word document), so `hub/headings` cuts it. Other forms keep the resource's own format.
 */
function formatOf(stat: ResourceStat, form: FormKind | undefined): string | undefined {
  return form === 'markdown' ? 'markdown' : stat.format;
}

/**
 * How specific a match is (how many things it pins down), or undefined when it doesn't fit the resource read in
 * `form` (its raw text when absent).
 */
export function matchScore(match: SectionMatch, stat: ResourceStat, form?: FormKind): number | undefined {
  if (match.format !== undefined && match.format !== formatOf(stat, form) && match.format !== stat.format) { return undefined; }
  if (match.mime !== undefined && match.mime !== stat.mime) { return undefined; }
  if (match.glob !== undefined && !globToRegExp(match.glob).test(stat.uri)) { return undefined; }
  if (match.form !== undefined && match.form !== form) { return undefined; }
  return [match.format, match.mime, match.glob, match.form].filter((m) => m !== undefined).length;
}
