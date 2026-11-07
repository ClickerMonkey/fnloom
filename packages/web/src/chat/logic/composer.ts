/**
 * The composer's rules, apart from any component: which picker the text at the caret opens (`@` mentions, `/`
 * commands, `!` fns), the hint for the command argument being typed, the parts a draft sends (text, mention chips,
 * a command), the placeholder that names only the powers the hub offers, and editing text at the caret. Pure, so it
 * is tested alone.
 */
import type { ChatCapabilities, OutgoingPart } from '@harness/core';

/** A mention picked into the draft. Its chip is `@label` in the text; deleting that text drops it. */
export type DraftMention = Extract<OutgoingPart, { type: 'mention' }>;

/** A `/` command the session offers. */
export type Command = ChatCapabilities['commands'][number];

/** A fn the person may run with `!`. */
export type Invocation = ChatCapabilities['invocations'][number];

/** What the text at the caret asks for: a picker, and the span of text a pick replaces. */
export interface Trigger {
  readonly kind: 'mention' | 'command' | 'invoke';
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/** The picker the caret is in, if any: `@word` anywhere at a word start; `/word` and `!word` at the very start. */
export function detectTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const lead = /^([/!])(\S*)$/.exec(before);
  if (lead !== null) {
    return { kind: lead[1] === '/' ? 'command' : 'invoke', query: lead[2] ?? '', start: 0, end: caret };
  }
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (mention === null) { return undefined; }
  const query = mention[1] ?? '';
  return { kind: 'mention', query, start: caret - query.length - 1, end: caret };
}

/** The `@label` token a mention shows as in the text. */
export function mentionToken(mention: Pick<DraftMention, 'label'>): string {
  return `@${mention.label}`;
}

/** Keep only the mentions whose chip is still in the text. */
export function pruneMentions(text: string, mentions: readonly DraftMention[]): DraftMention[] {
  return mentions.filter((mention) => text.includes(mentionToken(mention)));
}

/** Replace `start..end` of `text` with `insert`; returns the text and the caret after the insert. */
export function insertText(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  return { text: `${text.slice(0, start)}${insert}${text.slice(end)}`, caret: start + insert.length };
}

/** The command a draft starts with, if it names one: `/tree src` → the `tree` command. */
export function leadingCommand(text: string, commands: readonly Command[]): Command | undefined {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name === undefined ? undefined : commands.find((command) => command.name === name);
}

/** The hint row while typing a command's arguments: the command, its args, and which one the caret is on. */
export interface CommandHint {
  readonly command: Command;
  /** The argument being typed (clamped to the last). */
  readonly current: number;
}

/** The hint for the command being typed, once its name is complete and followed by a space. */
export function commandHint(text: string, commands: readonly Command[]): CommandHint | undefined {
  const line = text.split('\n', 1)[0] ?? '';
  const match = /^\/(\S+)\s(.*)$/.exec(line);
  if (match === null) { return undefined; }
  const command = commands.find((c) => c.name === match[1]);
  if (command === undefined || command.args.length === 0) { return undefined; }
  const rest = match[2] ?? '';
  const words = rest.split(/\s+/).filter((w) => w !== '');
  const typing = rest === '' || /\s$/.test(rest) ? words.length : words.length - 1;
  return { command, current: Math.min(typing, command.args.length - 1) };
}

/** A command's args from the words after its name: positional, the last one taking the rest. */
export function commandArgs(command: Command, rest: string): Record<string, string> {
  const words = rest.trim().split(/\s+/).filter((w) => w !== '');
  const args: Record<string, string> = {};
  command.args.forEach((arg, i) => {
    const last = i === command.args.length - 1;
    const value = last ? words.slice(i).join(' ') : words[i];
    if (value !== undefined && value !== '') { args[arg.name] = value; }
  });
  return args;
}

/** The required arguments a command is missing. */
export function missingArgs(command: Command, args: Readonly<Record<string, string>>): string[] {
  return command.args.filter((arg) => arg.required && (args[arg.name] ?? '') === '').map((arg) => arg.name);
}

/** Split text into text and mention parts at each chip, longest labels first so one chip can't hide inside another. */
export function textParts(text: string, mentions: readonly DraftMention[]): OutgoingPart[] {
  const live = pruneMentions(text, mentions).sort((a, b) => b.label.length - a.label.length);
  const parts: OutgoingPart[] = [];
  let rest = text;
  while (rest !== '') {
    let best: { at: number; mention: DraftMention } | undefined;
    for (const mention of live) {
      const at = rest.indexOf(mentionToken(mention));
      if (at !== -1 && (best === undefined || at < best.at)) { best = { at, mention }; }
    }
    if (best === undefined) { parts.push({ type: 'text', text: rest }); break; }
    if (best.at > 0) { parts.push({ type: 'text', text: rest.slice(0, best.at) }); }
    parts.push(best.mention);
    rest = rest.slice(best.at + mentionToken(best.mention).length);
  }
  return parts.filter((part) => part.type !== 'text' || part.text.trim() !== '');
}

/** The parts a draft sends: a leading command (its args from the first line), then the text with its chips. */
export function draftParts(text: string, mentions: readonly DraftMention[], commands: readonly Command[]): OutgoingPart[] {
  const trimmed = text.trim();
  const command = leadingCommand(trimmed, commands);
  if (command === undefined) { return textParts(trimmed, mentions); }
  const [first = '', ...lines] = trimmed.split('\n');
  const rest = first.slice(command.name.length + 1);
  const body = lines.join('\n').trim();
  return [{ type: 'command', context: command.context, args: commandArgs(command, rest) }, ...textParts(body, mentions)];
}

/** The composer's placeholder: names only the powers the hub offers now. */
export function placeholderFor(caps: Pick<ChatCapabilities, 'mentions' | 'commands' | 'invocations'> | undefined, compact: boolean): string {
  const powers = [
    caps !== undefined && caps.mentions.length > 0 ? '@ to mention' : '',
    caps !== undefined && caps.commands.length > 0 ? '/ for commands' : '',
    caps !== undefined && caps.invocations.length > 0 ? '! to run a fn' : '',
  ].filter((power) => power !== '');
  if (compact || powers.length === 0) { return 'Message'; }
  return `Message · ${powers.join(', ')}`;
}

/** Whether Enter sends: on a hardware keyboard Enter sends and Shift+Enter breaks the line; on touch, Enter breaks. */
export function enterSends(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'isComposing'>, touch: boolean): boolean {
  if (event.key !== 'Enter' || event.isComposing) { return false; }
  if (event.ctrlKey || event.metaKey) { return true; }
  return !touch && !event.shiftKey;
}
