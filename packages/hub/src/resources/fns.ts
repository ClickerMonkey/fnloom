/**
 * The hub fns of the resources module, implemented against the hub contract's refs: reading (`hub/resource_list`,
 * `hub/resource_read`, `hub/resource_outline`, `hub/resource_send`, `hub/context_get`) and writing
 * (`hub/resource_convert`, `hub/resource_import`, `hub/resource_rename`, `hub/resource_delete`,
 * `hub/context_from_resource`, `hub/remember`, `hub/forget`). The fns that mirror a web endpoint read their args with
 * that endpoint's body schema (`HUB_READ_ENDPOINTS`, `HUB_WRITE_ENDPOINTS`, through `toolArgsOf`, which unwraps a
 * body that isn't an object, such as an import's URL-or-content union) and run the same operation as its
 * handler, as the run's person, so the chat LLM sees and does what the browser does. Called through a hub MCP, each
 * fn also keeps to that MCP's rules: a resource outside them, or a context item it doesn't expose, is answered as if
 * it weren't there, and a listing leaves them out. Services are read when a fn runs, never while registering.
 */
import { reject } from '@ayepi/core';
import { ResourceOutlineArgs, ResourceSendArgs, splitName, type ActorId, type ContextLink, type LinkTarget, type QualifiedName } from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import { seesContextAs, seesTypeNamed } from '../access/scope.ts';
import { hub, HUB_READ_ENDPOINTS, HUB_WRITE_ENDPOINTS, toolArgsOf } from '@harness/sdk';
import type { HubFnCtx, HubFns } from '../execution/executors.ts';
import type { LlmGateway } from '../execution/index.ts';
import type { McpScope } from '../mcp/index.ts';
import type { HubStore } from '../store/index.ts';
import type { Asking, ContentModel, ResourceServices } from './index.ts';

/** What the hub MCP a caller acts as exposes, as far as resources and context go. */
export type ReachScope = Pick<McpScope, 'context' | 'allowsResource'>;

/** What the resource fns read, each looked up when a fn runs. */
export interface ResourceFnDeps {
  readonly resources: () => ResourceServices;
  readonly store: () => HubStore;
  readonly llm: () => Pick<LlmGateway, 'models'>;
  /** What the hub MCP a run's caller acts as exposes; none when the caller is no MCP's actor. */
  readonly mcpScope: (caller: ActorId) => Promise<ReachScope | undefined>;
  /** What the run's person may see (resource roots and context shared with them). */
  readonly access: (actor: ActorId) => Promise<AccessScope>;
}

/** A model that takes only text, for a send made outside any LLM call. */
const TEXT_ONLY: ContentModel = { id: 'text', capabilities: ['chat'] };

/** Who a fn runs for: the run's person, in its session, charged to the run. */
function askingOf(ctx: HubFnCtx): Asking {
  const run = ctx.request.run;
  return { actor: run.user.id, run: run.id, admin: run.user.role === 'admin', ...(run.session === undefined ? {} : { session: run.session }) };
}

/** What a run's caller may reach: everything outside an MCP, else what its hub MCP's rules expose. */
interface Reach {
  /** Whether a resource is in reach. */
  readonly resource: (uri: string) => boolean;
  /** The resource's URI, or a refusal that reads as if it weren't there. */
  readonly needResource: <U extends string>(uri: U) => U;
  /** The context item's name, or a refusal that reads as if it weren't there. */
  readonly needContext: (name: QualifiedName) => Promise<QualifiedName>;
  /** Whether a link's end is in reach: a context item, fn, type or resource. */
  readonly linked: (target: LinkTarget) => Promise<boolean>;
}

/** What the caller of a run may reach. */
async function reachOf(deps: ResourceFnDeps, ctx: HubFnCtx): Promise<Reach> {
  const [scope, access] = await Promise.all([deps.mcpScope(ctx.request.run.caller), deps.access(ctx.request.run.user.id)]);
  const resource = (uri: string): boolean => (scope === undefined || scope.allowsResource(uri)) && access.seesUri(uri);
  const session = ctx.request.run.session;
  const context = async (name: QualifiedName): Promise<boolean> => {
    const system = splitName(name).system;
    const record = await deps.store().table('context').get(name);
    // the item's own access: a resource-made item follows its resource, a memory its scope
    return (scope === undefined || scope.context.has(name)) && access.seesSystem(system) && access.sees({ kind: 'context', context: name })
      && seesContextAs(access, record ?? { name, system, origin: undefined }, session);
  };
  return {
    resource,
    needResource: (uri) => {
      if (!resource(uri)) { throw reject(404, 'NO_RESOURCE', `there is no resource ${uri}`); }
      return uri;
    },
    needContext: async (name) => {
      if (!(await context(name))) { throw reject(404, 'NO_CONTEXT', `there is no context ${name}`); }
      return name;
    },
    linked: async (target) => {
      switch (target.kind) {
        case 'context': return context(target.name);
        case 'fn': return access.seesFn({ name: target.name, system: splitName(target.name).system });
        case 'type': return seesTypeNamed(access, (name) => deps.store().table('types').get(name), target.name);
        case 'resource': return resource(target.uri);
      }
    },
  };
}

