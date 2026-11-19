/** An answer draws reasoning next to reasoning (nothing shown between) as one block, streaming into its last step. */
import type { ChatMessage } from '@harness/core';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { message, run, T0 } from '../test/fakes.ts';
import AssistantAnswer from './AssistantAnswer.vue';

const base = {
  authorName: 'Chat agent', now: T0, failed: false, collapsed: () => false, viewOf: () => undefined, attachmentView: () => undefined, actions: [], grouped: false,
};

describe('AssistantAnswer reasoning', () => {
  it('merges reasoning split by a call that shows nothing into one block, and keeps reasoning a shown call splits apart', async () => {
    const stored = message({
      role: 'assistant', author: 'act_agent', runs: ['run_h', 'run_s'],
      parts: [
        { type: 'reasoning', text: 'First.' }, { type: 'call', run: 'run_h', fn: 'hub/fns_search' }, { type: 'reasoning', text: 'Second.' },
        { type: 'call', run: 'run_s', fn: 'fs/bash' }, { type: 'reasoning', text: 'Third.' }, { type: 'text', text: 'Done.' },
      ],
    });
    const answer = mount(AssistantAnswer, {
      props: {
        ...base, messages: [stored], streaming: false, runsOf: () => [run({ id: 'run_h', fn: 'hub/fns_search', status: 'done' }), run({ id: 'run_s' })],
        displayOf: (r: { fn: string }) => (r.fn === 'hub/fns_search' ? 'hidden' : 'card'),
      },
    });
    const order = answer.findAll('[data-testid=reasoning], [data-testid=answer-text], [data-testid=run-card]').map((el) => el.attributes('data-testid'));
    expect(order).toEqual(['reasoning', 'run-card', 'reasoning', 'answer-text']);
    await answer.findAll('.reasoning-toggle')[0]?.trigger('click');
    expect(answer.get('.reasoning-text').text()).toContain('First.');
    expect(answer.get('.reasoning-text').text()).toContain('Second.');
    expect(answer.get('.reasoning-text').text()).not.toContain('Third.');
  });

  it('streams into the merged block: it shimmers, stays open, and grows', async () => {
    const live = message({ role: 'assistant', author: 'act_agent', status: 'streaming', parts: [], runs: ['run_h'] });
    const hidden = run({ id: 'run_h', fn: 'hub/fns_search', status: 'done' });
    const props = { ...base, messages: [live], streaming: true, runsOf: () => [hidden], displayOf: () => 'hidden' as const };
    const segments = (last: string) => [{ kind: 'reasoning', text: 'Look.' }, { kind: 'runs', runs: [hidden.id] }, { kind: 'reasoning', text: last }] as const;
    const answer = mount(AssistantAnswer, { props: { ...props, liveOf: (_m: ChatMessage) => segments('Th') } });
    expect(answer.findAll('[data-testid=reasoning]')).toHaveLength(1);
    expect(answer.get('.reasoning-toggle').classes()).toContain('shimmer');
    await answer.get('.reasoning-toggle').trigger('click');
    await answer.setProps({ liveOf: () => segments('Then read.') });
    expect(answer.findAll('[data-testid=reasoning]')).toHaveLength(1);
    expect(answer.get('.reasoning-text').text()).toContain('Then read.');
  });
});
