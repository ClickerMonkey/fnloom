/**
 * What is added to a user message before the LLM sees it, and the text the LLM gets for a message. The hub adds the
 * person's local time and the fns and context the message's embedding suggests; then each hook of the session's
 * systems adds its own blocks, in hook order. Every addition is a tagged block, so the model tells it from the
 * person's words. Suggestions are cards in the one XML of `contextor/xml.ts`, each fn's card snapshotted when the
 * message is sent, and a fn or context is suggested once in a chat, never again (`Session.suggested`). Before all of
 * that, a message after the first says which systems went on or off since the model was last told (`chat/announce.ts`).
 * When the suggestions chooser's action is `load`, what it picked is loaded for the turn instead (`#load`): the fns
 * join the tools, the context's text is brought into the message, and `<loaded_for_you>` tells the model so.
 */
import {
  compact, contextOff, DEFAULT_CHAT_MODE, type AnnouncedSystems, fnLabel, INPUT_ANSWER_TAG, splitName, type ActorId, type ChatMessage, type ChatModeType, type ContextRecord, type HookBlock, type HookInput,
  type Link, type LoadedForYouPart, type LoadOutcome, type MessagePart, QualifiedName, type Session, type SuggestedFnCard, type Suggestion, type SuggestionOutcome, type SuggestionRecord, type TurnId,
  type FnExample, type Json, type SearchHit, type UserInfo,
} from '@harness/core';
import type { ShownExample } from '../contextor/examples.ts';
import { withImports } from '../contextor/brought.ts';
import { DEFAULT_CHARS_PER_TOKEN } from '../contextor/tokens.ts';
import { announce, systemsChanged, systemsNow } from './announce.ts';
import type { ChatDeps } from './deps.ts';
import { messageOf } from './errors.ts';
import { fileTag } from './files.ts';
import type { CatalogEntry } from '../catalog/index.ts';
import type { DecidedSuggestions, MessageEnricher, SuggestedExamples, SuggestionDecider } from './index.ts';
import { allowsSystem, callSystem, escapeAttribute, escapeBody } from './support.ts';
import { timeInfo, weekday } from '../execution/time.ts';
import type { AccessScope } from '../access/index.ts';
import { seesContextAs } from '../access/scope.ts';
import type { ModeChoice } from '../contextor/index.ts';
import { modeChoice } from '../contextor/planner.ts';
import { fnHead, promptExamples } from '../contextor/render.ts';
import { fnRefusal, readsAsMissing } from '../contextor/views.ts';
import { cardList, contextElement, element, fnElement } from '../contextor/xml.ts';
import { LlmPayloadType, parseValue, type LlmPayload } from '@harness/sdk';

/** The tags the hub's own extras carry for the LLM. */
export const EXTRA_TAGS = { 'local-time': 'local_time', 'suggested-context': 'suggested_ctx', 'suggested-fns': 'suggested_fns' } as const;

/** The tag each kind of suggestion block is written in. */
const SUGGESTION_TAGS = { 'suggest-context': EXTRA_TAGS['suggested-context'], 'suggest-fns': EXTRA_TAGS['suggested-fns'] } as const;

/** What every suggestion block's first line ends with. */
const ONCE = 'Nothing is suggested twice in a chat, so what was suggested earlier still stands.';

/**
 * The line at the top of `<suggested_ctx>`, by the toolset the message was sent in: the tools mode loads context
 * with `hub/ctx_load`, the static toolset with its `load` tool.
 */
export const SUGGESTED_CONTEXT_LINES: Readonly<Record<ChatModeType, string>> = {
  tools: `Context that may help: load what fits with hub/ctx_load (the fns it brings join your tools). ${ONCE}`,
  static: `Context that may help: load what fits with load (the fns it brings come with it). ${ONCE}`,
};

/**
 * The line at the top of `<suggested_fns>`, by the toolset the message was sent in. Only the static toolset can run a
 * fn by name (its `run`); in the tools mode a fn must be loaded into the tools before it can be called. A suggested fn is a
 * brief card (name, label, description, its first example's args): its full args come when it is loaded or inspected.
 */
export const SUGGESTED_FNS_LINES: Readonly<Record<ChatModeType, string>> = {
  tools: `Fns that may help, each with what it does and an example's args. They are not in your tools yet: load the ones you will call with hub/fns_load (their full args come with them), then call them. One marked available="no" can't be used now: tell the person what its reason says instead. ${ONCE}`,
  static: `Fns that may help, each with what it does and an example's args: run one by its name (inspect it first for its full args). One marked available="no" can't be used now: tell the person what its reason says instead. ${ONCE}`,
};

/** The toolset a suggestion block written before blocks said theirs is read in (build 1's default). */
const UNSTATED_TOOLSET: ChatModeType = DEFAULT_CHAT_MODE.type;

