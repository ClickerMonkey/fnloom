/**
 * The session transcript as exchanges, and the history a prompt rebuilds from them. An exchange is a person's message
 * and everything until the next one (answers, tool calls and their replies, tool results sent back as text), so a
 * tool call always travels with its reply. The newest exchanges selected in a row are sent as real messages; older
 * selected ones become short summaries made without a model call (the question, the first and last sentence of the
 * answer, and what it used).
 */
import { fnOfModelNameByRule, QualifiedName, type LlmMessage } from '@harness/core';
import type { ExchangeSummary } from './index.ts';
import { parseRunBlocks, RESULT_TAG, SHOWN_TAG } from './render.ts';

/** Tags of user messages the hub writes (tool results in text, background results, resources shown), which don't start an exchange. */
const HUB_WRITTEN = [`<${RESULT_TAG} `, '<background-result ', `<${SHOWN_TAG} `] as const;

/** One exchange of a conversation. */
export interface Exchange {
  /** Its place in the transcript's exchanges (0 is the first). */
  readonly turn: number;
  readonly messages: readonly LlmMessage[];
  /** The person's words. */
  readonly user: string;
  /** The last answer text in it. */
  readonly answer: string;
  /** The fns it ran (tool names for native tools, fn names for `run`), in order, once each. */
  readonly used: readonly string[];
  /**
   * Items it brought up without running them: names loaded by a load call or a hook, `/command` context, fns the
   * person named, and fns whose cards a tool reply showed.
   */
  readonly mentioned: readonly string[];
}

/** Qualified names in a text (`fs/read`, `hub/fns_load`). */
const QUALIFIED = /\b[a-z][a-z0-9_-]*\/[A-Za-z_][\w.-]*\b/g;
/** A `/command` part as the enricher renders it. */
const COMMAND = /<command context="([^"]+)"/g;
/** A hook's load block as the enricher renders it. */
const LOADED = /^Loaded: (.+)$/gm;
/** A fn card's heading in a tool reply (its model name, or a qualified name in transcripts from before the one name). */
const CARD = /^### ([a-z][a-z0-9_-]*(?:\/|__)[A-Za-z0-9_][\w.-]*)(?: —|$)/gm;
/** Model names in a text (`fs__read`): what the model reads and writes in place of a fn's qualified name. */
const MODEL_NAMES = /\b[a-z][a-z0-9-]*__[A-Za-z0-9][A-Za-z0-9_-]*\b/g;
/** Tool names of calls that load items. */
const LOAD_TOOLS = /(^|__)(load|fns_load|ctx_load)$/;

/** A block the hub adds after a person's words (local time, suggestions, hook blocks): `<tag>` and `</tag>` on lines of their own. */
const HUB_BLOCK = /(?:^|\n)<([A-Za-z_][\w-]*)>\n[\s\S]*?\n<\/\1>(?=\n|$)/g;

/** A person's message without the blocks the hub added to it: their own words, mentions and commands. */
export function personWords(text: string): string {
  return text.replace(HUB_BLOCK, '').trim();
}

/** The qualified names a person's message names. */
export function namedIn(text: string): string[] {
  return [...new Set(text.match(QUALIFIED) ?? [])];
}

/** What an exchange brought up without running it (see `Exchange.mentioned`). */
function mentionsOf(messages: readonly LlmMessage[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    const text = textOf(message);
    if (isPersonMessage(message)) {
      found.push(...namedIn(text.replace(/<[^>]*>/g, ' ')), ...[...text.matchAll(COMMAND)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])));
      for (const match of text.matchAll(LOADED)) found.push(...(match[1] ?? '').split(',').map((name) => name.trim()));
    }
    if (message.role === 'tool' || (message.role === 'user' && !isPersonMessage(message))) found.push(...[...text.matchAll(CARD)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])));
    for (const call of message.toolCalls ?? []) if (LOAD_TOOLS.test(call.name)) found.push(...namedIn(call.arguments), ...(call.arguments.match(MODEL_NAMES) ?? []));
  }
  return [...new Set(found.filter((name) => name !== ''))];
}

/** A message's text: its string, or its text parts joined. */
export function textOf(message: LlmMessage): string {
  return typeof message.content === 'string' ? message.content : message.content.filter((p) => p.type === 'text').map((p) => p.content).join('\n');
}

