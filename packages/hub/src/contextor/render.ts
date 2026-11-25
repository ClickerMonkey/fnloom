/**
 * The text a prompt is made of: fn cards, context blocks, earlier-exchange summaries, and the static toolset's text
 * protocol (`<run fn="…">{…}</run>` blocks a model writes, `<result …>` replies the hub sends back). One renderer per
 * thing, used by every place that shows it (the prompt, `inspect`, an invalid-input reply), so they always read the
 * same. Fn and context cards are the one XML of `xml.ts`.
 */
import {
  fnLabel, problemLine, RESULT_TABLE_INSTRUCTION, type ChatModeType, type ContextCrawlResult, type ContextRecord, type CrawledContext, type CrawlSkip, type CrawlStopReason, type Detail, type FnBlock, type FnExample, type FnMode, type FnRefusal, type FnRecord, type InputProblem, type QualifiedName,
} from '@harness/core';
import { hub } from '@harness/sdk';
import { fnMode } from '../link/review-summary.ts';
import { PLAIN_EXAMPLES, shownExamples, toolExamples, verbatim, type ExampleWriter } from './examples.ts';
import type { CallProtocol, ChosenContext, ExchangeSummary, FnView } from './index.ts';
import { AVAILABLE, cardList, contextElement, element, fnElement, moreExamplesQuery, type FnCardParts, type Markup } from './xml.ts';

/** How calls come back in a prompt (`CallProtocol`, named for the renderers' signatures). */
type Protocol = CallProtocol;

/** The tag of a `<run>` block. */
export const RUN_TAG = 'run';
/** The tag of a result the hub sends back for a `<run>` block. */
export const RESULT_TAG = 'result';
/** The tag of the message the hub adds after a call that shows the model a resource (`chat/shown.ts`). */
export const SHOWN_TAG = 'shown';

/** The longest one-line description shown for a listed item. */
const LINE_MAX = 160;

/** A description's first line, clipped to `LINE_MAX`. */
export function firstLine(description: string): string {
  const first = description.split('\n', 1)[0]?.trim() ?? '';
  return first.length > LINE_MAX ? `${first.slice(0, LINE_MAX - 1).trimEnd()}…` : first;
}

/** An item's one line: `name — description`, the description's first line clipped. */
export function listedLine(name: string, description: string): string {
  const line = firstLine(description);
  return line === '' ? name : `${name} — ${line}`;
}

/** The short instruction about table results, once, when any of the fns shown returns a table; else empty. */
export function tableInstruction(views: readonly Pick<FnView, 'routing'>[]): string {
  return views.some((view) => view.routing !== undefined) ? RESULT_TABLE_INSTRUCTION : '';
}

/** How a call of `fn` with `args` is written in a protocol. */
export function callText(fn: string, args: string, protocol: Protocol): string {
  return protocol === 'text' ? `<${RUN_TAG} fn="${fn}">${args}</${RUN_TAG}>` : `run({ fn: "${fn}", args: ${args} })`;
}

/**
 * The examples of a fn a prompt shows: those chosen for this turn (`ChosenFn.examples`), else its first declared ones
 * up to its `promptExamples`; and how many more it has. A fn that has examples always shows at least one (Phil: "if
 * examples are available are sending at least one"): when none was chosen for the turn its first declared one goes,
 * unless the fn itself asks for none (`promptExamples: 0`).
 */
export function promptExamples(record: Pick<FnRecord, 'decl'>, chosen?: readonly FnExample[]): { readonly shown: readonly FnExample[]; readonly more: number } {
  const declared = record.decl.examples ?? [];
  const picked = chosen ?? (record.decl.promptExamples === undefined ? declared : declared.slice(0, record.decl.promptExamples));
  const shown = picked.length === 0 && record.decl.promptExamples !== 0 ? declared.slice(0, 1) : picked;
  return { shown, more: Math.max(0, declared.length - shown.length) };
}

