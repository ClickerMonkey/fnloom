/**
 * The server's models and the provider's: installed models read with @aeye/ollama's own readings (abilities, served
 * window), and the declared models exactly the offered ones the server has, within the offer's limits. Also the client
 * over a fake `fetch`: a pull's NDJSON progress and errors, and a removal.
 */
import { describe, expect, it } from 'vitest';
import { OllamaConfig } from '../shared/index.ts';
import { HttpOllamaApi } from './api.ts';
import { chatShow, embedShow, FakeOllama } from './fakes.ts';
import { declaredModels, installedModels, offerOf } from './models.ts';

/** A server with a chat model, an embedding model and a decision model. */
function server(): FakeOllama {
  const ollama = new FakeOllama('http://127.0.0.1:11435');
  ollama.models.set('qwen3:8b', { size: 5_225_000_000, show: chatShow(40_960, 16_384), details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M', format: 'gguf' } });
  ollama.models.set('nomic-embed-text:latest', { size: 274_000_000, show: embedShow(768) });
  ollama.models.set('nimble:latest', { size: 90_000_000, show: { model_info: { 'nimble.context_length': 2_048 } } });
  return ollama;
}

describe('models', () => {
  it('lists the installed models with what they are and can do, and which are offered', async () => {
    const offered = OllamaConfig.parse({ offered: [{ model: 'qwen3:8b' }, { model: 'nimble', decision: true }] }).offered;
    const models = await installedModels({ api: server(), offered, contextLength: undefined, maxContext: 4_096 });
    expect(models[0]).toEqual({
      name: 'qwen3:8b', size: 5_225_000_000, family: 'qwen3', parameters: '8.2B', quantization: 'Q4_K_M', format: 'gguf',
      capabilities: ['chat', 'streaming', 'json', 'tools'], contextLength: 40_960, servedWindow: 16_384, offered: true,
    });
    expect(models[1]).toMatchObject({ name: 'nomic-embed-text:latest', capabilities: ['embedding'], embeddingLength: 768, servedWindow: 2_048, offered: false });
    // a server that lists no abilities: a decision model named in an offer decides
    expect(models[2]).toMatchObject({ name: 'nimble:latest', capabilities: ['decision'], offered: true });
  });

  it('declares only the offered models the server has, free, within each offer\'s limits', async () => {
    const offered = OllamaConfig.parse({
      offered: [
        { model: 'qwen3:8b', label: 'Qwen 3', contextWindow: 8_192, maxOutput: 2_048 },
        { model: 'nomic-embed-text' },
        { model: 'nimble', decision: true },
        { model: 'gone:1b' },
      ],
    }).offered;
    const installed = await installedModels({ api: server(), offered, contextLength: 32_768, maxContext: 4_096 });
    const declared = declaredModels(installed, offered);
    expect(declared.map((m) => m.id)).toEqual(['qwen3:8b', 'nomic-embed-text:latest', 'nimble:latest']);
    expect(declared[0]).toEqual({ id: 'qwen3:8b', name: 'Qwen 3', capabilities: ['chat', 'streaming', 'json', 'tools'], contextWindow: 8_192, maxOutput: 2_048, pricing: { input: 0, output: 0 }, caching: false });
    expect(declared[1]).toMatchObject({ capabilities: ['embedding'], dimensions: 768 });
    expect(declared[2]).toMatchObject({ capabilities: ['decision'], maxQuestions: 64, maxRequestBytes: 65_536 });
    // an offer's window never raises the served one; nothing offered, nothing declared
    expect(declaredModels(installed, [{ model: 'qwen3:8b', contextWindow: 100_000, decision: false }])[0]?.contextWindow).toBe(16_384);
    expect(declaredModels(installed, [])).toEqual([]);
    expect(offerOf(offered, 'nimble:latest')?.decision).toBe(true);
  });

  it('leaves an embedding model whose vector size is unknown out of the embedders', () => {
    const declared = declaredModels([{ name: 'vec:latest', size: 1, capabilities: ['embedding'], servedWindow: 512, offered: true }], [{ model: 'vec', decision: false }]);
    expect(declared).toEqual([]);
  });
});

describe('the server client', () => {
  /** A fetch answering with these responses by path, recording what it was asked. */
  function fetching(answers: Record<string, () => Response>) {
    const asked: Array<{ path: string; method: string; body: unknown }> = [];
    const fake: typeof fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
      asked.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const answer = answers[path];
      return Promise.resolve(answer === undefined ? new Response('not found', { status: 404 }) : answer());
    };
    return { fake, asked };
  }
  const ndjson = (lines: readonly unknown[]): Response => new Response(lines.map((l) => JSON.stringify(l)).join('\n'));

  it('streams a pull\'s progress line by line and finishes on success', async () => {
    const { fake, asked } = fetching({ '/api/pull': () => ndjson([{ status: 'pulling manifest' }, { status: 'pulling abc', digest: 'abc', total: 10, completed: 5 }, { status: 'success' }]) });
    const api = new HttpOllamaApi('http://ollama/', fake, 1_000);
    const lines: string[] = [];
    await api.pull('qwen3:8b', (line) => { lines.push(`${line.status}:${String(line.completed ?? '')}`); }, new AbortController().signal);
    expect(lines).toEqual(['pulling manifest:', 'pulling abc:5', 'success:']);
    expect(asked).toEqual([{ path: '/api/pull', method: 'POST', body: { model: 'qwen3:8b', stream: true } }]);
  });

  it('fails a pull with the server\'s error, or one that ends early', async () => {
    const error = new HttpOllamaApi('http://ollama', fetching({ '/api/pull': () => ndjson([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]) }).fake, 1_000);
    await expect(error.pull('nope', () => undefined, new AbortController().signal)).rejects.toThrow(/file does not exist/);
    const early = new HttpOllamaApi('http://ollama', fetching({ '/api/pull': () => ndjson([{ status: 'pulling manifest' }]) }).fake, 1_000);
    await expect(early.pull('x', () => undefined, new AbortController().signal)).rejects.toThrow(/ended before it finished/);
    const refused = new HttpOllamaApi('http://ollama', fetching({ '/api/pull': () => new Response(JSON.stringify({ error: 'invalid model name' }), { status: 400 }) }).fake, 1_000);
    await expect(refused.pull('x', () => undefined, new AbortController().signal)).rejects.toThrow(/invalid model name/);
  });

  it('removes a model, says when there was none, and reads the model list\'s details', async () => {
    const { fake, asked } = fetching({
      '/api/delete': () => new Response(null, { status: 200 }),
      '/api/tags': () => Response.json({ models: [{ name: 'a:1b', model: 'a:1b', size: 12, details: { family: 'a', parameter_size: '1B' } }] }),
    });
    const api = new HttpOllamaApi('http://ollama', fake, 1_000);
    expect(await api.remove('a:1b')).toBe(true);
    expect(asked[0]).toEqual({ path: '/api/delete', method: 'DELETE', body: { model: 'a:1b' } });
    expect((await api.tags()).models[0]).toMatchObject({ size: 12, details: { parameter_size: '1B' } });
    const none = new HttpOllamaApi('http://ollama', fetching({}).fake, 1_000);
    expect(await none.remove('a:1b')).toBe(false);
  });
});
