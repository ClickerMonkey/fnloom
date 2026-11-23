/**
 * Runtime providers (a system's `provider({ models: 'runtime' })`, one per fleet instance): the catalog keeps each
 * instance's own when another sends, the offered providers route each to its instance and leave it out while that
 * instance is away, a change to a provider's models rebuilds the hub AI, and the review takes a runtime provider's free
 * models moving without asking again.
 */
import { InstanceName, Json, SystemName, type ContractChange, type Manifest, type SystemProviderDecl } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { fromInstance } from '../catalog/catalog.ts';
import { runtimeProviderChange } from '../link/lifecycle.ts';
import type { SystemConnection } from '../link/index.ts';
import { linkServer, TestSystem } from '../execution/testing.ts';
import { RecordingBus, memoryLog } from '../testing.ts';
import { SystemProviderSource } from './remote.ts';

const OLLAMA = SystemName.parse('ollama');
const DESK = InstanceName.parse('desk');
const LAPTOP = InstanceName.parse('laptop');

const model = (id: string, input = 0) => ({ id, capabilities: ['chat'], contextWindow: 4_096, pricing: { input, output: 0 }, caching: false });
const runtime = (instance: InstanceName, ids: readonly string[]): SystemProviderDecl => ({ name: instance, description: 'Offered models.', models: ids.map((id) => model(id)), runtime: true, instance });

const EMPTY: Manifest = {
  name: OLLAMA, version: '1', description: '', hash: 'h', types: [], settings: [], attachments: [], kinds: [], fns: [], context: [], hooks: [], mentions: [],
  sectioners: [], actions: [], events: [], resources: false, config: { name: 'obj' }, requires: [],
};

/** A connection of one instance of the ollama system, over the in-process link. */
function connectionOf(instance: InstanceName): SystemConnection {
  const hub = linkServer();
  return { ...new TestSystem('ollama', hub).connection(hub), instance };
}

describe('runtime providers', () => {
  it('are each instance\'s own in the catalog: another instance can neither change nor drop them', () => {
    const desk = fromInstance(undefined, { ...EMPTY, providers: [runtime(DESK, ['a'])] }, DESK);
    // laptop sends its own, and a claim to desk's, which is ignored
    const both = fromInstance(desk, { ...EMPTY, providers: [runtime(LAPTOP, ['b']), runtime(DESK, ['evil'])] }, LAPTOP);
    expect(both.providers?.map((p) => [p.name, p.models.map((m) => m.id)])).toEqual([['laptop', ['b']], ['desk', ['a']]]);
    // desk drops a model: its own provider changes, laptop's stays
    const after = fromInstance(both, { ...EMPTY, providers: [runtime(DESK, [])] }, DESK);
    expect(after.providers?.map((p) => [p.name, p.models.length])).toEqual([['desk', 0], ['laptop', 1]]);
    // a manifest with no providers at all keeps none
    expect(fromInstance(undefined, EMPTY, DESK).providers).toBeUndefined();
  });

  it('are offered while their instance is connected, routed to it, and a change to their models is heard', async () => {
    const bus = new RecordingBus();
    const { log } = memoryLog();
    let connected = [connectionOf(DESK)];
    let providers = [runtime(DESK, ['a']), runtime(LAPTOP, ['b'])];
    const asked: Array<InstanceName | undefined> = [];
    const source = new SystemProviderSource({
      link: { connected: () => connected, connection: (_system, instance) => { asked.push(instance); return connected.find((c) => c.instance === instance); } },
      catalog: { manifest: () => Promise.resolve({ ...EMPTY, providers }) },
      bus, log,
    });
    const loaded = await source.load();
    expect(Object.keys(loaded)).toEqual(['ollama/desk']);
    for (const provider of Object.values(loaded)) { await provider.checkHealth(); }
    expect(asked).toEqual([DESK]);

    let changes = 0;
    source.watch(() => { changes += 1; });
    // the same providers again: nothing to rebuild
    bus.publish('catalog.changed', { added: [], removed: [], fns: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changes).toBe(0);
    // desk's models changed (an admin offered one): the hub AI is rebuilt
    providers = [runtime(DESK, ['a', 'c']), runtime(LAPTOP, ['b'])];
    bus.publish('catalog.changed', { added: [], removed: [], fns: [] });
    await expect.poll(() => changes).toBe(1);
    await source.load();
    // laptop connects: its provider is offered too
    connected = [connectionOf(DESK), connectionOf(LAPTOP)];
    bus.publish('system.status', { system: OLLAMA, status: 'connected' });
    await expect.poll(() => changes).toBe(2);
    expect(Object.keys(await source.load()).sort()).toEqual(['ollama/desk', 'ollama/laptop']);
  });

  it('move without a review only while every model is free and both sides are runtime providers', () => {
    const change = (before: SystemProviderDecl | undefined, after: SystemProviderDecl | undefined): ContractChange => ({
      section: 'providers', name: 'ollama/desk', change: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed', origin: 'contract',
      ...(before === undefined ? {} : { before: Json.parse(before) }),
      ...(after === undefined ? {} : { after: Json.parse(after) }),
    });
    expect(runtimeProviderChange(change(runtime(DESK, ['a']), runtime(DESK, ['a', 'b'])))).toBe(true);
    expect(runtimeProviderChange(change(undefined, runtime(LAPTOP, [])))).toBe(true);
    expect(runtimeProviderChange(change(runtime(LAPTOP, ['a']), undefined))).toBe(true);
    // a price, or a provider that isn't runtime, waits for an admin
    expect(runtimeProviderChange(change(runtime(DESK, []), { ...runtime(DESK, []), models: [model('paid', 1)] }))).toBe(false);
    const { runtime: _r, instance: _i, ...plain } = runtime(DESK, ['a']);
    expect(runtimeProviderChange(change(plain, runtime(DESK, ['a'])))).toBe(false);
    expect(runtimeProviderChange({ section: 'fns', name: 'ollama/pull', change: 'added', origin: 'contract', after: {} })).toBe(false);
  });
});