/**
 * A fn's example lines as its native tool's description ends with them (`promptExamples`): the args of each example as
 * the tool takes them, written through the request's plan once it is made (`toolExamples`: the tool is the fn, so the
 * example is exactly its args as the schema sent with it has them), then where the rest are when it has more. `tool`:
 * the tool's name; `names`: the prompt's (none: estimates, which read the code shape).
 */
export function toolExampleLines(view: Pick<FnView, 'record' | 'signature'>, tool: string, chosen?: readonly FnExample[], names?: Parameters<typeof toolExamples>[1]): string[] {
  const { record } = view;
  const { shown, more } = promptExamples(record, chosen);
  const lines = shownExamples(view, shown, toolExamples(tool, names)).map((example) => {
    const result = example.result === undefined ? '' : ` → result ${example.result}`;
    return `Example args: ${example.args}${result}${example.note === undefined ? '' : ` — ${example.note}`}`;
  });
  // its args name the fn and say what you are about to do: nothing a dialect writes otherwise, so as they are
  if (more > 0) lines.push(`It has ${more} more example${more === 1 ? '' : 's'}: hub/fns_examples (${verbatim({ fn: names?.name(record.name) ?? record.name, query: 'what you are about to do' })}) gives the closest.`);
  return lines;
}

/** A fn's description with the lines saying what it changes in the hub (build 6) and how long it usually runs, as its native tool describes it. */
export function describedWithEffects(view: Pick<FnView, 'record' | 'effects' | 'notice' | 'routing'>): string {
  return [view.record.decl.description, ...besideLines(view)].join('\n');
}

/** The lines beside a fn's description: its table routing, what it changes in the hub, then its long-running warning. */
function besideLines(view: Pick<FnView, 'effects' | 'notice' | 'routing'>): string[] {
  return [view.routing === undefined ? undefined : `It ${view.routing}.`, view.effects, view.notice].filter((line) => line !== undefined);
}

/** The parts every card of a fn has, whatever its detail: its name, label, mode and whether it can be used. */
export function fnHead(record: Pick<FnRecord, 'name' | 'decl'>, blocked?: string): Pick<FnCardParts, 'name' | 'label' | 'blocked'> & { readonly mode: FnMode } {
  return { name: record.name, label: fnLabel(record.name), mode: fnMode(record.decl), ...(blocked === undefined ? {} : { blocked }) };
}

/**
 * A fn's card (`fnElement`) at a detail: `listed` is its first line; `signature` adds its whole description with the
 * lines beside it, and its args and result types (gin's `toCode()`); `full` adds its instructions, examples, and the
 * definition of each named type it uses that `shown` doesn't have yet (they are added to it, so a prompt prints each
 * type once). `blocked` says what blocks it, when something does. Its examples are written as the prompt's `writer` says
 * (`examples.ts`: the args the model would send for the fn here; outside a prompt, the code shape).
 */
export function fnCardElement(view: FnView, detail: Detail, shown: Set<QualifiedName> = new Set(), examples?: readonly FnExample[], blocked?: string, writer: ExampleWriter = PLAIN_EXAMPLES): Markup {
  const head = fnHead(view.record, blocked);
  if (detail === 'listed') return fnElement({ ...head, description: firstLine(view.record.decl.description), beside: view.routing === undefined ? [] : [`It ${view.routing}.`] });
  const signature: FnCardParts = { ...head, description: view.record.decl.description, beside: besideLines(view), args: view.args, returns: view.returns };
  if (detail === 'signature') return fnElement(signature);
  const { shown: picked, more } = promptExamples(view.record, examples);
  const types: Array<readonly [string, string]> = [];
  for (const [type, definition] of view.types) {
    if (shown.has(type)) continue;
    shown.add(type);
    types.push([type, definition]);
  }
  return fnElement({
    ...signature, instructions: view.record.decl.instructions, examples: shownExamples(view, picked, writer), moreExamples: more,
    ...(more > 0 ? { moreExamplesArgs: writer.contract(hub.fns.fns_examples, moreExamplesQuery(view.record.name)) } : {}), types,
  });
}