/** A message with nothing suggested. */
const NO_SUGGESTIONS: { parts: MessagePart[]; record?: SuggestionRecord } = { parts: [] };

/** A suggestion block's card list, in the toolset's words. */
function suggestionList(block: Extract<HookBlock, { type: 'suggest-context' | 'suggest-fns' }>, examples?: SuggestedExamples): string {
  const toolset = block.toolset ?? UNSTATED_TOOLSET;
  if (block.type === 'suggest-context') {
    return cardList(SUGGESTION_TAGS[block.type], SUGGESTED_CONTEXT_LINES[toolset], block.items.map((item) => contextElement({ key: item.context, title: item.title, text: item.why ?? '' })));
  }
  // a brief card (Phil 2026-11-22, "Brief cards"): a card snapshotted whole before reads as brief too
  return cardList(SUGGESTION_TAGS[block.type], SUGGESTED_FNS_LINES[toolset], block.items.map((item) => fnElement({
    name: item.fn, label: item.card?.label ?? fnLabel(item.fn), description: item.why ?? '',
    ...(item.card === undefined ? {} : { mode: item.card.mode, blocked: item.card.blocked, examples: briefExample(item.fn, item.card.examples ?? [], examples) }),
  })));
}

/**
 * The example args each suggested fn of a message shows (its card's first), in the code shape: the agent loop writes
 * them as the model would send them for that fn (`PromptPlanner.writeArgs`) before it renders the message.
 */
export function suggestedExamples(message: Pick<ChatMessage, 'parts'>): Array<{ readonly fn: QualifiedName; readonly args: Json }> {
  return message.parts.flatMap((part) => (part.type === 'extra' || part.type === 'hook' ? part.blocks : [])).flatMap((block) => {
    if (block.type !== 'suggest-fns') return [];
    return block.items.flatMap((item) => { const first = item.card?.examples?.[0]; return first === undefined ? [] : [{ fn: item.fn, args: first.args }]; });
  });
}

/** A suggested fn's card's one example as it is snapshotted: the first one's args, in the code shape. */
function firstArgs(examples: readonly FnExample[]): FnExample[] | undefined {
  const [first] = examples;
  return first === undefined ? undefined : [{ args: first.args }];
}

/**
 * A suggestion's one example: the first one's args, without its result or note, as `written` has them for the model
 * (`suggestedExamples`), else in the code shape.
 */
function briefExample(fn: QualifiedName, examples: readonly FnExample[], written?: SuggestedExamples): ShownExample[] | undefined {
  const [first] = examples;
  return first === undefined ? undefined : [{ args: written?.get(fn) ?? JSON.stringify(first.args) }];
}

/**
 * The names a message's parts suggest (the hub's and its hooks'), in order, and those the suggestions chooser loaded
 * for it (`loaded-for-you`): what was loaded is never suggested again either.
 */
export function suggestedIn(parts: readonly MessagePart[]): QualifiedName[] {
  return parts.flatMap((part): QualifiedName[] => {
    if (part.type === 'loaded-for-you') return [...part.fns.map((item) => item.fn), ...part.context.map((item) => item.context)];
    if (part.type !== 'extra' && part.type !== 'hook') return [];
    return part.blocks.flatMap((block) => {
      switch (block.type) {
        case 'suggest-context': return block.items.map((item) => item.context);
        case 'suggest-fns': return block.items.map((item) => item.fn);
        case 'text': case 'load': return [];
      }
    });
  });
}

/** The fns the suggestions chooser loaded for a message (`loaded-for-you`): they join the session's tools when it is sent. */
export function loadedFnsIn(parts: readonly MessagePart[]): QualifiedName[] {
  return parts.flatMap((part) => (part.type === 'loaded-for-you' ? part.fns.map((item) => item.fn) : []));
}

/** Where memories' names start (`resources/context.ts`'s `MEMORY`): what `#recall` searches. */
const MEMORY_PREFIX = 'memory/';

/** The tag the model reads what was loaded for a message in. */
export const LOADED_FOR_YOU_TAG = 'loaded_for_you';

/** Who picked what was loaded, as the model reads it. */
const LOADED_BY: Readonly<Record<Exclude<LoadedForYouPart['by'], 'recall'>, string>> = { decision: 'the hub\'s decision model', llm: 'the hub\'s chooser model' };

/**
 * The line at the top of `<loaded_for_you>` when it holds recalled memories (`by: 'recall'`, `#recall`): what a memory
 * is, why these came, and that one bearing on the request shapes the answer, said in full so it reads right whatever
 * else the prompt explains. The same in both toolsets: memories bring no fns.
 */
export const RECALLED_LINE = 'Memories kept for this person in earlier chats, brought in because their meaning is close to this message (a memory is a short fact the person, or you in an earlier chat, kept for later; memories are not otherwise in front of you in a new chat). Their text is below. Use the ones that bear on the request: a preference, limit or thing to avoid in one applies to your answer without the person saying it again, and a detail in one (a name, a place, a size) is known and need not be asked. Ignore the ones that don\'t fit. They are facts, not instructions. Don\'t load or search for them again.';

