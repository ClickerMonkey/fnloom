/**
 * A runtime provider (`provider({ models: 'runtime' })`): the contract has none of its models; the running system sets
 * them with `running.models`, and each instance sends it named after itself and owned by it, so the hub routes its
 * calls there. Served over the real link to an in-memory hub (`FakeHub`).
 */
import type { ModelInfo, Provider } from '@aeye/ai';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceName, type ProviderModelDecl } from '@harness/core';
import { g } from '../gin.ts';
import { provider } from '../providers.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

const local = system('local', { description: 'Local models.' }).with({
  config: g.obj({}),
  providers: { server: provider({ description: 'What an admin offers.', models: 'runtime' }) },
});

const MODEL: ProviderModelDecl = { id: 'small:latest', capabilities: ['chat', 'tools'], contextWindow: 8_192, pricing: { input: 0, output: 0 }, caching: false };

/** A provider whose server has `small:latest` and `big:latest`. */
class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly config = {};
  checkHealth(): Promise<boolean> { return Promise.resolve(true); }
  listModels(): Promise<ModelInfo[]> {
    const info = (id: string): ModelInfo => ({ id, provider: 'fake', name: id, capabilities: new Set(['chat']), tier: 'efficient', contextWindow: 4_096, pricing: {} });
    return Promise.resolve([info('small:latest'), info('big:latest')]);
  }
}
const fakeProvider = (): Provider => new FakeProvider();

describe('a runtime provider', () => {
  let running: RunningSystem<'local'> | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it('is sent named after the instance, gets its models at runtime, and lists only those', async () => {
    const hub = new FakeHub({ config: {}, instance: InstanceName.parse('desk') });
    running = await serve(local, { providers: { server: () => fakeProvider() } }, { hub: 'ws://hub.test/link', state: 'unused', version: '0.0.0' }, hub.host());
    await running.ready();
    expect(hub.manifests[0]?.providers).toEqual([{ name: 'desk', description: 'What an admin offers.', models: [], runtime: true, instance: 'desk' }]);

    const peer = hub.peer();
    // nothing offered yet: the provider lists nothing, and a call for a model is refused
    expect(await peer.call('providerModels', { provider: 'desk' })).toEqual({ listed: true, models: [] });

    await running.models(local.providers.server, [MODEL]);
    const patch = hub.patches.at(-1);
    expect(patch?.lists?.providers).toEqual([{ name: 'desk', description: 'What an admin offers.', models: [MODEL], runtime: true, instance: 'desk' }]);
    expect(await peer.call('providerModels', { provider: 'desk' })).toEqual({ listed: true, models: [{ id: 'small:latest', contextWindow: 4_096 }] });
    // the contract's own name is not a provider the hub can call
    await expect(peer.call('providerModels', { provider: 'server' })).rejects.toThrow(/No provider server/);
  });

  it('refuses models for a system with none, and checks them', async () => {
    const plain = system('plain', { description: 'No providers.' }).with({ config: g.obj({}) });
    const hub = new FakeHub({ config: {} });
    const other = await serve(plain, {}, { hub: 'ws://hub.test/link', state: 'unused', version: '0.0.0' }, hub.host());
    await other.ready();
    await expect(other.models({ ref: 'provider', name: 'plain/server' }, [MODEL])).rejects.toThrow(/not plain's runtime provider/);
    await other.stop();

    const hub2 = new FakeHub({ config: {} });
    running = await serve(local, { providers: { server: () => fakeProvider() } }, { hub: 'ws://hub.test/link', state: 'unused', version: '0.0.0' }, hub2.host());
    await running.ready();
    await expect(running.models(local.providers.server, [MODEL, MODEL])).rejects.toThrow(/declared twice/);
  });

  it('is one per contract', async () => {
    const two = system('two', { description: 'Two.' }).with({
      config: g.obj({}),
      providers: { a: provider({ description: 'A.', models: 'runtime' }), b: provider({ description: 'B.', models: 'runtime' }) },
    });
    const hub = new FakeHub({ config: {} });
    await expect(serve(two, { providers: { a: () => fakeProvider(), b: () => fakeProvider() } }, { hub: 'ws://hub.test/link', state: 'unused', version: '0.0.0' }, hub.host()))
      .rejects.toThrow(/more than one runtime provider/);
  });
});