/** A fn's card as text (`fnCardElement`). */
export function fnCard(view: FnView, detail: Detail, shown: Set<QualifiedName> = new Set(), examples?: readonly FnExample[], blocked?: string, writer?: ExampleWriter): string {
  return fnCardElement(view, detail, shown, examples, blocked, writer).toString();
}

/** The heading of the fn cards in a prompt. */
export function cardsHeading(protocol: Protocol): string {
  return protocol === 'text' ? '## Loaded fns — call one with a <run fn="…">{…}</run> block' : '## Loaded fns — call one with run({ fn, args })';
}

/** Fn cards under their heading (empty without cards). */
export function cardsSection(cards: readonly string[], protocol: Protocol): string {
  return cards.length === 0 ? '' : [cardsHeading(protocol), ...cards].join('\n\n');
}

/** How the hub says a fn is blocked, wherever it says it (a static `run`, `inspect`): its name, then the hub's reason. */
export function blockedLine(fn: string, block: Pick<FnBlock, 'reason'>): string {
  return `${fn} can't be used now: ${block.reason}`;
}

/**
 * What a context item's brought fns are in this prompt: `added` (in the model's tools now), `waiting` (usable, but not
 * in this step's tools: cut to fit, or listed only), and `blocked` (they can't be used now, each with what blocks it).
 * A context block says only what is true of each, so the model is never told a held fn is in its tools, in the chat
 * mode's `words` (the tools mode's by default).
 */
export interface BroughtFnLines {
  readonly added: readonly string[];
  readonly waiting?: readonly string[];
  readonly blocked?: readonly FnRefusal[];
  readonly words?: BroughtWords;
}

/**
 * How a context card says what its brought fns are, in a chat mode's words: `attribute` names whether they are ready
 * to call, `added` and `waiting` lead the two lists.
 */
export interface BroughtWords {
  readonly attribute: string;
  readonly added: string;
  readonly waiting: string;
}

/** The tools mode's words: an added fn is a native tool now. */
const TOOLS_BROUGHT: BroughtWords = { attribute: 'in_tools', added: 'In your tools now', waiting: 'Not in your tools this step' };

/**
 * The words for brought fns in a chat mode. In the tools mode an added fn is a native tool. The static toolset has its
 * five tools only: nothing joins them, so an added fn is a card in the prompt, run by name with `run` (or a block in the
 * text protocol), and one not shown can still be inspected, then run by name.
 */
export function broughtWords(mode: ChatModeType, protocol: Protocol): BroughtWords {
  if (mode === 'tools') return TOOLS_BROUGHT;
  const run = protocol === 'text' ? `a <${RUN_TAG} fn="…">{…}</${RUN_TAG}> block` : 'run({ fn, args })';
  return { attribute: 'loaded', added: `Their cards are in this prompt; run one with ${run}`, waiting: 'Not loaded this step: inspect one for its args, then run it by name' };
}

/**
 * Blocked fns in one line, grouped by reason, each reason without its fn's own name in front ("database/create_table
 * changed and waits for an admin to approve it" → "changed and waits for an admin to approve it"), so several held
 * fns read as one group: `database/create_table, database/insert_rows (changed and waits for an admin to approve it)`.
 */
export function blockedFnsLine(blocked: readonly FnRefusal[]): string {
  const groups = new Map<string, string[]>();
  for (const refusal of blocked) {
    const own = `${refusal.fn} `;
    const reason = refusal.reason.startsWith(own) ? refusal.reason.slice(own.length) : refusal.reason;
    groups.set(reason, [...(groups.get(reason) ?? []), refusal.fn]);
  }
  return [...groups].map(([reason, fns]) => `${fns.join(', ')} (${reason})`).join('; ');
}

/** The tag a context card names its brought fns in. */
const BROUGHT_TAG = 'brought_fns';