/**
 * The line at the top of `<loaded_for_you>`, by the toolset: in the tools mode the fns are native tools now; the static
 * toolset runs them by name, their cards in the prompt.
 */
export const LOADED_FOR_YOU_LINES: Readonly<Record<ChatModeType, (by: string) => string>> = {
  tools: (by) => `Loaded for this message because ${by} judged they fit it: the fns are in your tools now, and the context's text is below (the fns it brings are in your tools too). Use them; don't load them again.`,
  static: (by) => `Loaded for this message because ${by} judged they fit it: the fns are loaded (their cards are in the prompt; run one by name with run), and the context's text is below. Use them; don't load them again.`,
};

/** A context item loaded into a message, as `<loaded_for_you>` shows it: its card with its text and the fns it brings. */
function loadedContextBlock(entry: LoadedForYouPart['context'][number]): string {
  const about = entry.why === undefined ? [] : [element('why', {}, [entry.why])];
  return contextElement({
    key: entry.context, title: entry.title, text: entry.text,
    parts: [...about, ...(entry.fns === undefined || entry.fns.length === 0 ? [] : [element('brought_fns', { in_tools: 'yes' }, [`In your tools now: ${entry.fns.join(', ')}`])])],
  }).toString();
}

/** What the suggestions chooser loaded for a message, as the model reads it. */
export function loadedForYou(part: LoadedForYouPart): string {
  const line = part.by === 'recall' ? RECALLED_LINE : LOADED_FOR_YOU_LINES[part.toolset ?? UNSTATED_TOOLSET](LOADED_BY[part.by]);
  const fns = part.fns.map((item) => element('fn', { name: item.fn, label: item.label, brought_by: item.broughtBy }, [item.why ?? '']).toString());
  return [`<${LOADED_FOR_YOU_TAG}>`, line, ...fns, ...part.context.map(loadedContextBlock), `</${LOADED_FOR_YOU_TAG}>`].join('\n');
}

/** A context item's estimated tokens in a message, as `<loaded_for_you>` shows it (the planner measures it exactly). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);
}

/** A `why` field when there is one. */
function whyOf(why: string | undefined): { why?: string } {
  return why === undefined ? {} : { why };
}

