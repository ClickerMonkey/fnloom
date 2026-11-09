import { LlmInteractionId, RunId, SessionId, SystemName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { memoryLog, testStore } from '../testing.ts';
import { emptyUnits, StoreModelCallLog } from './calls.ts';

async function log() {
  const store = await testStore();
  const time = { now: 1_000 };
  let n = 0;
  const calls = new StoreModelCallLog({ store, clock: () => time.now, log: memoryLog().log, random: () => `${++n}` });
  return { store, time, calls };
}

describe('the model call log', () => {
  it('opens a call after its queue wait, and closes it once with its units, cost and timings', async () => {
    const { calls, time } = await log();
    const open = await calls.begin({ modality: 'transcribe', provider: 'openai', model: 'whisper-1', run: RunId.parse('run_1'), system: SystemName.parse('fs'), priority: 'normal' }, 400);
    expect(await calls.get(open.id)).toMatchObject({ status: 'running', queued: 600, startedAt: 1_000, units: emptyUnits('transcribe'), run: 'run_1', system: 'fs' });
    time.now = 1_200;
    open.firstByte();
    open.firstByte(1_250);
    time.now = 1_500;
    const done = await open.done({ units: { modality: 'transcribe', seconds: 3, bytes: 900 }, cost: 0.006, sent: 900, received: 40 });
    expect(done).toMatchObject({ status: 'done', firstByte: 200, total: 500, endedAt: 1_500, cost: 0.006, units: { seconds: 3 }, sent: 900, received: 40 });
    // closing again changes nothing
    expect(await open.failed('late', false)).toEqual(done);
  });

  it('records failures and aborts with why', async () => {
    const { calls } = await log();
    const a = await calls.begin({ modality: 'image', provider: 'openai', model: 'gpt-image-1', purpose: 'form:thumbnail' }, 1_000);
    const b = await calls.begin({ modality: 'speech', provider: 'openai', model: 'tts-1', purpose: 'speak' }, 1_000);
    expect(await a.failed('content policy', false)).toMatchObject({ status: 'failed', error: 'content policy', purpose: 'form:thumbnail' });
    expect(await b.failed('stopped', true)).toMatchObject({ status: 'aborted' });
    // a failed chat call still points at the interaction it saved
    const chat = await calls.begin({ modality: 'chat', provider: 'ollama', model: 'small' }, 1_000);
    expect(await chat.failed('400 no tools', false, LlmInteractionId.parse('llm_1'))).toMatchObject({ status: 'failed', interaction: 'llm_1' });
  });

  it('lists newest first, or the calls of one run', async () => {
    const { calls, time } = await log();
    const session = SessionId.parse('ses_1');
    await (await calls.begin({ modality: 'embed', provider: 'p', model: 'e', session }, 0)).done({ units: emptyUnits('embed'), cost: 0, sent: 0, received: 0 });
    time.now = 2_000;
    await calls.begin({ modality: 'chat', provider: 'p', model: 'c', session }, 0);
    time.now = 3_000;
    await calls.begin({ modality: 'chat', provider: 'p', model: 'd' }, 0);
    expect((await calls.list({})).items.map((c) => c.model)).toEqual(['d', 'c', 'e']);
    expect((await calls.list({ run: RunId.parse('run_none') })).items).toEqual([]);
    const first = await calls.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect((await calls.list({ limit: 2, cursor: first.cursor })).items.map((c) => c.model)).toEqual(['e']);
  });
});
