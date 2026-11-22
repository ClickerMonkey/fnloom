/**
 * The hub's own fns that span modules: finding and loading fns and context for a session's agent (index search,
 * the catalog, the session), searching resources, and asking a person (a handler call they answer in the chat).
 * `registerHubFns` implements them on execution's `HubFns` against the hub contract's refs, so args and results are
 * typed and checked by the contract's gin types. Services are read when a fn runs, never while registering. Every one
 * keeps to what the run's person may see and use (their `AccessScope`): search hits, loads and results alike.
 */
import { ContextCrawlArgs, contextOff, effectCovered, effectsLine, FnExamplesQuery, FnRouting, FnSearchArgs, QualifiedName, qualify, splitName, SystemName, type FnRefusal, type ContextCrawlResult, type ContextRecord, type CrawledContext, type LoadContextResult, type LoadFnsResult, type SearchItemKind, type ActorId, type FnDecl, type FnExample, type Json, type IndexedKind, type RegistryEffect, type Run, type Session, type SessionId } from '@harness/core';
import { hub, parseValue, SAVE_FN_TAKEN, wireType } from '@harness/sdk';
import type { AccessService } from '../access/index.ts';
import type { FnFactsService, FnsServices } from '../fns/index.ts';
import { latestUserText } from '../fns/decided.ts';
import { fnError, RunRefused } from '../execution/errors.ts';
import { InvalidArgs } from '../execution/executors.ts';
import type { Catalog } from '../catalog/index.ts';
import type { SessionService } from '../chat/index.ts';
import type { Search } from '../index/index.ts';
import type { HubStore } from '../store/index.ts';
import type { AccessScope } from '../access/index.ts';
import { keepSeen } from '../access/hits.ts';
import { seesContextNamed } from '../access/scope.ts';
import { allowsSystem, searchSystems } from '../chat/support.ts';
import type { HubFnCtx, HubFns } from '../execution/executors.ts';
import type { HandlerRelay } from '../execution/handlers.ts';
import { parseSectionIndexKey } from '../index/indexer.ts';
import { broughtFns, withImports } from '../contextor/brought.ts';
import type { FnScope } from '../contextor/fns.ts';
import type { FnView, FnViewSource } from '../contextor/index.ts';
import { crawledContextCards, loadedContextCards, loadedFnsCards } from '../contextor/render.ts';
import { ContextCrawler } from '../contextor/crawl.ts';
import type { Decider } from '../models/index.ts';
import { fnRefusal, readsAsMissing, refusalOf, unavailableBlock } from '../contextor/views.ts';
import { itemVersionCount } from '../catalog/versions.ts';

/** How many results a search returns when the agent doesn't say. */
const DEFAULT_LIMIT = 10;
/** The characters of a section shown as its preview. */
const PREVIEW = 280;

/** An example as the catalog keeps it: the parts it has (gin reads an absent optional field as undefined). */
function keptExample(example: { readonly args: Json; readonly result?: Json | undefined; readonly note?: string | undefined }): FnExample {
  return { args: example.args, ...(example.result === undefined ? {} : { result: example.result }), ...(example.note === undefined ? {} : { note: example.note }) };
}