/** A context card's parts about its brought fns: only the added ones as in the tools, the rest named for what they are. */
function broughtParts(fns: BroughtFnLines | undefined): Markup[] {
  if (fns === undefined) return [];
  const { added, waiting = [], blocked = [], words = TOOLS_BROUGHT } = fns;
  return [
    ...(added.length === 0 ? [] : [element(BROUGHT_TAG, { [words.attribute]: 'yes' }, [`${words.added}: ${added.join(', ')}`])]),
    ...(waiting.length === 0 ? [] : [element(BROUGHT_TAG, { [words.attribute]: 'no' }, [`${words.waiting}: ${waiting.join(', ')}`])]),
    ...(blocked.length === 0 ? [] : [element(BROUGHT_TAG, { [words.attribute]: 'no', available: AVAILABLE.no }, [`You can't use these now: ${blockedFnsLine(blocked)}. If you need one, tell the person what blocks it.`])]),
  ];
}

/** A context card's choices of where to go next. */
function choicesPart(choices: ChosenContext['choices']): Markup | undefined {
  if (choices === undefined || choices.length === 0) return undefined;
  return element('choices', {}, [
    'Where to go next: load the one that fits by its key, or none.',
    ...choices.map((c) => element('choice', { key: c.to, tokens: c.tokens }, [c.when])),
  ]);
}

/** A chosen context item's card as the prompt shows it; `listed` items go in `moreContext` instead. */
export function contextBlock(chosen: Pick<ChosenContext, 'detail' | 'text' | 'choices'> & { readonly name: string; readonly title?: string | undefined; readonly fns?: BroughtFnLines }): string {
  return contextElement({
    key: chosen.name, title: chosen.title, detail: chosen.detail === 'full' ? undefined : 'summary', text: chosen.text,
    parts: [...broughtParts(chosen.fns), choicesPart(chosen.choices)],
  }).toString();
}

/** A context item's listed card: its first line. */
export function listedContextElement(record: Pick<ContextRecord, 'name' | 'decl'>): Markup {
  return contextElement({ key: record.name, title: record.decl.title, text: firstLine(record.decl.description) });
}

/** Listed context items, loadable by name. */
export function moreContext(records: readonly Pick<ContextRecord, 'name' | 'decl'>[]): string {
  return cardList('more_ctx', 'Load any of these by name if it helps:', records.map(listedContextElement));
}

/** A refused name's card: the name as given, the hub's code, and why. */
function refusedElement(name: string, reason: string, attributes: Record<string, string | undefined> = {}): Markup {
  return element('refused', { name, ...attributes, available: AVAILABLE.no }, [reason]);
}

/** The words for what a load just brought: it joins the tools from the next step. */
const LOADED_BROUGHT: BroughtWords = { attribute: 'in_tools', added: 'In your tools from your next step', waiting: 'Not in your tools' };

/**
 * What `hub/fns_load` answers the model: the loaded fns' cards (`<loaded_fns>`, each listed: its name, label, mode and
 * first line; its tool has the rest from the next step), then each refused name with the hub's reason (`<refused_fns>`).
 */
export function loadedFnsCards(loaded: readonly FnView[], refused: readonly FnRefusal[]): string {
  return [
    cardList('loaded_fns', 'In your tools from your next step:', loaded.map((view) => fnCardElement(view, 'listed'))),
    cardList('refused_fns', 'Not loaded. Don\'t load these again; if you need one, tell the person what blocks it:', refused.map((r) => refusedElement(r.fn, r.reason, { code: r.code }))),
  ].filter((part) => part !== '').join('\n') || '<loaded_fns />';
}

/** A context name `hub/ctx_load` refused: as given, why, and the closest names it knows. */
export interface RefusedContext {
  readonly context: string;
  readonly reason: string;
  readonly closest: readonly string[];
}

/**
 * What `hub/ctx_load` answers the model: the loaded items' cards (`<loaded_ctx>`, each listed: its text is in
 * the prompt from the next step), the fns they brought for what they are (`<brought_fns>`, as a context block says
 * them), and each refused name with the closest names (`<refused_ctx>`).
 */
