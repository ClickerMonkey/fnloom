/**
 * Friendly names for things the hub names by qualified name (`fs/read_file`, `hub/chat`, `fs/Entry.reveal`): people
 * see "Read file", never a raw id. Pure and frontend-safe, so the hub's status text and the web app use the same words.
 */
import { splitName, type QualifiedName } from './primitives.ts';

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