/** What the hub fns read, each looked up when a fn runs. */
export interface HubFnDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn' | 'fns' | 'availability' | 'context' | 'type' | 'declare' | 'kind'>;
  readonly search: () => Search;
  /** Where a session's loaded fns and context are kept. */
  readonly sessions: () => Pick<SessionService, 'load'>;
  /** The relay a question to a person goes through. */
  readonly handlers: () => Pick<HandlerRelay, 'askPerson'>;
  /** What a person may see and use now. */
  readonly access: (actor: ActorId) => Promise<AccessScope>;
  /** Who owns and sees each fn (a saved fn is its person's). */
  readonly sharing: () => Pick<AccessService, 'sharing' | 'own'>;
  /** Fns search and examples (build 5). */
  readonly fns: () => Pick<FnsServices, 'search' | 'examples'>;
  /** Fn cards as the prompt shows them, for what a load answers the model. */
  readonly views: () => Pick<FnViewSource, 'view'>;
  /** What fns declare they change in the hub (build 6), so a change a run's fn did not declare is refused. */
  readonly facts: () => Pick<FnFactsService, 'registry'>;
  /** Plan item 7: the hub's decisions (the `decide` role's model), for `hub/context_crawl`. */
  readonly decider: () => Pick<Decider, 'model' | 'ask'>;
  /** The scope of the hub MCP a run's caller is, so `fns_search` keeps to it (none: no MCP). */
  readonly mcpScope?: (caller: ActorId) => Promise<Pick<FnScope, 'fns' | 'context'> | undefined>;
}

/** The error code of a registry change the calling run's fn did not declare (`FnEffects.registry`). */
export const UNDECLARED_CHANGE = 'undeclared-change';

/**
 * Refuse a change to the hub's registry that the fn of the run asking for it did not declare: its own effects or, worked
 * out deeply, those of what it uses (`FnFacts.registry`). Declaring `hub/save_fn` as a dep declares its effects.
 */
async function checkDeclared(deps: HubFnDeps, caller: Pick<Run, 'fn'>, change: RegistryEffect): Promise<void> {
  const declared = (await deps.facts().registry([caller.fn])).get(caller.fn) ?? [];
  if (effectCovered(declared, change)) return;
  const said = effectsLine(declared) ?? 'nothing';
  throw new RunRefused(fnError('caller', `${caller.fn} does not declare that it ${change.action}s ${change.thing}${change.kind === undefined ? '' : ` (${change.kind})`}; it declares: ${said} Add it to the fn's effects (registry).`, UNDECLARED_CHANGE));
}

/** The session a run belongs to and what its person may see. */
interface Asker {
  readonly session: Session;
  readonly access: AccessScope;
}

/** The session a run belongs to, refused when it has none (these fns only make sense in a chat), and its person's scope. */
async function askerOf(deps: HubFnDeps, ctx: HubFnCtx): Promise<Asker> {
  const id: SessionId | undefined = ctx.request.run.session;
  const [session, access] = await Promise.all([
    id === undefined ? undefined : deps.store().table('sessions').get(id),
    deps.access(ctx.request.run.user.id),
  ]);
  if (session === undefined) { throw new Error('this fn only works inside a chat session'); }
  return { session, access };
}

/** Index hits of one kind for a session's systems, only those its person may see. */
async function hits(deps: HubFnDeps, { session, access }: Asker, kind: IndexedKind, query: string, limit: number | undefined) {
  return deps.search().search({
    text: query, kinds: [kind], limit: limit ?? DEFAULT_LIMIT, systems: searchSystems(session),
    keep: keepSeen(access, { context: (name) => deps.catalog().context(name), type: (name) => deps.catalog().type(name) }, session.id),
  });
}

/** The cards of some fns, as the prompt shows them (a fn gone meanwhile has none). */
async function viewsOf(deps: Pick<HubFnDeps, 'views'>, names: readonly QualifiedName[]): Promise<FnView[]> {
  return (await Promise.all(names.map((name) => deps.views().view(name)))).flatMap((view) => (view === undefined ? [] : [view]));
}

/** Names the agent gave, split into well-formed qualified names and the rest. */
function names(given: readonly string[]): { valid: QualifiedName[]; invalid: string[] } {
  const valid: QualifiedName[] = [];
  const invalid: string[] = [];
  for (const name of given) {
    const parsed = QualifiedName.safeParse(name);
    if (parsed.success) { valid.push(parsed.data); } else { invalid.push(name); }
  }
  return { valid, invalid };
}

/** The error code of a crawl refused because no decision model can be used now. */
export const NO_DECISION_MODEL = 'no-decision-model';

