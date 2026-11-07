/**
 * Friendly names for things the hub names by qualified name (`fs/read_file`, `hub/chat`, `fs/Entry.reveal`): people
 * see "Read file", never a raw id. The words themselves (`humanize`, `fnLabel`, `lowerFirst`) are core's, so the
 * hub's status text and the chat say the same. Pure, so they are tested alone.
 */
import { fnLabel, splitName, type QualifiedName } from '@harness/core';

export { fnLabel, humanize, lowerFirst } from '@harness/core';

/** The part of a qualified name after its system: `fs/read_file` → `read_file`. */
export function localName(name: QualifiedName): string {
  return splitName(name).local;
}

/** The system a qualified name belongs to: `fs/read_file` → `fs`. */
export function systemOf(name: QualifiedName): string {
  return splitName(name).system;
}

/** An agent fn's name as a participant: `hub/chat` → "Chat agent"; `fs/coder_agent` → "Coder agent". */
export function agentName(agent: QualifiedName): string {
  const label = fnLabel(agent);
  return /\bagent$/i.test(label) ? label : `${label} agent`;
}

/**
 * The yes button of a yes-or-no question, from the question's own verb: "Run a command …?" → "Run", "Overwrite
 * a.md?" → "Overwrite". A question that doesn't start with a word gets "Yes".
 */
export function confirmVerb(question: string): string {
  const word = /^\s*([A-Za-z]+)\b[^?]*\?\s*$/.exec(question)?.[1];
  return word === undefined ? 'Yes' : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
