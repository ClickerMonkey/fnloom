/**
 * Citations in an answer (`records/citations.ts`): the model writes `<cite tool="run_…" path="rows.3">why</cite>`.
 *
 * - `CiteFilter` reads an answer as it streams: text passes through, but from an opening `<cite` it holds the text back
 *   until the tag closes, so the browser never sees half a cite; a whole cite comes out as a cite piece, with the
 *   marker that takes its place in the text. A `<cite` that doesn't close within `hold` characters was not a cite
 *   after all: it goes out as text.
 * - `citeParts` does the same to a finished message's text parts, numbering the cites in order.
 * - `resolveCites` finds each cite's run (by run id, or by the tool call id that made it) and the value at its path,
 *   and numbers them in chat order.
 */
import { CITE_TAG, citeMarker, RunId, valueAt, type Citation, type ChatMessage, type MessagePart, type Run, type Session, type SessionId, type StreamedCite } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import { rows } from '../store/rows.ts';
import { replyText } from '../execution/wire.ts';

/** A cite as the model wrote it, before it is numbered or resolved. */
export interface WrittenCite {
  /** Its place among the message's cites, from 1. */
  readonly index: number;
  readonly tool: string;
  readonly path: string;
  readonly note: string;
}

/** A piece of a streamed answer: text to show, or a whole cite (whose marker is its text). */
export type CitePiece = { readonly type: 'text'; readonly text: string } | { readonly type: 'cite'; readonly cite: WrittenCite; readonly text: string };

const OPEN = `<${CITE_TAG}`;
const CLOSE = `</${CITE_TAG}>`;
/** What may follow `<cite` in a real cite tag: a space before its attributes, `>` or the `/` of `/>`. */
const AFTER_OPEN = /[\s>/]/;
/** One attribute of the opening tag: `name="value"` or `name='value'`. */
const ATTRIBUTE = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text with the XML entities a model writes put back (`&lt;` is `<`). */
export function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? whole;
  });
}

/** A whole cite tag's tool, path and note; `tool` is '' when the tag names none. */
export function readCite(tag: string): Omit<WrittenCite, 'index'> {
  const head = tag.indexOf('>');
  const opening = tag.slice(OPEN.length, head);
  const attributes = new Map<string, string>();
  for (const match of opening.matchAll(ATTRIBUTE)) attributes.set((match[1] ?? '').toLowerCase(), unescapeXml(match[2] ?? match[3] ?? ''));
  const selfClosed = opening.trimEnd().endsWith('/');
  const note = selfClosed ? '' : tag.slice(head + 1, tag.length - CLOSE.length);
  return { tool: (attributes.get('tool') ?? '').trim(), path: (attributes.get('path') ?? '').trim(), note: unescapeXml(note).trim() };
}

/** Whether `text` (from a `<`) could still become `<cite`: it is a beginning of it. */
const mayOpen = (text: string): boolean => text.length < OPEN.length && OPEN.startsWith(text);

/**
 * Reads streamed text and holds back any cite until it is whole. `hold` is how many characters a cite may run to before
 * it is let out as text; `from` is how many cites came before (their indexes go on from it).
 */
export class CiteFilter {
  readonly #hold: number;
  #held = '';
  #count: number;

  constructor(hold: number, from = 0) {
    this.#hold = hold;
    this.#count = from;
  }

  /** How many cites it has let out. */
  get count(): number {
    return this.#count;
  }

