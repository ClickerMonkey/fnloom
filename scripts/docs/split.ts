/**
 * Cutting a part of the authoring guide that is too large for one context item into smaller ones, so a model with a
 * small window loads only the piece it needs. A part is cut at its `###` sections (or its `####` ones when it has no
 * `###`); a section still too large is cut at the next heading level, then at its top-level list items. Headings
 * inside code fences don't count. Small neighbouring sections are packed into one piece up to the budget, unless the
 * part asks for one piece per section: at the top level (the core types: one per source module) or at every level
 * (the worked examples: one per file).
 */

/** The most characters one context item of the guide holds (about 25 KB). */
export const PART_BUDGET = 25_000;

/** What an item adds around a piece's text (its header, the line naming its fns, links made longer across items), kept free of the budget. */
const ITEM_OVERHEAD = 5_000;

/** One piece of a cut part: its title, the names of the sections in it, and its text. */
export interface Piece {
  readonly title: string;
  readonly names: readonly string[];
  readonly text: string;
}

/** A cut part: the text before its first section (kept in the part itself), and its pieces in order. */
export interface CutPart {
  readonly head: string;
  readonly pieces: readonly Piece[];
}

/** Where every section is its own piece instead of being packed with its neighbours. */
export type EachSection = 'top' | 'all';

/** How to cut: the budget, and where every section is its own piece (absent: packed everywhere). */
export interface CutOptions {
  readonly budget?: number;
  readonly each?: EachSection;
}

/** A section of text: its heading's title (empty for text before any heading) and its text. */
interface Section {
  readonly title: string;
  readonly text: string;
}

