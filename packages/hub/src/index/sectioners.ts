/**
 * The hub's own sectioners (`hub/whole`, `hub/headings`, `hub/symbols`, `hub/pages`, `hub/paragraphs`, declared in
 * the hub's contract), and how sectioners are matched to resources. Headings and symbols are found by
 * `@aeye/resources` (`splitMarkdownSections`, `splitCodeBlocks`: fenced code skipped, the text before the first
 * heading or declaration kept as its own section, doc comments kept with their declaration). Every section key comes
 * from structure (a heading path, a symbol name, a page number, a paragraph's opening words) through the SDK's
 * `sectionKeys`, so a key survives content moving around it.
 */
import { inferTypeFromLocation, splitCodeBlocks, splitMarkdownSections } from '@aeye/resources';
import { qualify, type QualifiedName, type ResourceStat, type Section, type SectionMatch } from '@harness/core';
import { hub, sectionKeys } from '@harness/sdk';

/** Cuts a resource's text into sections. */
export interface Sectioner {
  readonly name: QualifiedName;
  readonly match: SectionMatch;
  sections(text: string, stat: ResourceStat): Section[];
}

/** A piece of text with its place in the outline, before keys are made. */
interface Piece {
  readonly path: readonly string[];
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

/** Key pieces from their paths, in order. */
function keyed(pieces: readonly Piece[]): Section[] {
  const keys = sectionKeys(pieces.map((p) => p.path));
  return pieces.flatMap((piece, i) => {
    const key = keys[i];
    return key === undefined ? [] : [{ key, path: [...piece.path], title: piece.title, start: piece.start, end: piece.end }];
  });
}

/** The language a resource's code is in: its format when known, else what its URI's extension says (`text` if nothing). */
function codeType(stat: ResourceStat): string {
  return stat.format ?? inferTypeFromLocation(stat.uri) ?? 'text';
}

/** The hub's sectioners, by name. */
export function hubSectioners(): Sectioner[] {
  const defs = hub.defs.sectioners;
  const name = (local: keyof typeof defs) => qualify(hub.name, local);
  return [
    { name: name('whole'), match: defs.whole.match, sections: (text, stat) => keyed([{ path: [], title: stat.name, start: 0, end: text.length }]) },
    {
      name: name('headings'),
      match: defs.headings.match,
      sections: (text, stat) => keyed(splitMarkdownSections(text).map((section) => ({
        path: section.headings, title: section.headings.at(-1) ?? stat.name, start: section.start, end: section.end,
      }))),
    },
    {
      name: name('symbols'),
      match: defs.symbols.match,
      sections: (text, stat) => keyed(splitCodeBlocks(text, codeType(stat)).map((block) => ({
        path: block.path, title: block.declaration ?? stat.name, start: block.start, end: block.end,
      }))),
    },
    {
      name: name('pages'),
      match: defs.pages.match,
      sections: (text) => {
        const pieces: Piece[] = [];
        let start = 0;
        text.split('\f').forEach((page, i) => {
          pieces.push({ path: [`Page ${i + 1}`], title: `Page ${i + 1}`, start, end: start + page.length });
          start += page.length + 1;
        });
        return keyed(pieces);
      },
    },
    {
      name: name('paragraphs'),
      match: defs.paragraphs.match,
      sections: (text) => {
        const pieces: Piece[] = [];
        for (const match of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g)) {
          const body = match[0];
          if (body.trim() === '') { continue; }
          const opening = body.trim().split(/\s+/).slice(0, 6).join(' ');
          pieces.push({ path: [opening], title: opening, start: match.index, end: match.index + body.trimEnd().length });
        }
        return keyed(pieces.length === 0 ? [{ path: [], title: '', start: 0, end: text.length }] : pieces);
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

/** How specific a match is (how many things it pins down), or undefined when it doesn't fit the resource. */
export function matchScore(match: SectionMatch, stat: ResourceStat): number | undefined {
  if (match.format !== undefined && match.format !== stat.format) { return undefined; }
  if (match.mime !== undefined && match.mime !== stat.mime) { return undefined; }
  if (match.glob !== undefined && !globToRegExp(match.glob).test(stat.uri)) { return undefined; }
  return [match.format, match.mime, match.glob].filter((m) => m !== undefined).length;
}
