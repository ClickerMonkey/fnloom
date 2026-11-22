/**
 * The contextors. Each chooses what one prompt holds within `plan.flexible` tokens (the budget left after the fixed
 * part), and reports what it asked for, what it got and what it cut.
 *
 * - `plain`: build 1's prompt. The agent's and session's context in full, its and the session's fns at `signature`,
 *   and the whole transcript, except that what won't fit is left out (and reported) instead of letting the provider
 *   cut the front or refusing the turn: context and fns the message asks for first, then the agent's, then the
 *   session's loaded ones, each kept whole or left out; then the newest exchanges, the oldest left out.
 * - `suggest`: `plain` plus, with `autoInject`, the best-matching context put in full into the system prompt, up to a
 *   number of items and tokens. The suggestion blocks themselves are the enricher's.
 * - `graph`: a fresh prompt each message. A bounded pool (always-items, loaded items, the last selection, the index's
 *   hits for the message, one hop of their links) is scored, activation spreads over links, items travel with what
 *   they hard-link, and the greedy chooser picks the detail of each under the budget. History is rebuilt: the newest
 *   selected exchanges in a row are real messages, older selected ones are summaries in the system prompt.
 */
import { contextOff, Detail, modelFnName, QualifiedName, seesOrigin, type ContextRecord, type GraphContextor, type PlainContextor, type PoolUse, type SelectedItem, type SelectionReport, type SuggestContextor, type SuggestionOutcome } from '@harness/core';
import { allowsSystem, searchSystems } from '../chat/support.ts';
import type { Pool, PoolTokens } from './budget.ts';
import { choose, type Cut, type Level, type Unit } from './choose.ts';
import { contiguousTail, shortenResults, summarise, type Exchange } from './history.ts';
import type {
  ChosenContext, ChosenFn, Contextor, ContextorDeps, ContextorFactories, ContextorInput, DynamicAsk, ExchangeSummary, FnView, Selection,
} from './index.ts';
import { contextBlock, earlierBlock, listedContextElement, listedLine } from './render.ts';
import { broughtFns, sizedChoices, withImports } from './brought.ts';
import { baseScore, metricSettings, spread, wordShare, words, type Edge, type Signals } from './score.ts';
import { metricDefaults } from './env.ts';
import { forModel, usable } from './views.ts';

/** The text of a context item at a detail. Dynamic context not yet written by its system (`DynamicContext`) shows its summary at `full`. */
export function contextText(record: ContextRecord, detail: Detail): string {
  switch (detail) {
    case 'listed': return listedLine(record.name, record.decl.description);
    case 'signature': return record.decl.summary ?? record.decl.description;
    case 'full': return record.decl.content ?? record.decl.summary ?? record.decl.description;
  }
}

/** The details a context item has: `full` only when its content is known. */
export function contextDetails(record: ContextRecord): readonly Detail[] {
  return record.decl.content === undefined ? ['listed', 'signature'] : ['listed', 'signature', 'full'];
}

/** What a context item costs at a detail, as the prompt shows it. */
export function contextCost(record: ContextRecord, detail: Detail, input: Pick<ContextorInput, 'ctx'>): number {
  const text = detail === 'listed'
    ? `${listedContextElement(record).toString()}\n`
    : `${contextBlock({ name: record.name, title: record.decl.title, detail, text: contextText(record, detail), fns: { added: record.decl.fns }, ...(record.decl.choices === undefined ? {} : { choices: record.decl.choices }) })}\n\n`;
  return input.ctx.estimator.text(text);
}

/** Whether a person (in a session) may see a context item: switched on, a system the session uses, memory in scope. */
export function visible(record: ContextRecord, input: Pick<ContextorInput, 'session' | 'user' | 'access'>): boolean {
  if (contextOff(record) || (record.decl.weight ?? 1) <= 0 || !input.access.seesContext(record)) return false;
  if (input.session !== undefined && !allowsSystem(input.session, record.system)) return false;
  return seesOrigin(record.origin, { actor: input.user, session: input.session?.id });
}

