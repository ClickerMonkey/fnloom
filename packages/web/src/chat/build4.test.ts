/**
 * Build 4 in the chat: the wavy rule where the model re-read the whole chat, hidden messages and debug mode, input
 * form answers, and fn validation refusals shown softly.
 */
import { ModelCallId, RunId } from '@harness/core';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { ref, shallowRef } from 'vue';
import CacheMissRule from './components/CacheMissRule.vue';
import RunCard from './components/RunCard.vue';
import UserMessage from './components/UserMessage.vue';
import { cacheMissLabel, CACHE_MISS_TIP } from './logic/format.ts';
import { invalidSummary, OUTPUT_REFUSED_CODE } from './logic/runs.ts';
import { messageSuggestions } from './logic/session.ts';
import { inputAnswers, inputAnswerText, isHiddenMessage, resendParts, threadItems } from './logic/thread.ts';
import { threadInputAnswers } from './state/input-host.ts';
import { message, run, T0 } from './test/fakes.ts';

const RUN = RunId.parse('run_form');
const CALL = ModelCallId.parse('mdl_1');
const answer = { type: 'input-answer', run: RUN, title: 'Trip', value: { city: 'Oslo' }, text: 'City: Oslo' } as const;

describe('hidden messages and debug mode', () => {
  it('leaves a message of only hidden parts out of the thread, unless in debug mode', () => {
    const asked = message({ createdAt: T0 + 1 });
    const answered = message({ parts: [answer], createdAt: T0 + 2 });
    expect(isHiddenMessage(answered)).toBe(true);
    expect(isHiddenMessage(asked)).toBe(false);
    expect(threadItems([asked, answered], asked.author, T0).filter((i) => i.kind === 'user')).toHaveLength(1);
    const debug = threadItems([asked, answered], asked.author, T0, { debug: true }).flatMap((i) => (i.kind === 'user' ? [i.hidden] : []));
    expect(debug).toEqual([false, true]);
  });

  it('draws a hidden message in debug mode as what the model read', () => {
    const m = message({ parts: [answer] });
    const view = mount(UserMessage, { props: { message: m, mine: true, authorName: 'Ada', now: T0, commandName: () => '', suggestions: messageSuggestions(m, undefined), actions: [], hidden: true } });
    expect(view.get('[data-testid=hidden-message]').text()).toContain('<input-answer title="Trip">City: Oslo</input-answer>');
    expect(view.find('[data-testid=added-for-model]').exists()).toBe(false);
  });

  it('reads the answers per run, and never resends them', () => {
    const m = message({ parts: [answer] });
    expect(inputAnswers([m]).get(RUN)?.text).toBe('City: Oslo');
    expect(inputAnswerText({ title: 'Say "hi"', text: 'x' })).toBe('<input-answer title="Say &quot;hi&quot;">x</input-answer>');
    expect(resendParts(m.parts)).toEqual([]);
  });

  it('sends a form’s answers as one hidden part, and says why when it could not', async () => {
    const sent: unknown[] = [];
    const ok = ref(true);
    const thread = {
      messages: shallowRef([message({ parts: [answer] })]),
      problem: ref('Offline'),
      send: (outgoing: { parts: readonly unknown[] }): Promise<boolean> => { sent.push(outgoing.parts); return Promise.resolve(ok.value); },
    };
    const answers = threadInputAnswers(thread);
    const { type: _type, ...body } = answer;
    await answers.send(body);
    expect(sent).toEqual([[answer]]);
    expect(answers.answerOf(RUN)).toEqual(body);
    ok.value = false;
    await expect(answers.send(body)).rejects.toThrow('Offline');
  });
});

describe('the cache-miss rule', () => {
  it('sits above the answer whose call read no cache', () => {
    const asked = message({ createdAt: T0 + 1 });
    const reply = message({ role: 'assistant', author: 'act_agent', turn: asked.turn, cacheMiss: { call: CALL, at: T0 + 3 }, createdAt: T0 + 3 });
    const kinds = threadItems([asked, reply], asked.author, T0).map((i) => i.kind);
    expect(kinds).toEqual(['day', 'user', 'cache-miss', 'answer']);
  });

  it('says the time, and the date when it isn’t today', () => {
    const today = cacheMissLabel(T0 - 60_000, T0, 'en-GB');
    expect(today).not.toMatch(/Nov/);
    expect(cacheMissLabel(T0 - 3 * 86_400_000, T0, 'en-GB')).toMatch(/Nov, /);
    const rule = mount(CacheMissRule, { props: { at: T0 - 60_000, now: T0 } });
    expect(rule.attributes('title')).toContain(CACHE_MISS_TIP);
    expect(rule.get('time').text()).toBe(cacheMissLabel(T0 - 60_000, T0));
    expect(rule.findAll('.wave')).toHaveLength(2);
  });
});

describe('fn validation, shown softly', () => {
  it('says a fn can’t run now without calling it a retry, and a refused result was sent back', () => {
    expect(invalidSummary({ source: 'unavailable', problems: [{ path: '', message: 'Shop is closed' }] })).toBe('Not available now: Shop is closed');
    expect(invalidSummary({ source: 'result', problems: [{ path: '', message: 'Too long' }] })).toMatch(/^Sent back · /);
    expect(invalidSummary({ source: 'schema', problems: [{ path: 'a', message: 'Required' }] })).toMatch(/^Retried · /);
  });

  it('shows a run its output hook stopped as a stop with the reason, not an error', () => {
    const stopped = run({ status: 'failed', outcome: { status: 'failed', error: { class: 'fatal', code: OUTPUT_REFUSED_CODE, message: 'Card declined' } } });
    const card = mount(RunCard, { props: { run: stopped, now: T0, collapsed: false } });
    expect(card.get('[data-testid=run-stopped]').text()).toBe('Stopped · Card declined');
    expect(card.find('.error-text').exists()).toBe(false);
    expect(card.classes()).toContain('stopped');
  });
});
