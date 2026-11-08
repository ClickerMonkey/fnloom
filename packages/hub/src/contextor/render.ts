/**
 * The text a prompt is made of: fn cards, context blocks, earlier-exchange summaries, and the static toolset's text
 * protocol (`<run fn="…">{…}</run>` blocks a model writes, `<result …>` replies the hub sends back). One renderer per
 * thing, used by every place that shows it (the prompt, `inspect`, an invalid-input reply), so they always read the
 * same.
 */
import { problemLine, type Detail, type InputProblem, type QualifiedName } from '@harness/core';
import type { CallProtocol, ChosenContext, ExchangeSummary, FnView } from './index.ts';

/** How calls come back in a prompt (`CallProtocol`, named for the renderers' signatures). */
type Protocol = CallProtocol;

/** The tag of a `<run>` block. */
export const RUN_TAG = 'run';
/** The tag of a result the hub sends back for a `<run>` block. */
export const RESULT_TAG = 'result';

/** The longest one-line description shown for a listed item. */
const LINE_MAX = 160;

/** An item's one line: `name — description`, the description's first line clipped. */
export function listedLine(name: string, description: string): string {
  const first = description.split('\n', 1)[0]?.trim() ?? '';
  const line = first.length > LINE_MAX ? `${first.slice(0, LINE_MAX - 1).trimEnd()}…` : first;
  return line === '' ? name : `${name} — ${line}`;
}

/** How a call of `fn` with `args` is written in a protocol. */
export function callText(fn: string, args: string, protocol: Protocol): string {
  return protocol === 'text' ? `<${RUN_TAG} fn="${fn}">${args}</${RUN_TAG}>` : `run({ fn: "${fn}", args: ${args} })`;
}

/**
 * A fn's card at a detail: `listed` is its heading line; `signature` adds how to call it with its args and result
 * types (gin's `toCode()`); `full` adds its instructions, examples, and the definition of each named type it uses
 * that `shown` doesn't have yet (they are added to it, so a prompt prints each type once).
 */
export function fnCard(view: FnView, detail: Detail, protocol: Protocol, shown: Set<QualifiedName> = new Set()): string {
  const { decl, name } = view.record;
  const lines = [`### ${listedLine(name, decl.description)}`];
  if (detail === 'listed') return lines[0] ?? '';
  lines.push(`${callText(name, view.args, protocol)} → ${view.returns}`);
  if (detail === 'signature') return lines.join('\n');
  if (decl.instructions !== undefined && decl.instructions.trim() !== '') lines.push(decl.instructions.trim());
  for (const example of decl.examples ?? []) lines.push(`Example: ${callText(name, JSON.stringify(example.args), protocol)}${example.note === undefined ? '' : ` — ${example.note}`}`);
  for (const [type, definition] of view.types) {
    if (shown.has(type)) continue;
    shown.add(type);
    lines.push(definition);
  }
  return lines.join('\n');
}

/** The heading of the fn cards in a prompt. */
export function cardsHeading(protocol: Protocol): string {
  return protocol === 'text' ? '## Loaded fns — call one with a <run fn="…">{…}</run> block' : '## Loaded fns — call one with run({ fn, args })';
}

/** Fn cards under their heading (empty without cards). */
export function cardsSection(cards: readonly string[], protocol: Protocol): string {
  return cards.length === 0 ? '' : [cardsHeading(protocol), ...cards].join('\n\n');
}

/** A chosen context item as the prompt shows it; `listed` items go in `moreContext` instead. */
export function contextBlock(chosen: Pick<ChosenContext, 'detail' | 'text'> & { readonly name: string }): string {
  const detail = chosen.detail === 'full' ? '' : ' detail="summary"';
  return `<context name="${chosen.name}"${detail}>\n${chosen.text}\n</context>`;
}

/** Listed context items, loadable by name. */
export function moreContext(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `<more_context>\nLoad any of these by name if it helps:\n${lines.map((line) => `- ${line}`).join('\n')}\n</more_context>`;
}

/** Listed fns, loadable by name (tools mode, where only loaded fns are native tools). */
export function moreFns(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `<more_fns>\nLoad any of these with hub/load_fns to use it:\n${lines.map((line) => `- ${line}`).join('\n')}\n</more_fns>`;
}

/** An earlier exchange's summary. */
export function earlierBlock(summary: ExchangeSummary): string {
  const used = summary.used.length === 0 ? '' : `\nUsed: ${summary.used.join(', ')}`;
  return `<earlier turn="${summary.turn}">\nUser: ${summary.user}\nAnswer: ${summary.answer}${used}\n</earlier>`;
}

/** What the text protocol's instructions say. */
export function textProtocolInstructions(): string {
  return [
    '## How to use tools',
    `To use a tool, write a block on its own lines, then stop and wait for its result:`,
    callText('fs/read', '{"path": "README.md"}', 'text'),
    `find, inspect, load and unload are tools too: ${callText('find', '{"query": "git status"}', 'text')}`,
    `Each result comes back as <${RESULT_TAG} fn="…" status="…">…</${RESULT_TAG}>. Write no block when you are ready to answer.`,
  ].join('\n');
}

/** Input problems as the model reads them, one per line, each with where it was. */
export function problemLines(problems: readonly InputProblem[]): string {
  return problems.map((p) => `- ${problemLine(p)}`).join('\n');
}

/** A result sent back for a `<run>` block. */
export function resultText(fn: string, status: string, body: string): string {
  return `<${RESULT_TAG} fn="${fn}" status="${status}">\n${body}\n</${RESULT_TAG}>`;
}