/** The detail an item shows at when its unit asks for `detail`: the most it has, up to that. */
export function contextDetailAtMost(record: ContextRecord, detail: Detail): Detail {
  const wanted = Detail.options.indexOf(detail);
  return contextDetails(record).filter((d) => Detail.options.indexOf(d) <= wanted).at(-1) ?? 'listed';
}

/** Who a prompt's dynamic context item is written for: the session's person, with the args its `/command` gave now. */
export function dynamicAsk(input: Pick<ContextorInput, 'session' | 'user' | 'person' | 'commands'>, name: string): DynamicAsk {
  return { session: input.session?.id, actor: input.user, user: input.person, args: input.commands.get(name) };
}

/**
 * The context records of names a person may see, in order, each once, dynamic ones with their system's text. What the
 * agent's injected section shows is in the prompt already: never again (an import of it, a search hit for it).
 */
export async function contextsOf(deps: ContextorDeps, names: readonly string[], input: Pick<ContextorInput, 'session' | 'user' | 'person' | 'commands' | 'access' | 'injected'>): Promise<ContextRecord[]> {
  const records: ContextRecord[] = [];
  const injected = new Set<string>(input.injected ?? []);
  for (const name of unique(names)) {
    if (injected.has(name)) continue;
    const parsed = QualifiedName.safeParse(name);
    const record = parsed.success ? await deps.catalog.context(parsed.data) : undefined;
    if (record !== undefined && visible(record, input)) records.push(await deps.dynamic.resolve(record, dynamicAsk(input, record.name)));
  }
  return records;
}

/** The fn views of names the session may use, in order, each once. */
export async function viewsOf(deps: ContextorDeps, names: readonly string[], input: Pick<ContextorInput, 'session' | 'access'>): Promise<FnView[]> {
  const views: FnView[] = [];
  for (const name of unique(names)) {
    const parsed = QualifiedName.safeParse(name);
    const view = parsed.success ? await deps.views.view(parsed.data) : undefined;
    if (view !== undefined && usable(view.record, input.session, input.access)) views.push(view);
  }
  return views;
}

/** A selection's report, before the planner adds the request's estimate. */
function report(input: ContextorInput, type: SelectionReport['contextor'], parts: {
  context: readonly ChosenContext[]; fns: readonly ChosenFn[]; linear: number; earlier: readonly ExchangeSummary[]; pools: Record<Pool, PoolUse>; cut: readonly Cut[];
}): SelectionReport {
  const { plan } = input;
  return {
    contextor: type, mode: input.mode.type,
    context: parts.context.map((c) => ({ name: c.record.name, detail: c.detail, activation: round(c.activation) })),
    fns: parts.fns.map((f) => ({ name: f.view.record.name, detail: f.detail, activation: round(f.activation) })),
    linear: parts.linear, earlier: parts.earlier.map((e) => e.turn),
    budget: { window: plan.limits.contextWindow, output: plan.output, reasoning: plan.reasoning, margin: plan.margin, fixed: plan.fixed, pools: parts.pools, estimate: 0, cut: [...parts.cut] },
  };
}

/** The linear history that fits `room` tokens: the newest exchanges whole, then the newest shortened, oldest left out. */
function fitHistory(history: readonly Exchange[], room: number, input: ContextorInput, floorChars: number): { messages: ReturnType<typeof shortenResults>; kept: number; used: number; cut: Cut[] } {
  const cut: Cut[] = [];
  const kept: Exchange[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const exchange = history[i];
    if (exchange === undefined) break;
    const cost = input.ctx.estimator.messages(exchange.messages);
    if (used + cost > room) break;
    kept.unshift(exchange);
    used += cost;
  }
  let messages = kept.flatMap((e) => [...e.messages]);
  const left = history.length - kept.length;
  const newest = history.at(-1);
  if (kept.length === 0 && newest !== undefined) {
    const shortened = shortenResults(newest.messages, floorChars);
    const cost = input.ctx.estimator.messages(shortened);
    if (cost <= room) {
      messages = shortened;
      used = cost;
      cut.push({ what: `exchange ${newest.turn}`, why: 'its tool results were shortened to fit' });
      if (left > 1) cut.push({ what: `${left - 1} older exchanges`, why: 'left out to fit the model\'s window' });
      return { messages, kept: 1, used, cut };
    }
  }
  if (left > 0) cut.push({ what: `${left} older exchanges`, why: 'left out to fit the model\'s window' });
  return { messages, kept: kept.length, used, cut };
}

