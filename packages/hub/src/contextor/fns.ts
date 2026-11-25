/**
 * The contextor's hub fns: the static toolset's `inspect`, `load` and `unload` (real fns, so they have policies,
 * runs and metrics like any other; its `find` tool is `hub/fns_search`), and the `model_limits` read. `inspect` shows one item at a detail
 * with the same renderers the prompt uses; `load` and `unload` change the session's loaded fns and context, which the
 * contextors keep in front of the model. `set_model_limits` is an admin operation (`api/admin-ops.ts`).
 */
import { QualifiedName, splitName, type ActorId, type ContextRecord, type NameRefusal, type Session, type SessionId } from '@harness/core';
import { hub, HUB_READ_ENDPOINTS } from '@harness/sdk';
import type { Catalog } from '../catalog/index.ts';
import type { SessionService } from '../chat/index.ts';
import { allowsSystem } from '../chat/support.ts';
import { InvalidArgs, type HubFnCtx, type HubFns } from '../execution/executors.ts';
import type { Search } from '../index/index.ts';
import type { HubStore } from '../store/index.ts';
import { contextDetailAtMost, contextText, unique, visible } from './contextors.ts';
import type { ExampleWriter } from './examples.ts';
import type { ContextorServices, FnViewSource, PromptPlanner } from './index.ts';
import { limitsFor } from './limits.ts';
import type { McpScope } from '../mcp/index.ts';
import type { AccessScope } from '../access/index.ts';
import { blockedLine, fnCard, listedLine } from './render.ts';
import { fnRefusal, readsAsMissing } from './views.ts';
import { broughtFns, withImports } from './brought.ts';

/** What a hub MCP exposes, as `fns_search` and `inspect` keep to it when they run for one of its clients. */
export type FnScope = Pick<McpScope, 'fns' | 'types' | 'context' | 'allowsResource'>;

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
  /** What the run's person may see and use. */
  readonly access: (actor: ActorId) => Promise<AccessScope>;
  /** How the prompt a run was called from writes fn examples (`PromptPlanner.writerForRun`); none outside a prompt. */
  readonly writer?: (run: Parameters<PromptPlanner['writerForRun']>[0]) => Promise<ExampleWriter | undefined>;
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
  fns.register(hub.fns.inspect, async (args, ctx) => {
    const session = await sessionOf(deps, ctx);
    const scope = await deps.mcpScope(ctx.request.run.caller);
    const detail = args.detail ?? 'full';
    const name = QualifiedName.safeParse(args.name);
    if (!name.success) throw new InvalidArgs([{ path: 'name', message: `${args.name} names no fn or context item; use find to look for one` }]);
    const nothing = new InvalidArgs([{ path: 'name', message: `there is no fn, context or type named ${name.data}; use find to look for one` }]);
    if (scope !== undefined && !scope.fns.has(name.data) && !scope.context.has(name.data) && !scope.types.has(name.data)) throw nothing;
    const access = await deps.access(ctx.request.run.user.id);
    const view = await deps.views().view(name.data);
    if (view !== undefined) {
      const blocked = fnRefusal(view.record, session, access);
      if (blocked !== undefined) throw new InvalidArgs([{ path: 'name', message: blockedLine(name.data, blocked) }]);
      // its examples as the model that asked would send them (the code shape outside a prompt)
      const writer = await deps.writer?.(ctx.request.run);
      return { name: name.data, kind: 'fn' as const, detail, text: fnCard(view, detail, undefined, undefined, undefined, writer) };
    }
    const found = await deps.catalog().context(name.data);
    const user = ctx.request.run.user;
    if (found !== undefined && visible(found, { session, user: user.id, access })) {
      const context = detail === 'full' ? await deps.contextor().dynamic.resolve(found, { session: session?.id, actor: user.id, user }) : found;
      return { name: name.data, kind: 'context' as const, detail, text: contextText(context, contextDetailAtMost(context, detail)) };
    }
    const type = await deps.catalog().type(name.data);
    if (type !== undefined && access.seesType(type)) {
      const code = detail === 'listed' ? undefined : await deps.views().typeText(name.data);
      return { name: name.data, kind: 'type' as const, detail, text: code ?? listedLine(type.name, type.description) };
    }
    throw nothing;
  });

  fns.register(hub.fns.load, async (args, ctx) => {
    const session = await requireSession(deps, ctx);
    const access = await deps.access(ctx.request.run.user.id);
    const refused: NameRefusal[] = [];
    const tools: QualifiedName[] = [];
    const context: QualifiedName[] = [];
    for (const given of args.names) {
      const name = QualifiedName.safeParse(given);
      if (!name.success) { refused.push({ name: given, code: 'not-a-name', reason: 'names no fn or context item' }); continue; }
      const { system } = splitName(name.data);
      if (!allowsSystem(session, system)) { refused.push({ name: given, code: 'other-system', reason: `this session does not use ${system}` }); continue; }
      const fn = await deps.catalog().fn(name.data);
      if (fn !== undefined) {
        const blocked = fnRefusal(fn, session, access);
        if (blocked === undefined) tools.push(name.data);
        else refused.push({ name: given, ...blocked });
        continue;
      }
      const item = await deps.catalog().context(name.data);
      if (item !== undefined && visible(item, { session, user: ctx.request.run.user.id, access })) context.push(name.data);
      else refused.push({ name: given, code: 'no-such-fn', reason: 'no fn or context has that name' });
    }
    // context loads with what it imports, and brings its fns (`broughtFns`), as hub/ctx_load does
    const user = ctx.request.run.user.id;
    const records: ContextRecord[] = [];
    for (const name of await withImports(deps.catalog(), context)) {
      const parsed = QualifiedName.safeParse(name);
      const item = parsed.success ? await deps.catalog().context(parsed.data) : undefined;
      if (item !== undefined && visible(item, { session, user, access })) records.push(item);
    }
    // a brought fn that can't be added is refused with what blocks it, as hub/ctx_load reports it; one that reads as missing is left out
    for (const name of broughtFns(records)) {
      const blocked = fnRefusal(await deps.catalog().fn(name), session, access);
      if (blocked === undefined) tools.push(name);
      else if (!readsAsMissing(blocked)) refused.push({ name, ...blocked });
    }
    const loadedContext = records.map((r) => r.name);
    if (tools.length > 0 || loadedContext.length > 0) {
      await deps.sessions().load(session.id, { tools: unique([...session.tools, ...tools]), context: unique([...session.context, ...loadedContext]) });
    }
    return { loaded: unique([...tools, ...loadedContext]), refused };
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
