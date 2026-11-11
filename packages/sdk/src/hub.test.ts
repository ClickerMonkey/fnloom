import { describe, expect, it } from 'vitest';
import { ADMIN_TAG, ChatModeConfig, ContextorConfig, OWN_TAG, READ_TAG, resourcesSlice } from '@harness/core';
import { agent } from './agent.ts';
import { encodeValue, g, parseValue } from './gin.ts';
import type { AnyFnDef } from './fn.ts';
import { ADMIN_ENDPOINTS, ADMIN_READ_ENDPOINTS, ChatModeType, ContextorType, HUB_EXPLORE_ENDPOINTS, HUB_PERSON_ENDPOINTS, HUB_READ_ENDPOINTS, HUB_WRITE_ENDPOINTS, LlmPayloadType, hub } from './hub.ts';
import { manifestOf } from './manifest.ts';

describe('the hub contract', () => {
  it('builds a manifest the hub accepts, with every build 2 fn', async () => {
    const manifest = await manifestOf(hub, { version: '2.0.0' });
    const names = new Set(manifest.fns.map((f) => f.name));
    for (const name of ['fns_search', 'inspect', 'load', 'unload', 'resource_outline', 'resource_send', 'mint_mcp_token', 'chat', 'chat_small']) { expect(names).toContain(name); }
    for (const name of [...Object.keys(HUB_READ_ENDPOINTS), ...Object.keys(HUB_WRITE_ENDPOINTS), ...Object.keys(ADMIN_ENDPOINTS), ...Object.keys(HUB_PERSON_ENDPOINTS), ...Object.keys(HUB_EXPLORE_ENDPOINTS), ...Object.keys(ADMIN_READ_ENDPOINTS)]) { expect(names).toContain(name); }
    // build 6: one search
    for (const name of ['search_fns', 'search_context', 'find']) { expect(names).not.toContain(name); }
    expect(manifest.sectioners.map((s) => s.name)).toContain('tables');
  });

  it('gives every fn instructions and at least one example (build 6)', () => {
    const fns: Readonly<Record<string, AnyFnDef | undefined>> = hub.defs.fns;
    const bare = Object.entries(fns).filter(([, def]) => def?.instructions === undefined || def.examples.length === 0).map(([name]) => name);
    expect(bare).toEqual([]);
  });

  it('tags every web read `read`, every admin write `admin`, the writes a system makes for itself `own`, and leaves the other writes to ask', () => {
    const fns: Readonly<Record<string, AnyFnDef | undefined>> = hub.defs.fns;
    for (const name of Object.keys(HUB_READ_ENDPOINTS)) { expect(fns[name]?.tags, name).toEqual([READ_TAG]); }
    for (const name of Object.keys(ADMIN_ENDPOINTS)) { expect(fns[name]?.tags, name).toEqual([ADMIN_TAG]); }
    // a system keeping what it fetched (resource_import) or saving a fn of its own kind (save_fn) is `own`: a system's call asks nobody
    for (const name of Object.keys(HUB_WRITE_ENDPOINTS)) { expect(fns[name]?.tags, name).toEqual(name === 'resource_import' ? [OWN_TAG] : []); }
    expect(hub.defs.fns.save_fn.tags).toEqual([OWN_TAG]);
    for (const name of ['fns_search', 'inspect', 'load', 'unload', 'resource_outline', 'resource_send', ...Object.keys(HUB_EXPLORE_ENDPOINTS)]) { expect(fns[name]?.tags, name).toEqual([READ_TAG]); }
    for (const name of Object.keys(HUB_PERSON_ENDPOINTS)) { expect(fns[name]?.tags, name).toEqual([]); }
    for (const name of Object.keys(ADMIN_READ_ENDPOINTS)) { expect(fns[name]?.tags, name).toEqual([ADMIN_TAG, READ_TAG]); }
    expect(hub.defs.fns.mint_mcp_token.tags).toEqual([ADMIN_TAG]);
  });

  it('takes an endpoint fn\'s args as the endpoint\'s body and checks them the same way', () => {
    const args = hub.defs.fns.resource_read.args;
    const body = resourcesSlice.endpoints.readResource.cfg.body.parse({ uri: 'file:///notes/a.md' });
    expect(resourcesSlice.endpoints.readResource.cfg.body.parse(parseValue(args, body))).toEqual(body);
    expect(() => parseValue(args, { uri: 7 })).toThrow();
  });

  it('runs the small-model chat agent with the static toolset and the graph contextor', () => {
    const payload = parseValue(LlmPayloadType, hub.defs.fns.chat_small.payload);
    expect(ChatModeConfig.parse(payload.mode)).toMatchObject({ type: 'static', protocol: 'auto', loadDetail: 'full' });
    expect(ContextorConfig.parse(payload.contextor)).toMatchObject({ type: 'graph', floorExchanges: 1 });
    expect(parseValue(LlmPayloadType, hub.defs.fns.chat.payload).mode).toBeUndefined();
  });

  it('checks a mode and a contextor with gin as core\'s schemas do', () => {
    for (const ok of [{ type: 'tools' }, { type: 'static', protocol: 'text', placement: 'tail' }]) { expect(ChatModeConfig.parse(parseValue(ChatModeType, ok))).toMatchObject(ok); }
    for (const bad of [{ type: 'loose' }, { type: 'static', protocol: 'xml' }]) { expect(() => parseValue(ChatModeType, bad)).toThrow(); }
    expect(ContextorConfig.parse(parseValue(ContextorType, { type: 'suggest', topN: 3 }))).toMatchObject({ type: 'suggest', topN: 3 });
    expect(() => parseValue(ContextorType, { type: 'graph', threshold: -1 })).toThrow();
  });
});

describe('agent', () => {
  it('carries its mode, contextor, output limit and examples into the payload and the fn', () => {
    const helper = agent({
      description: 'Helps.',
      args: g.obj({ topic: g.text() }),
      returns: g.text(),
      instructions: 'Help with {{args.topic}}.',
      mode: { type: 'static', protocol: 'text' },
      contextor: { type: 'graph' },
      maxOutput: 400,
      examples: [{ args: { topic: 'tests' } }],
    });
    expect(helper.payload).toMatchObject({ mode: { type: 'static', protocol: 'text' }, contextor: { type: 'graph' }, maxOutput: 400 });
    expect(encodeValue(LlmPayloadType, helper.payload)).toMatchObject({ maxOutput: 400 });
    expect(helper.examples).toEqual([{ args: { topic: 'tests' } }]);
    expect(agent({ description: 'x', args: g.obj({}), returns: g.text(), instructions: 'x' }).payload).not.toHaveProperty('mode');
  });
});
