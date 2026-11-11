/**
 * The hub's own fns that span modules: finding and loading fns and context for a session's agent (index search,
 * the catalog, the session), searching resources, and asking a person (a handler call they answer in the chat).
 * `registerHubFns` implements them on execution's `HubFns` against the hub contract's refs, so args and results are
 * typed and checked by the contract's gin types. Services are read when a fn runs, never while registering. Every one
 * keeps to what the run's person may see and use (their `AccessScope`): search hits, loads and results alike.
 */
import { FnExamplesQuery, FnRouting, FnSearchQuery, QualifiedName, qualify, splitName, SystemName, type ActorId, type FnDecl, type IndexedKind, type Session, type SessionId } from '@harness/core';
import { hub, parseValue, SAVE_FN_TAKEN, wireType } from '@harness/sdk';
import type { AccessService } from '../access/index.ts';
import type { FnsServices } from '../fns/index.ts';
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

/** How many results a search returns when the agent doesn't say. */
const DEFAULT_LIMIT = 10;
/** The characters of a section shown as its preview. */
const PREVIEW = 280;

/** What the hub fns read, each looked up when a fn runs. */
export interface HubFnDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn' | 'fns' | 'availability' | 'context' | 'declare'>;
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
    keep: keepSeen(access, (name) => deps.catalog().context(name), session.id),
  });
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

