/**
 * Providers systems bring: a declared provider becomes an aeye provider on the hub AI whose calls go over the
 * system's link, are recorded as model calls (with their cache reads and whether the model caches), and whose set
 * follows the systems that are connected.
 */
import type { Providers } from '@aeye/ai';
import { limiter } from '@ayepi/rate';
import { SystemName, type Manifest, type SystemProviderDecl } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';
import { AeyeLlm, cacheSupportOf, createHubAi, HubAiHooks, SwitchingLlm } from '../execution/ai.ts';
import { InteractionRecorder } from '../execution/interactions.ts';
import { HubLedger } from '../execution/ledger.ts';
import { LedgerSpend } from '../execution/spend.ts';
import { linkServer, testSettings, TestSystem } from '../execution/testing.ts';
import { StoreModelCallLog } from '../metrics/calls.ts';
import type { SystemConnection } from '../link/index.ts';
import { JoinedProviderSource, RemoteProvider, remoteModelInfo, SystemProviderSource } from './remote.ts';

const SHOP = SystemName.parse('shop');
const LOCAL: SystemProviderDecl = {
  name: 'local',
  description: 'Models on the shop box.',
  models: [
    { id: 'tiny', capabilities: ['chat', 'streaming', 'made-up'], contextWindow: 4096, pricing: { input: 1, output: 2, cached: 0.5 }, caching: true },
    { id: 'vec', capabilities: ['embedding'], contextWindow: 512, pricing: { input: 0.1, output: 0 }, caching: false },
  ],
};

/** A connected shop system whose provider streams two words and reports cache reads. */
function connectedShop(): { shop: TestSystem; connection: SystemConnection } {
  const hub = linkServer();
  const shop = new TestSystem('shop', hub);
  shop.behaviour.providerChat = async function* chat(input) {
    yield { type: 'chunk', chunk: { content: `hello ${input.model}` } };
    yield { type: 'chunk', chunk: { finishReason: 'stop' } };
    yield { type: 'done', usage: { input: 1_000, output: 10, cached: 800 } };
  };
  return { shop, connection: shop.connection(hub) };
}

async function hubAi(connection: SystemConnection) {
  const store = await testStore();
  const { log } = memoryLog();
  let n = 0;
  const base = { store, bus: new RecordingBus(), clock: () => 1_000, random: () => `${++n}`, settings: testSettings(), log };
  const calls = new StoreModelCallLog({ store, clock: base.clock, log, random: base.random });
  const hooks = new HubAiHooks({
    ...base, ledger: new HubLedger(base, new LedgerSpend(store)), recorder: new InteractionRecorder(base), calls,
    costs: { addCost: () => Promise.resolve(), addTokens: () => Promise.resolve() }, modelLimit: limiter({ limit: 10, window: 60_000 }),
  });
  const remote = new RemoteProvider(SHOP, LOCAL, () => connection);
  const ai = createHubAi({ providers: { [remote.name]: remote }, hooks, log, models: await remote.listModels() });
  return { ai, store, remote, hooks, log };
}

