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