/** Register the hub fns. */
export function registerHubFns(fns: HubFns, deps: HubFnDeps): void {

  fns.register(hub.fns.search_fns, async (args, ctx) => {
    const asker = await askerOf(deps, ctx);
    const found = await hits(deps, asker, 'fn', args.query, args.limit);
    const records = await deps.catalog().fns({ names: names(found.map((h) => h.key)).valid });
    return Promise.all(records.map(async (fn) => ({
      fn: fn.name, description: fn.decl.description,
      available: asker.access.mayUse(fn) && (await deps.catalog().availability(fn.name)) === true,
    })));
  });

  fns.register(hub.fns.load_fns, async (args, ctx) => {
    const { session, access } = await askerOf(deps, ctx);
    const { valid, invalid } = names(args.fns);
    const refused = invalid.map((fn) => ({ fn, reason: 'not a qualified fn name (system/name)' }));
    const loaded: QualifiedName[] = [];
    for (const name of valid) {
      const fn = await deps.catalog().fn(name);
      const availability = fn === undefined ? undefined : await deps.catalog().availability(name);
      if (fn === undefined || !access.seesFn(fn)) { refused.push({ fn: name, reason: 'no such fn' }); }
      else if (!allowsSystem(session, splitName(name).system)) { refused.push({ fn: name, reason: 'this session does not use that system' }); }
      else if (!access.mayUse(fn)) { refused.push({ fn: name, reason: 'connect your account to use this fn' }); }
      else if (availability !== true) { refused.push({ fn: name, reason: availability?.detail ?? 'unavailable' }); }
      else { loaded.push(name); }
    }
    if (loaded.length > 0) { await deps.sessions().load(session.id, { tools: [...new Set([...session.tools, ...loaded])] }); }
    return { loaded, refused };
  });

  fns.register(hub.fns.drop_fns, async (args, ctx) => {
    const { session } = await askerOf(deps, ctx);
    const drop = new Set<string>(args.fns);
    const dropped = session.tools.filter((fn) => drop.has(fn));
    if (dropped.length > 0) { await deps.sessions().load(session.id, { tools: session.tools.filter((fn) => !drop.has(fn)) }); }
    return { dropped };
  });

  fns.register(hub.fns.search_context, async (args, ctx) => {
    const found = await hits(deps, await askerOf(deps, ctx), 'context', args.query, args.limit);
    const records = await Promise.all(names(found.map((h) => h.key)).valid.map((name) => deps.catalog().context(name)));
    return records.flatMap((c) => (c === undefined ? [] : [{ context: c.name, description: c.decl.description }]));
  });

  fns.register(hub.fns.load_context, async (args, ctx) => {
    const { session, access } = await askerOf(deps, ctx);
    const lookup = (name: QualifiedName) => deps.catalog().context(name);
    const loaded: QualifiedName[] = [];
    for (const name of names(args.context).valid) {
      if (await lookup(name) !== undefined && allowsSystem(session, splitName(name).system) && await seesContextNamed(access, lookup, name, session.id)) { loaded.push(name); }
    }
    if (loaded.length > 0) { await deps.sessions().load(session.id, { context: [...new Set([...session.context, ...loaded])] }); }
    return { loaded };
  });

  fns.register(hub.fns.search_resources, async (args, ctx) => {
    const roots = args.roots;
    const found = await hits(deps, await askerOf(deps, ctx), 'section', args.query, args.limit);
    return found
      .map((hit) => ({ hit, at: parseSectionIndexKey(hit.key) }))
      .filter(({ at }) => roots === undefined || roots.some((root) => at.uri.startsWith(root)))
      .map(({ hit, at }) => ({
        uri: at.uri, ...('section' in at ? { section: at.section } : {}),
        title: hit.text.split('\n', 1)[0]?.slice(0, 120) ?? at.uri, preview: hit.text.slice(0, PREVIEW), score: hit.score,
      }));
  });

  fns.register(hub.fns.fns_search, async (args, ctx) => {
    const actor = ctx.request.run.user.id;
    return deps.fns().search.search(FnSearchQuery.parse(args), { actor, access: await deps.access(actor) });
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
    const versions = await deps.store().table('fnVersions').count({ fn: fn.name });
    const owner = fn.origin === 'runtime' ? (await deps.sharing().sharing({ kind: 'fn', fn: fn.name })).owner : undefined;
    return {
      fn: fn.name, kind: fn.decl.kind, description: fn.decl.description,
      ...(fn.decl.instructions === undefined ? {} : { instructions: fn.decl.instructions }),
      ...(fn.decl.payload === undefined ? {} : { payload: fn.decl.payload }),
      version: versions + 1, ...(owner === undefined ? {} : { owner }),
      ...(fn.decl.routing === undefined ? {} : { routing: fn.decl.routing }),
      available: access.mayUse(fn) && (await deps.catalog().availability(fn.name)) === true,
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
    const existing = await deps.catalog().fn(name);
    if (existing !== undefined && args.replace !== true) throw new RunRefused(fnError('caller', `${name} is taken: pick another name, or save over it with replace`, SAVE_FN_TAKEN));
    if (existing?.origin === 'contract') throw new RunRefused(fnError('caller', `${name} is one of ${system}'s own fns and can't be saved over`, SAVE_FN_TAKEN));
    const person = ctx.request.run.user.id;
    const decl: FnDecl = {
      name: args.name, description: args.description, ...(args.instructions === undefined ? {} : { instructions: args.instructions }), kind: kind.data, payload: args.payload,
      // its kind works out the signature from the payload
      args: { name: 'any' }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: args.tags ?? [],
      ...(args.examples === undefined ? {} : { examples: args.examples }),
      ...(args.routing === undefined ? {} : { routing: FnRouting.parse(args.routing) }),
    };
    const versions = deps.store().table('fnVersions');
    const number = (await versions.count({ fn: name })) + 1;
    const report = await deps.catalog().declare(system, decl, person);
    const refused = report.refused[0];
    if (refused !== undefined) throw new InvalidArgs(refused.problems.join('; ') || `${name} was refused`);
    // the version saved over is kept, numbered from 1
    if (existing !== undefined) await versions.put({ id: `${name}#${number}`, fn: name, number, decl: existing.decl, ...(existing.addedBy === undefined ? {} : { savedBy: existing.addedBy }), savedAt: existing.updatedAt });
    const share = args.share ?? (existing === undefined ? { visibility: 'private' as const, with: [] } : undefined);
    if (share !== undefined) await deps.sharing().own({ kind: 'fn', fn: name }, existing === undefined ? person : (await deps.sharing().sharing({ kind: 'fn', fn: name })).owner, share);
    return { fn: name, version: existing === undefined ? 1 : number + 1, created: existing === undefined };
  });

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
