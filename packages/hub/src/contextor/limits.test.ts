import { ActorId, mintId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { buildProvider } from '../execution/providers.ts';
import { AUTO_MODEL, defaultProbes } from './limits.ts';
import { numCtxOf, OllamaApi, OllamaProvider, reasons, servedDefault, servedWindow, unsetWindow, takesTools, trainedLengthOf, type OllamaShow } from './ollama.ts';
import { chatModel, contextorRig } from './testing.ts';
import { CALIBRATION } from './tokens.ts';

const ADMIN = ActorId.parse('act_admin');

/** A fake Ollama: `/api/tags`, `/api/show` per model, `/api/version`. */
function fakeOllama(shows: Record<string, OllamaShow>, version = '0.5.7') {
  const calls: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const path = new URL(url).pathname;
    const json = (body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (path === '/api/version') return json({ version });
    if (path === '/api/tags') return json({ models: Object.keys(shows).map((name) => ({ name, model: name })) });
    if (path === '/api/show') {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const model = typeof body === 'object' && body !== null && 'model' in body && typeof body.model === 'string' ? body.model : '';
      const show = shows[model];
      return show === undefined ? Promise.resolve(new Response('no', { status: 404 })) : json(show);
    }
    return Promise.resolve(new Response('no', { status: 404 }));
  };
  return { fetcher, calls };
}

const QWEN: OllamaShow = { parameters: 'num_ctx 8192\nstop "<|im_end|>"', template: '{{ if .Tools }}tools{{ end }}', model_info: { 'qwen2.context_length': 32_768 }, details: { family: 'qwen2' } };
const R1: OllamaShow = { parameters: 'stop "<｜User｜>"', template: '<｜User｜>{{ .Content }}', model_info: { 'qwen2.context_length': 131_072 }, details: { family: 'qwen2' } };

describe('Ollama', () => {
  it('reads the served window from num_ctx, else its default, never the trained length', () => {
    expect(numCtxOf(QWEN)).toBe(8_192);
    expect(numCtxOf(R1)).toBeUndefined();
    expect(trainedLengthOf(R1)).toBe(131_072);
    expect(servedDefault('0.5.7')).toBe(2_048);
    expect(servedDefault('0.12.3')).toBe(4_096);
    expect(unsetWindow('0.5.7', undefined, 4_096)).toBe(2_048);
    expect(unsetWindow('0.12.3', undefined, 3_000)).toBe(3_000);
    expect(unsetWindow('0.5.7', 8_192, 4_096)).toBe(8_192);
    expect(servedWindow(R1, unsetWindow('0.5.7', undefined))).toBe(2_048);
    expect(servedWindow(QWEN, 4_096)).toBe(8_192);
    expect(servedWindow({ ...QWEN, model_info: { 'llama.context_length': 1_024 } }, 4_096)).toBe(1_024);
  });

  it('tells which models take tools and which think', () => {
    expect(takesTools(QWEN)).toBe(true);
    expect(takesTools(R1)).toBe(false);
    expect(takesTools({ capabilities: ['completion', 'tools'] })).toBe(true);
    expect(reasons('deepseek-r1:7b', R1)).toBe(true);
    expect(reasons('qwen2.5:3b', QWEN)).toBe(false);
    expect(reasons('x', { capabilities: ['thinking'] })).toBe(true);
  });

  it('lists its models with their abilities and served windows', async () => {
    const { fetcher } = fakeOllama({ 'qwen2.5:3b': QWEN, 'deepseek-r1:7b': R1 });
    const models = await new OllamaProvider({ baseURL: 'http://ollama.test:11434/' }, fetcher).listModels();
    expect(models.map((m) => [m.id, m.provider, m.contextWindow, m.capabilities.has('tools'), m.capabilities.has('reasoning')])).toEqual([
      ['qwen2.5:3b', 'ollama', 8_192, true, false],
      ['deepseek-r1:7b', 'ollama', 2_048, false, true],
    ]);
    const provider = await buildProvider({ provider: 'ollama', baseURL: 'http://127.0.0.1:11434' }, () => Promise.reject(new Error('no key')));
    expect(provider.name).toBe('ollama');
    expect(new OllamaApi('http://x:1/').baseURL).toBe('http://x:1');
  });
});

describe('model limits', () => {
  it('resolve field by field: admin, then probe, then model info, then defaults, saying where each came from', async () => {
    const { fetcher } = fakeOllama({ 'deepseek-r1:7b': R1 });
    const r = await contextorRig({
      models: [chatModel('deepseek-r1:7b', { provider: 'ollama', contextWindow: 131_072, capabilities: ['chat', 'reasoning'] }), chatModel('big', { contextWindow: 100_000 })],
      probes: defaultProbes(4_096, fetcher),
    });
    await r.store.table('providers').insert({ id: mintId('provider'), config: { provider: 'ollama', baseURL: 'http://ollama.test:11434' }, createdAt: 0 });
    const r1 = await r.limits.resolve('deepseek-r1:7b');
    // named under its provider (a session or role pinned to it), it is the same model, probed the same way
    expect((await r.limits.resolve('ollama/deepseek-r1:7b')).sources.contextWindow).toBe('probe');
    expect(r1.limits).toEqual({ contextWindow: 2_048, maxOutputTokens: 512, reasoningTokens: 256, charsPerToken: 3.5 });
    expect(r1.sources).toEqual({ contextWindow: 'probe', maxOutputTokens: 'default', reasoningTokens: 'model-info', charsPerToken: 'probe' });
    expect(r1.ratio).toBe(CALIBRATION.start);

    const set = await r.limits.set('deepseek-r1:7b', { contextWindow: 4_096, maxOutputTokens: 1_024 }, ADMIN);
    expect(set.limits).toMatchObject({ contextWindow: 4_096, maxOutputTokens: 1_024, reasoningTokens: 512 });
    expect(set.sources).toMatchObject({ contextWindow: 'admin', maxOutputTokens: 'admin' });
    const cleared = await r.limits.set('deepseek-r1:7b', {}, ADMIN);
    expect(cleared.sources.contextWindow).toBe('probe');

    const big = await r.limits.resolve('big');
    expect(big.limits).toEqual({ contextWindow: 100_000, maxOutputTokens: 1_024, reasoningTokens: 0, charsPerToken: 4 });
    expect(big.sources.contextWindow).toBe('model-info');
    const unknown = await r.limits.resolve(AUTO_MODEL);
    expect(unknown.sources.contextWindow).toBe('default');
    await r.limits.resolve(AUTO_MODEL);
    expect(r.records.filter((rec) => rec.msg === 'model.limits.guessed')).toHaveLength(1);
    expect((await r.limits.list()).map((v) => v.model)).toEqual(['deepseek-r1:7b', 'big']);
  });

  it('cache probes, and treat a failing probe as nothing known', async () => {
    const { fetcher, calls } = fakeOllama({});
    const r = await contextorRig({ models: [chatModel('gone', { provider: 'ollama', contextWindow: 0 })], probes: defaultProbes(4_096, fetcher) });
    await r.store.table('providers').insert({ id: mintId('provider'), config: { provider: 'ollama', baseURL: 'http://ollama.test:11434' }, createdAt: 0 });
    expect((await r.limits.resolve('gone')).sources.contextWindow).toBe('default');
    const asked = calls.length;
    await r.limits.resolve('gone');
    expect(calls.length).toBe(asked);
    expect(r.records.some((rec) => rec.msg === 'model.limits.probe-failed')).toBe(true);
  });

  it('calibrate per model from measured input tokens', async () => {
    const r = await contextorRig();
    await r.tokens.observe('small', 1_100, 1_500);
    const estimator = await r.tokens.forModel('small');
    expect(estimator.ratio).toBeGreaterThan(CALIBRATION.start);
    expect((await r.store.table('modelCalibration').get('small'))?.samples).toBe(1);
  });
});
