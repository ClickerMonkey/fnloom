import type { Chunk, Response, Streamer } from '@aeye/core';
import { LlmInteractionId, RunId, SystemName, TurnId, type LlmForward, type LlmForwardChunk, type Run } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { testStore, memoryLog } from '../testing.ts';
import { LlmRateLimited } from './errors.ts';
import { abortableSleep, HubLlmGateway } from './gateway.ts';
import type { HubCallContext, HubCallMetadata } from './scope.ts';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from './testing.ts';

const RUN = RunId.parse('run_fwd');
const TURN = TurnId.parse('trn_fwd');
const FS = SystemName.parse('fs');
const forward: LlmForward & { system: string } = { run: RUN, request: { messages: [{ role: 'user', content: 'hi' }] }, stream: true, system: FS };

/** A gateway over a stored run, a streamer that is rate limited `limited` times first, and a recording LLM doer. */
async function gateway(limited: number, retryAfter = 40) {
  const store = await testStore();
  await store.table('turns').insert({
    id: TURN, actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0, errors: 'feed-back', createdAt: 0,
  });
  const run: Run = {
    id: RUN, fn: 'fs/summarize', fnVersion: 'v1', kind: 'native', system: FS, root: RUN, turn: TURN, key: 'k', actor: ALICE, caller: ALICE, args: {}, status: 'running',
    allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
  };
  await store.table('runs').insert(run);
  const events: string[] = [];
  let held = 0;
  let calls = 0;
  const streamer: Streamer<HubCallContext, HubCallMetadata> = async function* (_request, context): AsyncGenerator<Chunk, Response> {
    calls += 1;
    if (calls <= limited) throw new LlmRateLimited('test-model', retryAfter);
    context.call?.record({ interaction: LlmInteractionId.parse('lli_1'), model: 'test-model', cost: 0.001, usage: { input: 1, output: 1 } });
    yield { content: 'hello' };
    return { content: 'hello', finishReason: 'stop', model: 'test-model' };
  };
  const hub = new HubLlmGateway({
    store, clock: () => 0, log: memoryLog().log,
    runs: { get: (id) => store.table('runs').get(id) },
    queues: {
      llm: async (_priority, task) => {
        held += 1;
        events.push(`slot ${held}`);
        try { return await task(); } finally { held -= 1; events.push('free'); }
      },
    },
    llm: { streamer, embed: () => Promise.reject(new Error('no embeddings here')), models: () => [] },
    models: { resolve: () => Promise.resolve({}) },
    sleep: (ms, signal) => { events.push(`sleep ${ms} holding ${held}`); return abortableSleep(ms, signal); },
  });
  return { hub, events, calls: () => calls };
}

async function collect(stream: AsyncIterable<LlmForwardChunk>): Promise<LlmForwardChunk[]> {
  const out: LlmForwardChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('the forwarded-LLM retry', () => {
  it('waits out a rate limit between attempts, holding no LLM slot while it waits, then streams', async () => {
    const { hub, events, calls } = await gateway(1);
    const chunks = await collect(hub.forward(forward, new AbortController().signal));
    expect(chunks.map((c) => c.type)).toEqual(['descriptors', 'chunk', 'done']);
    expect(calls()).toBe(2);
    expect(events).toEqual(['slot 1', 'free', 'sleep 40 holding 0', 'slot 1', 'free']);
  });

  it('gives up after its tries with the limit as the error', async () => {
    const { hub, calls } = await gateway(10);
    const chunks = await collect(hub.forward(forward, new AbortController().signal));
    expect(chunks).toEqual([{ type: 'error', kind: 'limit', message: 'LLM calls on test-model are rate-limited for 40 ms' }]);
    expect(calls()).toBe(3);
  });

  it('stops waiting at once when the caller aborts', async () => {
    const { hub, calls } = await gateway(10, 60_000);
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => { stop.abort(new Error('the run stopped')); }, 5);
    const chunks = await collect(hub.forward(forward, stop.signal));
    expect(chunks).toMatchObject([{ type: 'error' }]);
    expect(calls()).toBe(1);
    // the minute-long wait was cut short
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('abortableSleep', () => {
  it('rejects at once for a signal already aborted', async () => {
    const stop = new AbortController();
    stop.abort(new Error('gone'));
    await expect(abortableSleep(1_000, stop.signal)).rejects.toThrow('gone');
  });
});
