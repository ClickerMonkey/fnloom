import { describe, expect, it } from 'vitest';
import { Completion, costOf } from './openrouter.ts';

/** A judge call's answer as OpenRouter sent it (2026-11-22, openai/gpt-6-luna routed through the account's OpenAI key). */
const BYOK = {
  id: 'gen-1795377041-eY4Nz6fy803Htpbpr5Es', model: 'openai/gpt-6-luna', provider: 'OpenAI',
  choices: [{ message: { role: 'assistant', content: '{"verdict":"weak"}' } }],
  usage: {
    prompt_tokens: 6729, completion_tokens: 817, total_tokens: 7546, cost: 0, is_byok: true,
    prompt_tokens_details: { cached_tokens: 6726, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
    cost_details: { upstream_inference_cost: 0.00047606, upstream_inference_prompt_cost: 0.00006756, upstream_inference_completions_cost: 0.0004085 },
    completion_tokens_details: { reasoning_tokens: 610, image_tokens: 0, audio_tokens: 0 },
  },
};

/** The same model billed by OpenRouter itself: `cost` is the bill, and `upstream_inference_cost` repeats it. */
const BILLED = {
  choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
  usage: { prompt_tokens: 14, completion_tokens: 12, total_tokens: 26, cost: 0.0000074, is_byok: false, cost_details: { upstream_inference_cost: 0.0000074 } },
};

describe('what an OpenRouter call cost', () => {
  it('counts the provider\'s bill when the call went through BYOK, where cost is only OpenRouter\'s fee', () => {
    expect(costOf(Completion.parse(BYOK).usage)).toBeCloseTo(0.00047606, 10);
  });

  it('counts cost alone when OpenRouter billed the call, never twice', () => {
    expect(costOf(Completion.parse(BILLED).usage)).toBeCloseTo(0.0000074, 10);
  });

  it('is 0 when the answer has no usage, or its cost fields are null', () => {
    expect(costOf(Completion.parse({ choices: BILLED.choices }).usage)).toBe(0);
    expect(costOf(Completion.parse({ choices: BILLED.choices, usage: { cost: null, is_byok: true, cost_details: { upstream_inference_cost: null } } }).usage)).toBe(0);
  });
});
