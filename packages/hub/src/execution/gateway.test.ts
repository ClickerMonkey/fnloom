import { a, planRequest, prepareRequest, type Chunk, type Request, type Response, type Streamer } from '@aeye/core';
import { LlmWire } from '@harness/sdk/server';
import { LlmInteractionId, ModelCallId, RunId, SystemName, TurnId, type LlmForward, type LlmForwardChunk, type Run } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { testStore, memoryLog } from '../testing.ts';
import { LlmRateLimited } from './errors.ts';
import { abortableSleep, HubLlmGateway } from './gateway.ts';
import { ChunkReader } from './wire.ts';
import type { HubCallContext, HubCallMetadata } from './scope.ts';
import { ALICE, ALICE_INFO, OPEN_LIMITS, testSettings } from './testing.ts';

const RUN = RunId.parse('run_fwd');
const WORK = RunId.parse('run_work');
const TURN = TurnId.parse('trn_fwd');
const FS = SystemName.parse('fs');
const forward: LlmForward & { system: string } = { run: RUN, request: { messages: [{ role: 'user', content: 'hi' }] }, stream: true, system: FS };

/** A gateway over a stored run, a streamer that is rate limited `limited` times first, and a recording LLM doer. */
async function gateway(limited: number, retryAfter = 40, streamed: (request: Request) => Iterable<Chunk> | Promise<Iterable<Chunk>> = () => [{ content: 'hello' }]) {
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
  const settled: Array<{ id: RunId; status: string }> = [];
  let held = 0;
  let calls = 0;
  const streamer: Streamer<HubCallContext, HubCallMetadata> = async function* (request, context): AsyncGenerator<Chunk, Response> {
    calls += 1;
    if (calls <= limited) throw new LlmRateLimited('test-model', retryAfter);
    context.call?.record({ interaction: LlmInteractionId.parse('llm_1'), modelCall: ModelCallId.parse('mdl_1'), model: 'test-model', cost: 0.001, usage: { input: 1, output: 1 } });
    context.receipts?.record({ modelCall: ModelCallId.parse('mdl_3'), model: 'test-model', cost: 0.001 });
    yield* await streamed(request);
    return { content: 'hello', finishReason: 'stop', model: 'test-model' };
  };
  const heard: Array<{ bytes: number; ctx: HubCallContext }> = [];
  /** A non-chat engine call: heard, and its record reported the way the hub AI's hooks do. */
  const answer = <T>(ctx: HubCallContext, value: T): Promise<T> => {
    ctx.receipts?.record({ modelCall: ModelCallId.parse('mdl_2'), model: 'whisper-1', cost: 0.002 });
    return Promise.resolve(value);
  };
  const hub = new HubLlmGateway({
    store, clock: () => 0, log: memoryLog().log, settings: testSettings({}, {}, 'test-model'),
    runs: {
      get: (id) => store.table('runs').get(id),
      // a system's work outside a run: a run of its own in the stored turn
      systemWork: (system) => store.table('runs').put({ ...run, id: WORK, fn: 'hub/system_calls', system, root: WORK, key: 'work', status: 'running' }),
      settle: async (id, outcome) => { settled.push({ id, status: outcome.status }); await store.table('runs').update(id, { status: outcome.status }); },
    },
    queues: {
      llm: async (_priority, task) => {
        held += 1;
        events.push(`slot ${held}`);
        try { return await task(); } finally { held -= 1; events.push('free'); }
      },
    },
    llm: {
      streamer, models: () => [],
      embed: (input, ctx) => answer(ctx, input.inputs.map(() => [1, 0])),
      image: () => Promise.reject(new Error('no images here')),
      speech: () => Promise.reject(new Error('no speech here')),
      transcribe: (input, ctx) => { heard.push({ bytes: input.audio.length, ctx }); return answer(ctx, { text: 'hello there' }); },
      decide: (input, ctx) => answer(ctx, { answers: Object.fromEntries(Object.keys(input.questions).map((name) => [name, { type: 'predicate' as const, probability: 1 }])), model: 'm' }),
    },
    models: { resolve: () => Promise.resolve({}) },
    sleep: (ms, signal) => { events.push(`sleep ${ms} holding ${held}`); return abortableSleep(ms, signal); },
  });
  return { hub, events, heard, settled, calls: () => calls };
}

