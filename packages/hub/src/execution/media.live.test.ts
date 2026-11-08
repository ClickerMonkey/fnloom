/**
 * Live: non-chat model calls through the hub AI on OpenAI, each recorded as a `ModelCall` with its units, cost and
 * timings: an embedding, speech made from text, and that speech transcribed back. Kept to three cheap calls. Run with
 * `npm run test:live`; skipped without `OPENAI_API_KEY`.
 */
import { OpenAIProvider } from '@aeye/openai';
import { env } from '@ayepi/env';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executionRig, type ExecutionRig } from './testing.ts';

/** The key this test reads (a test-only slice: the hub reads provider keys from its stored providers). */
const liveKeys = env({ OPENAI_API_KEY: z.string().optional() });

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); });

describe('non-chat model calls (live)', () => {
  const key = liveKeys.get('OPENAI_API_KEY');
  it.skipIf(key === undefined)('embed, speak and transcribe through the hub, each a recorded model call', async () => {
    rig = await executionRig({ llm: { providers: { openai: new OpenAIProvider({ apiKey: key ?? '' }) } } });
    await rig.module.start();
    const signal = new AbortController().signal;
    const site = { purpose: 'live-test' };

    const embedded = await rig.module.llm.embed({ texts: ['hello world'], metadata: { model: 'text-embedding-3-small' } }, site, signal);
    expect(embedded.value[0]?.length).toBe(1_536);

    const spoken = await rig.module.llm.speech({ text: 'Hello there, general.', metadata: { model: 'tts-1' }, format: 'mp3' }, site, signal);
    expect(spoken.value.audio.length).toBeGreaterThan(1_000);

    const heard = await rig.module.llm.transcribe({ audio: spoken.value.audio, mime: spoken.value.mime, metadata: { model: 'whisper-1' }, language: 'en' }, site, signal);
    expect(heard.value.text.toLowerCase()).toContain('hello');

    const calls = (await rig.calls.list({})).items;
    expect(calls.map((c) => `${c.modality} ${c.status} ${c.purpose ?? ''}`).sort()).toEqual(['embed done live-test', 'speech done live-test', 'transcribe done live-test']);
    expect(calls.find((c) => c.modality === 'embed')?.units).toMatchObject({ modality: 'embed', texts: 1, characters: 11, dimensions: 1_536 });
    expect(calls.find((c) => c.modality === 'transcribe')?.units).toMatchObject({ modality: 'transcribe', bytes: spoken.value.audio.length });
    expect(calls.every((c) => c.endedAt !== undefined && c.error === undefined)).toBe(true);
  }, 60_000);
});
