/**
 * The stream guard: every chat stream the hub AI makes (an agent fn's, the chat's, and every call a system forwards
 * through the gateway, its authoring agents' among them) passes through it, so two ways a model wastes a whole answer
 * end as a tool error the model can recover from instead of minutes of tokens or a failed run.
 *
 * - **A degenerate stream:** a tool call's arguments (or the answer's text) run into `HARNESS_STREAM_BLANK_RUN`
 *   blank characters in a row (spaces, tabs, newlines, or their JSON escapes `\n` `\t` `\r`). GPT-6 Luna once wrote
 *   65k tokens of whitespace into one `set` call of `make_api` over four minutes. The guard stops the provider's
 *   stream there (the call is recorded as ended early) and finishes the call with arguments that say what happened,
 *   which the prompt fails to parse and hands back to the model as that call's error, so it calls again.
 * - **A tool call cut off by the output limit:** the provider finishes with `length` while a call's arguments are
 *   still open. aeye reads `length` as "the context was too big" and forgets history, which never helps a reply that
 *   ran out of room. The guard finishes the open call the same way, saying it hit the output limit, so the model
 *   writes a shorter call.
 *
 * Text that runs blank just ends there (`stop`). Nothing else in a stream changes.
 */
import { getResponseFromChunks, type Chunk, type Request, type Response, type Streamer, type ToolCall } from '@aeye/core';

/** What the guard is set with. */
export interface StreamGuardOptions {
  /** Blank characters in a row that make a stream degenerate (`HARNESS_STREAM_BLANK_RUN`). */
  readonly blankRun: number;
}

/** How much of the arguments a stopped call keeps after its note, so the model sees which call it was. */
export const STOPPED_HEAD = 300;

/** The arguments a stopped call ends with: the note first (what the model reads), then the start of what it wrote. */
export function stoppedArguments(why: 'blank' | 'length', written: string, options: { blankRun: number; maxTokens?: number | undefined }): string {
  const note = why === 'blank'
    ? `Stopped by the hub: these arguments ran into ${options.blankRun} blank characters in a row (a stuck stream), so the call was not run. Call the tool again with the whole arguments as compact JSON, without padding.`
    : `Stopped by the hub: the arguments reached the output limit${options.maxTokens === undefined ? '' : ` (${options.maxTokens} tokens)`} before they were complete, so the call was not run. Call the tool again with shorter arguments (a smaller draft, fewer rows, no padding).`;
  const head = written.trimEnd().slice(0, STOPPED_HEAD);
  return head === '' ? note : `${note}\nIt began: ${head}`;
}

/** Counts the blank characters at the end of a growing text, a piece at a time. */
export class BlankRun {
  #scanned = 0;
  #run = 0;
  #escape = false;

  /** The run after reading `text`'s new part (`text` is the whole text so far, or `delta` only the new part). */
  read(text: string, delta = false): number {
    const from = delta ? 0 : this.#scanned;
    if (!delta && text.length < this.#scanned) { this.#scanned = 0; this.#run = 0; this.#escape = false; return this.read(text); }
    for (let i = from; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (this.#escape) {
        this.#escape = false;
        // `\n` `\t` `\r` inside a JSON string: blank, counted as one
        if (c === 110 || c === 116 || c === 114) { this.#run += 1; continue; }
        this.#run = 0;
        continue;
      }
      if (c === 92) { this.#escape = true; continue; }
      if (c === 32 || c === 9 || c === 10 || c === 13) { this.#run += 1; continue; }
      this.#run = 0;
    }
    if (!delta) this.#scanned = text.length;
    return this.#run;
  }

  get run(): number {
    return this.#run;
  }
}

/** The calls a chunk names or grows. */
function callsOf(chunk: Chunk): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const call of [chunk.toolCallNamed, chunk.toolCallArguments]) {
    if (call !== undefined && !calls.some((c) => c.id === call.id)) calls.push(call);
  }
  return calls;
}

/** A chunk without what it says about the calls in `drop` (calls the guard already finished). */
function without(chunk: Chunk, drop: ReadonlySet<string>): Chunk | undefined {
  if (drop.size === 0) return chunk;
  const { toolCallNamed, toolCallArguments, toolCall, ...rest } = chunk;
  const kept: Chunk = { ...rest };
  if (toolCallNamed !== undefined && !drop.has(toolCallNamed.id)) kept.toolCallNamed = toolCallNamed;
  if (toolCallArguments !== undefined && !drop.has(toolCallArguments.id)) kept.toolCallArguments = toolCallArguments;
  if (toolCall !== undefined && !drop.has(toolCall.id)) kept.toolCall = toolCall;
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** Wrap a streamer in the guard. */
export function guardStream<C, M>(inner: Streamer<C, M>, options: StreamGuardOptions): Streamer<C, M> {
  return async function* guarded(request: Request, context, metadata, signal): AsyncGenerator<Chunk, Response> {
    const out: Chunk[] = [];
    const emit = (chunk: Chunk): Chunk => { out.push(chunk); return chunk; };
    const runs = new Map<string, BlankRun>();
    /** Calls still open: named, not finished by the provider. */
    const open = new Map<string, ToolCall>();
    /** Calls the guard finished; what the provider says of them later is dropped. */
    const ended = new Set<string>();
    const text = new BlankRun();
    for await (const chunk of inner(request, context, metadata, signal)) {
      for (const call of callsOf(chunk)) {
        if (ended.has(call.id)) continue;
        open.set(call.id, call);
        const run = runs.get(call.id) ?? new BlankRun();
        runs.set(call.id, run);
        if (run.read(call.arguments) >= options.blankRun) {
          // stop the provider here (leaving the loop returns its stream): the call ends early and is recorded so
          const stopped: ToolCall = { id: call.id, name: call.name, arguments: stoppedArguments('blank', call.arguments, options) };
          // only the finished call goes out (a growing one would be sent on as a delta of what it replaced)
          yield emit({ ...(chunk.toolCallNamed?.id === call.id ? { toolCallNamed: stopped } : {}), toolCall: stopped, finishReason: 'tool_calls' });
          return getResponseFromChunks(out);
        }
      }
      if (chunk.toolCall !== undefined) open.delete(chunk.toolCall.id);
      if (chunk.content !== undefined && chunk.content !== '' && text.read(chunk.content, true) >= options.blankRun) {
        const { content, ...rest } = chunk;
        const head = content.trimEnd();
        yield emit({ ...rest, ...(head === '' ? {} : { content: head }), finishReason: 'stop' });
        return getResponseFromChunks(out);
      }
      if (chunk.finishReason === 'length' && open.size > 0) {
        const kept = without({ ...chunk, finishReason: 'tool_calls' }, ended);
        if (kept !== undefined) yield emit(kept);
        for (const call of open.values()) {
          ended.add(call.id);
          const stopped: ToolCall = { id: call.id, name: call.name, arguments: stoppedArguments('length', call.arguments, { blankRun: options.blankRun, maxTokens: request.maxTokens }) };
          yield emit({ toolCall: stopped });
        }
        open.clear();
        continue;
      }
      const kept = without(chunk, ended);
      if (kept !== undefined) yield emit(kept);
    }
    return getResponseFromChunks(out);
  };
}