/** Items in the order a prompt shows them (the agent's, then the session's, then the message's), by name. */
function shownInOrder<T>(items: readonly T[], name: (item: T) => string, order: readonly string[]): T[] {
  const at = new Map(unique(order).map((n, i) => [n, i]));
  return [...items].sort((a, b) => (at.get(name(a)) ?? 0) - (at.get(name(b)) ?? 0));
}

/** The plain contextor: build 1's prompt, held to the budget. */
export class PlainContextorImpl implements Contextor {
  readonly type: 'plain' | 'suggest' = 'plain';
  protected readonly deps: ContextorDeps;

  constructor(_config: PlainContextor | SuggestContextor, deps: ContextorDeps) {
    this.deps = deps;
  }

  async select(input: ContextorInput): Promise<Selection> {
    const { always, loaded, asked, payload, ctx } = input;
    const detail = input.mode.loadDetail;
    // What the message asks for comes first, then what the agent always has, then what the session loaded; an item that
    // won't fit what is left is left out (and reported), so a session's loaded context never makes a prompt too large.
    const cut: Cut[] = [];
    let left = Math.max(0, input.plan.flexible);
    const fit = <T>(items: readonly T[], cost: (item: T) => number, name: (item: T) => string): T[] => items.filter((item) => {
      const tokens = cost(item);
      if (tokens <= left) { left -= tokens; return true; }
      cut.push({ what: name(item), why: 'left out to fit the model\'s window' });
      return false;
    });
    // every item comes with the context it imports, and the kept ones bring their fns (`broughtFns`)
    const [askedContext, alwaysContext, loadedContext] = await Promise.all([withImports(this.deps.catalog, asked.context), withImports(this.deps.catalog, always.context), withImports(this.deps.catalog, loaded.context)]);
    const contextOrder = [...alwaysContext, ...loadedContext, ...askedContext];
    const wanted = (await contextsOf(this.deps, [...askedContext, ...alwaysContext, ...loadedContext], input)).filter((r) => r.decl.content !== undefined);
    const records = shownInOrder(fit(wanted, (r) => contextCost(r, 'full', input), (r) => r.name), (r) => r.name, contextOrder);
    const context: ChosenContext[] = await Promise.all(records.map(async (record): Promise<ChosenContext> => ({
      record, detail: 'full', activation: 1, text: contextText(record, 'full'), choices: await sizedChoices(this.deps.catalog, record, (text) => ctx.estimator.text(text)),
    })));
    const brought = broughtFns(records);
    const wantedFns = (await viewsOf(this.deps, [...asked.fns, ...always.fns, ...brought, ...loaded.fns], input)).slice(0, payload.maxTools);
    const views = shownInOrder(fit(wantedFns, (v) => input.mode.cost(v, detail, ctx), (v) => v.record.name), (v) => v.record.name, [...always.fns, ...brought, ...loaded.fns, ...asked.fns]);
    const contextTokens = records.reduce((sum, r) => sum + contextCost(r, 'full', input), 0);
    const injected = await this.inject(input, context, left);
    const injectedTokens = injected.reduce((sum, c) => sum + contextCost(c.record, 'full', input), 0);
    left = Math.max(0, left - injectedTokens);
    // injected context brings its fns too, as far as they fit
    const shown = new Set<string>(views.map((v) => v.record.name));
    const injectedFns = broughtFns(injected.map((c) => c.record)).filter((name) => !shown.has(name));
    const extra = fit((await viewsOf(this.deps, injectedFns, input)).slice(0, Math.max(0, payload.maxTools - views.length)), (v) => input.mode.cost(v, detail, ctx), (v) => v.record.name);
    const fns: ChosenFn[] = [...views, ...extra].map((view) => ({ view, detail, activation: 1 }));
    const fnTokens = fns.reduce((sum, f) => sum + input.mode.cost(f.view, detail, ctx), 0);
    const history = fitHistory(input.history, left, input, this.deps.settings.HARNESS_FLOOR_RESULT_CHARS);
    const all = [...context, ...injected];
    const historyAsk = input.ctx.estimator.messages(input.history.flatMap((e) => [...e.messages]));
    const wantedTokens = wanted.reduce((sum, r) => sum + contextCost(r, 'full', input), 0);
    const pools = {
      history: { asked: historyAsk, got: history.used },
      context: { asked: wantedTokens + injectedTokens, got: contextTokens + injectedTokens },
      fns: { asked: wantedFns.reduce((sum, v) => sum + input.mode.cost(v, detail, ctx), 0), got: fnTokens },
    };
    return {
      context: all, fns, linear: [...history.messages, ...input.current], earlier: [],
      report: report(input, this.type, { context: all, fns, linear: history.kept, earlier: [], pools, cut: [...cut, ...history.cut] }),
    };
  }