const FENCE = /^(`{3,}|~{3,})/;

const encoder = new TextEncoder();

/** A text's size as stored: its UTF-8 bytes. */
export function sizeOf(text: string): number {
  return encoder.encode(text).length;
}

/** The line indexes that start a heading of this level, outside code fences. */
function headingLines(lines: readonly string[], level: number): number[] {
  const marker = `${'#'.repeat(level)} `;
  const found: number[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const opened = FENCE.exec(line)?.[1];
    if (opened !== undefined) {
      if (fence === undefined) { fence = opened; } else if (opened[0] === fence[0] && opened.length >= fence.length) { fence = undefined; }
      return;
    }
    if (fence === undefined && line.startsWith(marker)) { found.push(index); }
  });
  return found;
}

/** The line indexes that start a top-level list item, outside code fences. */
function itemLines(lines: readonly string[]): number[] {
  const found: number[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const opened = FENCE.exec(line.trimStart())?.[1];
    if (opened !== undefined) {
      if (fence === undefined) { fence = opened; } else if (opened[0] === fence[0] && opened.length >= fence.length) { fence = undefined; }
      return;
    }
    if (fence === undefined && line.startsWith('- ')) { found.push(index); }
  });
  return found;
}

/** A heading line's title: no `#`s, anchors or backticks. */
export function headingTitle(line: string): string {
  return line.replace(/^#+\s*/, '').replace(/<a id="[^"]*"><\/a>/g, '').replaceAll('`', '').trim();
}

/** Text cut at the given line starts: what comes before the first, then one section per start. */
function cutAt(lines: readonly string[], starts: readonly number[], titleOf: (line: string) => string): { head: string; sections: Section[] } {
  const head = lines.slice(0, starts[0] ?? lines.length).join('\n');
  const sections = starts.map((start, index) => ({ title: titleOf(lines[start] ?? ''), text: lines.slice(start, starts[index + 1] ?? lines.length).join('\n') }));
  return { head, sections };
}

/** Sections packed into pieces of at most `budget` characters each, in order (a larger section is a piece alone). */
function pack(sections: readonly Section[], budget: number): Piece[] {
  const pieces: Piece[] = [];
  let names: string[] = [];
  let texts: string[] = [];
  const flush = () => {
    if (texts.length === 0) { return; }
    pieces.push({ title: names.length === 1 ? names[0] ?? '' : `${names[0] ?? ''} … ${names.at(-1) ?? ''}`, names, text: texts.join('\n') });
    names = [];
    texts = [];
  };
  for (const section of sections) {
    if (texts.length > 0 && sizeOf(texts.join('\n')) + sizeOf(section.text) + 1 > budget) { flush(); }
    names.push(section.title);
    texts.push(section.text);
  }
  flush();
  return pieces;
}

/** One section as pieces of at most `budget` characters: cut at the next heading level, else at its list items. */
function sectionPieces(section: Section, level: number, budget: number, each: boolean): Piece[] {
  if (sizeOf(section.text) <= budget) { return [{ title: section.title, names: [section.title], text: section.text }]; }
  const lines = section.text.split('\n');
  const heading = lines[0] ?? '';
  const body = lines.slice(1);
  for (let deeper = level + 1; deeper <= 4; deeper += 1) {
    const starts = headingLines(body, deeper);
    if (starts.length > 1) { return continued(heading, cutAt(body, starts, headingTitle), budget - sizeOf(heading) - 2, each); }
  }
  const items = itemLines(body);
  if (items.length > 1) { return continued(heading, cutAt(body, items, (line) => itemTitle(line)), budget - sizeOf(heading) - 2, each); }
  // nothing to cut at: one piece over the budget
  return [{ title: section.title, names: [section.title], text: section.text }];
}

/** Pieces of one section's body, each under the section's heading; the first keeps the text before its first cut. */
function continued(heading: string, cut: { head: string; sections: Section[] }, budget: number, each: boolean): Piece[] {
  const [first, ...rest] = cut.sections;
  const sections = first === undefined ? [] : [{ title: first.title, text: `${cut.head}\n${first.text}`.replace(/^\n+/, '') }, ...rest];
  const grouped = each ? sections.map((section) => ({ title: section.title, names: [section.title], text: section.text })) : pack(sections, budget);
  return grouped.map((piece) => ({
    title: piece.title,
    names: piece.names,
    text: `${heading}\n\n${piece.text.replace(/^\n+/, '')}`,
  }));
}

/** A list item's title: its first code span, else its first words. */
function itemTitle(line: string): string {
  const code = /`([^`]+)`/.exec(line)?.[1];
  return code ?? line.replace(/^- /, '').split(/[.:]/)[0]?.trim() ?? line;
}

/**
 * A part's text cut into pieces when it is over the budget, or `undefined` when it fits (or has no section to cut at).
 * The head (the part's own heading and intro) stays with the part, which lists the pieces.
 */
export function cutPart(text: string, options: CutOptions = {}): CutPart | undefined {
  const whole = options.budget ?? PART_BUDGET;
  if (sizeOf(text) <= whole) { return undefined; }
  // room for the item's header and the line naming its fns
  const budget = whole - Math.min(ITEM_OVERHEAD, Math.floor(whole / 5));
  const lines = text.split('\n');
  for (const level of [3, 4]) {
    const starts = headingLines(lines, level);
    if (starts.length === 0) { continue; }
    const { head, sections } = cutAt(lines, starts, headingTitle);
    const top: Piece[] = options.each === undefined
      ? pack(sections, budget)
      : sections.map((section) => ({ title: section.title, names: [section.title], text: section.text }));
    // a piece over the budget is one section too large to share: cut it further
    const pieces = top.flatMap((piece) => (sizeOf(piece.text) <= budget || piece.names.length > 1 ? [piece] : sectionPieces({ title: piece.title, text: piece.text }, level, budget, options.each === 'all')));
    return { head, pieces };
  }
  return undefined;
}

/** A slug for a piece's key: lowercase letters, digits and dashes, at most 48 characters, never starting with a digit. */
export function pieceSlug(title: string): string {
  const slug = title.toLowerCase().replace(/^from /, '').replace(/^packages\/[a-z-]+\/src\//, '').replace(/^scripts\/docs\/example\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return slug === '' ? 'part' : /^[0-9]/.test(slug) ? `p${slug}` : slug;
}
