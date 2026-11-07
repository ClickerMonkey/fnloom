/**
 * The hub's own sectioners (`hub/whole`, `hub/headings`, `hub/symbols`, `hub/pages`, `hub/paragraphs`, declared in
 * the hub's contract), and how sectioners are matched to resources. Every section key comes from structure (a
 * heading path, a symbol name, a page number, a paragraph's opening words) through the SDK's `sectionKeys`, so a
 * key survives content moving around it.
 */
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

/** Lines of a text with their offsets. */
function lines(text: string): Array<{ line: string; start: number }> {
  const out: Array<{ line: string; start: number }> = [];
  let start = 0;
  for (const raw of text.split(/(?<=\n)/)) {
    out.push({ line: raw.replace(/\r?\n$/, ''), start });
    start += raw.length;
  }
  return out;
}

/**
 * Cut wherever `startsAt` says a line begins a piece. Text before the first is its own piece (titled `preamble`);
 * lines inside fenced code blocks never begin one.
 */
function cutAt(text: string, startsAt: (line: string) => { path: string[]; title: string } | undefined, preamble: string): Piece[] {
  const pieces: Piece[] = [];
  let current: Piece = { path: [], title: preamble, start: 0, end: text.length };
  let fence: string | undefined;
  for (const { line, start } of lines(text)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (marker !== undefined) {
      fence = fence === undefined ? marker : marker === fence ? undefined : fence;
      continue;
    }
    const begins = fence === undefined ? startsAt(line) : undefined;
    if (begins === undefined) { continue; }
    if (start > current.start || current.path.length > 0) { pieces.push({ ...current, end: start }); }
    current = { path: begins.path, title: begins.title, start, end: text.length };
  }
  pieces.push(current);
  return pieces;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SYMBOL = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?(function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|module|namespace)\s+([A-Za-z_$][\w$]*)/;

/** The hub's sectioners, by name. */
export function hubSectioners(): Sectioner[] {
  const defs = hub.defs.sectioners;
  const name = (local: keyof typeof defs) => qualify(hub.name, local);
  return [
    { name: name('whole'), match: defs.whole.match, sections: (text, stat) => keyed([{ path: [], title: stat.name, start: 0, end: text.length }]) },
    {
      name: name('headings'),
      match: defs.headings.match,
      sections: (text, stat) => {
        const stack: Array<string | undefined> = [];
        return keyed(cutAt(text, (line) => {
          const heading = HEADING.exec(line);
          if (heading?.[1] === undefined || heading[2] === undefined) { return undefined; }
          stack.length = heading[1].length - 1;
          stack[heading[1].length - 1] = heading[2];
          const path = stack.filter((h): h is string => h !== undefined);
          return { path, title: heading[2] };
        }, stat.name));
      },
    },
    {
      name: name('symbols'),
      match: defs.symbols.match,
      sections: (text, stat) => keyed(cutAt(text, (line) => {
        const symbol = SYMBOL.exec(line);
        return symbol?.[2] === undefined ? undefined : { path: [symbol[2]], title: `${symbol[1] ?? ''} ${symbol[2]}`.trim() };
      }, stat.name)),
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
