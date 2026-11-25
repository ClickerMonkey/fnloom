/**
 * What a sent message is offered (fns and context), and the record of what it was not and why. The admin's suggestions
 * setting (`hubOptions['suggestDecision']`, `SuggestDecision`) says who picks:
 *
 * - `none`: no model picks: the candidates most similar in meaning at or over `HARNESS_SUGGEST_THRESHOLD` are
 *   suggested, best first, up to `HARNESS_SUGGESTIONS` (the record says `by: 'score'`).
 * - `decision`: a decision model (its own choice, else the `decide` role's) answers one yes/no question per candidate
 *   scoring at least the floor; those at or over the decide role's threshold are picked, most likely first, up to the
 *   cap. The questions go through the models module's `Decider`, split by the model's `maxQuestions`.
 * - `llm`: a chat model reads the candidates and the last few user messages and answers with its picks as JSON.
 *
 * Every model call is a `ModelCall` (purpose `suggestions`) linked in the record. If it fails or answers nonsense, the
 * score decides (the best at or over `HARNESS_SUGGEST_THRESHOLD`, up to the cap) and the items it left out say so
 * (`failed`). A score is a candidate's similarity of meaning to the
 * message (`index/suggester.ts`), never its rank, so the threshold and the floor tell a fit from noise.
 *
 * A model chooser's action (`SuggestDecision.action`) is `suggest` (the default) or `load`: with `load` the record says
 * so (`action: 'load'`), each pick is marked to load (`load: 'loaded'`), and the decision carries `load` with the
 * picks' reasons, so the enricher loads them for the turn (`chat/enrich.ts`), sizing context to the prompt's room and
 * marking what didn't fit or can't be used `budget` or `blocked`. When the model fails, the score's picks are only
 * suggested.
 *
 * The same chooser answers a system's `decide` (reuse something it has, or make something new), unless it is `none`.
 */
import {
  actionOf, messageOf, StoredSuggestDecision, SUGGEST_DECISION_DEFAULT, yesProbability, type ActorId, type DecideAnswer, type DecideRequest, type DecisionAnswer,
  type DecisionQuestions, type LlmMessage, type ModelCallId, type ModelChoice, type RoleModel, type SessionId, type SkipReason, type Suggestion,
  type SuggestDecision, type SuggestDecisionView, type SuggestionOutcome, type SuggestionRecord,
} from '@harness/core';
import { a } from '@aeye/schema';
import type { AccessScope } from '../access/index.ts';
import { mayOffer } from '../access/hits.ts';
import type { DecisionModel } from '../models/index.ts';
import { pinnedModel } from '../models/pinned.ts';
import { structuredAnswer } from '../models/structured.ts';
import type { ChatDeps } from './deps.ts';
import type { DecidedSuggestions, SuggestionDecider } from './index.ts';
import { plainText } from './turns.ts';

/** The purpose the suggestion choosers' calls are recorded under. */
export const SUGGESTION_PURPOSE = 'suggestions';

/** A setting with a model that picks (an LLM or a decision model). */
type ModelPicking = Exclude<SuggestDecision, { by: 'none' }>;

/** A pick or a decline, by the candidate's key, with why. */
const DecisionItem = a.object({
  name: a.string().describe('The candidate\'s key (kind:name), exactly as given.'),
  reason: a.string().optional().describe('Why, in under 12 words.'),
});

/** What the LLM answers: the names it picks and those it declines, each with a reason. */
const DecisionAnswerJson = structuredAnswer(a.object({
  picks: a.array(DecisionItem).describe('The candidates that clearly help with the latest message.'),
  declined: a.array(DecisionItem).optional().describe('Candidates left out, when there is a reason worth keeping.'),
}));

/** One candidate left out. */
function skipped(item: Pick<Suggestion, 'kind' | 'name' | 'score'>, reason: SkipReason, note?: string): SuggestionOutcome {
  return { used: false, kind: item.kind, name: item.name, score: item.score, reason, ...(note === undefined ? {} : { note }) };
}