/** The suggested context and fns as the extras the LLM reads, best first, and the record of every candidate. */
function suggestionParts(suggestions: readonly Suggestion[], record: SuggestionRecord | undefined): { parts: MessagePart[]; record?: SuggestionRecord } {
  const ranked = [...suggestions].sort((a, b) => b.score - a.score);
  const fns = ranked.filter((s) => s.kind === 'fn');
  const context = ranked.filter((s) => s.kind === 'context');
  const parts: MessagePart[] = [];
  if (context.length > 0) {
    parts.push({ type: 'extra', extra: 'suggested-context', blocks: [{ type: 'suggest-context', items: context.map((s) => ({ context: s.name, why: s.description, score: s.score })) }] });
  }
  if (fns.length > 0) {
    parts.push({ type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', items: fns.map((s) => ({ fn: s.name, why: s.description, score: s.score })) }] });
  }
  return record === undefined ? { parts } : { parts, record };
}

/** A session's suggested set after a message with these parts was sent (nothing to change when they suggest nothing). */
export function suggestedAfter(session: Pick<Session, 'suggested'>, parts: readonly MessagePart[]): Pick<Session, 'suggested'> {
  const added = suggestedIn(parts);
  return added.length === 0 ? {} : { suggested: [...new Set([...(session.suggested ?? []), ...added])] };
}

/** Enriches and renders messages. */
export class HubMessageEnricher implements MessageEnricher {
  readonly #deps: Pick<ChatDeps, 'clock' | 'log' | 'settings' | 'catalog' | 'link' | 'access' | 'store' | 'promptRoom' | 'search'>;
  readonly #decider: Pick<SuggestionDecider, 'decide'>;

  constructor(deps: Pick<ChatDeps, 'clock' | 'log' | 'settings' | 'catalog' | 'link' | 'access' | 'store' | 'promptRoom' | 'search'>, decider: Pick<SuggestionDecider, 'decide'>) {
    this.#deps = deps;
    this.#decider = decider;
  }

  async enrich(input: { session: Session; turn: TurnId; text: string; user: UserInfo }): Promise<{ parts: MessagePart[]; suggestions?: SuggestionRecord; announcedSystems?: AnnouncedSystems }> {
    const choice = await this.#choice(input.session);
    // the graph contextor chooses context and fns for each prompt itself, so its sessions get no suggestion blocks
    const suggest = choice.contextor.type !== 'graph';
    const [systems, decided, hooks] = await Promise.all([
      this.#systems(input.session, input.user.id), suggest ? this.#decide(input.session, input.text, input.user.id) : undefined, this.#hooks(input),
    ]);
    const at = { session: input.session, actor: input.user.id, toolset: choice.mode.type };
    // a chooser whose action is `load` loads what it can for the turn; the rest of its picks are suggested
    const loading = decided?.load === undefined ? undefined : await this.#load(decided, decided.load, { ...at, text: input.text });
    // the person's memories closest to the message come with it as their text, whoever picks suggestions
    const recalled = suggest ? await this.#recall({ ...at, text: input.text }, loading?.names ?? []) : undefined;
    const suggested = decided === undefined ? NO_SUGGESTIONS : suggestionParts(loading?.rest ?? decided.suggestions, loading?.record ?? decided.record);
    const offered = await this.#offer([...suggested.parts, ...hooks], at, [...(loading?.names ?? []), ...(recalled?.context.map((item) => item.context) ?? [])]);
    const parts = [
      ...(systems.changed === undefined ? [] : [systems.changed]), this.#localTime(input.user), ...(loading?.part === undefined ? [] : [loading.part]), ...(recalled === undefined ? [] : [recalled]), ...offered,
    ];
    return {
      parts, ...(suggested.record === undefined ? {} : { suggestions: suggested.record }), ...(systems.announced === undefined ? {} : { announcedSystems: systems.announced }),
    };
  }

  /**
   * What a chooser with the action `load` picked, loaded for the turn as `hub/fns_load` and `hub/ctx_load` load:
   * each fn the session may use joins its tools (`#loads` in `chat/turns.ts` adds the part's fns when the message is
   * sent); each context item is brought into the message as its text, with its imports and the fns it brings (into
   * the tools too), best first while its text fits the room (`#contextRoom`). What was suggested or loaded before, what
   * the person can't see and what is gone are left to `#offer`, which drops them. What didn't fit (`budget`) or can't
   * be used now (`blocked`: a fn that can't be used here, a context item with no text of its own) is suggested
   * instead, and the record says so. `names`: what this message loads, so nothing suggests it again.
   */
  async #load(decided: DecidedSuggestions, load: NonNullable<DecidedSuggestions['load']>, at: { session: Session; actor: ActorId; toolset: ChatModeType; text: string }): Promise<{
    part?: LoadedForYouPart; rest: Suggestion[]; record?: SuggestionRecord; names: QualifiedName[];
  }> {
    const { session } = at;
    const access = await this.#deps.access.scope(at.actor);
    // what the agent's injected section holds (the fixed region's stamp) is in the prompt already: never loaded for you
    const seen = new Set<string>([...(session.suggested ?? []), ...session.tools, ...session.context, ...(session.fixed?.injected ?? [])]);
    const broughtBy = new Map((decided.record?.items ?? []).flatMap((item) => (item.kind === 'fn' && item.broughtBy !== undefined ? [[item.name, item.broughtBy] as const] : [])));
    const ranked = [...decided.suggestions].sort((a, b) => b.score - a.score);
    const why = (item: Suggestion): string | undefined => load.why.get(`${item.kind}:${item.name}`);
    const outcomes = new Map<string, LoadOutcome>();
    const rest: Suggestion[] = [];
    const taken = { fn: new Set<string>(), context: new Set<string>() };
    const context: LoadedForYouPart['context'] = [];
    const contexts = ranked.filter((item) => item.kind === 'context');
    let left = contexts.length === 0 ? 0 : await this.#contextRoom(at);
    for (const item of contexts) {
      if (taken.context.has(item.name)) continue;
      const main = seen.has(item.name) ? undefined : await this.#deps.catalog.context(item.name);
      if (main === undefined || contextOff(main) || !seesContextAs(access, main, session.id)) { rest.push(item); continue; }
      if (main.decl.content === undefined) { rest.push(item); outcomes.set(`context:${item.name}`, 'blocked'); continue; }
      // it comes with what it imports, each once in the message, as hub/ctx_load loads it
      const records: ContextRecord[] = [];
      for (const name of await withImports(this.#deps.catalog, [item.name])) {
        if (name !== item.name && (seen.has(name) || taken.context.has(name))) continue;
        const record = name === item.name ? main : await this.#deps.catalog.context(QualifiedName.parse(name));
        if (record?.decl.content === undefined || contextOff(record) || !allowsSystem(session, record.system) || !seesContextAs(access, record, session.id)) continue;
        records.push(record);
      }
      const entries = records.map((record) => ({
        context: record.name, ...(record.decl.title === undefined ? {} : { title: record.decl.title }),
        ...(record === main ? whyOf(why(item)) : { why: `Imported by ${item.name}.` }), text: record.decl.content ?? '',
        ...(record.decl.fns.length === 0 ? {} : { fns: [...record.decl.fns] }),
      }));
      const cost = entries.reduce((sum, entry) => sum + estimateTokens(loadedContextBlock(entry)), 0);
      if (cost > left) { rest.push(item); outcomes.set(`context:${item.name}`, 'budget'); continue; }
      left -= cost;
      for (const entry of entries) { context.push(entry); taken.context.add(entry.context); }
    }
    // the fns: those picked, then those the loaded context brings (each once, only what the session may use)
    const fns: LoadedForYouPart['fns'] = [];
    const addFn = async (item: Pick<Suggestion, 'name'> & { readonly why?: string | undefined }, by: QualifiedName | undefined): Promise<'loaded' | 'blocked' | 'missing'> => {
      const record = await this.#deps.catalog.fn(item.name);
      const blocked = fnRefusal(record, session, access);
      if (record === undefined || (blocked !== undefined && readsAsMissing(blocked))) return 'missing';
      if (blocked !== undefined) return 'blocked';
      fns.push({ fn: item.name, label: fnHead(record).label, ...(item.why === undefined ? {} : { why: item.why }), ...(by === undefined ? {} : { broughtBy: by }) });
      taken.fn.add(item.name);
      return 'loaded';
    };
    for (const item of ranked.filter((s) => s.kind === 'fn')) {
      const by = broughtBy.get(item.name);
      // a fn suggested because its context was: loaded with it, else suggested with it
      if (by !== undefined && !taken.context.has(by)) { rest.push(item); const of = outcomes.get(`context:${by}`); if (of !== undefined) outcomes.set(`fn:${item.name}`, of); continue; }
      if (taken.fn.has(item.name)) continue;
      if (seen.has(item.name)) { rest.push(item); continue; }
      const added = await addFn({ name: item.name, why: by === undefined ? why(item) : undefined }, by);
      if (added !== 'loaded') { rest.push(item); if (added === 'blocked') outcomes.set(`fn:${item.name}`, 'blocked'); }
    }
    const brought: SuggestionOutcome[] = [];
    for (const entry of context) {
      for (const name of entry.fns ?? []) {
        if (seen.has(name) || taken.fn.has(name)) continue;
        if (await addFn({ name }, entry.context) === 'loaded') brought.push({ used: true, kind: 'fn', name, broughtBy: entry.context, load: 'loaded' });
      }
    }
    // a context card names only the fns it brought that are in the tools now (one that can't be used is suggested, or left out)
    const inTools = (name: QualifiedName): boolean => taken.fn.has(name) || session.tools.includes(name);
    for (const [i, entry] of context.entries()) {
      const { fns: brings, ...card } = entry;
      const kept = (brings ?? []).filter(inTools);
      context[i] = kept.length === 0 ? card : { ...card, fns: kept };
    }
    // the record: what each pick became (one left to #offer, seen or gone, says nothing of a load)
    const record = decided.record === undefined ? undefined : {
      ...decided.record,
      items: [...decided.record.items.map((item): SuggestionOutcome => {
        if (!item.used || item.load === undefined) return item;
        const { load: _meant, ...rest } = item;
        const became = taken[item.kind].has(item.name) ? 'loaded' : outcomes.get(`${item.kind}:${item.name}`);
        return became === undefined ? rest : { ...rest, load: became };
      }), ...brought.filter((item) => !decided.record?.items.some((had) => had.kind === 'fn' && had.name === item.name))],
    };
    this.#deps.log.info('chat.suggest.loaded', { session: session.id, by: load.by, fns: fns.length, context: context.length, suggested: rest.length });
    const part: LoadedForYouPart | undefined = fns.length + context.length === 0 ? undefined : { type: 'loaded-for-you', by: load.by, toolset: at.toolset, fns, context };
    return { ...(part === undefined ? {} : { part }), rest, ...(record === undefined ? {} : { record }), names: [...fns.map((f) => f.fn), ...context.map((c) => c.context)] };
  }

  /**
   * The person's memories whose meaning is closest to the message (iteration 4): up to `HARNESS_RECALL_MEMORIES`, each
   * at or over `HARNESS_RECALL_THRESHOLD`, brought in as their text (`<loaded_for_you>`, `by: 'recall'`), so a kept
   * preference, limit or detail is in front of the model in a new chat without it having to think of searching
   * (iteration 3, case 28: the model searched in the chat it saved the memory in, never in the next one). Only memories
   * the person may see in this chat (a session memory only in its own chat), on, and not suggested, loaded or recalled
   * before in it; `taken`: what this message loads already. The text sits in the message, not in the system prompt, so
   * a model-written memory never lands in every later prompt (`guardReach`); it is read once in a chat, and only when it
   * fits. Undefined when nothing fits or the search fails (logged).
   */
  async #recall(at: { session: Session; actor: ActorId; toolset: ChatModeType; text: string }, taken: readonly QualifiedName[]): Promise<LoadedForYouPart | undefined> {
    const { HARNESS_RECALL_MEMORIES: most, HARNESS_RECALL_THRESHOLD: least } = this.#deps.settings.chat;
    if (most === 0 || at.text.trim() === '') return undefined;
    const { session } = at;
    const seen: string[] = [...new Set<string>([...(session.suggested ?? []), ...session.context, ...(session.fixed?.injected ?? []), ...taken])];
    try {
      const access = await this.#deps.access.scope(at.actor);
      const records = new Map<string, ContextRecord>();
      const keep = async (hit: SearchHit): Promise<boolean> => {
        if (seen.includes(hit.key)) return false;
        const name = QualifiedName.safeParse(hit.key);
        const record = name.success ? await this.#deps.catalog.context(name.data) : undefined;
        if (record?.origin?.type !== 'memory' || record.decl.content === undefined || contextOff(record) || !seesContextAs(access, record, session.id)) return false;
        // a session memory is for its own chat only, even for its author
        if (record.origin.scope.to === 'session' && record.origin.scope.session !== session.id) return false;
        records.set(hit.key, record);
        return true;
      };
      const hits = await this.#deps.search.search({
        text: at.text, kinds: ['context'], limit: most, prefix: MEMORY_PREFIX, meaning: true, keep, ...(seen.length === 0 ? {} : { excludeKeys: seen }),
      });
      const context = hits.slice(0, most).flatMap((hit): LoadedForYouPart['context'] => {
        const record = records.get(hit.key);
        if (record === undefined || hit.similarity === undefined || hit.similarity < least) return [];
        return [{ context: record.name, title: record.decl.title ?? record.decl.description, text: record.decl.content ?? '' }];
      });
      if (context.length === 0) return undefined;
      this.#deps.log.info('chat.recall', { session: session.id, memories: context.length });
      return { type: 'loaded-for-you', by: 'recall', toolset: at.toolset, fns: [], context };
    } catch (error) {
      this.#deps.log.warn('chat.recall.failed', { session: session.id, error: messageOf(error) });
      return undefined;
    }
  }

  /**
   * The most tokens of context text a chooser may load into one message: `HARNESS_AUTOLOAD_TOKENS`, and no more than
   * `HARNESS_AUTOLOAD_ROOM_SHARE` of the room the prompt has besides its fixed part (`ChatDeps.promptRoom`), so the
   * contextor's plan, which counts the message in its fixed part, still has room for the history.
   */
  async #contextRoom(at: { session: Session; actor: ActorId; text: string }): Promise<number> {
    const cap = this.#deps.settings.chat.HARNESS_AUTOLOAD_TOKENS;
    if (cap === 0 || this.#deps.promptRoom === undefined) return cap;
    try {
      const room = await this.#deps.promptRoom({ session: at.session.id, text: at.text, actor: at.actor });
      return room === undefined ? cap : Math.max(0, Math.min(cap, Math.floor(room * this.#deps.settings.chat.HARNESS_AUTOLOAD_ROOM_SHARE)));
    } catch (error) {
      this.#deps.log.warn('chat.suggest.room-unknown', { session: at.session.id, error: messageOf(error) });
      return cap;
    }
  }

  /** What changed in the session's systems for its person since the model was last told, and the snapshot after it. */
  async #systems(session: Session, actor: ActorId): Promise<ReturnType<typeof announce>> {
    return announce(session.announcedSystems, await systemsNow(this.#deps.store, await this.#deps.access.scope(actor), session));
  }

  /** A session's chat mode and contextor (its own choice, else its agent's). */
  async #choice(session: Session): Promise<ModeChoice> {
    // the agent's payload only matters when the session doesn't choose both itself
    const payload = session.mode === undefined || session.contextor === undefined ? await this.#agentChoice(session) : {};
    return modeChoice(session, payload);
  }

  /** The mode and contextor a session's agent fn asks for (none when it is gone or its payload doesn't parse, logged). */
  async #agentChoice(session: Session): Promise<Pick<LlmPayload, 'mode' | 'contextor'>> {
    const agent = await this.#deps.catalog.fn(session.agent);
    if (agent === undefined) return {};
    try {
      return parseValue(LlmPayloadType, agent.decl.payload);
    } catch (error) {
      this.#deps.log.warn('chat.agent.payload-unreadable', { session: session.id, agent: session.agent, error: messageOf(error) });
      return {};
    }
  }

  render(message: ChatMessage, examples?: SuggestedExamples): string {
    // what changed in the systems is read first, before the person's words it may explain
    const first: string[] = [];
    const inline: string[] = [];
    const blocks: string[] = [];
    for (const part of message.parts) {
      switch (part.type) {
        case 'systems-changed': first.push(systemsChanged(part)); break;
        case 'text': inline.push(part.text); break;
        // the model reads its own reasoning and fn calls from the transcript, never from the message
        case 'reasoning': case 'call': break;
        // an undo note's list of what A/B variants left done is for people; the model never reads notes
        case 'kept-effects': break;
        case 'mention':
          inline.push(`<mention provider="${escapeAttribute(part.provider)}" label="${escapeAttribute(part.label)}">${escapeBody(part.text)}</mention>`);
          break;
        case 'command':
          inline.push(`<command context="${escapeAttribute(part.context)}"${attributes(part.args)} />`);
          break;
        case 'invocation': inline.push(`<invocation fn="${escapeAttribute(part.fn)}" run="${escapeAttribute(part.run)}" />`); break;
        case 'file': inline.push(fileTag(part)); break;
        case 'extra': blocks.push(this.block(EXTRA_TAGS[part.extra], part.blocks, examples)); break;
        case 'hook': blocks.push(this.block(hookTag(part.hook), part.blocks, examples)); break;
        case 'attachment':
          blocks.push(`<attachment name="${escapeAttribute(part.attachment)}" title="${escapeAttribute(part.title)}">${escapeBody(JSON.stringify(part.data))}</attachment>`);
          break;
        case 'link': inline.push(linkTag(part.link)); break;
        // a form's answers: the model reads them, the chat shows the message only in debug mode
        case 'input-answer': blocks.push(`<${INPUT_ANSWER_TAG} title="${escapeAttribute(part.title)}">${escapeBody(part.text)}</${INPUT_ANSWER_TAG}>`); break;
        // what the suggestions chooser loaded for the turn, so the model uses it and doesn't load it again
        case 'loaded-for-you': blocks.push(loadedForYou(part)); break;
      }
    }
    return [...first, inline.join(''), ...blocks].filter((s) => s !== '').join('\n\n');
  }

  block(tag: string, blocks: readonly HookBlock[], examples?: SuggestedExamples): string {
    const lines = blocks.map((block) => {
      switch (block.type) {
        case 'text': return `<${hookTag(block.tag)}>${escapeBody(block.text)}</${hookTag(block.tag)}>`;
        case 'suggest-context': case 'suggest-fns': return suggestionList(block, examples);
        case 'load': return `Loaded: ${[...(block.context ?? []), ...(block.fns ?? [])].join(', ')}`;
      }
    });
    // the hub's own suggestions are one block in an extra of the same name: that block is the extra, not wrapped twice
    const [only] = blocks;
    if (blocks.length === 1 && (only?.type === 'suggest-context' || only?.type === 'suggest-fns') && SUGGESTION_TAGS[only.type] === tag) return lines[0] ?? '';
    return `<${tag}>\n${lines.join('\n')}\n</${tag}>`;
  }

  #localTime(user: UserInfo): MessagePart {
    const time = timeInfo(this.#deps.clock(), user.timeZone);
    const text = `${weekday(time.now, time.timeZone)} ${time.local} (${time.timeZone})`;
    return { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'now', text }] };
  }

  /** What the suggestions chooser picked for the message, and the record of every candidate (none when it fails, logged). */
  async #decide(session: Session, text: string, actor: ActorId): Promise<DecidedSuggestions | undefined> {
    try {
      return await this.#decider.decide({ session: session.id, text, actor });
    } catch (error) {
      this.#deps.log.warn('chat.suggest.failed', { session: session.id, error: messageOf(error) });
      return undefined;
    }
  }

  /**
   * The suggestions of a message's extras and hooks as they are sent: what this chat was suggested before (or this
   * message already suggests) left out, and so is what the session has loaded (it is in the prompt already), each
   * block stamped with the session's toolset, each fn's card snapshotted, a context's title added. A fn or context the
   * person can't see, one that is gone, or a fn not for the model, is left out. A block left with nothing goes, and a
   * part left with no blocks. `loaded`: what this message loads for the turn (`#load`), never suggested with it.
   */
  async #offer(parts: readonly MessagePart[], at: { session: Session; actor: ActorId; toolset: ChatModeType }, loaded: readonly QualifiedName[] = []): Promise<MessagePart[]> {
    // nor is what the injected section holds suggested: it is in the prompt
    const seen = new Set<string>([...(at.session.suggested ?? []), ...at.session.tools, ...at.session.context, ...(at.session.fixed?.injected ?? []), ...loaded]);
    const out: MessagePart[] = [];
    let access: AccessScope | undefined;
    const scope = async (): Promise<AccessScope> => (access ??= await this.#deps.access.scope(at.actor));
    for (const part of parts) {
      if (part.type !== 'extra' && part.type !== 'hook') { out.push(part); continue; }
      const blocks: HookBlock[] = [];
      for (const block of part.blocks) {
        const offered = await this.#offerBlock(block, seen, { ...at, scope });
        if (offered !== undefined) blocks.push(offered);
      }
      if (blocks.length > 0) out.push({ ...part, blocks });
    }
    return out;
  }

  /** One block as `#offer` sends it; undefined when it suggests nothing new. */
  async #offerBlock(block: HookBlock, seen: Set<string>, at: { session: Session; toolset: ChatModeType; scope: () => Promise<AccessScope> }): Promise<HookBlock | undefined> {
    switch (block.type) {
      case 'text': case 'load': return block;
      case 'suggest-context': {
        const items: typeof block.items = [];
        for (const item of block.items) {
          if (seen.has(item.context)) continue;
          const record = await this.#deps.catalog.context(item.context);
          if (record === undefined || !seesContextAs(await at.scope(), record, at.session.id)) continue;
          seen.add(item.context);
          const title = item.title ?? record.decl.title;
          // a brief card: title and summary (the hub's own suggestion carries the description, its summary when it has one)
          const why = item.why === record.decl.description && record.decl.summary !== undefined ? record.decl.summary : item.why;
          items.push({ ...item, ...(title === undefined ? {} : { title }), ...(why === undefined ? {} : { why }) });
        }
        return items.length === 0 ? undefined : { ...block, toolset: at.toolset, items };
      }
      case 'suggest-fns': {
        const items: typeof block.items = [];
        for (const item of block.items) {
          if (seen.has(item.fn)) continue;
          const card = item.card ?? await this.#card(item.fn, { session: at.session, access: await at.scope() });
          if (card === undefined) continue;
          seen.add(item.fn);
          items.push({ ...item, card });
        }
        return items.length === 0 ? undefined : { ...block, toolset: at.toolset, items };
      }
    }
  }

  /**
   * A suggested fn's brief card as of now (Phil 2026-11-22, "Brief cards"): its label, mode, what blocks it (the
   * Phase 1 refusal, in the hub's words) and its first example's args; with the item's description that is the whole
   * card. Its full args and returns come when it is loaded (or inspected). Undefined for a fn that reads as missing
   * (gone, unseen, not for the model).
   */
  async #card(name: QualifiedName, at: { session: Session; access: AccessScope }): Promise<SuggestedFnCard | undefined> {
    const record = await this.#deps.catalog.fn(name);
    const blocked = fnRefusal(record, at.session, at.access);
    if (record === undefined || (blocked !== undefined && readsAsMissing(blocked))) return undefined;
    const head = fnHead(record, blocked?.reason);
    return compact({ label: head.label, mode: head.mode, blocked: head.blocked, examples: firstArgs(promptExamples(record).shown) });
  }

  async #hooks(input: { session: Session; turn: TurnId; text: string; user: UserInfo }): Promise<MessagePart[]> {
    const hooks = (await this.#deps.catalog.entries('hooks'))
      .filter((h) => allowsSystem(input.session, h.system))
      .toSorted((a, b) => a.decl.order - b.decl.order || a.name.localeCompare(b.name));
    const time = timeInfo(this.#deps.clock(), input.user.timeZone);
    const message: HookInput = { session: input.session.id, turn: input.turn, text: input.text, user: input.user, time };
    const results = await Promise.all(hooks.map(async (hook) => this.#runHook(hook, message)));
    return results.flatMap((blocks, i) => {
      const hook = hooks[i];
      return hook === undefined || blocks.length === 0 ? [] : [{ type: 'hook' as const, hook: hook.name, blocks }];
    });
  }

  async #runHook(hook: CatalogEntry<'hooks'>, message: HookInput): Promise<HookBlock[]> {
    const available = await this.#deps.catalog.availability(hook.name);
    if (available !== true) { return []; }
    const started = this.#deps.clock();
    try {
      const blocks = await callSystem(this.#deps.link, hook.system, hook.decl.timeout, (c, signal) =>
        c.peer.call('hook', { hook: splitName(hook.name).local, message }, { signal }));
      this.#deps.log.debug('chat.hook.done', { hook: hook.name, blocks: blocks.length, time: this.#deps.clock() - started });
      return blocks;
    } catch (error) {
      this.#deps.log.warn('chat.hook.failed', { hook: hook.name, turn: message.turn, error: messageOf(error) });
      return [];
    }
  }
}

/** The LLM tag of a hook's blocks: `fs/git_branch` → `fs_git_branch`. */
export function hookTag(hook: string): string {
  return hook.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Tag attributes from a record; names are made tag-safe. */
function attributes(values: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(values).map(([name, value]) => (value === undefined ? '' : ` ${hookTag(name)}="${escapeAttribute(value)}"`)).join('');
}

/** A link as the LLM sees it. */
function linkTag(link: Link): string {
  if ('resource' in link) { return `<link${attributes({ resource: link.resource, section: link.section, title: link.title })} />`; }
  if ('url' in link) { return `<link${attributes({ url: link.url, title: link.title })} />`; }
  if ('file' in link) { return `<link${attributes({ file: link.file.hash, title: link.title })} />`; }
  return `<link${attributes({ run: link.run, title: link.title })} />`;
}
