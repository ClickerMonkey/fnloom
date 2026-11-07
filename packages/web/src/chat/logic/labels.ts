/**
 * Friendly names for things the hub names by qualified name (`fs/read_file`, `hub/chat`, `fs/Entry.reveal`): people
 * see "Read file", never a raw id. Pure, so they are tested alone.
 */
import { splitName, type QualifiedName } from '@harness/core';

/** The part of a qualified name after its system: `fs/read_file` → `read_file`. */
export function localName(name: QualifiedName): string {
  return splitName(name).local;
}

/** The system a qualified name belongs to: `fs/read_file` → `fs`. */
export function systemOf(name: QualifiedName): string {
  return splitName(name).system;
}

/** Words for an identifier: `read_file`, `readFile` and `read-file` → "Read file"; `Entry.reveal` → "Entry reveal". */
export function humanize(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._/-]+/)
    .filter((word) => word !== '')
    .map((word, i) => (i === 0 ? word : word.toLowerCase()));
  const sentence = words.join(' ');
  return sentence === '' ? identifier : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** A fn's label for people: `fs/read_file` → "Read file". */
export function fnLabel(fn: QualifiedName): string {
  return humanize(localName(fn));
}

/** A label with its first letter lowered, for the middle of a sentence ("Waiting to read file"). */
export function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

/** An agent fn's name as a participant: `hub/chat` → "Chat agent"; `fs/coder_agent` → "Coder agent". */
export function agentName(agent: QualifiedName): string {
  const label = fnLabel(agent);
  return /\bagent$/i.test(label) ? label : `${label} agent`;
}
