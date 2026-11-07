/**
 * Live smoke test: the OpenRouter key in the environment works with the free test models. One small call per model,
 * stopping at the first that answers; a model that is rate-limited (429) is skipped. Run with `npm run test:live`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { liveModels } from '@harness/sdk/server/testing';
import { modelEnv } from './env.ts';

const Completion = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) });

describe('OpenRouter (live)', () => {
  const key = modelEnv.get('OPENROUTER_API_KEY');
  it.skipIf(key === undefined)('answers with a free model', async () => {
    const models = liveModels();
    const tried: string[] = [];
    for (const model of models) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] }),
      });
      if (res.status === 429 || res.status >= 500) { tried.push(`${model}: ${res.status}`); continue; }
      expect(res.status).toBe(200);
      const body = Completion.parse(await res.json());
      expect(body.choices[0]?.message.content ?? '').not.toBe('');
      return;
    }
    console.warn('live.openrouter.unavailable', { tried });
  });
});
