import { peers } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import { ActorId, systemLinkSpec } from '@harness/core';
import { fake, fakeModules, rig } from '../api/testing/rig.ts';
import type { HubModules } from './index.ts';
import { assemble } from './services.ts';

const extras = { peers: peers(systemLinkSpec), hubActor: ActorId.parse('act_hub') };

describe('assemble', () => {
  it('builds each module once, on first use', async () => {
    const r = await rig();
    const built: string[] = [];
    const base = fakeModules();
    const modules: HubModules = {
      ...base,
      catalog: (ctx) => { built.push('catalog'); return base.catalog(ctx); },
      chat: (ctx) => { built.push('chat'); return base.chat(ctx); },
    };
    const { hub, builds } = assemble(r.hub, r.api, modules, extras);
    expect(built).toEqual([]);
    expect(hub.catalog).toBe(hub.catalog);
    expect(built).toEqual(['catalog']);
    builds();
    builds();
    expect(built).toEqual(['catalog', 'chat']);
  });

  it('gives factories the hub, its peers and its actor, and lets one read another while being built', async () => {
    const r = await rig();
    const base = fakeModules();
    let seenActor: string | undefined;
    const modules: HubModules = {
      ...base,
      chat: (ctx) => {
        seenActor = ctx.hubActor;
        expect(ctx.peers).toBe(extras.peers);
        expect(ctx.hub.catalog).toBeDefined();
        return base.chat(ctx);
      },
    };
    const { builds } = assemble(r.hub, r.api, modules, extras);
    expect(builds()).toHaveLength(5);
    expect(seenActor).toBe('act_hub');
  });

  it('refuses modules that need each other while being built', async () => {
    const r = await rig();
    const base = fakeModules();
    const modules: HubModules = {
      ...base,
      link: (ctx) => { expect(ctx.hub.execution).toBeDefined(); return base.link(ctx); },
      execution: (ctx) => { expect(ctx.hub.link).toBeDefined(); return { services: fake('execution') }; },
    };
    const { builds } = assemble(r.hub, r.api, modules, extras);
    expect(() => builds()).toThrow(/link -> execution -> link/);
  });
});
