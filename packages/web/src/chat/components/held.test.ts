import { SystemName, type ChatMessage, type Json } from '@harness/core';
import { mount, RouterLinkStub } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { links } from '../../app/routes.ts';
import { message, run, T0 } from '../test/fakes.ts';
import AssistantAnswer from './AssistantAnswer.vue';

const stubs = { RouterLink: RouterLinkStub };
const held = (fn: string) => ({ fn, code: 'held', reason: `${fn} changed and waits for an admin to approve it`, system: fn.split('/')[0] ?? '' });

function answer(results: ReadonlyArray<{ fn: string; result: Json }>, canReview: boolean) {
  const runs = results.map(({ fn, result }, i) => run({ id: `run_${i}`, fn, status: 'done', outcome: { status: 'done', result } }));
  const m = message({ role: 'assistant', author: 'act_agent', turn: 'trn_a', parts: [{ type: 'text', text: 'I can\'t make the table yet.' }], runs: runs.map((r) => r.id) });
  return mount(AssistantAnswer, {
    props: {
      messages: [m], authorName: 'Chat agent', now: T0, streaming: false, failed: false, runsOf: (_: ChatMessage) => runs,
      collapsed: () => true, viewOf: () => undefined, attachmentView: () => undefined, actions: [], canReview,
    },
    global: { stubs },
  });
}

describe('held-system banner on a turn', () => {
  const turn = [
    { fn: 'hub/load_fns', result: { loaded: [], refused: [held('database/create_table'), held('database/insert_rows')] } },
    { fn: 'hub/load_fns', result: { loaded: [], refused: [held('database/create_table'), { fn: 'fs/write', code: 'disabled', reason: 'fs/write is switched off', system: 'fs' }] } },
  ];

  it('shows one banner per held system, linking an admin to its pending review', () => {
    const wrapper = answer(turn, true);
    const banners = wrapper.findAll('[data-testid=held-banner]');
    expect(banners.map((b) => b.attributes('data-system'))).toEqual(['database']);
    expect(banners[0]?.text()).toContain('database has changes waiting for review');
    expect(banners[0]?.text()).toContain('database/create_table and database/insert_rows are off until then.');
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toEqual(links.review(SystemName.parse('database'), 'pending'));
  });

  it('shows the words without the link to someone who can\'t review', () => {
    const wrapper = answer(turn, false);
    expect(wrapper.find('[data-testid=held-banner]').text()).toContain('database has changes waiting for review');
    expect(wrapper.find('[data-testid=held-review]').exists()).toBe(false);
  });

  it('shows none on a turn that hit nothing held', () => {
    expect(answer([{ fn: 'hub/load_fns', result: { loaded: ['fs/read'], refused: [] } }], true).find('[data-testid=held-banner]').exists()).toBe(false);
  });
});
