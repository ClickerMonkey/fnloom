/**
 * The admin's search decisions (`SearchDecision`, the `hubOptions` rows `fnsSearchDecision` and
 * `contextSearchDecision`): who filters a ranked search's hits before they are returned, for fns and for context
 * apart. `DecidedFnSearch` wraps the database search with them, so every caller of the one operation gets the same
 * hits: `hub/fns_search` and `hub/ctx_search`, the web's `searchFns` and the system link's `searchFns`.
 *
 * - `none`: the hits as ranked.
 * - `decision`: the models module's `Decider` asks a decision model (its own, else the `decide` role's) one yes/no
 *   question per hit, "does it fit what the search is for?", in batches within its `maxQuestions` and
 *   `maxRequestBytes`; those at or over the decide role's threshold are kept, in their order.
 * - `llm`: a chat model reads the hits and the search and answers which to keep, as JSON, with reasons.
 *
 * What the search is for is its text and, when it runs inside a turn, the turn's latest user message. Only a ranked
 * search is filtered (by text, not by name or for named items). Every model call is a `ModelCall` (purpose
 * `fns-search` or `context-search`) charged to the asker's run when there is one. If the model fails, every hit is
 * kept and the page says so (`SearchFiltered.failed`).
 *
 * An item the search names exactly (its `names`, its whole text, or a name-like word in it: `web/guide`, or a fn as
 * a model spells it, `web__read`) is always on the first page, first, marked `exact`: whatever the query's other
 * filters, the ranking or a decision would have done with it (`DecidedFnSearch`). A name in `names` no item the asker
 * may see has is said so (`FnSearchPage.missing`) instead of an empty page.
 *
 * A decision whose action is `load` marks its record so (`SearchFiltered.action`); the filter itself loads nothing
 * (the web's search only filters). `hub/fns_search` and `hub/ctx_search`, which run in a chat, then load the best kept hits they may use
 * (`loadKept` in `boot/hub-fns.ts`) and say what in their page (`FnSearchPage.loaded`).
 */
import type { Logger } from '@ayepi/log';
import {
  actionOf, fnOfModelNameByRule, mapConcurrent, messageOf, QualifiedName, SEARCH_DECISION_DEFAULT, SEARCH_DECISION_OPTIONS, SearchDecision, yesProbability, type ActorId, type DecisionQuestions, type FnSearchHit,
  type FnSearchPage, type FnSearchQuery, type LlmMessage, type ModelCallId, type MessagePart, type RunId, type SearchDecisionsView, type SearchDecisionView,
  type SearchFiltered, type SearchItemKind, type SessionId, type Timestamp,
} from '@harness/core';
import { a } from '@aeye/schema';
import { plainText } from '../chat/turns.ts';
import type { LlmGateway } from '../execution/index.ts';
import type { Decider, DecisionModel } from '../models/index.ts';
import { pinnedModel } from '../models/pinned.ts';
import { structuredAnswer } from '../models/structured.ts';
import type { HubStore } from '../store/index.ts';
import type { FnsTuning } from './env.ts';
import type { Asker, FnSearch } from './index.ts';

/** The purpose each item kind's filter calls are recorded under. */
export const SEARCH_DECISION_PURPOSES = { fn: 'fns-search', context: 'context-search' } as const satisfies Record<SearchItemKind, string>;

/** What the search decisions read. */
export interface SearchDecisionsDeps {
  readonly store: () => HubStore;
  readonly decider: () => Pick<Decider, 'model' | 'ask'>;
  readonly llm: () => Pick<LlmGateway, 'chat'>;
  readonly clock: () => Timestamp;
  readonly log: Pick<Logger, 'info' | 'warn'>;
  readonly tuning: Pick<FnsTuning, 'HARNESS_SEARCH_DECISION_TIMEOUT'>;
}

/** What the search was for: its text, and the turn's latest user message when it runs inside one. */
export interface SearchPurpose {
  readonly text: string;
  readonly latest?: string | undefined;
}

/** A model setting of a search decision (a decision model or an LLM). */
type Judging = Exclude<SearchDecision, { by: 'none' }>;

/** Which hits a model kept, and the notes on those it dropped. */
interface Judged {
  readonly kept: ReadonlySet<FnSearchHit>;
  readonly notes: ReadonlyMap<FnSearchHit, string | undefined>;
}

/** One hit kept or dropped by the LLM, by its name. */
const JudgedItem = a.object({
  name: a.string().describe('The hit\'s name, exactly as given.'),
  reason: a.string().optional().describe('Why, in under 12 words.'),
});