/** What a crawl's decide calls are recorded as (`ModelSite.purpose`), on the crawl's run. */
export const CONTEXT_CRAWL_PURPOSE = 'context_crawl';

/** Whether the asker may load a context item by name now: switched on, of a system the session uses, and visible to them. */
async function mayLoad(deps: Pick<HubFnDeps, 'catalog'>, { session, access }: Asker, record: ContextRecord): Promise<boolean> {
  return !contextOff(record) && allowsSystem(session, record.system) && seesContextNamed(access, (name) => deps.catalog().context(name), record.name, session.id);
}

/**
 * The context names an agent gave that it may load (`name: description`, as a listed line or a choice reads, means
 * the name), and the rest refused with the closest names it knows.
 */
async function askedContext(deps: HubFnDeps, asker: Asker, ctx: HubFnCtx, given: readonly string[]): Promise<{ asked: QualifiedName[]; refused: LoadContextResult['refused'] }> {
  const refused: LoadContextResult['refused'] = [];
  const asked: QualifiedName[] = [];
  for (const line of given) {
    const name = QualifiedName.safeParse(line.split(/:\s/, 1)[0]?.trim() ?? line);
    const record = name.success ? await deps.catalog().context(name.data) : undefined;
    if (record !== undefined && await mayLoad(deps, asker, record)) { asked.push(record.name); continue; }
    refused.push({ context: line, reason: name.success ? 'no context you can load has that name' : 'not a qualified name (system/name)', closest: await closestContext(deps, asker, ctx, line) });
  }
  return { asked, refused };
}

/**
 * Load context into the asker's session as `hub/load_context` does: each name with what it imports (a switched-off or
 * unseen item left out), and the fns they bring into its tools; a brought fn that can't be added is reported with what
 * blocks it, one that reads as missing (unseen, not for the model) left out.
 */
async function loadIntoSession(deps: HubFnDeps, asker: Asker, names: readonly QualifiedName[]): Promise<{ loaded: QualifiedName[]; records: ContextRecord[]; brought: QualifiedName[]; fnsRefused: FnRefusal[] }> {
  const { session, access } = asker;
  const lookup = (name: QualifiedName) => deps.catalog().context(name);
  const loaded: QualifiedName[] = [];
  const records: ContextRecord[] = [];
  for (const name of await withImports(deps.catalog(), names)) {
    const parsed = QualifiedName.safeParse(name);
    const record = parsed.success ? await lookup(parsed.data) : undefined;
    if (parsed.success && record !== undefined && !contextOff(record) && allowsSystem(session, splitName(parsed.data).system) && await seesContextNamed(access, lookup, parsed.data, session.id)) {
      loaded.push(parsed.data);
      records.push(record);
    }
  }
  const brought: QualifiedName[] = [];
  const fnsRefused: FnRefusal[] = [];
  for (const name of broughtFns(records)) {
    const blocked = fnRefusal(await deps.catalog().fn(name), session, access);
    if (blocked === undefined) { brought.push(name); } else if (!readsAsMissing(blocked)) { fnsRefused.push(refusalOf(name, blocked)); }
  }
  if (loaded.length > 0) {
    // read again: a load_fns in the same step may have changed the tools meanwhile
    const now = (await deps.store().table('sessions').get(session.id)) ?? session;
    await deps.sessions().load(session.id, {
      context: [...new Set([...now.context, ...loaded])], ...(brought.length === 0 ? {} : { tools: [...new Set([...now.tools, ...brought])] }),
    });
  }
  return { loaded, records, brought, fnsRefused };
}

