/**
 * Friendly names for things the hub names by qualified name (`fs/read_file`, `hub/chat`, `fs/Entry.reveal`): people
 * see "Read file", never a raw id. Pure and frontend-safe, so the hub's status text and the web app use the same words.
 */
import { splitName, type Json, type QualifiedName } from './primitives.ts';

/**
 * Words people read as initialisms, written in capitals wherever they turn up in a name: `user_id` → "User ID",
 * `avatarUrl` → "Avatar URL". A plural keeps its lower "s" (`ids` → "IDs").
 */
export const ACRONYMS: ReadonlySet<string> = new Set([
  'id', 'uuid', 'guid', 'url', 'uri', 'api', 'json', 'csv', 'tsv', 'xml', 'html', 'css', 'yaml', 'sql', 'pdf', 'svg', 'png', 'jpg',
  'ip', 'dns', 'http', 'https', 'ssh', 'tls', 'ssl', 'tcp', 'udp', 'vpn', 'os', 'cpu', 'gpu', 'ram', 'ui', 'ux', 'ai', 'llm',
  'sku', 'sms', 'otp', 'jwt', 'utc', 'iso', 'gmt', 'ssn', 'vat', 'faq', 'crm', 'rgb', 'db', 'mime', 'ttl', 'oauth', 'sso', 'mfa',
]);

/** One word of a label: an acronym (or its plural) in capitals, any other word lowered unless it is the first. */
function word(text: string, first: boolean): string {
  const lower = text.toLowerCase();
  if (ACRONYMS.has(lower)) { return lower.toUpperCase(); }
  if (lower.endsWith('s') && ACRONYMS.has(lower.slice(0, -1))) { return `${lower.slice(0, -1).toUpperCase()}s`; }
  return first ? text : lower;
}

/**
 * Words for an identifier, in sentence case: `read_file`, `readFile` and `read-file` → "Read file"; `due_date` →
 * "Due date"; `createdAt` → "Created at"; `user_id` / `userID` → "User ID"; `HTTPServer` → "HTTP server";
 * `SCREAMING_CASE` → "Screaming case"; a dotted or slashed path reads as its parts (`Entry.reveal` → "Entry reveal",
 * `address.city` → "Address city"). The first word keeps its own capitals ("Entry"); a lone all-caps word stays as it
 * is (it may be an acronym the list lacks). Only names go through this, never values: a widget shows `humanize(name)`
 * where a column, field or argument has no label of its own, with the raw name as the element's `title`.
 */
export function humanize(identifier: string): string {
  const screaming = /[\s._/:-]/.test(identifier) && !/[a-z]/.test(identifier);
  const words = (screaming ? identifier.toLowerCase() : identifier)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._/:-]+/)
    .filter((part) => part !== '')
    .map((part, i) => word(part, i === 0));
  return upperFirst(words.join(' ')) || identifier;
}

/** What a person reads for a named thing (a column, a field): its own label when it has one, as it is, else its name humanized. */
export function labelFor(thing: { readonly name: string; readonly label?: string | undefined }): string {
  return thing.label ?? humanize(thing.name);
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