/** What the LLM answers: the hits it keeps, and those it drops with a reason worth keeping. */
const FilterAnswer = structuredAnswer(a.object({
  keep: a.array(JudgedItem).describe('The hits that fit what the search is for.'),
  dropped: a.array(JudgedItem).optional().describe('Hits left out, when there is a reason worth keeping.'),
}));

/** A probability in words, for a decision model's note: "82% likely". */
const likelihood = (probability: number): string => `${Math.round(probability * 100)}% likely`;

/** The decision question's name for the hit at a position: short and safe for every decision model. */
const questionKey = (index: number): string => `h${index}`;

/** What a hit is, in a question: a tool or a context item. */
const itemWords = (item: SearchItemKind): string => (item === 'fn' ? 'tool' : 'context item');

/** What the search was for, as one text for the judging model. */
export function purposeText(purpose: SearchPurpose): string {
  const latest = purpose.latest?.trim() ?? '';
  return latest === '' ? `Search: ${purpose.text}` : `Search: ${purpose.text}\nLatest user message: ${latest}`;
}

/** One yes/no question per hit, by position. */
export function hitQuestions(hits: readonly FnSearchHit[]): DecisionQuestions {
  return Object.fromEntries(hits.map((hit, i) => [questionKey(i), {
    type: 'predicate' as const,
    instructions: `Does this ${itemWords(hit.item)} fit what the search is for? ${hit.name}: ${hit.description}`,
  }]));
}

