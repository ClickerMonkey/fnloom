/**
 * What a sent message is offered (fns and context), and the record of what it was not and why. By default the score
 * decides: the best candidates at or over `HARNESS_SUGGEST_THRESHOLD`, up to `HARNESS_SUGGESTIONS`. With the admin's
 * decision model on (`hubOptions['suggestDecision']`), the candidates scoring at least its floor and the last few
 * user messages go to that model, which picks; its call is a `ModelCall` (purpose `suggestions`) linked in the
 * record. If it fails or answers nonsense, the score decides and the items it left out say so (`failed`).
 */
import {
  messageOf, SuggestDecision, type ActorId, type DecideAnswer, type DecideRequest, type LlmMessage, type ModelCallId, type ModelChoice, type SessionId, type SkipReason, type Suggestion, type SuggestDecisionView,
  type SuggestionOutcome, type SuggestionRecord,
} from '@harness/core';
import { z } from 'zod';
import type { AccessScope } from '../access/index.ts';
import { mayOffer } from '../access/hits.ts';
import type { ChatDeps } from './deps.ts';
import type { DecidedSuggestions, SuggestionDecider } from './index.ts';
import { plainText } from './turns.ts';

/** The purpose the decision model's calls are recorded under. */
export const SUGGESTION_PURPOSE = 'suggestions';

/** What the decision model answers: the names it picks and those it declines, each with a reason. */
const DecisionAnswer = z.object({
  picks: z.array(z.object({ name: z.string(), reason: z.string().optional() })),
  declined: z.array(z.object({ name: z.string(), reason: z.string().optional() })).optional(),
});

/** The JSON object in a model's answer (fenced or bare), or undefined. */
export function answerJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) { return undefined; }
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value;
  } catch {
    return undefined;
  }
}

/** One candidate left out. */
function skipped(item: Pick<Suggestion, 'kind' | 'name' | 'score'>, reason: SkipReason, note?: string): SuggestionOutcome {
  return { used: false, kind: item.kind, name: item.name, score: item.score, reason, ...(note === undefined ? {} : { note }) };
}

/** One candidate used. */
function used(item: Suggestion, note?: string): SuggestionOutcome {
  return { used: true, kind: item.kind, name: item.name, score: item.score, ...(note === undefined ? {} : { note }) };
}

/** The suggestions decider over the index's candidates, the hub options table and the LLM gateway. */
export class HubSuggestions implements SuggestionDecider {
  readonly #deps: Pick<ChatDeps, 'store' | 'suggest' | 'llm' | 'settings' | 'log' | 'clock' | 'access' | 'catalog'>;

  constructor(deps: Pick<ChatDeps, 'store' | 'suggest' | 'llm' | 'settings' | 'log' | 'clock' | 'access' | 'catalog'>) {
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
    return row === undefined ? { value: SuggestDecision.parse({}) } : { value: row.value, setBy: row.setBy, updatedAt: row.updatedAt };
  }