  /** Context put in on top of what the agent and session have (none for plain). */
  protected inject(_input: ContextorInput, _have: readonly ChosenContext[], _room: number): Promise<ChosenContext[]> {
    return Promise.resolve([]);
  }
}

/** The suggest contextor: plain, plus the best-matching context's content when `autoInject` is set. */
export class SuggestContextorImpl extends PlainContextorImpl {
  override readonly type = 'suggest';
  readonly #config: SuggestContextor;

  constructor(config: SuggestContextor, deps: ContextorDeps) {
    super(config, deps);
    this.#config = config;
  }

  protected override async inject(input: ContextorInput, have: readonly ChosenContext[], room: number): Promise<ChosenContext[]> {
    const auto = this.#config.autoInject;
    if (auto === undefined || auto.items === 0 || input.query.trim() === '') return [];
    const hits = await safeSearch(this.deps, input, ['context'], this.#config.topN);
    const taken = new Set<string>(have.map((c) => c.record.name));
    const records = await contextsOf(this.deps, (await withImports(this.deps.catalog, hits.map((h) => h.key))).filter((key) => !taken.has(key)), input);
    const out: ChosenContext[] = [];
    let left = Math.min(auto.tokens, Math.max(0, room));
    for (const record of records) {
      if (out.length >= auto.items || record.decl.content === undefined || record.decl.suggest === 'user' || record.decl.suggest === 'none') continue;
      const cost = contextCost(record, 'full', input);
      if (cost > left) continue;
      left -= cost;
      out.push({ record, detail: 'full', activation: hits.find((h) => h.key === record.name)?.similarity ?? 0, text: contextText(record, 'full'), choices: await sizedChoices(this.deps.catalog, record, (text) => input.ctx.estimator.text(text)) });
    }
    return out;
  }
}

/** Index hits for the message, or none when the index can't answer (logged). */
async function safeSearch(deps: ContextorDeps, input: Pick<ContextorInput, 'query' | 'session'>, kinds: ReadonlyArray<'context' | 'fn'>, limit: number) {
  if (input.query.trim() === '' || limit <= 0) return [];
  try {
    return await deps.search.search({ text: input.query, kinds, limit, ...(input.session === undefined ? {} : { systems: searchSystems(input.session) }) });
  } catch (error) {
    deps.log.warn('contextor.search-failed', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** A candidate of the graph contextor. */
type Candidate =
  | { readonly kind: 'context'; readonly name: QualifiedName; readonly record: ContextRecord }
  | { readonly kind: 'fn'; readonly name: QualifiedName; readonly view: FnView };

/** The graph contextor. */
export class GraphContextorImpl implements Contextor {
  readonly type = 'graph';
  readonly #config: GraphContextor;
  readonly #deps: ContextorDeps;

  constructor(config: GraphContextor, deps: ContextorDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  async select(input: ContextorInput): Promise<Selection> {
    const { settings } = this.#deps;
    const config = this.#config;
    const K = settings.HARNESS_GRAPH_POOL;
    const now = input.history.length;
    const cached = input.cached?.contextor === 'graph' && config.evaluate === 'perMessage' ? input.cached : undefined;
    const last = cached === undefined ? lastSelection(input) : new Map([...cached.context, ...cached.fns].map((item) => [item.name, item]));

    // 1. the pool
    const hits = await safeSearch(this.#deps, input, ['context', 'fn'], K);
    // the embedding signal is a hit's similarity of meaning, never its rank: a hit words alone found has no such signal
    const hitScore = new Map(hits.flatMap((hit) => (hit.similarity === undefined ? [] : [[hit.key, hit.similarity] as const])));
    const seeds = unique([
      ...input.always.context, ...input.always.fns, ...input.loaded.context, ...input.loaded.fns, ...input.asked.context, ...input.asked.fns, ...last.keys(), ...hits.map((h) => h.key),
    ]);
    const neighbours = await this.#deps.graph.neighbours(seeds.flatMap((s) => { const p = QualifiedName.safeParse(s); return p.success ? [p.data] : []; }), 1, K);
    const found = await this.#candidates([...seeds, ...neighbours.keys()], input);
    // a context's imports and brought fns are always candidates with it, so its unit is whole however it was found
    const pooled = new Set<string>(found.map((c) => c.name));
    const contexts = found.flatMap((c) => (c.kind === 'context' ? [c.record] : []));
    const closure = [...await withImports(this.#deps.catalog, contexts.map((r) => r.name)), ...broughtFns(contexts)].filter((name) => !pooled.has(name));
    const extra = closure.length === 0 ? [] : await this.#candidates(closure, input);
    const more = extra.flatMap((c) => (c.kind === 'context' ? [c.record] : []));
    const brought = broughtFns(more).filter((name) => !pooled.has(name) && !extra.some((c) => c.name === name));
    const candidates = [...found, ...extra, ...(brought.length === 0 ? [] : await this.#candidates(brought, input))];
    const byName = new Map<string, Candidate>(candidates.map((c) => [c.name, c]));

    // 2. base scores
    const settingsByMetric = metricSettings(metricDefaults(settings), config.metrics);
    const query = words(input.query);
    const lastUse = lastUses(input.history, candidates);
    const base = new Map<string, number>();
    for (const candidate of candidates) {
      const describe = candidate.kind === 'context'
        ? `${candidate.name} ${candidate.record.decl.description} ${candidate.record.decl.summary ?? ''}`
        : `${candidate.name} ${candidate.view.record.decl.description}`;
      const used = lastUse.get(candidate.name);
      const signals: Signals = {
        ...(hitScore.has(candidate.name) ? { embedding: hitScore.get(candidate.name) } : {}),
        ...(query.size === 0 ? {} : { words: wordShare(query, describe) }),
        ...(used === undefined ? {} : { turnsAgo: now - Math.max(...used), used: used.filter((turn) => turn >= now - settings.HARNESS_USED_WINDOW).length / settings.HARNESS_USED_WINDOW }),
        ...(candidate.kind === 'context' && candidate.record.origin?.type === 'memory' ? { age: (this.#deps.clock() - candidate.record.updatedAt) / 86_400_000 } : {}),
        ...(last.size === 0 ? {} : { selectedBefore: last.has(candidate.name) ? 1 : 0 }),
      };
      base.set(candidate.name, baseScore(signals, weightOf(candidate, settings.HARNESS_MEMORY_WEIGHT), settingsByMetric));
    }

    // 3. spread over links between candidates
    const edges: Edge[] = [];
    for (const candidate of candidates) {
      for (const link of await this.#deps.graph.links(candidate.name)) {
        const to = link.to.kind === 'resource' ? undefined : link.to.name;
        if (to !== undefined && byName.has(to)) edges.push({ from: candidate.name, to, weight: link.weight });
      }
    }
    const activation = spread(base, edges, config.spread.damping, config.spread.hops);
    const act = (name: string): number => activation.get(name) ?? 0;

    // 4. units, and what is forced
    const forcedLevel = new Map<string, Detail>();
    const force = (name: string, detail: Detail): void => {
      const known = forcedLevel.get(name);
      if (known === undefined || Detail.options.indexOf(detail) > Detail.options.indexOf(known)) forcedLevel.set(name, detail);
    };
    for (const name of input.always.context) force(name, 'full');
    for (const name of input.always.fns) force(name, input.mode.alwaysDetail);
    for (const name of input.asked.context) force(name, 'full');
    for (const name of input.asked.fns) force(name, 'signature');
    const fresh = (name: string): boolean => {
      const uses = lastUse.get(name);
      return uses === undefined || now - Math.max(...uses) <= settings.HARNESS_LOADED_TURNS;
    };
    for (const name of input.loaded.context) if (fresh(name)) force(name, 'full');
    for (const name of input.loaded.fns) if (fresh(name)) force(name, input.mode.loadDetail);
    if (cached !== undefined) for (const item of [...cached.context, ...cached.fns]) force(item.name, item.detail);

    const units: Unit[] = [];
    const members = new Map<string, ReadonlyArray<{ readonly candidate: Candidate }>>();
    for (const candidate of candidates) {
      const levels = this.#levels(candidate, byName, input, members);
      const forced = forcedLevel.get(candidate.name);
      const lastItem = last.get(candidate.name);
      units.push({
        key: candidate.name, pool: candidate.kind === 'context' ? 'context' : 'fns', activation: act(candidate.name), levels,
        forced: forced === undefined ? undefined : levelIndex(levels, forced), last: lastItem === undefined ? undefined : levelIndex(levels, lastItem.detail),
      });
    }

    // history: each earlier exchange as a summary or whole; the floor forced whole
    const summaries = input.history.map((exchange) => this.#summary(exchange, input));
    input.history.forEach((exchange, i) => {
      const summary = summaries[i];
      if (summary === undefined) return;
      const levels: Level[] = [
        { detail: 'signature', cost: input.ctx.estimator.text(`${earlierBlock(summary)}\n\n`) },
        { detail: 'full', cost: input.ctx.estimator.messages(exchange.messages) },
      ];
      const signals: Signals = { turnsAgo: now - exchange.turn, ...(query.size === 0 ? {} : { words: wordShare(query, `${exchange.user} ${exchange.answer}`) }) };
      const floor = i >= input.history.length - config.floorExchanges;
      units.push({ key: exchangeKey(exchange), pool: 'history', activation: baseScore(signals, 1, settingsByMetric), levels, forced: floor ? 1 : undefined });
    });

    // 5. choose
    const choice = choose(units, config.shares, input.plan.flexible, config.threshold);
    const detailOf = new Map<string, Detail>();
    const raise = (name: string, detail: Detail): void => {
      const known = detailOf.get(name);
      if (known === undefined || Detail.options.indexOf(detail) > Detail.options.indexOf(known)) detailOf.set(name, detail);
    };
    for (const unit of units) {
      const level = choice.chosen.get(unit.key);
      const detail = level === undefined ? undefined : unit.levels[level]?.detail;
      if (detail === undefined || unit.pool === 'history') continue;
      raise(unit.key, detail);
      if (detail === 'listed') continue;
      for (const { candidate: member } of members.get(unit.key) ?? []) raise(member.name, member.kind === 'fn' ? 'signature' : contextDetailAtMost(member.record, detail));
    }
    const context: ChosenContext[] = [];
    const fns: ChosenFn[] = [];
    for (const [name, detail] of detailOf) {
      const candidate = byName.get(name);
      if (candidate?.kind === 'context') {
        const choices = detail === 'listed' ? [] : await sizedChoices(this.#deps.catalog, candidate.record, (text) => input.ctx.estimator.text(text));
        context.push({ record: candidate.record, detail, activation: act(name), text: contextText(candidate.record, detail), choices });
      }
      if (candidate?.kind === 'fn') fns.push({ view: candidate.view, detail, activation: act(name) });
    }
    context.sort((a, b) => b.activation - a.activation || a.record.name.localeCompare(b.record.name));
    fns.sort((a, b) => b.activation - a.activation || a.view.record.name.localeCompare(b.view.record.name));

    // 6. history: the newest whole exchanges in a row are linear, the other chosen ones summaries
    const whole = input.history.map((exchange) => {
      const level = choice.chosen.get(exchangeKey(exchange));
      return level !== undefined && units.find((u) => u.key === exchangeKey(exchange))?.levels[level]?.detail === 'full';
    });
    const tail = contiguousTail(whole);
    const linearFrom = input.history.length - tail;
    const earlier: ExchangeSummary[] = [];
    input.history.forEach((exchange, i) => {
      const summary = summaries[i];
      if (i < linearFrom && choice.chosen.has(exchangeKey(exchange)) && summary !== undefined) earlier.push(summary);
    });
    const linear = [...input.history.slice(linearFrom).flatMap((e) => [...e.messages]), ...input.current];
    const pools = poolUses(choice.asked, choice.used);
    this.#deps.log.debug('contextor.selected', {
      context: context.length, fns: fns.length, linear: tail, earlier: earlier.length, pool: candidates.length, used: choice.total, flexible: input.plan.flexible,
    });
    // what this cycle considered, for the user message's suggestions: each item shown, and each candidate left out and why
    const items: SuggestionOutcome[] = [
      ...context.map((c): SuggestionOutcome => ({ used: true, kind: 'context', name: c.record.name, score: c.activation })),
      ...fns.map((f): SuggestionOutcome => ({ used: true, kind: 'fn', name: f.view.record.name, score: f.activation })),
      ...candidates.filter((c) => !detailOf.has(c.name)).map((c): SuggestionOutcome => ({
        used: false, kind: c.kind, name: c.name, score: act(c.name), reason: forcedLevel.has(c.name) || act(c.name) >= config.threshold ? 'budget' : 'below-threshold',
      })),
    ];
    return {
      context, fns, linear, earlier, report: report(input, 'graph', { context, fns, linear: tail, earlier, pools, cut: choice.cut }),
      ...(items.length === 0 ? {} : { considered: { by: 'graph', threshold: config.threshold, items } }),
    };
  }

  /** The candidates among names: context a person may see and fns the session may use, offered to the model. */
  async #candidates(names: readonly string[], input: ContextorInput): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const forced = new Set<string>([...input.always.context, ...input.always.fns, ...input.loaded.context, ...input.loaded.fns, ...input.asked.context, ...input.asked.fns]);
    // the injected section's items are in the prompt already: never a candidate, so never chosen or counted again
    const injected = new Set<string>(input.injected ?? []);
    for (const name of unique(names)) {
      const parsed = QualifiedName.safeParse(name);
      if (!parsed.success || parsed.data === input.agent.name || injected.has(name)) continue;
      const record = await this.#deps.catalog.context(parsed.data);
      if (record !== undefined) {
        if (!visible(record, input) || !(forced.has(name) || forModel(record.decl.suggest))) continue;
        // what the agent, the session or the message pulls in is shown whole, so a dynamic item gets its system's text
        out.push({ kind: 'context', name: parsed.data, record: forced.has(name) ? await this.#deps.dynamic.resolve(record, dynamicAsk(input, name)) : record });
        continue;
      }
      const view = await this.#deps.views.view(parsed.data);
      if (view !== undefined && usable(view.record, input.session, input.access) && (forced.has(name) || forModel(view.record.decl.visibility))) {
        out.push({ kind: 'fn', name: parsed.data, view });
      }
    }
    return out;
  }

  /** A candidate's levels, the whole unit's cost at each (a context with the context it imports and the fns it brings). */
  #levels(candidate: Candidate, byName: ReadonlyMap<string, Candidate>, input: ContextorInput, members: Map<string, ReadonlyArray<{ readonly candidate: Candidate }>>): Level[] {
    if (candidate.kind === 'fn') return Detail.options.map((detail) => ({ detail, cost: input.mode.cost(candidate.view, detail, input.ctx) }));
    const unit = hardClosure(candidate.record, byName);
    members.set(candidate.name, unit.map((m) => ({ candidate: m })));
    return contextDetails(candidate.record).map((detail) => ({
      detail,
      cost: contextCost(candidate.record, detail, input) + (detail === 'listed' ? 0 : unit.reduce((sum, member) => sum + (member.kind === 'fn'
        ? input.mode.cost(member.view, 'signature', input.ctx)
        : contextCost(member.record, contextDetailAtMost(member.record, detail), input)), 0)),
    }));
  }

  /** An exchange's summary, held to `HARNESS_EARLIER_TOKENS` at the model's characters per token. */
  #summary(exchange: Exchange, input: Pick<ContextorInput, 'ctx'>): ExchangeSummary {
    const { limits, ratio } = input.ctx.estimator;
    return summarise(exchange, Math.floor((this.#deps.settings.HARNESS_EARLIER_TOKENS * limits.charsPerToken) / ratio));
  }
}

/** What a candidate weighs: its declared weight, else `memory` for a memory, else 1. */
function weightOf(candidate: Candidate, memory: number): number {
  if (candidate.kind === 'fn') return 1;
  return candidate.record.decl.weight ?? (candidate.record.origin?.type === 'memory' ? memory : 1);
}

/** The context a record imports (recursively, cycles cut) and the fns it and they bring, among the candidates. */
export function hardClosure(record: ContextRecord, byName: ReadonlyMap<string, Candidate>): Candidate[] {
  const seen = new Set<string>([record.name]);
  const out: Candidate[] = [];
  const visit = (r: ContextRecord): void => {
    for (const name of [...r.decl.imports, ...r.decl.fns]) {
      if (seen.has(name)) continue;
      seen.add(name);
      const member = byName.get(name);
      if (member === undefined) continue;
      out.push(member);
      if (member.kind === 'context') visit(member.record);
    }
  };
  visit(record);
  return out;
}

/** The turns (exchange indexes) each candidate was used or brought up in. */
function lastUses(history: readonly Exchange[], candidates: readonly Candidate[]): Map<string, number[]> {
  const uses = new Map<string, number[]>();
  const aliases = new Map<string, string>();
  for (const candidate of candidates) { aliases.set(candidate.name, candidate.name); if (candidate.kind === 'fn') aliases.set(modelFnName(candidate.name), candidate.name); }
  for (const exchange of history) {
    for (const name of [...exchange.used, ...exchange.mentioned]) {
      const known = aliases.get(name);
      if (known === undefined) continue;
      const list = uses.get(known) ?? [];
      if (!list.includes(exchange.turn)) list.push(exchange.turn);
      uses.set(known, list);
    }
  }
  return uses;
}

/** The last cycle's selection in the session, by name. */
function lastSelection(input: Pick<ContextorInput, 'session'>): Map<string, SelectedItem> {
  return new Map((input.session?.selection?.items ?? []).map((item) => [item.name, item]));
}

/** The index of a detail among levels, or the highest level below it. */
function levelIndex(levels: readonly Level[], detail: Detail): number {
  const wanted = Detail.options.indexOf(detail);
  let best = 0;
  levels.forEach((level, i) => { if (Detail.options.indexOf(level.detail) <= wanted) best = i; });
  return best;
}

/** The unit key of an exchange. */
function exchangeKey(exchange: Pick<Exchange, 'turn'>): string {
  return `exchange:${exchange.turn}`;
}

/** Items in order, each once. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Each pool's ask and what it got. */
function poolUses(asked: PoolTokens, got: PoolTokens): Record<Pool, PoolUse> {
  return { history: { asked: asked.history, got: got.history }, context: { asked: asked.context, got: got.context }, fns: { asked: asked.fns, got: got.fns } };
}

/** Every contextor, by config type. */
export const CONTEXTORS: ContextorFactories = {
  plain: (config, deps) => new PlainContextorImpl(config, deps),
  suggest: (config, deps) => new SuggestContextorImpl(config, deps),
  graph: (config, deps) => new GraphContextorImpl(config, deps),
};

