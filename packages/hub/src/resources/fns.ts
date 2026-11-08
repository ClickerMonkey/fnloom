/**
 * The hub fns of the resources module, implemented against the hub contract's refs: reading (`hub/resource_list`,
 * `hub/resource_read`, `hub/resource_outline`, `hub/resource_send`, `hub/context_get`) and writing
 * (`hub/resource_convert`, `hub/resource_import`, `hub/resource_rename`, `hub/resource_delete`,
 * `hub/context_from_resource`, `hub/remember`, `hub/forget`). The fns that mirror a web endpoint read their args with
 * that endpoint's body schema (`HUB_READ_ENDPOINTS`, `HUB_WRITE_ENDPOINTS`, through `toolArgsOf`, which unwraps a
 * body that isn't an object, such as an import's URL-or-content union) and run the same operation as its
 * handler, as the run's person, so the chat LLM sees and does what the browser does. Services are read when a fn
 * runs, never while registering.
 */
import { ResourceOutlineArgs, ResourceSendArgs } from '@harness/core';
import { hub, HUB_READ_ENDPOINTS, HUB_WRITE_ENDPOINTS, toolArgsOf } from '@harness/sdk';
import type { HubFnCtx, HubFns } from '../execution/executors.ts';
import type { LlmGateway } from '../execution/index.ts';
import type { HubStore } from '../store/index.ts';
import type { Asking, ContentModel, ResourceServices } from './index.ts';

/** What the resource fns read, each looked up when a fn runs. */
export interface ResourceFnDeps {
  readonly resources: () => ResourceServices;
  readonly store: () => HubStore;
  readonly llm: () => Pick<LlmGateway, 'models'>;
}

/** A model that takes only text, for a send made outside any LLM call. */
const TEXT_ONLY: ContentModel = { id: 'text', capabilities: ['chat'] };

/** Who a fn runs for: the run's person, in its session, charged to the run. */
function askingOf(ctx: HubFnCtx): Asking {
  const run = ctx.request.run;
  return { actor: run.user.id, run: run.id, ...(run.session === undefined ? {} : { session: run.session }) };
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

  fns.register(refs.resource_list, async (args, ctx) => deps.resources().library.browse(read.list(args), askingOf(ctx)));
  fns.register(refs.resource_read, async (args, ctx) => deps.resources().reader.read(read.read(args), askingOf(ctx)));
  fns.register(refs.context_get, async (args, ctx) => deps.resources().context.item(read.context(args).name, askingOf(ctx)));
  // args arrive checked against the contract's gin types, made from these schemas; parsing adds the brands
  fns.register(refs.resource_outline, async (args, ctx) => deps.resources().reader.outline(ResourceOutlineArgs.parse(args).uri, askingOf(ctx)));
  fns.register(refs.resource_send, async (args, ctx) => {
    const { uri, section } = ResourceSendArgs.parse(args);
    const parts = await deps.resources().content.parts(uri, await modelOf(deps, ctx), askingOf(ctx), section === undefined ? {} : { section });
    return { parts: parts.map((part) => ({ type: part.type, chars: part.content.length, ...(part.name === undefined ? {} : { name: part.name }) })) };
  });

  fns.register(refs.resource_convert, async (args, ctx) => {
    const body = write.convert(args);
    return deps.resources().forms.ensure(body.uri, body.kind, askingOf(ctx));
  });
  fns.register(refs.resource_import, async (args, ctx) => deps.resources().library.import(write.import(args), askingOf(ctx)));
  fns.register(refs.resource_rename, async (args, ctx) => {
    const body = write.rename(args);
    return deps.resources().library.rename(body.uri, body.name, askingOf(ctx));
  });
  fns.register(refs.resource_delete, async (args, ctx) => deps.resources().library.remove(write.delete(args).uri, askingOf(ctx)));
  fns.register(refs.context_from_resource, async (args, ctx) => deps.resources().context.fromResource(write.fromResource(args), askingOf(ctx)));
  fns.register(refs.remember, async (args, ctx) => deps.resources().context.remember(write.remember(args), askingOf(ctx)));
  fns.register(refs.forget, async (args, ctx) => ({ ok: await deps.resources().context.forget(write.forget(args).name, askingOf(ctx)) }));
}