/** Register the hub fns. */
export function registerHubFns(fns: HubFns, deps: HubFnDeps): void {

  fns.register(hub.fns.load_fns, async (args, ctx): Promise<LoadFnsResult> => {
    const { session, access } = await askerOf(deps, ctx);
    const { valid, invalid } = names(args.fns);
    const refused: FnRefusal[] = invalid.map((fn) => ({ fn, code: 'not-a-name', reason: 'not a qualified fn name (system/name)' }));
    const loaded: QualifiedName[] = [];
    // the same check as hub/load and the static run: usable here and meant for the model
    for (const name of valid) {
      const blocked = fnRefusal(await deps.catalog().fn(name), session, access);
      if (blocked === undefined) { loaded.push(name); } else { refused.push(refusalOf(name, blocked)); }
    }
    if (loaded.length > 0) { await deps.sessions().load(session.id, { tools: [...new Set([...session.tools, ...loaded])] }); }
    return { loaded, refused, cards: loadedFnsCards(await viewsOf(deps, loaded), refused) };
  });

  fns.register(hub.fns.drop_fns, async (args, ctx) => {
    const { session } = await askerOf(deps, ctx);
    const drop = new Set<string>(args.fns);
    const dropped = session.tools.filter((fn) => drop.has(fn));
    if (dropped.length > 0) { await deps.sessions().load(session.id, { tools: session.tools.filter((fn) => !drop.has(fn)) }); }
    return { dropped };
  });

  fns.register(hub.fns.load_context, async (args, ctx): Promise<LoadContextResult> => {
    const asker = await askerOf(deps, ctx);
    const { asked, refused } = await askedContext(deps, asker, ctx, args.context);
    const { loaded, records, brought, fnsRefused } = await loadIntoSession(deps, asker, asked);
    return { loaded, fns: brought, fnsRefused, refused, cards: loadedContextCards(records, { added: brought, blocked: fnsRefused }, refused) };
  });

  fns.register(hub.fns.context_crawl, async (args, ctx): Promise<ContextCrawlResult> => {
    const asker = await askerOf(deps, ctx);
    const plan = ContextCrawlArgs.parse(args);
    // the catalog keeps it unavailable while the decide role has no model; one that can't be used now fails here
    const model = await deps.decider().model();
    if ('problem' in model) throw new RunRefused(fnError('caller', model.problem, NO_DECISION_MODEL));
    const { asked, refused } = await askedContext(deps, asker, ctx, plan.context);
    const outcome = await new ContextCrawler({ catalog: deps.catalog(), decider: deps.decider(), usable: (record) => mayLoad(deps, asker, record) }).crawl({
      start: asked, guidance: plan.guidance, maxDepth: plan.maxDepth, maxDecisions: plan.maxDecisions, maxTokens: plan.maxTokens,
      model, site: { purpose: CONTEXT_CRAWL_PURPOSE, run: ctx.request.run.id }, signal: ctx.signal,
    });
    // what it took loads as hub/load_context loads it, unless only its metadata was asked for
    const load = plan.metadataOnly ? undefined : await loadIntoSession(deps, asker, outcome.taken.map((item) => item.name));
    const brought = load?.brought ?? [];
    const fnsRefused = load?.fnsRefused ?? [];
    const crawled = outcome.taken.map(({ record, ...item }): CrawledContext => (plan.metadataOnly || record.decl.content === undefined ? item : { ...item, content: record.decl.content }));
    return {
      loaded: load?.loaded ?? [], fns: brought, fnsRefused, refused, crawled, skipped: [...outcome.skipped], stop: outcome.stop,
      depth: outcome.depth, decisions: outcome.decisions, tokens: outcome.tokens, calls: [...outcome.calls], metadataOnly: plan.metadataOnly,
      cards: crawledContextCards({
        taken: outcome.taken, skipped: outcome.skipped, stop: outcome.stop, decisions: outcome.decisions, tokens: outcome.tokens,
        loaded: load !== undefined, brought: { added: brought, blocked: fnsRefused }, refused,
      }),
    };
  });

  fns.register(hub.fns.search_resources, async (args, ctx) => {
    const roots = args.roots;
    const found = await hits(deps, await askerOf(deps, ctx), 'section', args.query, args.limit);
    return found
      .map((hit) => ({ hit, at: parseSectionIndexKey(hit.key) }))
      .filter(({ at }) => roots === undefined || roots.some((root) => at.uri.startsWith(root)))
      .map(({ hit, at }) => ({
        uri: at.uri, ...('section' in at ? { section: at.section } : {}),
        title: hit.text.split('\n', 1)[0]?.slice(0, 120) ?? at.uri, preview: hit.text.slice(0, PREVIEW), rank: hit.rank,
      }));
  });

  fns.register(hub.fns.fns_search, async (args, ctx) => {
    const actor = ctx.request.run.user.id;
    const id = ctx.request.run.session;
    const [session, scope, access] = await Promise.all([
      id === undefined ? undefined : deps.store().table('sessions').get(id),
      deps.mcpScope === undefined ? undefined : deps.mcpScope(ctx.request.run.caller),
      deps.access(actor),
    ]);
    // in a session only its systems' items; through a hub MCP only what it exposes
    const keep = (item: SearchItemKind, name: QualifiedName): boolean => (session === undefined || allowsSystem(session, splitName(name).system))
      && (scope === undefined || (item === 'fn' ? scope.fns.has(name) : scope.context.has(name)));
    // the model sees what it can't use too, each hit marked with what blocks it, unless it asks for usable ones only;
    // never a fn not for the model; the admin's search decisions judge hits against the turn's latest user message
    const query = FnSearchArgs.parse(args);
    const latest = await latestUserText(deps.store(), id);
    return deps.fns().search.search({ ...query, available: query.available ?? false }, {
      actor, access, keep, forModel: true, run: ctx.request.run.id, ...(latest === undefined ? {} : { latest }),
    });
  });

  fns.register(hub.fns.fn_examples, async (args, ctx) => {
    const actor = ctx.request.run.user.id;
    return deps.fns().examples.page(FnExamplesQuery.parse(args), { actor, access: await deps.access(actor) });
  });

  fns.register(hub.fns.fn_get, async (args, ctx) => {
    const name = QualifiedName.safeParse(args.fn);
    const access = await deps.access(ctx.request.run.user.id);
    const fn = name.success ? await deps.catalog().fn(name.data) : undefined;
    if (fn === undefined || !access.seesFn(fn)) throw new InvalidArgs(`no such fn: ${args.fn}`);
    const versions = await itemVersionCount(deps.store(), fn.system, 'fns', fn.name);
    const owner = fn.origin === 'runtime' ? (await deps.sharing().sharing({ kind: 'fn', fn: fn.name })).owner : undefined;
    // what blocks it, as fns_search's hits say it: the availability's own words, else an account to connect
    const blocked = unavailableBlock(fn, access);
    return {
      fn: fn.name, kind: fn.decl.kind, description: fn.decl.description,
      ...(fn.decl.instructions === undefined ? {} : { instructions: fn.decl.instructions }),
      ...(fn.decl.payload === undefined ? {} : { payload: fn.decl.payload }),
      version: Math.max(1, versions), ...(owner === undefined ? {} : { owner }),
      ...(fn.decl.routing === undefined ? {} : { routing: fn.decl.routing }),
      args: fn.decl.args, returns: fn.decl.returns, ...(fn.decl.live === undefined ? {} : { live: fn.decl.live }),
      available: blocked === undefined, ...(blocked === undefined ? {} : { blocked }),
    };
  });

  fns.register(hub.fns.save_fn, async (args, ctx) => {
    const kind = QualifiedName.safeParse(args.kind);
    if (!kind.success) throw new InvalidArgs([{ path: 'kind', message: 'a kind is a qualified name, like input/form' }]);
    const system = SystemName.parse(splitName(kind.data).system);
    // only the kind's own system saves fns of it: the hub fn's caller is a run of that system
    const parent = ctx.request.run.parent === undefined ? undefined : await deps.store().table('runs').get(ctx.request.run.parent);
    if (parent?.system !== system) throw new RunRefused(fnError('caller', `only ${system} may save fns of ${kind.data}`, 'not-your-kind'));
    const name = qualify(system, args.name);
    const [existing, kindRecord] = await Promise.all([deps.catalog().fn(name), deps.catalog().kind(kind.data)]);
    if (existing !== undefined && args.replace !== true) throw new RunRefused(fnError('caller', `${name} is taken: pick another name, or save over it with replace`, SAVE_FN_TAKEN));
    if (existing?.origin === 'contract') throw new RunRefused(fnError('caller', `${name} is one of ${system}'s own fns and can't be saved over`, SAVE_FN_TAKEN));
    await checkDeclared(deps, parent, { thing: 'fns', action: existing === undefined ? 'create' : 'update', kind: kind.data });
    const person = ctx.request.run.user.id;
    const decl: FnDecl = {
      name: args.name, description: args.description, ...(args.instructions === undefined ? {} : { instructions: args.instructions }), kind: kind.data, payload: args.payload,
      // its kind works out the signature from the payload
      args: { name: 'any' }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: args.tags ?? [],
      ...(args.examples === undefined ? {} : { examples: args.examples.map(keptExample) }),
      ...(args.routing === undefined ? {} : { routing: FnRouting.parse(args.routing) }),
      // a saved fn asks as its kind says every fn of it asks (a saved write query shows its preview)
      ...(kindRecord?.decl.approval === undefined ? {} : { approval: kindRecord.decl.approval }),
    };
    const report = await deps.catalog().declare(system, decl, person);
    const refused = report.refused[0];
    if (refused !== undefined) throw new InvalidArgs(refused.problems.join('; ') || `${name} was refused`);
    const share = args.share ?? (existing === undefined ? { visibility: 'private' as const, with: [] } : undefined);
    if (share !== undefined) await deps.sharing().own({ kind: 'fn', fn: name }, existing === undefined ? person : (await deps.sharing().sharing({ kind: 'fn', fn: name })).owner, share);
    // every save is a version of the fn (`itemVersions`, written with it), numbered from 1
    return { fn: name, version: Math.max(1, await itemVersionCount(deps.store(), system, 'fns', name)), created: existing === undefined };
  });

  // its runs are made by the hub for a system's own model calls (`RunService.systemWork`); it is never run itself
  fns.register(hub.fns.system_calls, () => Promise.reject(new RunRefused(fnError('caller', 'hub/system_calls is not called: the hub makes its runs itself', 'not-callable'))));

  const ask = hub.fns.ask_user;
  fns.register(ask, async (args, ctx) => {
    const run = await deps.store().table('runs').get(ctx.request.run.id);
    if (run === undefined) { throw new Error(`no run ${ctx.request.run.id}`); }
    const answer = await deps.handlers().askPerson({
      run, user: ctx.request.run.user.id, handler: 'ask_user', args: { question: args.question },
      decl: { description: args.question, args: wireType(ask.args), returns: wireType(ask.returns) },
    }, ctx.signal);
    if (!answer.ok) { throw new Error(answer.error.message); }
    return parseValue(ask.returns, answer.value);
  });
}

/** The context items whose names or descriptions come closest to a name the model got wrong, from the hub's search. */
async function closestContext(deps: HubFnDeps, asker: Asker, ctx: HubFnCtx, given: string): Promise<QualifiedName[]> {
  const text = given.replace(/[/._:-]+/g, ' ').trim();
  if (text === '') return [];
  const page = await deps.fns().search.search({ text, items: ['context'], limit: 3 }, {
    actor: ctx.request.run.user.id, access: asker.access, keep: (_item, name) => allowsSystem(asker.session, splitName(name).system),
  });
  return page.items.map((hit) => hit.name);
}