/** The LLM's prompt: what the search was for, the hits, and the JSON to answer with. */
export function filterPrompt(purpose: SearchPurpose, hits: readonly FnSearchHit[]): LlmMessage[] {
  const system = [
    'You filter search results for an assistant: keep the tools and context items that fit what the search is for, and drop the rest.',
    'Keep a hit when it helps with what was searched for (and the user\'s latest message, when given); drop one that only shares words with it.',
    'Name each hit exactly as given. For example, for "Search: keep track of what I spend" with a hit notes/make_table ("Make a table to keep records in") and a hit notes/plugin_guide ("Writing a plugin"), keep { "name": "notes/make_table", "reason": "Keeps the records." } and drop notes/plugin_guide.',
  ].join('\n');
  const listed = hits.map((hit) => `- ${hit.name} (${itemWords(hit.item)}): ${hit.description}`).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${purposeText(purpose)}\n\nHits:\n${listed}` },
  ];
}

/** The latest user message of a session, as plain text; undefined when it has none. */
export async function latestUserText(store: HubStore, session: SessionId | undefined): Promise<string | undefined> {
  if (session === undefined) return undefined;
  const page = await store.table('messages').find({ where: { session, role: 'user' }, order: [['createdAt', 'desc']], limit: 1 });
  const parts: readonly MessagePart[] | undefined = page.items[0]?.parts;
  const text = parts === undefined ? '' : plainText(parts).trim();
  return text === '' ? undefined : text;
}

/** The search decisions: their settings, and the filter they put on a page of hits. */
export class SearchDecisions {
  readonly #deps: SearchDecisionsDeps;

  constructor(deps: SearchDecisionsDeps) {
    this.#deps = deps;
  }

  /** One item kind's setting, who set it and when (nobody filters until an admin chooses). */
  async setting(item: SearchItemKind): Promise<SearchDecisionView> {
    const key = SEARCH_DECISION_OPTIONS[item];
    const row = await this.#deps.store().table('hubOptions').get(key);
    return row?.key !== key ? { value: SEARCH_DECISION_DEFAULT } : { value: SearchDecision.parse(row.value), setBy: row.setBy, updatedAt: row.updatedAt };
  }

  /** Both settings. */
  async settings(): Promise<SearchDecisionsView> {
    const [fn, context] = await Promise.all([this.setting('fn'), this.setting('context')]);
    return { fn, context };
  }

  /** Set one item kind's setting; answers both. */
  async set(item: SearchItemKind, value: SearchDecision, by: ActorId): Promise<SearchDecisionsView> {
    const row = { key: SEARCH_DECISION_OPTIONS[item], value, setBy: by, updatedAt: this.#deps.clock() };
    await this.#deps.store().table('hubOptions').put(row);
    this.#deps.log.info('fns.search-decision.set', { item, by: value.by, setBy: by });
    return this.settings();
  }

  /**
   * A page with the hits each item kind's setting drops taken out, in their order, and what was dropped and why
   * (`filtered`). A search by name, for named items, or with no text is returned as it is.
   */
  async filter(page: FnSearchPage, query: FnSearchQuery, asker: Pick<Asker, 'run' | 'latest'>): Promise<FnSearchPage> {
    const text = query.text?.trim() ?? '';
    if (text === '' || query.order === 'name' || query.names !== undefined || page.items.length === 0) return page;
    const purpose: SearchPurpose = { text, latest: asker.latest };
    // the fn hits and the context hits are judged at once (each kind's own model call); recorded fn first, then context
    const outcomes = await mapConcurrent(['fn', 'context'] as const, async (item) => {
      const hits = page.items.filter((hit) => hit.item === item);
      if (hits.length === 0) return undefined;
      const setting = (await this.setting(item)).value;
      if (setting.by === 'none') return undefined;
      return { hits, outcome: await this.#judge(item, setting, purpose, hits, asker.run) };
    });
    const dropped = new Set<FnSearchHit>();
    const filtered: SearchFiltered[] = [];
    for (const judged of outcomes) {
      if (judged === undefined) continue;
      for (const hit of judged.hits) if (judged.outcome.kept !== undefined && !judged.outcome.kept.has(hit)) dropped.add(hit);
      filtered.push(judged.outcome.filtered);
    }
    if (filtered.length === 0) return page;
    return { ...page, items: page.items.filter((hit) => !dropped.has(hit)), filtered: [...(page.filtered ?? []), ...filtered] };
  }

  /** One item kind's hits judged: the kept ones (none when the model failed, so all stay) and the record. */
  async #judge(item: SearchItemKind, setting: Judging, purpose: SearchPurpose, hits: readonly FnSearchHit[], run: RunId | undefined): Promise<{ kept?: ReadonlySet<FnSearchHit>; filtered: SearchFiltered }> {
    const calls: ModelCallId[] = [];
    const site = { purpose: SEARCH_DECISION_PURPOSES[item], ...(run === undefined ? {} : { run }) };
    const signal = AbortSignal.timeout(this.#deps.tuning.HARNESS_SEARCH_DECISION_TIMEOUT);
    const withCalls = (): Pick<SearchFiltered, 'calls'> => (calls.length === 0 ? {} : { calls: [...calls] });
    try {
      const judged = setting.by === 'llm'
        ? await this.#byLlm(setting, purpose, hits, site, signal, calls)
        : await this.#byDecision(setting, purpose, hits, site, signal, calls);
      const dropped = hits.filter((hit) => !judged.kept.has(hit)).map((hit) => {
        const note = judged.notes.get(hit);
        return { name: hit.name, ...(note === undefined ? {} : { note }) };
      });
      const action = actionOf(setting);
      this.#deps.log.info('fns.search-decision.filtered', { item, by: setting.by, action, hits: hits.length, dropped: dropped.length, calls });
      return { kept: judged.kept, filtered: { item, by: setting.by, dropped, ...withCalls(), ...(action === 'load' ? { action } : {}) } };
    } catch (error) {
      this.#deps.log.warn('fns.search-decision.failed', { item, by: setting.by, error: messageOf(error) });
      return { filtered: { item, by: setting.by, dropped: [], ...withCalls(), failed: `The ${setting.by === 'llm' ? 'LLM' : 'decision model'} failed (${messageOf(error)}), so every hit was kept.` } };
    }
  }

  /** The decision model's verdicts: one yes/no question per hit, kept at or over the decide role's threshold. */
  async #byDecision(setting: Extract<SearchDecision, { by: 'decision' }>, purpose: SearchPurpose, hits: readonly FnSearchHit[], site: { purpose: string; run?: RunId }, signal: AbortSignal, calls: ModelCallId[]): Promise<Judged> {
    const model = await this.#decisionModel(setting.model);
    const decided = await this.#deps.decider().ask({ input: purposeText(purpose), questions: hitQuestions(hits), model, site, signal });
    calls.push(...decided.calls);
    const kept = new Set<FnSearchHit>();
    const notes = new Map<FnSearchHit, string>();
    hits.forEach((hit, i) => {
      const probability = yesProbability(decided.answers[questionKey(i)]);
      if (probability >= model.threshold) kept.add(hit); else notes.set(hit, likelihood(probability));
    });
    return { kept, notes };
  }

  /** The LLM's picks among the hits, as JSON with its reasons. */
  async #byLlm(setting: Extract<SearchDecision, { by: 'llm' }>, purpose: SearchPurpose, hits: readonly FnSearchHit[], site: { purpose: string; run?: RunId }, signal: AbortSignal, calls: ModelCallId[]): Promise<Judged> {
    const answer = await this.#deps.llm().chat(
      { request: { messages: filterPrompt(purpose, hits), temperature: 0, responseFormat: FilterAnswer.responseFormat }, ...(await pinnedModel(this.#deps.store(), setting.model)), priority: 'interactive' },
      site, signal,
    );
    calls.push(answer.call);
    const parsed = FilterAnswer.read(answer.value);
    if (parsed === undefined) throw new Error('the model did not answer the JSON asked for');
    const byName = (name: string): FnSearchHit | undefined => hits.find((hit) => hit.name === name);
    const kept = new Set(parsed.keep.flatMap((item) => { const hit = byName(item.name); return hit === undefined ? [] : [hit]; }));
    const notes = new Map<FnSearchHit, string | undefined>();
    for (const item of parsed.dropped ?? []) { const hit = byName(item.name); if (hit !== undefined && !kept.has(hit)) notes.set(hit, item.reason); }
    return { kept, notes };
  }

  /** The decision model to ask, or a failure saying why there is none. */
  async #decisionModel(choice: Extract<SearchDecision, { by: 'decision' }>['model']): Promise<DecisionModel> {
    const model = await this.#deps.decider().model(choice);
    if ('problem' in model) throw new Error(model.problem);
    return model;
  }
}

/** The most names a search looks up exactly (the query's `names` cap). */
const EXACT_MAX = 100;

/** Quotes, brackets and sentence marks around a word of a search's text. */
const WORD_EDGES = /^[`'"([{<]+|[`'")\]}>,;:.?!]+$/g;

/**
 * The names a search asks for exactly: its `names`, then its whole text and each word of it that is an item's name
 * (`web/guide`), or a fn's name as a model spells it (`web__read`). Words that only look like names are harmless: a
 * name no item has finds nothing.
 */
export function exactNames(query: Pick<FnSearchQuery, 'text' | 'names'>): QualifiedName[] {
  const text = query.text?.trim() ?? '';
  const words = [text, ...text.split(/\s+/)].map((word) => word.replace(WORD_EDGES, '')).filter((word) => word.includes('/') || word.includes('__'));
  const named = words.flatMap((word): QualifiedName[] => {
    const name = QualifiedName.safeParse(word);
    if (name.success && !/\s/.test(word)) return [name.data];
    const fn = fnOfModelNameByRule(word);
    return fn === undefined ? [] : [fn];
  });
  return [...new Set([...(query.names ?? []), ...named])].slice(0, EXACT_MAX);
}

/** What a page says of names asked for that no item the asker may see has. */
export function missingNote(names: readonly string[], items: FnSearchQuery['items']): string {
  const what = items?.length === 1 ? (items[0] === 'fn' ? 'fn' : 'context item') : 'fn or context item';
  return `No ${what} you may use here is named ${names.join(', ')}: check the spelling, or search by what it does or is about instead.`;
}

/**
 * The database search with the admin's search decisions on its pages: the one search every caller asks. The items it
 * names exactly come first on the first page, marked `exact`, looked up by name alone (so no other filter, ranking
 * or decision drops them), and taken out of what the decision says it dropped.
 */
export class DecidedFnSearch implements FnSearch {
  readonly #inner: FnSearch;
  readonly #decisions: Pick<SearchDecisions, 'filter'>;

  constructor(inner: FnSearch, decisions: Pick<SearchDecisions, 'filter'>) {
    this.#inner = inner;
    this.#decisions = decisions;
  }

  async search(query: FnSearchQuery, asker: Asker): Promise<FnSearchPage> {
    const page = await this.#decisions.filter(await this.#inner.search(query, asker), query, asker);
    const names = exactNames(query);
    if (names.length === 0 || (query.offset ?? 0) > 0) return page;
    // by name alone: the asker's reach still holds (what it may see, a session's systems, an MCP's rules)
    const lookup: FnSearchQuery = {
      names, order: 'name', limit: names.length,
      ...(query.items === undefined ? {} : { items: query.items }),
      ...(query.off === undefined ? {} : { off: query.off }),
      ...(query.available === undefined ? {} : { available: query.available }),
    };
    const exact = (await this.#inner.search(lookup, asker)).items.map((hit): FnSearchHit => ({ ...hit, exact: true }));
    const key = (hit: Pick<FnSearchHit, 'item' | 'name'>): string => `${hit.item}:${hit.name}`;
    const found = new Set(exact.map(key));
    const named = new Set<string>(exact.map((hit) => hit.name));
    const filtered = page.filtered?.map((f) => ({ ...f, dropped: f.dropped.filter((d) => !named.has(d.name)) }));
    const missing = (query.names ?? []).filter((name) => !named.has(name));
    return {
      ...page,
      items: [...exact, ...page.items.filter((hit) => !found.has(key(hit)))],
      ...(filtered === undefined ? {} : { filtered }),
      ...(missing.length === 0 ? {} : { missing: { names: missing, note: missingNote(missing, query.items) } }),
    };
  }
}
