/**
 * How a result that holds only part of what there is says so, in what the model reads: one wording everywhere a
 * reply is cut (a read's window of characters, a file's window of lines, a table's first rows, a search snippet, a
 * file's text inline in a message). Each says what is shown, how much was left out, and how to get the rest, so the
 * model never takes the part for the whole or fills in what it did not see.
 */

/** What a cut result held: which `unit`s from `offset` (counted from 0), how many of them, out of how many. */
export interface PartialCut {
  /** What is counted, plural: `characters`, `lines`, `rows`. */
  readonly unit: string;
  /** Where the part starts in the whole, counted from 0. */
  readonly offset: number;
  /** How many of the unit the part holds. */
  readonly shown: number;
  /** How many there are in all; absent when not counted (more exist, how many is unknown). */
  readonly total?: number;
  /** How to get the rest, as an instruction: "read on with hub/resource_read and `offset: 4000`". */
  readonly rest: string;
}

/** A count for people: `12,345`. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The line a cut result carries: "Partial: characters 1–4,000 of 12,345 are here; 8,345 characters were left out. To get
 * the rest, read on with … Don't state what the left-out part says." Undefined when nothing was left out.
 */
export function partialNote(cut: PartialCut): string | undefined {
  const end = cut.offset + cut.shown;
  const before = cut.offset;
  const after = cut.total === undefined ? undefined : Math.max(0, cut.total - end);
  if (before === 0 && after === 0) return undefined;
  const one = cut.unit.replace(/s$/, '');
  const range = cut.shown === 0 ? `no ${cut.unit}` : cut.shown === 1 ? `${one} ${count(end)}` : `${cut.unit} ${count(cut.offset + 1)}–${count(end)}`;
  const of = cut.total === undefined ? '' : ` of ${count(cut.total)}`;
  const are = cut.shown === 1 ? 'is' : 'are';
  let left = 'more follow (how many is not known)';
  if (after !== undefined) {
    const out = before + after;
    const where = before > 0 && after > 0 ? ` (${count(before)} before this part, ${count(after)} after it)` : before > 0 ? ' (all before this part)' : '';
    left = `${count(out)} ${out === 1 ? one : cut.unit} ${out === 1 ? 'was' : 'were'} left out${where}`;
  }
  return `Partial: ${range}${of} ${are} here; ${left}. To get the rest, ${cut.rest}. Don't state what the left-out part says.`;
}

/**
 * A text cut to at most `max` characters, with a marker in the text saying how much was cut and, when given, how to
 * get the rest: "…[8,345 more characters cut: read on with …]". `atWord` cuts at a space near the end instead of mid-word.
 * The text as it is when it fits.
 */
export function clipMarked(text: string, max: number, options: { readonly rest?: string; readonly atWord?: boolean } = {}): string {
  if (text.length <= max) return text;
  let head = text.slice(0, Math.max(0, max));
  if (options.atWord === true) {
    const space = head.lastIndexOf(' ');
    if (space > max * 0.6) head = head.slice(0, space);
    head = head.replace(/[\s,;:.-]+$/, '');
  }
  return `${head}${cutMarker(text.length - head.length, options.rest)}`;
}

/** The marker a cut text ends with: "…[8,345 more characters cut: read on with …]" (`unit`: what is counted, plural). */
export function cutMarker(left: number, rest?: string, unit = 'characters'): string {
  const what = left === 1 ? unit.replace(/s$/, '') : unit;
  return `…[${count(left)} more ${what} cut${rest === undefined ? '' : `: ${rest}`}]`;
}
