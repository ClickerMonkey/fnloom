/**
 * The contextor's hub fns: the static toolset's `find`, `inspect`, `load` and `unload` (real fns, so they have
 * policies, runs and metrics like any other), and the `model_limits` read. `find` searches the index for fns,
 * context, types and resource sections and marks what the session has loaded; `inspect` shows one item at a detail
 * with the same renderers the prompt uses; `load` and `unload` change the session's loaded fns and context, which the
 * contextors keep in front of the model. `set_model_limits` is an admin operation (`api/admin-ops.ts`).
 */
import { QualifiedName, splitName, type ActorId, type IndexedKind, type Session, type SessionId } from '@harness/core';
import { FIND_KINDS, hub, HUB_READ_ENDPOINTS } from '@harness/sdk';
import type { Catalog } from '../catalog/index.ts';
import type { SessionService } from '../chat/index.ts';
import { allowsSystem, searchSystems } from '../chat/support.ts';
import { InvalidArgs, type HubFnCtx, type HubFns } from '../execution/executors.ts';
import type { Search } from '../index/index.ts';
import { parseSectionIndexKey } from '../index/indexer.ts';
import type { HubStore } from '../store/index.ts';
import { contextDetailAtMost, contextText, unique, visible } from './contextors.ts';
import type { ContextorServices, FnViewSource } from './index.ts';
import { limitsFor } from './limits.ts';
import type { McpScope } from '../mcp/index.ts';
import { fnCard, listedLine } from './render.ts';
import { forModel, modelMayUse } from './views.ts';

/** What `find` looks for, as an index kind. */
type FindKind = (typeof FIND_KINDS)[number];
const INDEX_KIND: Readonly<Record<FindKind, IndexedKind>> = { fn: 'fn', context: 'context', type: 'type', resource: 'section' };
const FIND_KIND: Readonly<Record<IndexedKind, FindKind | undefined>> = { fn: 'fn', context: 'context', type: 'type', section: 'resource', message: undefined };

/** How many hits `find` returns when the model doesn't say, and the most it looks through. */
const FIND_LIMIT = 8;
const FIND_MAX = 50;

/** What a hub MCP exposes, as `find` and `inspect` keep to it when they run for one of its clients. */
export type FnScope = Pick<McpScope, 'fns' | 'types' | 'context' | 'allowsResource'>;

/** Whether a hit is inside an MCP's scope. */
function inScope(scope: FnScope, kind: FindKind, key: string): boolean {
  if (kind === 'resource') return scope.allowsResource(parseSectionIndexKey(key).uri);
  const name = QualifiedName.safeParse(key);
  if (!name.success) return false;
  switch (kind) {
    case 'fn': return scope.fns.has(name.data);
    case 'context': return scope.context.has(name.data);
    case 'type': return scope.types.has(name.data);
  }
}

/** What the contextor fns read, each looked up when a fn runs. */
export interface ContextorFnDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn' | 'context' | 'type' | 'availability'>;
  readonly search: () => Pick<Search, 'search'>;
  readonly sessions: () => Pick<SessionService, 'load'>;
  readonly contextor: () => Pick<ContextorServices, 'limits' | 'dynamic'>;
  readonly views: () => FnViewSource;
  /** The scope of the hub MCP a run's caller is (its `mcp` actor), or undefined for any other caller. */
  readonly mcpScope: (caller: ActorId) => Promise<FnScope | undefined>;
}

/** The session a run is in, if any. */
async function sessionOf(deps: ContextorFnDeps, ctx: HubFnCtx): Promise<Session | undefined> {
  const id: SessionId | undefined = ctx.request.run.session;
  return id === undefined ? undefined : deps.store().table('sessions').get(id);
}

/** The session a run is in, refused when it has none (loading only makes sense in a chat). */
async function requireSession(deps: ContextorFnDeps, ctx: HubFnCtx): Promise<Session> {
  const session = await sessionOf(deps, ctx);
  if (session === undefined) throw new Error('this fn only works inside a chat session');
  return session;
}