  /** The pieces this text lets out, in order: what is held back waits for more. */
  push(text: string): CitePiece[] {
    const out: CitePiece[] = [];
    let rest = this.#held + text;
    this.#held = '';
    let plain = '';
    while (rest !== '') {
      const at = rest.indexOf('<');
      if (at < 0) { plain += rest; break; }
      plain += rest.slice(0, at);
      rest = rest.slice(at);
      const next = this.#read(rest);
      if (next === 'hold') { this.#held = rest; break; }
      if (next === 'text') { plain += '<'; rest = rest.slice(1); continue; }
      if (plain !== '') out.push({ type: 'text', text: plain });
      plain = '';
      out.push(next.piece);
      rest = rest.slice(next.length);
    }
    if (plain !== '') out.push({ type: 'text', text: plain });
    return out;
  }

  /** The end of the text: whatever is still held was never a whole cite, and goes out as text. */
  end(): CitePiece[] {
    const held = this.#held;
    this.#held = '';
    return held === '' ? [] : [{ type: 'text', text: held }];
  }

  /** What the text from a `<` is: a whole cite (and its length), plain text, or the start of a cite still coming. */
  #read(text: string): 'hold' | 'text' | { piece: CitePiece; length: number } {
    if (!text.startsWith(OPEN)) return mayOpen(text) ? 'hold' : 'text';
    const after = text[OPEN.length];
    if (after === undefined) return 'hold';
    if (!AFTER_OPEN.test(after)) return 'text';
    const head = text.indexOf('>');
    const selfClosed = head >= 0 && text[head - 1] === '/';
    const end = selfClosed ? head + 1 : head < 0 ? -1 : text.indexOf(CLOSE, head);
    if (end < 0) return text.length > this.#hold ? 'text' : 'hold';
    const length = selfClosed ? end : end + CLOSE.length;
    if (length > this.#hold) return 'text';
    this.#count += 1;
    const cite: WrittenCite = { index: this.#count, ...readCite(text.slice(0, length)) };
    return { piece: { type: 'cite', cite, text: citeMarker(cite.index) }, length };
  }
}

/** The text pieces let out, joined (each cite as its marker). */
export function piecesText(pieces: readonly CitePiece[]): string {
  return pieces.map((piece) => piece.text).join('');
}

/**
 * A message's parts with every whole cite in their text taken out and its marker put in its place, and the cites in
 * order. A cite that never closed stays as the model wrote it.
 */
export function citeParts(parts: readonly MessagePart[], hold: number): { parts: MessagePart[]; cites: WrittenCite[] } {
  const cites: WrittenCite[] = [];
  let count = 0;
  const out = parts.map((part): MessagePart => {
    if (part.type !== 'text') return part;
    const filter = new CiteFilter(hold, count);
    const pieces = [...filter.push(part.text), ...filter.end()];
    count = filter.count;
    for (const piece of pieces) if (piece.type === 'cite') cites.push(piece.cite);
    return { type: 'text', text: piecesText(pieces) };
  });
  return { parts: out, cites };
}

/**
 * Parts as they read while a message still streams: each whole cite as its marker, and a cite still coming left out
 * (it shows once it closes).
 */
export function streamingParts(parts: readonly MessagePart[], hold: number): MessagePart[] {
  let count = 0;
  return parts.map((part): MessagePart => {
    if (part.type !== 'text') return part;
    const filter = new CiteFilter(hold, count);
    const text = piecesText(filter.push(part.text));
    count = filter.count;
    return { type: 'text', text };
  });
}

/** A table's rows as the model reads them all (`rows.3` is the fourth row it was shown). */
const EVERY_ROW = { rows: Number.MAX_SAFE_INTEGER, watched: false } as const;

/** What resolving cites needs. */
export interface CiteContext {
  readonly store: HubStore;
  /** The most characters of JSON a cite's value may take to be kept on the message. */
  readonly valueChars: number;
}

/**
 * The run a cite names: by its run id, else by the tool call id that made it, in the session (or the chat a fork is of).
 * Undefined when neither is a run of theirs.
 */
async function citedRun(context: CiteContext, tool: string, sessions: ReadonlySet<SessionId>): Promise<Run | undefined> {
  const runs = context.store.table('runs');
  const id = RunId.safeParse(tool);
  const byId = id.success ? await runs.get(id.data) : undefined;
  if (byId?.session !== undefined && sessions.has(byId.session)) return byId;
  for (const session of sessions) {
    const found = (await runs.find({ where: { session, toolCallId: tool }, limit: 1 })).items[0];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A cite resolved against its run: the value at its path in the run's result (or as the model read it), or why not. */
async function resolveOne(context: CiteContext, cite: WrittenCite, number: number, sessions: ReadonlySet<SessionId>): Promise<Citation> {
  const base: Citation = { index: cite.index, number, tool: cite.tool, path: cite.path, note: cite.note };
  if (cite.tool === '') return { ...base, problem: 'It names no tool call.' };
  const run = await citedRun(context, cite.tool, sessions);
  if (run === undefined) return { ...base, problem: `No tool call of this chat has the id ${cite.tool}.` };
  const cited = { ...base, run: run.id, fn: run.fn };
  if (run.outcome?.status !== 'done') return { ...cited, problem: 'That call has no result to cite: it did not finish.' };
  const result = run.outcome.result;
  const inResult = valueAt(result, cite.path);
  const inReply = inResult === undefined ? valueAt(replyText(result, EVERY_ROW), cite.path) : undefined;
  const found = inResult ?? inReply;
  if (found === undefined) return { ...cited, problem: `Its result has nothing at ${cite.path === '' ? 'that path' : cite.path}.` };
  const where = inResult === undefined ? 'reply' : 'result';
  return JSON.stringify(found.value).length > context.valueChars ? { ...cited, found: where, large: true } : { ...cited, found: where, value: found.value };
}

/**
 * The chat's next cite number: one more than the highest so far, in the session and, for a compare's fork, the chat it
 * is a fork of. Numbers only grow, so the newest message with cites has the highest. An undone turn's messages leave
 * the thread, and their numbers are given again (a retried answer starts where the undone one did).
 */
export async function nextCiteNumber(store: HubStore, session: Pick<Session, 'id' | 'forkOf'>, except?: ChatMessage['id']): Promise<number> {
  let highest = 0;
  for (const id of [session.id, ...(session.forkOf === undefined ? [] : [session.forkOf])]) {
    for await (const message of rows(store.table('messages'), { where: { session: id }, order: [['createdAt', 'desc']] })) {
      if (message.id === except || message.citations === undefined || message.citations.length === 0) continue;
      if ((await store.table('turns').get(message.turn))?.status === 'undone') continue;
      highest = Math.max(highest, ...message.citations.map((c) => c.number));
      break;
    }
  }
  return highest + 1;
}

/** A message's cites resolved and numbered from `first`, in order. */
export async function resolveCites(context: CiteContext, cites: readonly WrittenCite[], session: Pick<Session, 'id' | 'forkOf'>, first: number): Promise<Citation[]> {
  const sessions = new Set([session.id, ...(session.forkOf === undefined ? [] : [session.forkOf])]);
  return Promise.all(cites.map(async (cite) => resolveOne(context, cite, first + cite.index - 1, sessions)));
}

/** A cite as it streams: numbered from the chat's next number when the message began. */
export function streamedCite(cite: WrittenCite, first: number): StreamedCite {
  return { index: cite.index, number: first + cite.index - 1, tool: cite.tool, path: cite.path, note: cite.note };
}