/** One candidate used. */
function used(item: Suggestion, note?: string): SuggestionOutcome {
  return { used: true, kind: item.kind, name: item.name, score: item.score, ...(note === undefined ? {} : { note }) };
}

/** What a model chose among the pool: the picks and the declines, each with its note, and the first call it made. */
interface ModelChoices {
  readonly picked: ReadonlyMap<Suggestion, string | undefined>;
  readonly declined: ReadonlyMap<Suggestion, string | undefined>;
  readonly call?: ModelCallId | undefined;
}

/** A probability in words, for a decision model's note: "82% likely". */
export function likelihood(probability: number): string {
  return `${Math.round(probability * 100)}% likely`;
}

/** The suggestions decider over the index's candidates, the hub options table, the LLM gateway and the decider. */
export class HubSuggestions implements SuggestionDecider {
  readonly #deps: Pick<ChatDeps, 'store' | 'suggest' | 'llm' | 'decider' | 'settings' | 'log' | 'clock' | 'access' | 'catalog'>;

  constructor(deps: Pick<ChatDeps, 'store' | 'suggest' | 'llm' | 'decider' | 'settings' | 'log' | 'clock' | 'access' | 'catalog'>) {
    this.#deps = deps;
  }

  /** The names among candidates a person may be offered (`mayOffer`). */
  async #seen(access: AccessScope, items: ReadonlyArray<Pick<Suggestion, 'kind' | 'name'>>, session: SessionId): Promise<ReadonlySet<string>> {
    const seen = new Set<string>();
    for (const item of items) {
      if (await mayOffer(access, (n) => this.#deps.catalog.context(n), item, session)) seen.add(item.name);
    }
    return seen;
  }

  async setting(): Promise<SuggestDecisionView> {
    const row = await this.#deps.store.table('hubOptions').get('suggestDecision');
    // a setting stored before the chooser became one choice reads as today's (`StoredSuggestDecision`)
    return row?.key !== 'suggestDecision' ? { value: SUGGEST_DECISION_DEFAULT } : { value: StoredSuggestDecision.parse(row.value), setBy: row.setBy, updatedAt: row.updatedAt };
  }

  async set(value: SuggestDecision, by: ActorId): Promise<SuggestDecisionView> {
    const row = { key: 'suggestDecision' as const, value, setBy: by, updatedAt: this.#deps.clock() };
    await this.#deps.store.table('hubOptions').put(row);
    this.#deps.log.info('suggestions.decision.set', { by: value.by, setBy: by });
    return { value: row.value, setBy: row.setBy, updatedAt: row.updatedAt };
  }

  async decide(input: { session: SessionId; text: string; actor: ActorId }): Promise<DecidedSuggestions> {
    return this.#withBrought(await this.#decide(input), input.actor);
  }

  /**
   * A suggested context brings its fns (`ContextDecl.fns`): each the person may use and that isn't suggested already
   * is suggested with it, at the context's score, and recorded with `broughtBy`.
   */
  async #withBrought(decided: DecidedSuggestions, actor: ActorId): Promise<DecidedSuggestions> {
    const contexts = decided.suggestions.filter((s) => s.kind === 'context');
    if (contexts.length === 0) { return decided; }
    const have = new Set<string>(decided.suggestions.filter((s) => s.kind === 'fn').map((s) => s.name));
    const access = await this.#deps.access.scope(actor);
    const brought: Suggestion[] = [];
    const outcomes: SuggestionOutcome[] = [];
    for (const context of contexts) {
      const record = await this.#deps.catalog.context(context.name);
      for (const name of record?.decl.fns ?? []) {
        if (have.has(name)) { continue; }
        const fn = await this.#deps.catalog.fn(name);
        if (fn === undefined || fn.disabled || !access.seesFn(fn) || !access.mayUse(fn)) { continue; }
        have.add(name);
        brought.push({ kind: 'fn', name, description: fn.decl.description, score: context.score });
        outcomes.push({ used: true, kind: 'fn', name, score: context.score, broughtBy: context.name, ...(decided.load === undefined ? {} : { load: 'loaded' as const }) });
      }
    }
    if (brought.length === 0) { return decided; }
    const record = decided.record === undefined ? undefined : { ...decided.record, items: [...decided.record.items, ...outcomes] };
    return { ...decided, suggestions: [...decided.suggestions, ...brought], ...(record === undefined ? {} : { record }) };
  }

  async #decide(input: { session: SessionId; text: string; actor: ActorId }): Promise<DecidedSuggestions> {
    const limit = this.#deps.settings.model.HARNESS_SUGGESTIONS;
    if (limit === 0 || input.text.trim() === '') { return { suggestions: [] }; }
    const setting = (await this.setting()).value;
    const found = await this.#deps.suggest.consider({ session: input.session, text: input.text, pool: (setting.by === 'none' ? limit : Math.max(setting.candidates, limit)) * 2 });
    // what the person may not see is never suggested, nor named among what was left out
    const access = await this.#deps.access.scope(input.actor);
    const sees = await this.#seen(access, [...found.offered, ...found.hidden], input.session);
    const hidden = found.hidden.filter((item) => sees.has(item.name)).map((item) => skipped(item, 'rule'));
    const offered = found.offered.filter((item) => sees.has(item.name)).sort((x, y) => y.score - x.score);
    return setting.by === 'none' ? this.#byScore(offered, hidden, limit) : this.#byModel(input, setting, offered, hidden);
  }