/** Register the contextor's hub fns. */
export function registerContextorFns(fns: HubFns, deps: ContextorFnDeps): void {
  fns.register(hub.fns.find, async (args, ctx) => {
    const session = await sessionOf(deps, ctx);
    const scope = await deps.mcpScope(ctx.request.run.caller);
    const kinds = (args.kinds ?? FIND_KINDS).map((kind) => INDEX_KIND[kind]);
    const limit = args.limit ?? FIND_LIMIT;
    // through an MCP, hits outside its scope are dropped, so ask for more
    const hits = await deps.search().search({ text: args.query, kinds, limit: scope === undefined ? limit : FIND_MAX, ...(session === undefined ? {} : { systems: searchSystems(session) }) });
    const loaded = new Set<string>([...(session?.tools ?? []), ...(session?.context ?? [])]);
    const out: Array<{ name: string; kind: FindKind; description: string; loaded: boolean }> = [];
    for (const hit of hits) {
      const kind = FIND_KIND[hit.kind];
      if (kind === undefined || (scope !== undefined && !inScope(scope, kind, hit.key))) continue;
      const description = await describe(deps, kind, hit.key, hit.text);
      if (description !== undefined) out.push({ name: kind === 'resource' ? resourceName(hit.key) : hit.key, kind, description, loaded: loaded.has(hit.key) });
      if (out.length >= limit) break;
    }
    return out;
  });

  fns.register(hub.fns.inspect, async (args, ctx) => {
    const session = await sessionOf(deps, ctx);
    const scope = await deps.mcpScope(ctx.request.run.caller);
    const detail = args.detail ?? 'full';
    const name = QualifiedName.safeParse(args.name);
    if (!name.success) throw new InvalidArgs([{ path: 'name', message: `${args.name} is not a name (system/name); use find to look for one` }]);
    const nothing = new InvalidArgs([{ path: 'name', message: `there is no fn, context or type named ${name.data}; use find to look for one` }]);
    if (scope !== undefined && !scope.fns.has(name.data) && !scope.context.has(name.data) && !scope.types.has(name.data)) throw nothing;
    const view = await deps.views().view(name.data);
    if (view !== undefined) {
      if (!modelMayUse(view.record, session)) throw new InvalidArgs([{ path: 'name', message: `${name.data} can't be used here` }]);
      return { name: name.data, kind: 'fn' as const, detail, text: fnCard(view, detail, 'native') };
    }
    const found = await deps.catalog().context(name.data);
    const user = ctx.request.run.user;
    if (found !== undefined && visible(found, { session, user: user.id })) {
      const context = detail === 'full' ? await deps.contextor().dynamic.resolve(found, { session: session?.id, actor: user.id, user }) : found;
      return { name: name.data, kind: 'context' as const, detail, text: contextText(context, contextDetailAtMost(context, detail)) };
    }
    const type = await deps.catalog().type(name.data);
    if (type !== undefined) {
      const code = detail === 'listed' ? undefined : await deps.views().typeText(name.data);
      return { name: name.data, kind: 'type' as const, detail, text: code ?? listedLine(type.name, type.description) };
    }
    throw nothing;
  });

  fns.register(hub.fns.load, async (args, ctx) => {
    const session = await requireSession(deps, ctx);
    const refused: Array<{ name: string; reason: string }> = [];
    const tools: QualifiedName[] = [];
    const context: QualifiedName[] = [];
    for (const given of args.names) {
      const name = QualifiedName.safeParse(given);
      if (!name.success) { refused.push({ name: given, reason: 'not a name (system/name)' }); continue; }
      if (!allowsSystem(session, splitName(name.data).system)) { refused.push({ name: given, reason: 'this session does not use that system' }); continue; }
      const fn = await deps.catalog().fn(name.data);
      if (fn !== undefined) {
        if (modelMayUse(fn, session)) tools.push(name.data);
        else refused.push({ name: given, reason: fn.disabled ? 'switched off' : !forModel(fn.decl.visibility) ? 'not for the model' : 'unavailable now' });
        continue;
      }
      const item = await deps.catalog().context(name.data);
      if (item !== undefined && visible(item, { session, user: ctx.request.run.user.id })) context.push(name.data);
      else refused.push({ name: given, reason: 'no fn or context has that name' });
    }
    if (tools.length > 0 || context.length > 0) {
      await deps.sessions().load(session.id, { tools: unique([...session.tools, ...tools]), context: unique([...session.context, ...context]) });
    }
    return { loaded: [...tools, ...context], refused };
  });

  fns.register(hub.fns.unload, async (args, ctx) => {
    const session = await requireSession(deps, ctx);
    const drop = new Set<string>(args.names);
    const unloaded = [...session.tools, ...session.context].filter((name) => drop.has(name));
    const gone = new Set<string>(unloaded);
    const refused = args.names.filter((name) => !gone.has(name)).map((name) => ({ name, reason: 'not loaded' }));
    if (unloaded.length > 0) await deps.sessions().load(session.id, { tools: session.tools.filter((n) => !drop.has(n)), context: session.context.filter((n) => !drop.has(n)) });
    return { unloaded, refused };
  });

  fns.register(hub.fns.model_limits, async (args) => {
    const { model } = HUB_READ_ENDPOINTS.model_limits.cfg.body.parse(args);
    return limitsFor(deps.contextor().limits, model);
  });
}

/** One line about a hit: its declared description, or the first line of a section. Undefined for an item that is gone. */
async function describe(deps: ContextorFnDeps, kind: FindKind, key: string, text: string): Promise<string | undefined> {
  if (kind === 'resource') return text.split('\n', 1)[0]?.slice(0, 160) ?? key;
  const name = QualifiedName.safeParse(key);
  if (!name.success) return undefined;
  switch (kind) {
    case 'fn': return (await deps.catalog().fn(name.data))?.decl.description;
    case 'context': return (await deps.catalog().context(name.data))?.decl.description;
    case 'type': return (await deps.catalog().type(name.data))?.description;
  }
}

/** A section hit's name: `uri#section`, or the uri. */
function resourceName(key: string): string {
  const at = parseSectionIndexKey(key);
  return 'section' in at ? `${at.uri}#${at.section}` : at.uri;
}