  async set(value: SuggestDecision, by: ActorId): Promise<SuggestDecisionView> {
    const row = { key: 'suggestDecision' as const, value, setBy: by, updatedAt: this.#deps.clock() };
    await this.#deps.store.table('hubOptions').put(row);
    this.#deps.log.info('suggestions.decision.set', { enabled: value.enabled, by });
    return { value: row.value, setBy: row.setBy, updatedAt: row.updatedAt };
  }

  async decide(input: { session: SessionId; text: string; actor: ActorId }): Promise<DecidedSuggestions> {
    const limit = this.#deps.settings.model.HARNESS_SUGGESTIONS;
    if (limit === 0 || input.text.trim() === '') { return { suggestions: [] }; }
    const decision = (await this.setting()).value;
    const on = decision.enabled && decision.model !== undefined;
    const found = await this.#deps.suggest.consider({ session: input.session, text: input.text, pool: (on ? Math.max(decision.candidates, limit) : limit) * 2 });
    // what the person may not see is never suggested, nor named among what was left out
    const access = await this.#deps.access.scope(input.actor);
    const sees = await this.#seen(access, [...found.offered, ...found.hidden], input.session);
    const hidden = found.hidden.filter((item) => sees.has(item.name)).map((item) => skipped(item, 'rule'));
    const offered = found.offered.filter((item) => sees.has(item.name)).sort((a, b) => b.score - a.score);
    if (!on) { return this.#byScore(offered, limit, hidden); }
    return this.#byModel(input, decision, offered, hidden);
  }

  /** The score decides: the best at or over the threshold, up to the count. */
  #byScore(offered: readonly Suggestion[], limit: number, hidden: readonly SuggestionOutcome[]): DecidedSuggestions {
    const threshold = this.#deps.settings.chat.HARNESS_SUGGEST_THRESHOLD;
    const chosen = offered.filter((item) => item.score >= threshold).slice(0, limit);
    const items = offered.map((item) => (chosen.includes(item) ? used(item) : skipped(item, item.score < threshold ? 'below-threshold' : 'top-n')));
    return finish(chosen, { by: 'score', threshold, items: [...items, ...hidden] });
  }

  /** The decision model picks among the candidates over its floor; on failure the score decides. */
  async #byModel(input: { session: SessionId; text: string }, decision: SuggestDecision, offered: readonly Suggestion[], hidden: readonly SuggestionOutcome[]): Promise<DecidedSuggestions> {
    const pool = offered.filter((item) => item.score >= decision.floor).slice(0, decision.candidates);
    const rest = offered.filter((item) => !pool.includes(item)).map((item) => skipped(item, item.score < decision.floor ? 'below-threshold' : 'top-n'));
    const base = { by: 'decision' as const, threshold: decision.floor };
    if (pool.length === 0) { return finish([], { ...base, items: [...rest, ...hidden] }); }
    let call: ModelCallId | undefined;
    try {
      const recent = await this.#recent(input.session, decision.messages - 1);
      const answer = await this.#deps.llm.chat(
        { request: { messages: prompt([...recent, input.text], pool, decision.cap), temperature: 0 }, ...(await this.#model(decision)), priority: 'interactive' },
        { purpose: SUGGESTION_PURPOSE }, AbortSignal.timeout(this.#deps.settings.chat.HARNESS_SUGGEST_DECISION_TIMEOUT),
      );
      call = answer.call;
      const parsed = DecisionAnswer.safeParse(answerJson(answer.value));
      if (!parsed.success) { throw new Error('the decision model did not answer the JSON asked for'); }
      const reasons = new Map<Suggestion, string | undefined>();
      for (const declined of parsed.data.declined ?? []) { const item = candidateFor(pool, declined.name); if (item !== undefined) { reasons.set(item, declined.reason); } }
      const picked = new Map<Suggestion, string | undefined>();
      for (const pick of parsed.data.picks) { const item = candidateFor(pool, pick.name); if (item !== undefined && picked.size < decision.cap) { picked.set(item, pick.reason); } }
      const chosen = pool.filter((item) => picked.has(item));
      const items = pool.map((item) => (picked.has(item) ? used(item, picked.get(item)) : skipped(item, 'declined', reasons.get(item))));
      this.#deps.log.info('suggestions.decided', { session: input.session, candidates: pool.length, picked: chosen.length, call });
      return finish(chosen, { ...base, call, items: [...items, ...rest, ...hidden] });
    } catch (error) {
      this.#deps.log.warn('suggestions.decision.failed', { session: input.session, error: messageOf(error) });
      const chosen = pool.slice(0, decision.cap);
      const items = pool.map((item) => (chosen.includes(item) ? used(item) : skipped(item, 'failed')));
      return finish(chosen, { ...base, ...(call === undefined ? {} : { call }), items: [...items, ...rest, ...hidden] });
    }
  }

  async forSystem(request: DecideRequest): Promise<DecideAnswer> {
    const decision = (await this.setting()).value;
    if (!decision.enabled || decision.model === undefined) { return { by: 'off' }; }
    try {
      const answer = await this.#deps.llm.chat(
        { request: { messages: systemDecisionPrompt(request), temperature: 0 }, ...(await this.#model(decision)), priority: 'interactive' },
        { purpose: SYSTEM_DECISION_PURPOSE, run: request.run }, AbortSignal.timeout(this.#deps.settings.chat.HARNESS_SUGGEST_DECISION_TIMEOUT),
      );
      const decided = systemDecision(request, answer.value);
      this.#deps.log.info('decide.decided', { run: request.run, candidates: request.candidates.length, picked: decided.picked.length, call: answer.call });
      return decided;
    } catch (error) {
      this.#deps.log.warn('decide.failed', { run: request.run, error: messageOf(error) });
      return { by: 'failed', message: messageOf(error) };
    }
  }

  /** The decision model, and the kind of provider it is pinned to (the gateway's name for it), as the gateway takes them. */
  async #model(decision: SuggestDecision): Promise<{ model?: ModelChoice; provider?: string }> {
    if (decision.model === undefined) { return {}; }
    const pinned = decision.model.provider === undefined ? undefined : (await this.#deps.store.table('providers').get(decision.model.provider))?.config.provider;
    return { model: decision.model.model, ...(pinned === undefined ? {} : { provider: pinned }) };
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


/** How a candidate is named to the decision model: its kind and name, so a fn and a context item of one name differ. */
export const candidateKey = (item: Pick<Suggestion, 'kind' | 'name'>): string => `${item.kind}:${item.name}`;

/** The candidate an answered name means: by its key, or by a bare name when exactly one candidate has it. */
export function candidateFor(pool: readonly Suggestion[], answered: string): Suggestion | undefined {
  const keyed = pool.find((item) => candidateKey(item) === answered);
  if (keyed !== undefined) { return keyed; }
  const named = pool.filter((item) => item.name === answered);
  return named.length === 1 ? named[0] : undefined;
}

/** The decision model's prompt: the person's recent messages, the candidates, and the JSON to answer with. */
export function prompt(messages: readonly string[], pool: readonly Suggestion[], cap: number): LlmMessage[] {
  const system = [
    'You choose which tools (fns) and context items to offer an assistant for the latest user message.',
    `Pick at most ${cap} that clearly help with what the user is asking now; pick none when none fit.`,
    'Answer with JSON only: {"picks":[{"name":"...","reason":"..."}],"declined":[{"name":"...","reason":"..."}]}. Use the key of each candidate (kind:name) exactly as given; keep each reason under 12 words.',
  ].join('\n');
  const recent = messages.map((text, i) => `${i === messages.length - 1 ? 'Latest' : 'Earlier'}: ${text}`).join('\n');
  const candidates = pool.map((item) => `- ${candidateKey(item)} (score ${item.score.toFixed(2)}): ${item.description}`).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `User messages:\n${recent}\n\nCandidates:\n${candidates}` },
  ];
}

/** The purpose a system's decision calls are recorded under. */
export const SYSTEM_DECISION_PURPOSE = 'decide';

/** What the decision model answers a system: the ids it picks, best first, and why it picked none. */
const SystemDecisionAnswer = z.object({
  picked: z.array(z.object({ id: z.string(), why: z.string().optional() })),
  note: z.string().optional(),
});

/** The decision model's prompt for a system's question: the candidates by id with their scores, and the JSON to answer with. */
export function systemDecisionPrompt(request: DecideRequest): LlmMessage[] {
  const system = [
    'You decide whether something that already exists answers what is wanted, so it is reused instead of made again.',
    `Pick at most ${request.max} candidates that fully answer what is wanted, best first; pick none when none does, and say why in "note".`,
    'Answer with JSON only: {"picked":[{"id":"...","why":"..."}],"note":"..."}. Use each candidate\'s id exactly as given; keep each reason under 15 words.',
  ].join('\n');
  const candidates = request.candidates.map((item) => `- id ${JSON.stringify(item.id)} (score ${item.score.toFixed(2)}): ${item.text}`).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Wanted: ${request.question}\n\nCandidates:\n${candidates}` },
  ];
}

/** Read the decision model's answer to a system: only ids among the candidates, each once, at most `max`. */
export function systemDecision(request: DecideRequest, text: string): Extract<DecideAnswer, { by: 'decision' }> {
  const parsed = SystemDecisionAnswer.safeParse(answerJson(text));
  if (!parsed.success) { throw new Error('the decision model did not answer the JSON asked for'); }
  const ids = new Set(request.candidates.map((item) => item.id));
  const picked: Array<{ id: string; why?: string }> = [];
  for (const pick of parsed.data.picked) {
    if (!ids.has(pick.id) || picked.some((p) => p.id === pick.id) || picked.length >= request.max) { continue; }
    picked.push(pick.why === undefined ? { id: pick.id } : { id: pick.id, why: pick.why });
  }
  return { by: 'decision', picked, ...(parsed.data.note === undefined || picked.length > 0 ? {} : { note: parsed.data.note }) };
}