async function collect(stream: AsyncIterable<LlmForwardChunk>): Promise<LlmForwardChunk[]> {
  const out: LlmForwardChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('non-chat model calls', () => {
  const audio = { audio: new Uint8Array(12), mime: 'audio/webm', metadata: { model: 'whisper-1' } };
  const live = () => new AbortController().signal;

  it('are paid by a system’s own run and answer with their record', async () => {
    const { hub, heard } = await gateway(0);
    const out = await hub.transcribe(audio, { system: FS, run: RUN }, live());
    expect(out).toEqual({ value: { text: 'hello there' }, call: 'mdl_2', cost: 0.002, model: 'whisper-1' });
    expect(heard[0]?.bytes).toBe(12);
    expect(heard[0]?.ctx.call).toMatchObject({ run: RUN, system: FS, fn: 'fs/summarize' });
  });

  it('refuse a run that isn’t the system’s', async () => {
    const { hub, heard } = await gateway(0);
    await expect(hub.transcribe(audio, { system: SystemName.parse('web'), run: RUN }, live())).rejects.toThrow(/not web's/);
    expect(heard).toEqual([]);
  });

  it('charge a system’s call outside any run to a run of its own work, settled when the call ends (build 6)', async () => {
    const { hub, settled } = await gateway(0);
    const out = await hub.transcribe(audio, { system: FS }, live());
    expect(out).toMatchObject({ value: { text: 'hello there' }, call: 'mdl_2' });
    expect(settled).toEqual([{ id: WORK, status: 'done' }]);
    const streamed = await collect(hub.forward({ request: forward.request, stream: true, system: FS }, live()));
    expect(streamed.at(-1)).toMatchObject({ type: 'done' });
    expect(settled.at(-1)).toEqual({ id: WORK, status: 'done' });
  });

  it('do the hub’s own work under its purpose, paid by no turn', async () => {
    const { hub, heard } = await gateway(0);
    await expect(hub.transcribe(audio, { purpose: 'dictation' }, live())).resolves.toMatchObject({ value: { text: 'hello there' }, call: 'mdl_2' });
    expect(heard[0]?.ctx.call).toBeUndefined();
    expect(heard[0]?.ctx.purpose).toBe('dictation');
  });

  it('make the hub’s own chat call under its purpose and priority, the answer’s text collected', async () => {
    const { hub } = await gateway(0);
    const request = { messages: [{ role: 'user' as const, content: 'pick' }] };
    await expect(hub.chat({ request, priority: 'interactive' }, { purpose: 'suggestions' }, live())).resolves.toEqual({ value: 'hello', call: 'mdl_3', cost: 0.001, model: 'test-model' });
  });
});

describe('the forwarded-LLM retry', () => {
  it('waits out a rate limit between attempts, holding no LLM slot while it waits, then streams', async () => {
    const { hub, events, calls } = await gateway(1);
    const chunks = await collect(hub.forward(forward, new AbortController().signal));
    expect(chunks.map((c) => c.type)).toEqual(['chunk', 'done']);
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

/** A tool call whose arguments stream a character at a time, as aeye's providers give it: one call object, growing. */
function* growingCall(args: string): Iterable<Chunk> {
  const call = { id: 'call_set', name: 'set', arguments: '' };
  for (const [i, char] of [...args].entries()) {
    call.arguments += char;
    yield i === 0 ? { toolCallNamed: call } : { toolCallArguments: call };
  }
  yield { toolCall: call, finishReason: 'tool_calls' };
}

describe('a forwarded tool call’s streamed arguments', () => {
  // scenarios iter-1 rep 2: GPT-6 Luna looped whitespace into a `set` call for minutes; every chunk carried the
  // arguments so far, so the link carried n² bytes and the hub died at its 4 GB heap
  it('cross the link once, not whole on every chunk, and read back whole', async () => {
    const args = `{"draft":${' \n'.repeat(10_000)}}`;
    const { hub } = await gateway(0, 40, () => growingCall(args));
    const out = await collect(hub.forward(forward, new AbortController().signal));
    const bytes = out.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
    // linear: the arguments twice (streamed, then the finished call) plus a small frame per chunk
    expect(bytes).toBeLessThan(args.length * 2 + out.length * 100);
    const reader = new ChunkReader();
    const read = out.flatMap((item) => (item.type === 'chunk' ? [reader.read(item.chunk)] : []));
    expect(read.at(-2)?.toolCallArguments?.arguments).toBe(args);
    expect(read.at(-1)?.toolCall?.arguments).toBe(args);
  });
});

/** A model with OpenAI's strict dialect, as the hub's real provider plans for it. */
const OPENAI = { id: 'gpt-4o', provider: 'openai', capabilities: ['tools', 'toolsStrict', 'structured', 'json'] };

/** How a system forwards a request: each schema as its lenient JSON schema. */
const systemWire = new LlmWire({ unrepresentable: 'refuse' });

/** A streamer standing in for the hub's real provider: it plans the request for OpenAI, then the model writes `write(plan)`. */
function strictModel(write: (plan: ReturnType<typeof planRequest>) => Chunk[]) {
  return async (request: Request): Promise<Chunk[]> => {
    const prepared = await prepareRequest(request, OPENAI);
    return write(prepared.plan ?? planRequest(request));
  };
}

describe('answers decoded hub-side, through the plan the provider sent', () => {
  const Search = a.object({ field: a.string(), limit: a.number().optional(), tags: a.record(a.string()) });
  const system: Request = { messages: [{ role: 'user', content: 'find' }], tools: [{ name: 'search', parameters: Search.bind() }] };

  it('forward a strict call (nulls for optionals, pairs for records) in the code shape, which the system decodes as it is', async () => {
    const value = { field: 'name', tags: { a: 'x' } };
    const { hub } = await gateway(0, 40, strictModel((plan) => {
      const call = plan.encodeCall('search', value);
      const named = { id: 'c1', name: call.name, arguments: '' };
      return [{ toolCallNamed: named }, { toolCall: { ...named, arguments: JSON.stringify(call.args) } }, { finishReason: 'tool_calls' }];
    }));
    const out = await collect(hub.forward({ ...forward, request: systemWire.request(system) }, new AbortController().signal));
    const reader = new ChunkReader();
    const call = out.flatMap((item) => (item.type === 'chunk' ? [reader.read(item.chunk)] : [])).find((chunk) => chunk.toolCall !== undefined)?.toolCall;
    expect(call).toEqual({ id: 'c1', name: 'search', arguments: JSON.stringify(value) });
    expect(planRequest(system).decodeCall('search', JSON.parse(call?.arguments ?? ''))).toMatchObject({ ok: true, value });
  });

  it('forward a call that does not fit with the model\'s arguments and what the model is told', async () => {
    const { hub } = await gateway(0, 40, strictModel(() => [{ toolCall: { id: 'c1', name: 'search', arguments: '{"field":3}' } }, { finishReason: 'tool_calls' }]));
    const out = await collect(hub.forward({ ...forward, request: systemWire.request(system) }, new AbortController().signal));
    const call = out.flatMap((item) => (item.type === 'chunk' && item.chunk.toolCall !== undefined ? [item.chunk.toolCall] : []))[0];
    expect(call).toMatchObject({ id: 'c1', name: 'search', arguments: '{"field":3}' });
    expect(call?.invalid).toMatch(/field/);
  });

  it('forward a dispatched call (more tools than the provider takes) under its own tool\'s name', async () => {
    const many: Request = { messages: [{ role: 'user', content: 'go' }], tools: Array.from({ length: 130 }, (_, i) => ({ name: `tool_${String(i)}`, parameters: a.object({ n: a.number() }).bind() })) };
    const { hub } = await gateway(0, 40, strictModel((plan) => {
      const call = plan.encodeCall('tool_129', { n: 2 });
      const named = { id: 'd1', name: call.name, arguments: '' };
      return [{ toolCallNamed: named }, { toolCallArguments: { ...named, arguments: '{' } }, { toolCall: { ...named, arguments: JSON.stringify(call.args) } }, { finishReason: 'tool_calls' }];
    }));
    const out = await collect(hub.forward({ ...forward, request: systemWire.request(many) }, new AbortController().signal));
    const chunks = out.flatMap((item) => (item.type === 'chunk' ? [item.chunk] : []));
    expect(chunks).toEqual([
      { toolCallNamed: { id: 'd1', name: 'tool_129', arguments: '{"n":2}' }, toolCall: { id: 'd1', name: 'tool_129', arguments: '{"n":2}' } },
      { finishReason: 'tool_calls' },
    ]);
  });

  it('forward a structured answer as one chunk of its decoded JSON, before it finishes', async () => {
    const asked: Request = { messages: [{ role: 'user', content: 'say' }], responseFormat: { type: a.object({ answer: a.string(), note: a.string().optional() }).bind(), strict: true } };
    const { hub } = await gateway(0, 40, strictModel(() => [{ content: '{"answer":"hi",' }, { content: '"note":null}' }, { finishReason: 'stop' }]));
    const out = await collect(hub.forward({ ...forward, request: systemWire.request(asked) }, new AbortController().signal));
    expect(out.flatMap((item) => (item.type === 'chunk' ? [item.chunk] : []))).toEqual([{ content: '{"answer":"hi"}' }, { finishReason: 'stop' }]);
    // the hub's own structured chat call reads the same decoded text
    const { hub: own } = await gateway(0, 40, strictModel(() => [{ content: '{"answer":"yo","note":null}' }, { finishReason: 'stop' }]));
    await expect(own.chat({ request: systemWire.request(asked) }, { purpose: 'test' }, new AbortController().signal)).resolves.toMatchObject({ value: '{"answer":"yo"}' });
  });
});

describe('abortableSleep', () => {
  it('rejects at once for a signal already aborted', async () => {
    const stop = new AbortController();
    stop.abort(new Error('gone'));
    await expect(abortableSleep(1_000, stop.signal)).rejects.toThrow('gone');
  });
});