/** One `<run>` block found in a model's text. */
export interface RunBlock {
  /** The `fn` attribute; absent when the block had none. */
  readonly fn: string | undefined;
  /** The block's body, which should be the args as JSON. */
  readonly json: string;
}

/** A model's text with its `<run>` blocks taken out. */
export interface ParsedRuns {
  readonly calls: readonly RunBlock[];
  /** The text around the blocks. */
  readonly prose: string;
}

const BLOCK = /<run(\s[^>]*)?>([\s\S]*?)(?:<\/run>|$)/g;
const FN_ATTRIBUTE = /\bfn\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** A reasoning model's thinking written into its answer (`<think>…</think>`, as some local models do). */
const THINKING = /<think>[\s\S]*?(?:<\/think>|$)/g;

/**
 * The `<run>` blocks of a text and the prose around them. A block left open at the end runs to the end. Thinking
 * written into the answer is neither: a block a model only thought about is not a call.
 */
export function parseRunBlocks(text: string): ParsedRuns {
  const calls: RunBlock[] = [];
  const prose = text.replace(THINKING, '').replace(BLOCK, (_whole, attributes: string | undefined, body: string) => {
    const match = FN_ATTRIBUTE.exec(attributes ?? '');
    const fn = match?.[1] ?? match?.[2];
    calls.push({ fn: fn === undefined || fn.trim() === '' ? undefined : fn.trim(), json: body.trim() });
    return '';
  });
  return { calls, prose: prose.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * Watches a streamed answer for `<run>` blocks: prose is let through as it arrives, a block is held back from its
 * `<run` to its `</run>`, and a chunk ending in what could be the start of `<run` waits for the next chunk.
 */
export class RunBlockFilter {
  #buffer = '';
  #inside = false;

  /** Take a chunk; returns the prose that can be streamed now. */
  push(chunk: string): string {
    this.#buffer += chunk;
    let out = '';
    for (;;) {
      if (this.#inside) {
        const end = this.#buffer.indexOf(`</${RUN_TAG}>`);
        if (end < 0) break;
        this.#buffer = this.#buffer.slice(end + RUN_TAG.length + 3);
        this.#inside = false;
        continue;
      }
      const start = this.#blockStart();
      if (start === 'partial') break;
      if (start === undefined) {
        const keep = partialTail(this.#buffer);
        out += this.#buffer.slice(0, this.#buffer.length - keep);
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        break;
      }
      out += this.#buffer.slice(0, start);
      this.#buffer = this.#buffer.slice(start);
      this.#inside = true;
    }
    return out;
  }

  /** The answer ended: the prose still held (nothing, if a block was left open). */
  end(): string {
    const rest = this.#inside ? '' : this.#buffer;
    this.#buffer = '';
    this.#inside = false;
    return rest;
  }

  /** Where the next block starts; `partial` when `<run` is at the very end and the next character decides. */
  #blockStart(): number | 'partial' | undefined {
    let from = 0;
    for (;;) {
      const at = this.#buffer.indexOf(`<${RUN_TAG}`, from);
      if (at < 0) return undefined;
      const after = this.#buffer[at + RUN_TAG.length + 1];
      if (after === undefined) return 'partial';
      if (after === '>' || /\s/.test(after)) return at;
      from = at + 1;
    }
  }
}

/** How many characters at the end of a text could begin `<run`. */
function partialTail(text: string, open = `<${RUN_TAG}`): number {
  for (let k = Math.min(open.length - 1, text.length); k > 0; k--) if (text.endsWith(open.slice(0, k))) return k;
  return 0;
}

/** The tags a model that thinks in its answer (deepseek-r1 through an OpenAI-style API) wraps its thinking in. */
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** What part of an answer is thinking, and what is the answer. */
export interface ThinkingSplit {
  readonly text: string;
  readonly reasoning: string;
}

/**
 * Splits a streamed answer's `<think>…</think>` out as reasoning, so thinking is kept and shown as reasoning (collapsed)
 * and never as the answer. A chunk ending in what could start a tag waits for the next chunk.
 */
export class ThinkingFilter {
  #buffer = '';
  #inside = false;

  /** Take a chunk; returns the answer text and the reasoning that can be streamed now. */
  push(chunk: string): ThinkingSplit {
    this.#buffer += chunk;
    let text = '';
    let reasoning = '';
    const take = (part: string): void => { if (this.#inside) reasoning += part; else text += part; };
    for (;;) {
      const tag = this.#inside ? THINK_CLOSE : THINK_OPEN;
      const at = this.#buffer.indexOf(tag);
      if (at < 0) {
        const keep = partialTail(this.#buffer, tag);
        take(this.#buffer.slice(0, this.#buffer.length - keep));
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        break;
      }
      take(this.#buffer.slice(0, at));
      this.#buffer = this.#buffer.slice(at + tag.length);
      this.#inside = !this.#inside;
    }
    return { text, reasoning };
  }

  /** The answer ended: what is still held. */
  end(): ThinkingSplit {
    const rest = this.#buffer;
    const inside = this.#inside;
    this.#buffer = '';
    this.#inside = false;
    return inside ? { text: '', reasoning: rest } : { text: rest, reasoning: '' };
  }
}

/** A whole answer with its thinking split out. */
export function splitThinking(answer: string): ThinkingSplit {
  const filter = new ThinkingFilter();
  const first = filter.push(answer);
  const rest = filter.end();
  return { text: (first.text + rest.text).trim(), reasoning: (first.reasoning + rest.reasoning).trim() };
}
