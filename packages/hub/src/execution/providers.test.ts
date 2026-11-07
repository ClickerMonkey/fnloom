import { ActorId, mintId, SecretId, type SecretId as SecretIdType } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryLog, testStore } from '../testing.ts';
import { buildProvider, openRouterProviders, ProviderUnavailable, StoredProviders, type ProviderSource } from './providers.ts';
import { ScriptedProvider, TEST_MODEL, executionRig, type ExecutionRig } from './testing.ts';

const OWNER = ActorId.parse('act_hub');

/** A vault in memory. */
class MemoryVault {
  readonly values = new Map<SecretIdType, string>();
  store(input: { value: string }): Promise<SecretIdType> {
    const id = mintId('secret');
    this.values.set(id, input.value);
    return Promise.resolve(id);
  }
  reveal(id: SecretIdType): Promise<string | undefined> {
    return Promise.resolve(this.values.get(id));
  }
}

async function stored(seed?: string) {
  const store = await testStore();
  const vault = new MemoryVault();
  const { log, records } = memoryLog();
  const providers = new StoredProviders({ store, secrets: vault, log, clock: () => 7, seed: seed === undefined ? undefined : { key: seed, owner: OWNER } });
  return { store, vault, records, providers };
}

describe('stored providers', () => {
  it('builds OpenAI and OpenRouter from their records with the keys revealed', async () => {
    const key = (id: SecretIdType): Promise<string> => Promise.resolve(`key of ${id}`);
    const openai = await buildProvider({ provider: 'openai', apiKey: SecretId.parse('sec_1'), baseURL: 'https://llm.example.com/v1' }, key);
    expect(openai.name).toBe('openai');
    expect((await buildProvider({ provider: 'openrouter', apiKey: SecretId.parse('sec_2') }, key)).name).toBe('openrouter');
    await expect(buildProvider({ provider: 'aws', region: 'us-east-1' }, key)).rejects.toBeInstanceOf(ProviderUnavailable);
    await expect(buildProvider({ provider: 'replicate', apiKey: SecretId.parse('sec_3') }, key)).rejects.toMatchObject({ provider: 'replicate' });
  });

  it('seeds the bootstrap OpenRouter key as the first record, once', async () => {
    const { store, vault, providers } = await stored('sk-or-boot');
    expect(Object.keys(await providers.load())).toEqual(['openrouter']);
    expect(Object.keys(await providers.load())).toEqual(['openrouter']);
    const records = (await store.table('providers').find({ limit: 5 })).items;
    expect(records).toHaveLength(1);
    const config = records[0]?.config;
    if (config?.provider !== 'openrouter') { throw new Error('expected an openrouter record'); }
    expect(await vault.reveal(config.apiKey)).toBe('sk-or-boot');
  });

  it('uses the stored records over the bootstrap key, and leaves out the ones it can’t build', async () => {
    const { store, vault, records, providers } = await stored('sk-or-boot');
    const apiKey = await vault.store({ value: 'sk-openai' });
    await store.table('providers').insert({ id: mintId('provider'), config: { provider: 'openai', apiKey }, createdAt: 1 });
    await store.table('providers').insert({ id: mintId('provider'), config: { provider: 'openrouter', apiKey: SecretId.parse('sec_gone') }, createdAt: 2 });
    await store.table('providers').insert({ id: mintId('provider'), config: { provider: 'aws', region: 'eu-west-1' }, createdAt: 3 });
    expect(Object.keys(await providers.load())).toEqual(['openai']);
    expect(records.filter((r) => r.msg === 'provider.unusable').map((r) => r['provider']).sort()).toEqual(['aws', 'openrouter']);
    expect(records.some((r) => r.msg === 'provider.seeded')).toBe(false);
  });

  it('gives no providers without records or a key', async () => {
    const { providers } = await stored();
    expect(await providers.load()).toEqual({});
    expect(openRouterProviders(undefined)).toEqual({});
  });
});

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

describe('the hub AI over stored providers', () => {
  it('starts with the stored providers and is rebuilt with new ones on reload', async () => {
    let current: Awaited<ReturnType<ProviderSource['load']>> = {};
    const source: ProviderSource = { load: () => Promise.resolve(current) };
    const r = await executionRig({ llm: { stored: source, models: [TEST_MODEL] } });
    rig = r;
    expect(await r.module.llm.models()).toEqual([]);
    current = { scripted: new ScriptedProvider() };
    await r.module.start();
    expect((await r.module.llm.models()).map((m) => m.id)).toEqual(['test-model']);
    current = {};
    await r.module.providers.reload();
    expect(await r.module.llm.models()).toEqual([]);
  });
});