/** The model the run's LLM call used, so a send fits what that model takes (text only when it can't be told). */
async function modelOf(deps: ResourceFnDeps, ctx: HubFnCtx): Promise<ContentModel> {
  const run = await deps.store().table('runs').get(ctx.request.run.id);
  const call = run?.llmCall === undefined ? undefined : await deps.store().table('llmInteractions').get(run.llmCall);
  if (call === undefined) { return TEXT_ONLY; }
  return (await deps.llm().models()).find((model) => model.id === call.model) ?? { ...TEXT_ONLY, id: call.model };
}

/** Register the resource and context fns. */
export function registerResourceFns(fns: HubFns, deps: ResourceFnDeps): void {
  const { fns: refs } = hub;
  const read = {
    list: toolArgsOf(HUB_READ_ENDPOINTS.resource_list.cfg.body).read,
    read: toolArgsOf(HUB_READ_ENDPOINTS.resource_read.cfg.body).read,
    context: toolArgsOf(HUB_READ_ENDPOINTS.context_get.cfg.body).read,
  };
  const write = {
    convert: toolArgsOf(HUB_WRITE_ENDPOINTS.resource_convert.cfg.body).read,
    import: toolArgsOf(HUB_WRITE_ENDPOINTS.resource_import.cfg.body).read,
    rename: toolArgsOf(HUB_WRITE_ENDPOINTS.resource_rename.cfg.body).read,
    delete: toolArgsOf(HUB_WRITE_ENDPOINTS.resource_delete.cfg.body).read,
    fromResource: toolArgsOf(HUB_WRITE_ENDPOINTS.context_from_resource.cfg.body).read,
    remember: toolArgsOf(HUB_WRITE_ENDPOINTS.remember.cfg.body).read,
    forget: toolArgsOf(HUB_WRITE_ENDPOINTS.forget.cfg.body).read,
  };

  fns.register(refs.resource_list, async (args, ctx) => {
    const reach = await reachOf(deps, ctx);
    const page = await deps.resources().library.browse(read.list(args), askingOf(ctx));
    const items = page.items.filter((item) => reach.resource(item.uri));
    // through an MCP, the facets' counts would tell of resources it can't reach
    return items.length === page.items.length ? page : { ...page, items, facets: [] };
  });
  fns.register(refs.resource_read, async (args, ctx) => {
    const body = read.read(args);
    (await reachOf(deps, ctx)).needResource(body.uri);
    return deps.resources().reader.read(body, askingOf(ctx));
  });
  fns.register(refs.context_get, async (args, ctx) => {
    const reach = await reachOf(deps, ctx);
    const item = await deps.resources().context.item(await reach.needContext(read.context(args).name), askingOf(ctx));
    // a link names its other end: only the ends the caller may reach are shown
    const kept = async (links: readonly ContextLink[], end: (link: ContextLink) => Promise<boolean>): Promise<ContextLink[]> => {
      const seen = await Promise.all(links.map(end));
      return links.filter((_, i) => seen[i] === true);
    };
    const [links, backlinks] = await Promise.all([
      kept(item.links, (link) => reach.linked(link.to)),
      kept(item.backlinks, async (link) => (await deps.store().table('context').get(link.from)) === undefined ? reach.linked({ kind: 'fn', name: link.from }) : reach.linked({ kind: 'context', name: link.from })),
    ]);
    return { ...item, links, backlinks };
  });
  // args arrive checked against the contract's gin types, made from these schemas; parsing adds the brands
  fns.register(refs.resource_outline, async (args, ctx) => deps.resources().reader.outline((await reachOf(deps, ctx)).needResource(ResourceOutlineArgs.parse(args).uri), askingOf(ctx)));
  fns.register(refs.resource_send, async (args, ctx) => {
    const { uri, section } = ResourceSendArgs.parse(args);
    (await reachOf(deps, ctx)).needResource(uri);
    const parts = await deps.resources().content.parts(uri, await modelOf(deps, ctx), askingOf(ctx), section === undefined ? {} : { section });
    return { parts: parts.map((part) => ({ type: part.type, chars: part.content.length, ...(part.name === undefined ? {} : { name: part.name }) })) };
  });

  fns.register(refs.resource_convert, async (args, ctx) => {
    const body = write.convert(args);
    return deps.resources().forms.ensure((await reachOf(deps, ctx)).needResource(body.uri), body.kind, askingOf(ctx));
  });
  fns.register(refs.resource_import, async (args, ctx) => deps.resources().library.import(write.import(args), askingOf(ctx)));
  fns.register(refs.resource_rename, async (args, ctx) => {
    const body = write.rename(args);
    return deps.resources().library.rename((await reachOf(deps, ctx)).needResource(body.uri), body.name, askingOf(ctx));
  });
  fns.register(refs.resource_delete, async (args, ctx) => deps.resources().library.remove((await reachOf(deps, ctx)).needResource(write.delete(args).uri), askingOf(ctx)));
  fns.register(refs.context_from_resource, async (args, ctx) => {
    const body = write.fromResource(args);
    (await reachOf(deps, ctx)).needResource(body.uri);
    return deps.resources().context.fromResource(body, askingOf(ctx));
  });
  fns.register(refs.remember, async (args, ctx) => deps.resources().context.remember(write.remember(args), askingOf(ctx)));
  fns.register(refs.forget, async (args, ctx) => ({ ok: await deps.resources().context.forget(await (await reachOf(deps, ctx)).needContext(write.forget(args).name), askingOf(ctx)) }));
}