  /** No model picks: the best at or over the threshold, up to the cap; the rest say why they were left out. */
  #byScore(offered: readonly Suggestion[], hidden: readonly SuggestionOutcome[], limit: number): DecidedSuggestions {
    const threshold = this.#deps.settings.chat.HARNESS_SUGGEST_THRESHOLD;
    const chosen = offered.filter((item) => item.score >= threshold).slice(0, limit);
    const items = offered.map((item) => (chosen.includes(item) ? used(item) : skipped(item, item.score < threshold ? 'below-threshold' : 'top-n')));
    return finish(chosen, { by: 'score', threshold, items: [...items, ...hidden] });
  }

  /** A model picks among the candidates over its floor; on failure the score decides. */
  async #byModel(input: { session: SessionId; text: string }, setting: ModelPicking, offered: readonly Suggestion[], hidden: readonly SuggestionOutcome[]): Promise<DecidedSuggestions> {
    const pool = offered.filter((item) => item.score >= setting.floor).slice(0, setting.candidates);
    const rest = offered.filter((item) => !pool.includes(item)).map((item) => skipped(item, item.score < setting.floor ? 'below-threshold' : 'top-n'));
    const base = { by: 'decision' as const, threshold: setting.floor };
    if (pool.length === 0) { return finish([], { ...base, items: [...rest, ...hidden] }); }
    const calls: ModelCallId[] = [];
    try {
      const messages = [...await this.#recent(input.session, setting.messages - 1), input.text];
      const signal = AbortSignal.timeout(this.#deps.settings.chat.HARNESS_SUGGEST_DECISION_TIMEOUT);
      const choices = setting.by === 'llm'
        ? await this.#llmChoices(messages, pool, setting, signal, calls)
        : await this.#decisionChoices(messages, pool, setting, signal, calls);
      const chosen = pool.filter((item) => choices.picked.has(item));
      // with the action `load` each pick is meant to load; the enricher says what became of it when the message is sent
      const loads = actionOf(setting) === 'load';
      const items = pool.map((item) => (choices.picked.has(item) ? { ...used(item, choices.picked.get(item)), ...(loads ? { load: 'loaded' as const } : {}) } : skipped(item, 'declined', choices.declined.get(item))));
      this.#deps.log.info('suggestions.decided', { session: input.session, by: setting.by, action: actionOf(setting), candidates: pool.length, picked: chosen.length, calls });
      const decided = finish(chosen, { ...base, ...(calls.length === 0 ? {} : { calls }), ...(loads ? { action: 'load' as const } : {}), items: [...items, ...rest, ...hidden] });
      if (!loads) { return decided; }
      const why = new Map(chosen.flatMap((item) => { const note = choices.picked.get(item); return note === undefined ? [] : [[candidateKey(item), note] as const]; }));
      return { ...decided, load: { by: setting.by, why } };
    } catch (error) {
      this.#deps.log.warn('suggestions.decision.failed', { session: input.session, by: setting.by, error: messageOf(error) });
      // the score decides: the best at or over the threshold, up to the cap
      const threshold = this.#deps.settings.chat.HARNESS_SUGGEST_THRESHOLD;
      const chosen = pool.filter((item) => item.score >= threshold).slice(0, setting.cap);
      const items = pool.map((item) => (chosen.includes(item) ? used(item) : skipped(item, 'failed')));
      return finish(chosen, { ...base, ...(calls.length === 0 ? {} : { calls }), items: [...items, ...rest, ...hidden] });
    }
  }

  /** The LLM's picks among the pool, as JSON with its reasons. */
  async #llmChoices(messages: readonly string[], pool: readonly Suggestion[], setting: Extract<SuggestDecision, { by: 'llm' }>, signal: AbortSignal, calls: ModelCallId[]): Promise<ModelChoices> {
    const answer = await this.#deps.llm.chat(
      { request: { messages: prompt(messages, pool, setting.cap), temperature: 0, responseFormat: DecisionAnswerJson.responseFormat }, ...(await this.#model(setting.model)), priority: 'interactive' },
      { purpose: SUGGESTION_PURPOSE }, signal,
    );
    calls.push(answer.call);
    const parsed = DecisionAnswerJson.read(answer.value);
    if (parsed === undefined) { throw new Error('the model did not answer the JSON asked for'); }
    const declined = new Map<Suggestion, string | undefined>();
    for (const item of parsed.declined ?? []) { const found = candidateFor(pool, item.name); if (found !== undefined) { declined.set(found, item.reason); } }
    const picked = new Map<Suggestion, string | undefined>();
    for (const pick of parsed.picks) { const found = candidateFor(pool, pick.name); if (found !== undefined && picked.size < setting.cap) { picked.set(found, pick.reason); } }
    return { picked, declined };
  }

  /**
   * The decision model's picks: one yes/no question per candidate ("does it help with the latest message?"); those at
   * or over the decide role's threshold, most likely first, up to the cap. Each note says how likely it was.
   */
  async #decisionChoices(messages: readonly string[], pool: readonly Suggestion[], setting: Extract<SuggestDecision, { by: 'decision' }>, signal: AbortSignal, calls: ModelCallId[]): Promise<ModelChoices> {
    const model = await this.#decisionModel(setting.model);
    const questions = suggestionQuestions(pool);
    const decided = await this.#deps.decider.ask({ input: conversationText(messages), questions, model, site: { purpose: SUGGESTION_PURPOSE }, signal });
    calls.push(...decided.calls);
    const ranked = rankedYes(pool, decided.answers, model.threshold);
    const picked = new Map(ranked.slice(0, setting.cap).map(({ item, probability }) => [item, likelihood(probability)] as const));
    const declined = new Map(pool.flatMap((item, i) => (picked.has(item) ? [] : [[item, likelihood(yesProbability(decided.answers[questionKey(i)]))] as const])));
    return { picked, declined };
  }

  async forSystem(request: DecideRequest): Promise<DecideAnswer> {
    const setting = (await this.setting()).value;
    if (setting.by === 'none') { return { by: 'off' }; }
    const signal = AbortSignal.timeout(this.#deps.settings.chat.HARNESS_SUGGEST_DECISION_TIMEOUT);
    try {
      const decided = setting.by === 'llm' ? await this.#systemByLlm(request, setting.model, signal) : await this.#systemByDecision(request, setting.model, signal);
      this.#deps.log.info('decide.decided', { run: request.run, by: setting.by, candidates: request.candidates.length, picked: decided.picked.length, call: decided.call });
      return decided;
    } catch (error) {
      this.#deps.log.warn('decide.failed', { run: request.run, by: setting.by, error: messageOf(error) });
      return { by: 'failed', message: messageOf(error) };
    }
  }

  /** A system's question to the LLM: its picks among the candidates, as JSON. */
  async #systemByLlm(request: DecideRequest, model: RoleModel, signal: AbortSignal): Promise<Extract<DecideAnswer, { by: 'decision' }>> {
    const answer = await this.#deps.llm.chat(
      { request: { messages: systemDecisionPrompt(request), temperature: 0, responseFormat: SystemDecisionAnswer.responseFormat }, ...(await this.#model(model)), priority: 'interactive' },
      { purpose: SYSTEM_DECISION_PURPOSE, run: request.run }, signal,
    );
    return { ...systemDecision(request, answer.value), call: answer.call };
  }

  /**
   * A system's question to the decision model: one yes/no question per candidate ("does it fully answer what is
   * wanted?"); those at or over the decide role's threshold, most likely first, up to \`max\`.
   */
  async #systemByDecision(request: DecideRequest, choice: RoleModel | undefined, signal: AbortSignal): Promise<Extract<DecideAnswer, { by: 'decision' }>> {
    const model = await this.#decisionModel(choice);
    const decided = await this.#deps.decider.ask({
      input: `Wanted: ${request.question}`, questions: systemQuestions(request), model, site: { purpose: SYSTEM_DECISION_PURPOSE, run: request.run }, signal,
    });
    const picked = rankedYes(request.candidates, decided.answers, model.threshold).slice(0, request.max).map(({ item, probability }) => ({ id: item.id, why: likelihood(probability) }));
    const call = decided.calls[0];
    return {
      by: 'decision', picked, ...(call === undefined ? {} : { call }),
      ...(picked.length > 0 ? {} : { note: `No candidate was at least ${likelihood(model.threshold)} to answer it.` }),
    };
  }

  /** The decision model to ask, or a failure saying why there is none. */
  async #decisionModel(choice: RoleModel | undefined): Promise<DecisionModel> {
    const model = await this.#deps.decider.model(choice);
    if ('problem' in model) { throw new Error(model.problem); }
    return model;
  }

  /** The LLM, and the kind of provider it is pinned to (the gateway's name for it), as the gateway takes them. */
  #model(setting: RoleModel): Promise<{ model?: ModelChoice; provider?: string }> {
    return pinnedModel(this.#deps.store, setting);
  }

  /** The session's last user messages before this one, oldest first, as plain text. */
  async #recent(session: SessionId, count: number): Promise<string[]> {
    if (count < 1) { return []; }
    const page = await this.#deps.store.table('messages').find({ where: { session, role: 'user' }, order: [['createdAt', 'desc']], limit: count });
    return page.items.map((message) => plainText(message.parts)).filter((text) => text.trim() !== '').reverse();
  }
}