describe('remote providers', () => {
  it('turn declared models into aeye model info, keeping only known abilities and marking caching models', () => {
    const [tiny, vec] = LOCAL.models.map((m) => remoteModelInfo('shop/local', m));
    expect(tiny).toMatchObject({ id: 'tiny', provider: 'shop/local', contextWindow: 4096, pricing: { text: { input: 1, output: 2, cached: 0.5 } } });
    expect([...(tiny?.capabilities ?? [])]).toEqual(['chat', 'streaming']);
    expect(cacheSupportOf(tiny)).toBe('yes');
    expect(cacheSupportOf(vec)).toBe('no');
    expect(cacheSupportOf({ pricing: {} })).toBe('unknown');
    expect(cacheSupportOf(undefined)).toBe('unknown');
  });

  it('send a chat call over the link and record it with its cache reads and caching support', async () => {
    const { shop, connection } = connectedShop();
    const { ai, store } = await hubAi(connection);
    const response = await ai.chat.get({ messages: [{ role: 'user', content: 'hi' }] }, { metadata: { model: 'tiny' } });
    expect(response.content).toBe('hello tiny');
    expect(shop.chats).toMatchObject([{ provider: 'local', model: 'tiny', request: { messages: [{ role: 'user', content: 'hi' }] } }]);
    const [call] = (await store.table('modelCalls').find({ limit: 5 })).items;
    expect(call).toMatchObject({ modality: 'chat', provider: 'shop/local', model: 'tiny', status: 'done', units: { modality: 'chat', input: 1_000, output: 10, cached: 800, caching: 'yes' } });
    expect(call?.cost).toBeGreaterThan(0);
  });

  it('embed over the link', async () => {
    const { shop, connection } = connectedShop();
    shop.behaviour.providerEmbed = (input) => ({ vectors: input.texts.map((t) => [t.length, 1]), tokens: 4 });
    const remote = new RemoteProvider(SHOP, LOCAL, () => connection);
    const response = await remote.embed({ texts: ['ab', 'c'] }, { metadata: { model: 'vec' } });
    expect(response.embeddings.map((e) => e.embedding)).toEqual([[2, 1], [1, 1]]);
    expect(response.usage).toEqual({ text: { input: 4 } });
  });

  it('embed through the hub engine, which keeps its callers while new providers are swapped in', async () => {
    const { shop, connection } = connectedShop();
    shop.behaviour.providerEmbed = (input) => ({ vectors: input.texts.map((t) => [t.length, 1]), tokens: 4 });
    const { store, remote, hooks, log } = await hubAi(connection);
    const make = (providers: Providers) => new AeyeLlm(createHubAi({ providers, hooks, log, models: LOCAL.models.map((m) => remoteModelInfo(remote.name, m)) }));
    const engine = new SwitchingLlm(make, {});
    expect(engine.models()).toEqual([]);
    await engine.use({ [remote.name]: remote });
    expect(engine.models().map((m) => m.id).sort()).toEqual(['tiny', 'vec']);
    expect(await engine.embed({ texts: ['ab', 'c'], metadata: { model: 'vec' } }, { purpose: 'test' })).toEqual([[2, 1], [1, 1]]);
    const [call] = (await store.table('modelCalls').find({ limit: 5 })).items;
    expect(call).toMatchObject({ modality: 'embed', provider: 'shop/local', model: 'vec', status: 'done' });
    // the shop serves no images, transcription or speech: those calls fail rather than go elsewhere
    await expect(engine.image({ prompt: 'a cat', metadata: { model: 'tiny' } }, { purpose: 'test' })).rejects.toThrow();
    await expect(engine.transcribe({ audio: new Uint8Array([1]), mime: 'audio/wav', metadata: { model: 'tiny' } }, { purpose: 'test' })).rejects.toThrow();
    await expect(engine.speech({ text: 'hi', format: 'ogg', metadata: { model: 'tiny' } }, { purpose: 'test' })).rejects.toThrow();
  });

  it('stream a chat call with the model given as model info, and throw the error the system sends', async () => {
    const { shop, connection } = connectedShop();
    const remote = new RemoteProvider(SHOP, LOCAL, () => connection);
    const texts: string[] = [];
    for await (const chunk of remote.createStreamer()({ messages: [{ role: 'user', content: 'hi' }] }, {}, { model: { id: 'tiny' } })) {
      if (chunk.content !== undefined) texts.push(chunk.content);
    }
    expect(texts).toEqual(['hello tiny']);
    shop.behaviour.providerChat = async function* refuse() {
      yield { type: 'error', message: 'out of credit', kind: 'limit' };
    };
    const stream = remote.createStreamer()({ messages: [{ role: 'user', content: 'hi' }] }, {}, { model: 'tiny' });
    await expect(stream.next()).rejects.toThrow('shop/local: out of credit');
  });

  it('fail a call while the system is away', async () => {
    const remote = new RemoteProvider(SHOP, LOCAL, () => undefined);
    expect(await remote.checkHealth()).toBe(false);
    await expect(remote.embed({ texts: ['x'] }, { metadata: { model: 'vec' } })).rejects.toThrow(/not connected/);
  });

  it('follow the connected systems that declare providers, and say when that set changes', async () => {
    const { connection } = connectedShop();
    const bus = new RecordingBus();
    const { log } = memoryLog();
    let connected: SystemConnection[] = [];
    const manifest: Pick<Manifest, 'providers'> = { providers: [LOCAL] };
    const source = new SystemProviderSource({
      link: { connected: () => connected, connection: (system) => connected.find((c) => c.system === system) },
      catalog: { manifest: (system) => Promise.resolve(system === SHOP ? { ...EMPTY_MANIFEST, ...manifest } : undefined) },
      bus, log,
    });
    const joined = new JoinedProviderSource([{ load: () => Promise.resolve({}) }, source]);
    expect(Object.keys(await joined.load())).toEqual([]);
    let changes = 0;
    joined.watch(() => { changes += 1; });
    connected = [connection];
    bus.publish('system.status', { system: SHOP, status: 'connected' });
    await expect.poll(() => changes).toBe(1);
    expect(Object.keys(await joined.load())).toEqual(['shop/local']);
    bus.publish('system.status', { system: SHOP, status: 'connected' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changes).toBe(1);
  });

  it('leave out a provider that is not offered (its system installed, or the provider switched off)', async () => {
    const { connection } = connectedShop();
    const bus = new RecordingBus();
    const { log } = memoryLog();
    let offered = false;
    const source = new SystemProviderSource({
      link: { connected: () => [connection], connection: () => connection },
      catalog: { manifest: () => Promise.resolve({ ...EMPTY_MANIFEST, providers: [LOCAL] }) },
      bus, log, offered: () => Promise.resolve(offered),
    });
    expect(Object.keys(await source.load())).toEqual([]);
    let changes = 0;
    source.watch(() => { changes += 1; });
    offered = true;
    bus.publish('capabilities.changed', {});
    await expect.poll(() => changes).toBe(1);
    expect(Object.keys(await source.load())).toEqual(['shop/local']);
  });
});

/** A manifest with nothing in it, for the fake catalog. */
const EMPTY_MANIFEST: Manifest = {
  name: SHOP, version: '1', description: '', hash: 'h', types: [], settings: [], attachments: [], kinds: [], fns: [], context: [], hooks: [], mentions: [], embedders: [],
  sectioners: [], actions: [], events: [], resources: false, config: { name: 'obj' }, requires: [],
};