export function loadedContextCards(loaded: readonly Pick<ContextRecord, 'name' | 'decl'>[], brought: Pick<BroughtFnLines, 'added' | 'blocked'>, refused: readonly RefusedContext[]): string {
  return [
    cardList('loaded_ctx', 'Their text is in front of you from your next step:', loaded.map(listedContextElement)),
    ...broughtParts({ ...brought, words: LOADED_BROUGHT }).map((part) => part.toString()),
    cardList('refused_ctx', 'Not loaded:', refused.map((r) => refusedElement(r.context, r.closest.length === 0 ? r.reason : `${r.reason}. The closest: ${r.closest.join(', ')}.`))),
  ].filter((part) => part !== '').join('\n') || '<loaded_ctx />';
}

/** Why a crawl stopped, as the model reads it. */
const CRAWL_STOP_WORDS = {
  complete: 'It followed every choice there was.',
  'max-depth': 'It reached maxDepth: the choices past the last level are under <skipped_ctx>.',
  'max-decisions': 'It ran out of questions (maxDecisions): the choices it could not ask about are under <skipped_ctx>.',
  'max-tokens': 'It reached maxTokens: what did not fit is under <skipped_ctx>.',
  failed: 'The decision model failed, so it stopped; what it took before is kept.',
} as const satisfies Record<CrawlStopReason, string>;

/** What a crawl's cards show: what it took, skipped and refused, how it stopped, and whether it loaded what it took. */
export interface CrawlCards extends Pick<ContextCrawlResult, 'stop' | 'decisions' | 'tokens'> {
  readonly taken: readonly Omit<CrawledContext, 'content'>[];
  readonly skipped: readonly CrawlSkip[];
  /** Loaded into the session (else metadata only: nothing loaded). */
  readonly loaded: boolean;
  readonly brought: Pick<BroughtFnLines, 'added' | 'blocked'>;
  readonly refused: readonly RefusedContext[];
}

/** A probability as a card shows it: two decimals. */
const chance = (probability: number | undefined): string | undefined => (probability === undefined ? undefined : probability.toFixed(2));

/**
 * What `hub/ctx_crawl` answers the model: what it took (`<crawled_ctx>`, each a listed context card with its
 * level, how it was reached and its size; loaded, or metadata only), the fns that brought (`<brought_fns>`), the
 * choices it skipped and why (`<skipped_ctx>`), the starting names it refused (`<refused_ctx>`), and why it
 * stopped (`<crawl_stop>`).
 */
export function crawledContextCards(cards: CrawlCards): string {
  const intro = cards.loaded
    ? 'Their text is in front of you from your next step:'
    : 'Not loaded (metadata only): load what fits with hub/ctx_load.';
  const taken = cards.taken.map((item) => contextElement({
    key: item.name, title: item.title, text: firstLine(item.description),
    about: { depth: item.depth, via: item.via, from: item.from, yes: chance(item.probability), tokens: item.tokens },
  }));
  return [
    element('crawled_ctx', { decisions: cards.decisions, tokens: cards.tokens }, taken.length === 0 ? ['Nothing was taken.'] : [intro, ...taken]).toString(),
    ...broughtParts({ ...cards.brought, words: LOADED_BROUGHT }).map((part) => part.toString()),
    cardList('skipped_ctx', 'Not taken:', cards.skipped.map((skip) => element('skipped', { key: skip.context, from: skip.from, depth: skip.depth, reason: skip.reason, yes: chance(skip.probability) }))),
    cardList('refused_ctx', 'Not loaded:', cards.refused.map((r) => refusedElement(r.context, r.closest.length === 0 ? r.reason : `${r.reason}. The closest: ${r.closest.join(', ')}.`))),
    element('crawl_stop', { reason: cards.stop.reason }, [cards.stop.detail === undefined ? CRAWL_STOP_WORDS[cards.stop.reason] : `${CRAWL_STOP_WORDS[cards.stop.reason]} ${cards.stop.detail}`]).toString(),
  ].filter((part) => part !== '').join('\n');
}