/** The decision result: what is used, and the record (none when nothing was even a candidate). */
function finish(chosen: Suggestion[], record: SuggestionRecord): DecidedSuggestions {
  return record.items.length === 0 ? { suggestions: chosen } : { suggestions: chosen, record };
}

/** How a candidate is named to the LLM: its kind and name, so a fn and a context item of one name differ. */
export const candidateKey = (item: Pick<Suggestion, 'kind' | 'name'>): string => `${item.kind}:${item.name}`;

/** The candidate an answered name means: by its key, or by a bare name when exactly one candidate has it. */
export function candidateFor(pool: readonly Suggestion[], answered: string): Suggestion | undefined {
  const keyed = pool.find((item) => candidateKey(item) === answered);
  if (keyed !== undefined) { return keyed; }
  const named = pool.filter((item) => item.name === answered);
  return named.length === 1 ? named[0] : undefined;
}

/** The person's recent messages as one text, oldest first, the latest marked. */
export function conversationText(messages: readonly string[]): string {
  return messages.map((text, i) => `${i === messages.length - 1 ? 'Latest' : 'Earlier'}: ${text}`).join('\n');
}

/** The LLM's prompt: the person's recent messages, the candidates, and the JSON to answer with. */
export function prompt(messages: readonly string[], pool: readonly Suggestion[], cap: number): LlmMessage[] {
  const system = [
    'You choose which tools (fns) and context items to offer an assistant for the latest user message.',
    `Pick at most ${cap} that clearly help with what the user is asking now; pick none when none fit.`,
    'Name each candidate by its key (kind:name) exactly as given. For example, for a question about open tickets with a candidate fn:tickets/open, pick { "name": "fn:tickets/open", "reason": "Lists the open tickets." }.',
  ].join('\n');
  const candidates = pool.map((item) => `- ${candidateKey(item)} (score ${item.score.toFixed(2)}): ${item.description}`).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `User messages:\n${conversationText(messages)}\n\nCandidates:\n${candidates}` },
  ];
}

