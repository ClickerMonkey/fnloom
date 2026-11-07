/**
 * Friendly names for things the hub names by qualified name (`fs/read_file`, `hub/chat`, `fs/Entry.reveal`): people
 * see "Read file", never a raw id. Pure and frontend-safe, so the hub's status text and the web app use the same words.
 */
import { splitName, type Json, type QualifiedName } from './primitives.ts';

/** Words for an identifier: `read_file`, `readFile` and `read-file` → "Read file"; `Entry.reveal` → "Entry reveal". */
export function humanize(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._/-]+/)
    .filter((word) => word !== '')
    .map((word, i) => (i === 0 ? word : word.toLowerCase()));
  return upperFirst(words.join(' ')) || identifier;
}

/** A fn's label for people: `fs/read_file` → "Read file". */
export function fnLabel(fn: QualifiedName): string {
  return humanize(splitName(fn).local);
}

/** A label with its first letter lowered, for the middle of a sentence ("Waiting to read file"). Acronyms stay. */
export function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

/** A sentence with its first letter raised. */
export function upperFirst(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Shorten text to `max` characters on a word boundary where one is near, ending with "…". Whitespace runs become one space. */
export function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) { return flat; }
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** The keys whose value best says what a run is about, most telling first. */
const TELLING_KEYS = ['path', 'file', 'uri', 'query', 'command', 'url', 'name', 'title', 'text', 'pattern', 'message'] as const;

/**
 * A one-line summary of a fn's args: the most telling value ("harness.md", "sleep 20; echo never"), clamped. Empty
 * when there are none. The chat's run cards and the hub's notifications say what a run is about the same way.
 */
export function argSummary(args: Json | undefined, max = 60): string {
  if (args === undefined || args === null) { return ''; }
  if (typeof args === 'string') { return clamp(args, max); }
  if (typeof args === 'number' || typeof args === 'boolean') { return String(args); }
  if (Array.isArray(args)) { return args.length === 0 ? '' : `${args.length} item${args.length === 1 ? '' : 's'}`; }
  const telling = TELLING_KEYS.map((key) => args[key]).find((value) => typeof value === 'string' && value !== '');
  if (typeof telling === 'string') { return clamp(telling, max); }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return clamp(`${key}: ${String(value)}`, max); }
  }
  return '';
}