/** Whether a message is a person's (a user message the hub did not write). */
export function isPersonMessage(message: LlmMessage): boolean {
  if (message.role !== 'user') return false;
  const text = textOf(message).trimStart();
  return !HUB_WRITTEN.some((tag) => text.startsWith(tag));
}

/** The fns an assistant message calls: native tools (`run` read for its fn), and `<run>` blocks in its text. */
export function callsOf(message: LlmMessage): string[] {
  if (message.role !== 'assistant') return [];
  const native = (message.toolCalls ?? []).map((call) => {
    if (call.name !== 'run') return call.name;
    const fn = runTarget(call.arguments);
    return fn ?? call.name;
  });
  return [...native, ...parseRunBlocks(textOf(message)).calls.flatMap((call) => (call.fn === undefined ? [] : [call.fn]))];
}

/** The `fn` a `run` tool call names, if its arguments say. */
function runTarget(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && 'fn' in parsed && typeof parsed.fn === 'string' ? parsed.fn : undefined;
  } catch {
    return undefined;
  }
}

/** Cut a transcript into exchanges. Messages before the first person message join the first exchange. */
export function exchanges(transcript: readonly LlmMessage[]): Exchange[] {
  const groups: LlmMessage[][] = [];
  for (const message of transcript) {
    const last = groups.at(-1);
    if (last === undefined || isPersonMessage(message)) groups.push([message]);
    else last.push(message);
  }
  return groups.map((messages, turn) => {
    const person = messages.find(isPersonMessage);
    const answer = messages.filter((m) => m.role === 'assistant').map(textOf).filter((t) => t.trim() !== '').at(-1) ?? '';
    return {
      turn, messages, user: person === undefined ? '' : personWords(textOf(person)), answer: parseRunBlocks(answer).prose, used: [...new Set(messages.flatMap(callsOf))], mentioned: mentionsOf(messages),
    };
  });
}

/** The first and last sentence of a text (the whole text when it has one or two). */
export function firstAndLast(text: string): string {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()) ?? [];
  if (sentences.length <= 2) return sentences.join(' ');
  return `${sentences[0] ?? ''} … ${sentences.at(-1) ?? ''}`;
}

/** A text cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** A text cut to its head and tail with a note of what was left out, when it is longer than `max` characters. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 80);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}\n[… ${text.length - keep} characters trimmed: run it again with a range to see them]\n${tail === 0 ? '' : text.slice(-tail)}`;
}

/** Messages with every tool result (tool replies and text results) shortened to `max` characters. */
export function shortenResults(messages: readonly LlmMessage[], max: number): LlmMessage[] {
  return messages.map((message) => {
    const isResult = message.role === 'tool' || (message.role === 'user' && !isPersonMessage(message));
    return isResult && typeof message.content === 'string' ? { ...message, content: shorten(message.content, max) } : message;
  });
}

/**
 * An exchange's summary (made without a model call): its question and the first and last sentence of its answer,
 * clipped so the rendered block's text fits `maxChars`, and the fns it used (by qualified name).
 */
export function summarise(exchange: Exchange, maxChars: number): ExchangeSummary {
  // a call's name is the model's (`fs__read`, read back by rule) or, in older transcripts, a qualified name
  const used = exchange.used.flatMap((name) => { const parsed = QualifiedName.safeParse(name); const fn = parsed.success ? parsed.data : fnOfModelNameByRule(name); return fn === undefined ? [] : [fn]; });
  const usedChars = used.length === 0 ? 0 : `\nUsed: ${used.join(', ')}`.length;
  const room = Math.max(40, maxChars - usedChars - 'User: \nAnswer: '.length);
  const user = clip(exchange.user.replace(/\s+/g, ' ').trim(), Math.ceil(room * 0.45));
  return { turn: exchange.turn, user, answer: clip(firstAndLast(exchange.answer), room - user.length), used };
}

/** How many of the newest flags are true in a row (the contiguous recent tail). */
export function contiguousTail(selected: readonly boolean[]): number {
  let count = 0;
  for (let i = selected.length - 1; i >= 0 && selected[i] === true; i--) count += 1;
  return count;
}