/** Listed fns, loadable by name (tools mode, where only loaded fns are native tools). */
export function moreFns(views: readonly FnView[]): string {
  return cardList('more_fns', 'Load any of these with hub/fns_load to use it:', views.map((view) => fnCardElement(view, 'listed')));
}

/** An earlier exchange's summary. */
export function earlierBlock(summary: ExchangeSummary): string {
  const used = summary.used.length === 0 ? '' : `\nUsed: ${summary.used.join(', ')}`;
  return `<earlier turn="${summary.turn}">\nUser: ${summary.user}\nAnswer: ${summary.answer}${used}\n</earlier>`;
}

/** What the guide says of a context item shown as a summary (`detail="summary"`): how to read it whole, with `call`. */
export function summaryHint(call: string): string {
  return `A context item marked detail="summary" is cut short; when you need the rest, read it whole with ${call}.`;
}

/**
 * What the text protocol's instructions say. Small models tend to answer "I can't access files", so the guide says
 * plainly that the blocks are how it acts, and shows one whole exchange: the block, the result, the answer.
 */
export function textProtocolInstructions(): string {
  const read = callText('fs/read', '{"path": "notes.txt"}', 'text');
  return [
    '## How to use tools',
    'Answer from the context below when it holds the answer.',
    'You can use tools: reading files, running commands and more. You use one by writing a block, and the hub runs it for you and sends back its result. Never say you cannot access something a tool reaches; write the block instead.',
    `To use a tool, write only the block, on its own line, then stop and wait for the result:\n${read}`,
    `find (fns), find_ctx (context), inspect, load and unload are tools too: ${callText('find', '{"text": "git status"}', 'text')}`,
    `When a system has several machines connected, say which one runs it with on: <${RUN_TAG} fn="fs/read" on="laptop">{"path": "notes.txt"}</${RUN_TAG}>`,
    `Each result comes back as <${RESULT_TAG} fn="…" status="…">…</${RESULT_TAG}>. Write no block when you are ready to answer.`,
    summaryHint(callText('inspect', '{"name": "<its name>", "detail": "full"}', 'text')),
    `Example. The person asks: "What is in notes.txt?" You write:\n${read}\nThe hub sends back:\n${resultText('fs/read', 'done', 'buy milk')}\nYou answer: "notes.txt says: buy milk."`,
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
  /** The `on` attribute: which machine runs it, for a system with several connected; absent when the block had none. */
  readonly on?: string;
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
/** The attributes a `<run>` block's opening tag may carry, each `name="…"` or `name='…'`. */
const ATTRIBUTES = {
  fn: /\bfn\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  on: /\bon\s*=\s*(?:"([^"]*)"|'([^']*)')/,
} as const;

/** An attribute's value in a block's opening tag; absent when it has none or it is blank. */
function attribute(attributes: string, name: keyof typeof ATTRIBUTES): string | undefined {
  const match = ATTRIBUTES[name].exec(attributes);
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value === '' ? undefined : value;
}

/** A reasoning model's thinking written into its answer (`<think>…</think>`, as some local models do). */
const THINKING = /<think>[\s\S]*?(?:<\/think>|$)/g;

/**
 * The `<run>` blocks of a text and the prose around them. A block left open at the end runs to the end. Thinking
 * written into the answer is neither: a block a model only thought about is not a call.
 */
export function parseRunBlocks(text: string): ParsedRuns {
  const calls: RunBlock[] = [];
  const prose = text.replace(THINKING, '').replace(BLOCK, (_whole, attributes: string | undefined, body: string) => {
    const on = attribute(attributes ?? '', 'on');
    calls.push({ fn: attribute(attributes ?? '', 'fn'), json: body.trim(), ...(on === undefined ? {} : { on }) });
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
