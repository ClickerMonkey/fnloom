import { ModelCallId, ModelCategoryId, RunId, SystemName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import type { LlmGateway, Recorded } from '../execution/index.ts';
import { MemoryFiles } from '../api/testing/rig.ts';
import { FileContentStore } from '../api/files.ts';
import { memoryLog, testStore } from '../testing.ts';
import { HubModelGateway, NoModel } from './gateway.ts';
import type { ModelSite } from './index.ts';

const FS = SystemName.parse('fs');
const RUN = RunId.parse('run_1');
const SITE: ModelSite = { system: FS, run: RUN };

/** What the fake execution gateway was asked, and its answers (each recorded as `mdl_1` for $0.01). */
async function rig(roles: Record<string, { model: string; provider: string }> = {}) {
  const store = await testStore();
  const content = new FileContentStore({
    files: new MemoryFiles(), presign: { presignUpload: (key) => Promise.resolve(key), presignDownload: (key) => Promise.resolve(key) }, maxUpload: 1_000_000, presignTtl: 60_000, clock: () => 0,
  });
  const asked: Array<{ modality: string; input: unknown; site: ModelSite }> = [];
  const recorded = <T>(value: T): Promise<Recorded<T>> => Promise.resolve({ value, call: ModelCallId.parse('mdl_1'), cost: 0.01, model: 'served' });
  const llm: Pick<LlmGateway, 'embed' | 'image' | 'transcribe' | 'speech'> = {
    embed: (input, site) => { asked.push({ modality: 'embed', input, site }); return recorded(input.texts.map((t) => [t.length])); },
    image: (input, site) => { asked.push({ modality: 'image', input, site }); return recorded([{ bytes: new Uint8Array([1, 2]), mime: 'image/png' }]); },
    transcribe: (input, site) => { asked.push({ modality: 'transcribe', input, site }); return recorded({ text: `heard ${input.audio.length}`, segments: [{ start: 0, end: 1, text: 'hi' }] }); },
    speech: (input, site) => { asked.push({ modality: 'speech', input, site }); return recorded({ audio: new Uint8Array([7, 7, 7]), mime: 'audio/mpeg' }); },
  };
  const gateway = new HubModelGateway({
    store, log: memoryLog().log, llm, content,
    roles: { resolve: (role) => Promise.resolve(roles[role]) },
  });
  return { gateway, asked, content, store };
}

const live = () => new AbortController().signal;

describe('the model gateway', () => {
  it('embeds with the model asked for, answering with the call’s record', async () => {
    const { gateway, asked } = await rig();
    expect(await gateway.forward({ modality: 'embed', texts: ['ab', 'c'], model: { model: 'text-embedding-3-small' } }, SITE, live()))
      .toEqual({ modality: 'embed', vectors: [[2], [1]], call: 'mdl_1', cost: 0.01, model: 'served' });
    expect(asked).toEqual([{ modality: 'embed', input: { texts: ['ab', 'c'], metadata: { model: 'text-embedding-3-small' } }, site: SITE }]);
  });

  it('keeps made images and speech in the content store and answers with refs', async () => {
    const { gateway, content } = await rig({ speak: { model: 'tts-1', provider: 'openai' } });
    const image = await gateway.forward({ modality: 'image', prompt: 'a cat', size: '512x512' }, SITE, live());
    if (image.modality !== 'image') throw new Error('not an image answer');
    expect(image.images).toHaveLength(1);
    expect(await content.read(image.images[0] ?? { hash: '', size: 0, mime: '' }, 0, 2)).toEqual(new Uint8Array([1, 2]));
    const spoken = await gateway.forward({ modality: 'speech', text: 'hello', voice: 'alloy' }, SITE, live());
    expect(spoken).toMatchObject({ modality: 'speech', audio: { size: 3, mime: 'audio/mpeg' } });
  });

  it('hears audio from the content store with the transcription role’s model, pinned to the role’s provider', async () => {
    const { gateway, asked, content } = await rig({ transcribe: { model: 'whisper-1', provider: 'openai' } });
    const audio = await content.put(new Uint8Array(9), 'audio/webm');
    expect(await gateway.forward({ modality: 'transcribe', audio, language: 'en' }, { purpose: 'form:transcript' }, live()))
      .toMatchObject({ modality: 'transcribe', text: 'heard 9', segments: [{ start: 0, end: 1, text: 'hi' }] });
    expect(asked[0]).toMatchObject({ input: { mime: 'audio/webm', language: 'en', metadata: { model: 'whisper-1', provider: 'openai' } }, site: { purpose: 'form:transcript' } });
  });

  it('uses the role it is asked to (dictation) when the request names no model', async () => {
    const { gateway, asked, content } = await rig({ transcribe: { model: 'whisper-1', provider: 'openai' }, dictate: { model: 'gpt-4o-transcribe', provider: 'openrouter' } });
    const audio = await content.put(new Uint8Array(4), 'audio/webm');
    await gateway.forward({ modality: 'transcribe', audio }, { purpose: 'dictation' }, live(), 'dictate');
    expect(asked[0]).toMatchObject({ input: { metadata: { model: 'gpt-4o-transcribe', provider: 'openrouter' } } });
  });

  it('refuses a job whose role has no model, and reads categories and weights', async () => {
    const { gateway, asked, store } = await rig();
    await expect(gateway.forward({ modality: 'speech', text: 'hello' }, SITE, live())).rejects.toBeInstanceOf(NoModel);
    await store.table('modelCategories').insert({ id: ModelCategoryId.parse('mct_1'), name: 'voices', description: '', models: ['tts-hd'] });
    await gateway.forward({ modality: 'speech', text: 'hello', model: { category: 'voices' } }, SITE, live());
    await gateway.forward({ modality: 'embed', texts: ['x'], model: { auto: { cost: 1 } } }, SITE, live());
    await gateway.forward({ modality: 'image', prompt: 'x' }, SITE, live());
    expect(asked.map((a) => a.input)).toMatchObject([{ metadata: { model: 'tts-hd' } }, { metadata: { weights: { cost: 1 } } }, { metadata: {} }]);
    await expect(gateway.forward({ modality: 'speech', text: 'hello', model: { category: 'none' } }, SITE, live())).rejects.toThrow(/has no models/);
  });
});