/** The decision question's name for the candidate at a position: short and safe for every decision model. */
const questionKey = (index: number): string => `c${index}`;

/** One yes/no question per suggestion candidate, by position. */
export function suggestionQuestions(pool: readonly Suggestion[]): DecisionQuestions {
  return Object.fromEntries(pool.map((item, i) => [questionKey(i), {
    type: 'predicate' as const,
    instructions: `Would offering this ${item.kind === 'fn' ? 'tool' : 'context item'} help the assistant answer the latest user message? ${item.name}: ${item.description}`,
  }]));
}

/** One yes/no question per candidate a system asks about, by position. */
export function systemQuestions(request: DecideRequest): DecisionQuestions {
  return Object.fromEntries(request.candidates.map((item, i) => [questionKey(i), {
    type: 'predicate' as const,
    instructions: `Does this existing item fully answer what is wanted, so it can be reused instead of made again? ${item.text}`,
  }]));
}

/** The items whose question was answered yes at or over the threshold, most likely first (ties keep their order). */
export function rankedYes<T>(items: readonly T[], answers: Readonly<Record<string, DecisionAnswer>>, threshold: number): Array<{ item: T; probability: number }> {
  return items.map((item, i) => ({ item, probability: yesProbability(answers[questionKey(i)]) }))
    .filter((entry) => entry.probability >= threshold)
    .sort((x, y) => y.probability - x.probability);
}

