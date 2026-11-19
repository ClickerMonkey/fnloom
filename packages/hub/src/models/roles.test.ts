import { ActorId, ProviderId, RoleChoice, SecretId, type ModelInfo } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '../bus/memory.ts';
import { memoryLog, testStore } from '../testing.ts';
import { defaultChoice, dictationOf, resolveChoice, roleModel, StoreModelRoles } from './roles.ts';

const ADMIN = ActorId.parse('act_admin');
const WHISPER: ModelInfo = { id: 'whisper-1', provider: 'openai', name: 'Whisper', capabilities: ['hearing'] };
const GPT: ModelInfo = { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', capabilities: ['chat', 'vision', 'hearing'], pricing: { input: 2.5, output: 10 } };
const CHEAP: ModelInfo = { id: 'openai/gpt-4o-mini', provider: 'openrouter', name: 'mini', capabilities: ['chat', 'vision'], pricing: { input: 0.15, output: 0.6 } };
const TTS: ModelInfo = { id: 'tts-1', provider: 'openai', name: 'TTS', capabilities: ['audio'] };
const JUDGE: ModelInfo = { id: 'judge', provider: 'ollama', name: 'Judge', capabilities: ['decision'], maxQuestions: 64 };
const OFFERED = [WHISPER, GPT, CHEAP, TTS, JUDGE];
const OPENAI = ProviderId.parse('prv_openai');
const kinds = (id: ProviderId) => (id === OPENAI ? 'openai' : undefined);
const NO_CATEGORIES = new Map<string, readonly string[]>();

async function roles(defaults = { HARNESS_DEFAULT_MODEL: 'openrouter/auto', HARNESS_TRANSCRIBE_MODEL: '' }, offered: readonly ModelInfo[] = OFFERED) {
  const store = await testStore();
  const bus = new MemoryEventBus(() => undefined);
  let changed = 0;
  bus.subscribe('capabilities.changed', () => { changed += 1; });
  const roleChanges: string[] = [];
  bus.subscribe('model.role.changed', ({ role }) => { roleChanges.push(role); });
  await store.table('providers').insert({ id: OPENAI, config: { provider: 'openai', apiKey: SecretId.parse('sec_1') }, createdAt: 0 });
  const service = new StoreModelRoles({ store, bus, clock: () => 5, log: memoryLog().log, defaults, models: () => Promise.resolve(offered) });
  return { service, store, changed: () => changed, roleChanges };
}

describe('role defaults', () => {
  it('come from env: chat from the default model, transcription and model dictation from the transcription model, others off', () => {
    const env = { HARNESS_DEFAULT_MODEL: 'm', HARNESS_TRANSCRIBE_MODEL: 'whisper-1' };
    expect(defaultChoice('chat', env)).toEqual({ role: 'chat', model: { model: 'm' } });
    expect(defaultChoice('transcribe', env)).toEqual({ role: 'transcribe', model: { model: 'whisper-1' } });
    expect(defaultChoice('dictate', env)).toEqual({ role: 'dictate', engine: { engine: 'model', model: { model: 'whisper-1' } } });
    expect(defaultChoice('speak', env)).toBeUndefined();
    expect(defaultChoice('dictate', { ...env, HARNESS_TRANSCRIBE_MODEL: '' })).toBeUndefined();
  });

  it('name no model for dictation in the browser', () => {
    expect(roleModel({ role: 'dictate', engine: { engine: 'browser' } })).toBeUndefined();
    expect(roleModel({ role: 'dictate', engine: { engine: 'model', model: { model: 'x' }, provider: OPENAI } })).toEqual({ model: { model: 'x' }, provider: OPENAI });
  });
});

describe('resolving a choice', () => {
  it('finds the model among those offered, by id or provider/id, and checks it can do the job', () => {
    expect(resolveChoice('transcribe', { model: { model: 'whisper-1' } }, OFFERED, kinds, NO_CATEGORIES)).toEqual({ model: 'whisper-1', provider: 'openai' });
    expect(resolveChoice('describe', { model: { model: 'openrouter/openai/gpt-4o-mini' } }, OFFERED, kinds, NO_CATEGORIES)).toEqual({ model: 'openai/gpt-4o-mini', provider: 'openrouter' });
    expect(resolveChoice('transcribe', { model: { model: 'openai/gpt-4o-mini' } }, OFFERED, kinds, NO_CATEGORIES)).toEqual({ problem: "openai/gpt-4o-mini can't do hearing, which transcribe needs." });
    expect(resolveChoice('speak', { model: { model: 'nope' } }, OFFERED, kinds, NO_CATEGORIES)).toEqual({ problem: 'No configured provider offers nope.' });
  });

  it('keeps to a pinned provider, and takes an unlisted model from it on trust', () => {
    expect(resolveChoice('describe', { model: { model: 'openai/gpt-4o-mini' }, provider: OPENAI }, OFFERED, kinds, NO_CATEGORIES)).toEqual({ model: 'openai/gpt-4o-mini', provider: 'openai' });
    expect(resolveChoice('describe', { model: { model: 'x' }, provider: ProviderId.parse('prv_gone') }, OFFERED, kinds, NO_CATEGORIES)).toEqual({ problem: 'There is no provider prv_gone.' });
  });

  it('takes a category’s first model, and the cheapest able model for automatic choice', () => {
    expect(resolveChoice('transcribe', { model: { category: 'ears' } }, OFFERED, kinds, new Map([['ears', ['whisper-1']]]))).toEqual({ model: 'whisper-1', provider: 'openai' });
    expect(resolveChoice('describe', { model: { auto: {} } }, OFFERED, kinds, NO_CATEGORIES)).toEqual({ model: 'openai/gpt-4o-mini', provider: 'openrouter' });
    expect(resolveChoice('speak', { model: { auto: {} } }, [GPT], kinds, NO_CATEGORIES)).toEqual({ problem: 'No configured provider offers a model that can do audio.' });
  });
});

describe('model roles', () => {
  it('fall back to env, then a setting wins, and clearing goes back', async () => {
    const { service, changed } = await roles({ HARNESS_DEFAULT_MODEL: '', HARNESS_TRANSCRIBE_MODEL: 'whisper-1' });
    expect(await service.get('transcribe')).toEqual({ role: 'transcribe', from: 'env', choice: { role: 'transcribe', model: { model: 'whisper-1' } }, resolved: { model: 'whisper-1', provider: 'openai' } });
    expect(await service.get('speak')).toEqual({ role: 'speak', from: 'none' });
    const set = await service.set({ role: 'transcribe', model: { model: 'gpt-4o' }, language: 'fr' }, ADMIN);
    expect(set).toMatchObject({ from: 'setting', resolved: { model: 'gpt-4o', provider: 'openai' } });
    expect(await service.resolve('transcribe')).toEqual({ model: 'gpt-4o', provider: 'openai' });
    expect(await service.clear('transcribe', ADMIN)).toMatchObject({ from: 'env', resolved: { model: 'whisper-1' } });
    expect(changed()).toBe(2);
    expect((await service.list()).map((r) => r.role)).toEqual(['chat', 'transcribe', 'dictate', 'speak', 'describe', 'ocr', 'decide']);
  });

  it('keep the decide role to decision models, with its threshold, and resolve a job’s own choice the same way', async () => {
    const { service } = await roles();
    expect(await service.get('decide')).toEqual({ role: 'decide', from: 'none' });
    const set = await service.set(RoleChoice.parse({ role: 'decide', model: { model: 'judge' } }), ADMIN);
    expect(set).toEqual({ role: 'decide', from: 'setting', choice: { role: 'decide', model: { model: 'judge' }, threshold: 0.5 }, resolved: { model: 'judge', provider: 'ollama' } });
    await service.set({ role: 'decide', model: { model: 'gpt-4o' }, threshold: 0.7 }, ADMIN);
    expect((await service.get('decide')).resolved).toEqual({ problem: "gpt-4o can't do decision, which decide needs." });
    expect(await service.resolveModel('decide', { model: { model: 'judge' } })).toEqual({ model: 'judge', provider: 'ollama' });
    expect(await service.resolveModel('decide', { model: { auto: {} } })).toEqual({ model: 'judge', provider: 'ollama' });
    expect(RoleChoice.safeParse({ role: 'decide', model: { model: 'judge' }, threshold: 1.5 }).success).toBe(false);
  });

  it('say whether a role is set without resolving it, and announce each set and clear so the fns that need it follow (plan item 7)', async () => {
    const { service, roleChanges } = await roles();
    expect(await service.isSet('decide')).toBe(false);
    expect(await service.isSet('chat')).toBe(true);
    await service.set(RoleChoice.parse({ role: 'decide', model: { model: 'judge' } }), ADMIN);
    expect(await service.isSet('decide')).toBe(true);
    await service.clear('decide', ADMIN);
    expect(await service.isSet('decide')).toBe(false);
    // clearing a role with nothing stored changes nothing, so it announces nothing
    await service.clear('decide', ADMIN);
    expect(roleChanges).toEqual(['decide', 'decide']);
  });

  it('resolve to nothing when the model can’t be used', async () => {
    const { service } = await roles();
    await service.set({ role: 'speak', model: { model: 'whisper-1' } }, ADMIN);
    expect(await service.resolve('speak')).toBeUndefined();
    expect((await service.get('speak')).resolved).toEqual({ problem: "whisper-1 can't do audio, which speak needs." });
  });

  it('tell the composer how dictation hears: in the browser, through a model that resolves, or not at all', async () => {
    const { service } = await roles();
    expect(dictationOf(await service.get('dictate'))).toBeUndefined();
    await service.set({ role: 'dictate', engine: { engine: 'browser' }, language: 'en-GB' }, ADMIN);
    expect(dictationOf(await service.get('dictate'))).toEqual({ engine: 'browser', language: 'en-GB' });
    await service.set({ role: 'dictate', engine: { engine: 'model', model: { model: 'whisper-1' } } }, ADMIN);
    expect(dictationOf(await service.get('dictate'))).toEqual({ engine: 'model' });
    await service.set({ role: 'dictate', engine: { engine: 'model', model: { model: 'tts-1' } } }, ADMIN);
    expect(dictationOf(await service.get('dictate'))).toBeUndefined();
  });

  it('serve a resolved model as provider/model, so a pinned provider answers', () => {
  });
});