/** The purpose a system's decision calls are recorded under. */
export const SYSTEM_DECISION_PURPOSE = 'decide';

/** What the LLM answers a system: the ids it picks, best first, and why it picked none. */
const SystemDecisionAnswer = structuredAnswer(a.object({
  picked: a.array(a.object({
    id: a.string().describe('The candidate\'s id, exactly as given.'),
    why: a.string().optional().describe('Why it answers what is wanted, in under 15 words.'),
  })).describe('The candidates that fully answer what is wanted, best first; none when none does.'),
  note: a.string().optional().describe('When none is picked, why.'),
}));

/** The LLM's prompt for a system's question: the candidates by id with their scores, and the JSON to answer with. */
export function systemDecisionPrompt(request: DecideRequest): LlmMessage[] {
  const system = [
    'You decide whether something that already exists answers what is wanted, so it is reused instead of made again.',
    `Pick at most ${request.max} candidates that fully answer what is wanted, best first; pick none when none does, and say why in "note".`,
    'Use each candidate\'s id exactly as given.',
  ].join('\n');
  const candidates = request.candidates.map((item) => `- id ${JSON.stringify(item.id)} (score ${item.score.toFixed(2)}): ${item.text}`).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Wanted: ${request.question}\n\nCandidates:\n${candidates}` },
  ];
}

/** Read the LLM's answer to a system: only ids among the candidates, each once, at most `max`. */
export function systemDecision(request: DecideRequest, text: string): Extract<DecideAnswer, { by: 'decision' }> {
  const parsed = SystemDecisionAnswer.read(text);
  if (parsed === undefined) { throw new Error('the decision model did not answer the JSON asked for'); }
  const ids = new Set(request.candidates.map((item) => item.id));
  const picked: Array<{ id: string; why?: string }> = [];
  for (const pick of parsed.picked) {
    if (!ids.has(pick.id) || picked.some((p) => p.id === pick.id) || picked.length >= request.max) { continue; }
    picked.push(pick.why === undefined ? { id: pick.id } : { id: pick.id, why: pick.why });
  }
  return { by: 'decision', picked, ...(parsed.note === undefined || picked.length > 0 ? {} : { note: parsed.note }) };
}
