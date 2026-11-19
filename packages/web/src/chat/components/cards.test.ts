import { BudgetRule, RunId, type ModelInfo, type Notification } from '@harness/core';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import NotificationRow from '../../components/inbox/NotificationRow.vue';
import { notification } from '../../test/fakes.ts';
import { handlerCall, run, session, summary, T0 } from '../test/fakes.ts';
import AttachmentCard from './AttachmentCard.vue';
import BackgroundStrip from './BackgroundStrip.vue';
import BudgetCard from './BudgetCard.vue';
import ComposerMeta from './ComposerMeta.vue';
import HandlerCard from './HandlerCard.vue';
import HoverCard from './HoverCard.vue';
import LinkCard from './LinkCard.vue';
import ModelPicker from './ModelPicker.vue';
import RunCard from './RunCard.vue';
import SessionRow from './SessionRow.vue';
import SessionSettings from './SessionSettings.vue';
import TurnNotice from './TurnNotice.vue';

afterEach(() => { document.body.innerHTML = ''; });

describe('HandlerCard', () => {
  it('asks a yes-or-no question like an approval, with buttons named for what they do', async () => {
    const call = handlerCall({
      args: { command: 'seq 1 30', reason: 'not on the safe list' },
      decl: { description: 'Run this command? Your shell setting asks first.', args: { name: 'obj' }, returns: { name: 'bool' } },
    });
    const card = mount(HandlerCard, { props: { call, fn: 'fs/bash' } });
    expect(card.attributes('data-kind')).toBe('confirm');
    expect(card.get('.title').text()).toBe('Run this command? Your shell setting asks first.');
    expect(card.text()).toContain('Bash is waiting for your answer.');
    // its fn is a pill, as everywhere a fn is named
    expect(card.get('.description [data-testid=fn-pill]').attributes('data-fn')).toBe('fs/bash');
    expect(card.get('[data-testid=arg-list]').text()).toContain('seq 1 30');
    expect(card.find('[role=switch]').exists()).toBe(false);
    expect(card.get('[data-testid=handler-yes]').text()).toBe('Run');
    await card.get('[data-testid=handler-yes]').trigger('click');
    await card.get('[data-testid=handler-no]').trigger('click');
    expect(card.emitted('answer')).toEqual([[true], [false]]);
  });

  it('asks anything else with a form built from the answer type', () => {
    const call = handlerCall({ decl: { description: 'Pick a folder', args: { name: 'obj' }, returns: { name: 'text' } } });
    const card = mount(HandlerCard, { props: { call, fn: 'fs/write_file' } });
    expect(card.attributes('data-kind')).toBe('form');
    expect(card.find('[data-testid=handler-yes]').exists()).toBe(false);
    expect(card.find('[data-testid=gin-submit]').exists()).toBe(true);
  });
});

describe('RunCard', () => {
  it('says a run blocked on the person waits for them, instead of looking busy', () => {
    const card = mount(RunCard, { props: { run: { ...run({ status: 'running', fn: 'fs/bash', args: { command: 'seq 1 30' } }), asking: true }, now: T0, collapsed: false } });
    expect(card.attributes('data-status')).toBe('waiting');
    expect(card.classes()).not.toContain('active');
    expect(card.get('[data-testid=run-status]').text()).toContain('Waiting for your answer');
  });
});

describe('BackgroundStrip', () => {
  it('lists background runs with their time, opening one on tap, and hides when there are none', async () => {
    const runs = [run({ id: 'run_bg', fn: 'fs/bash', status: 'running', background: true, startedAt: T0 - 5_000 })];
    const strip = mount(BackgroundStrip, { props: { runs, now: T0 } });
    expect(strip.get('[data-testid=background-strip]').text()).toContain('Bash');
    expect(strip.text()).toContain('5.0s');
    await strip.get('[data-run=run_bg]').trigger('click');
    expect(strip.emitted('open')).toEqual([[RunId.parse('run_bg')]]);
    await strip.setProps({ runs: [] });
    expect(strip.find('[data-testid=background-strip]').exists()).toBe(false);
  });
});

describe('AttachmentCard', () => {
  it('peeks at data without a renderer, folding long data behind Show all', async () => {
    const data = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i]));
    const card = mount(AttachmentCard, { props: { title: 'Diff', attachment: 'fs/diff', data } });
    expect(card.get('.title').text()).toBe('Diff');
    expect(card.get('.kind').text()).toBe('Diff');
    expect(card.get('.peek').classes()).not.toContain('open');
    await card.get('.toggle').trigger('click');
    expect(card.get('.peek').classes()).toContain('open');
    expect(card.get('.toggle').text()).toBe('Show less');
  });
});

describe('LinkCard', () => {
  it('opens a web page in a new tab, and asks the chat to open resources, files and runs', async () => {
    const web = mount(LinkCard, { props: { link: { url: 'https://example.com/a', title: 'Example' } } });
    expect(web.get('a').attributes()).toMatchObject({ href: 'https://example.com/a', target: '_blank', rel: 'noopener noreferrer' });
    expect(web.text()).toContain('example.com');
    const resource = mount(LinkCard, { props: { link: { resource: 'file:///repo/docs/harness.md' } } });
    expect(resource.text()).toContain('harness.md');
    await resource.get('button').trigger('click');
    expect(resource.emitted('open')).toHaveLength(1);
    const file = mount(LinkCard, { props: { link: { file: { hash: 'a'.repeat(64), size: 2048, mime: 'text/plain' }, title: 'notes.txt' } } });
    expect(file.text()).toContain('text/plain · 2.0 KB');
    const runLink = mount(LinkCard, { props: { link: { run: RunId.parse('run_1'), title: 'The build' } } });
    expect(runLink.text()).toContain('Run details');
  });
});

describe('TurnNotice', () => {
  it('says why the turn failed and offers a retry, or a fresh chat after repeated failures', async () => {
    const notice = mount(TurnNotice, { props: { reason: 'The model was unavailable.', failures: 1 } });
    expect(notice.text()).toContain('The model was unavailable.');
    await notice.get('[data-testid=retry]').trigger('click');
    expect(notice.emitted('retry')).toHaveLength(1);
    expect(notice.text()).not.toContain('New chat');
    await notice.setProps({ failures: 3 });
    await notice.findAll('button').find((b) => b.text() === 'New chat')?.trigger('click');
    expect(notice.emitted('fresh')).toHaveLength(1);
    expect(notice.find('[data-testid=continue]').exists()).toBe(false);
  });

  it('makes Continue the primary action for a turn that stopped at its step limit or was cancelled, with Retry beside it', async () => {
    const notice = mount(TurnNotice, { props: { reason: "I couldn't finish: hub/chat stopped after 24 iterations without an answer.", failures: 1, fatal: true, continuable: true } });
    expect(notice.text()).toContain('The agent stopped before it finished');
    const buttons = notice.findAll('.actions button');
    expect(buttons.map((b) => b.text())).toEqual(['Retry', 'Continue']);
    expect(notice.get('[data-testid=continue]').classes()).toContain('primary');
    expect(notice.get('[data-testid=retry]').classes()).not.toContain('primary');
    expect(notice.get('[data-testid=retry]').attributes('title')).toContain('Undo this turn');
    await notice.get('[data-testid=continue]').trigger('click');
    expect(notice.emitted('continue')).toHaveLength(1);
    expect(notice.emitted('retry')).toBeUndefined();
    // a stop that can carry on is no terminal banner
    expect(notice.get('[data-testid=turn-failed]').classes()).not.toContain('fatal');
  });
});

describe('HoverCard', () => {
  it("offers its type's methods on the thing, marking those that ask for more", async () => {
    const methods = [
      { fn: 'fs/Entry.reveal' as const, label: 'Reveal', description: 'Show it', own: undefined },
      { fn: 'fs/Entry.rename' as const, label: 'Rename', description: 'Rename it', own: { name: 'obj', props: { to: { type: { name: 'text' } } } } },
    ];
    const card = mount(HoverCard, { props: { label: 'a.md', loading: false, methods, hover: { title: 'a.md', value: { path: 'a.md' } } } });
    const buttons = card.findAll('[data-testid=hover-methods] button');
    expect(buttons.map((b) => b.text())).toEqual(['Reveal', 'Rename…']);
    await buttons[1]?.trigger('click');
    expect(card.emitted('method')?.[0]).toEqual([methods[1]]);
    await card.setProps({ hover: { title: 'a.md' } });
    expect(card.find('[data-testid=hover-methods]').exists()).toBe(false);
  });
});

describe('ComposerMeta', () => {
  it('switches agents from its menu and shows the model, which opens the model picker', async () => {
    const meta = mount(ComposerMeta, {
      props: {
        agent: 'Chat agent', agents: [{ fn: 'hub/chat', name: 'Chat agent' }, { fn: 'fs/explore', name: 'Explore agent' }], model: 'Llama (free)',
        systems: { total: 2, offline: 0 }, background: 1, spent: 0, compact: false, fnMode: 'auto',
      },
      attachTo: document.body,
    });
    expect(meta.get('[data-testid=model-chip]').text()).toBe('Llama (free)');
    // what the agent may do: every mode, mildest first; picking one asks for it
    expect(meta.get('[data-testid=fn-mode-picker]').text()).toBe('Auto');
    await meta.get('[data-testid=fn-mode-picker]').trigger('click');
    await nextTick();
    await nextTick();
    const modes = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
    expect(modes.map((i) => i.textContent.trim())).toEqual(['No fns', 'Read only', 'Read and write', 'Full access', 'Auto']);
    modes[1]?.click();
    expect(meta.emitted('fnMode')).toEqual([['read']]);
    await nextTick();
    await meta.get('[data-testid=agent-picker]').trigger('click');
    await nextTick();
    await nextTick();
    const items = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
    expect(items.map((i) => i.textContent.trim())).toEqual(['Chat agent', 'Explore agent', 'Chat settings…']);
    items[1]?.click();
    expect(meta.emitted('agent')).toEqual([['fs/explore']]);
    await meta.get('[data-testid=model-chip]').trigger('click');
    expect(meta.emitted('model')).toHaveLength(1);
    expect(meta.get('[data-testid=background-count]').text()).toContain('1');
  });
});

/** Chat models as the hub lists them: a free one with tools, a paid one with vision and a long context. */
const MODELS: ModelInfo[] = [
  { id: 'meta/llama-free', provider: 'openrouter', name: 'Llama (free)', contextWindow: 131_072, pricing: { input: 0, output: 0 }, capabilities: ['chat', 'tools'] },
  { id: 'acme/vision-pro', provider: 'openrouter', name: 'Vision Pro', contextWindow: 1_000_000, pricing: { input: 3, output: 15 }, capabilities: ['chat', 'vision', 'reasoning'] },
];

describe('SessionSettings', () => {
  it('picks the agent, names the model and asks for the model picker', async () => {
    const record = session({ model: { model: 'meta/llama-free' } });
    const settings = mount(SessionSettings, {
      props: {
        session: record, systems: [], notify: 'all', agent: 'Chat agent', nameOf: () => 'Ada',
        agents: [{ fn: 'hub/chat', description: 'The chat agent.' }, { fn: 'fs/explore', description: 'Explores the files.' }],
        models: MODELS,
      },
    });
    expect(settings.text()).toContain('The chat agent.');
    expect(settings.get('[data-testid=session-model]').text()).toContain('Llama (free)');
    await settings.get('select').setValue('fs/explore');
    await settings.get('[data-testid=change-model]').trigger('click');
    expect(settings.emitted('agent')).toEqual([['fs/explore']]);
    expect(settings.emitted('pickModel')).toHaveLength(1);
    expect(settings.get('[data-testid=people]').text()).toContain('Ada');
  });
});

describe('ModelPicker', () => {
  it('searches, filters and sorts models, shows price and context, and picks one', async () => {
    const picker = mount(ModelPicker, { props: { models: MODELS, current: 'model:meta/llama-free' } });
    const names = (): string[] => picker.findAll('[data-model]').map((row) => row.attributes('data-model') ?? '');
    expect(names()).toEqual(['default', 'meta/llama-free', 'acme/vision-pro']);
    expect(picker.text()).toContain('Free');
    expect(picker.text()).toContain('131k context');
    expect(picker.text()).toContain('$3.00 in · $15.00 out per M tokens');
    expect(picker.get('[data-model="meta/llama-free"]').attributes('aria-selected')).toBe('true');
    await picker.get('[data-testid=model-search] input').setValue('free');
    expect(names()).toEqual(['default', 'meta/llama-free']);
    await picker.get('[data-testid=model-search] input').setValue('');
    await picker.get('[data-filter=vision]').trigger('click');
    expect(names()).toEqual(['default', 'acme/vision-pro']);
    await picker.get('[data-filter=vision]').trigger('click');
    await picker.findAll('[data-testid=model-sort] button').find((b) => b.text() === 'Context')?.trigger('click');
    expect(names()).toEqual(['default', 'acme/vision-pro', 'meta/llama-free']);
    await picker.get('[data-model="acme/vision-pro"]').trigger('click');
    await picker.get('[data-model=default]').trigger('click');
    expect(picker.emitted('pick')).toEqual([['model:acme/vision-pro'], ['default']]);
  });
});

describe('SessionRow', () => {
  it('asks the list to delete it from its menu', async () => {
    const row = mount(SessionRow, { props: { session: summary(), active: false, now: T0 }, attachTo: document.body });
    await row.get('[aria-haspopup=menu]').trigger('click');
    await nextTick();
    await nextTick();
    const remove = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((i) => i.textContent.includes('Delete'));
    remove?.click();
    expect(row.emitted('remove')).toHaveLength(1);
  });
});

describe('NotificationRow', () => {
  const at = (over: Partial<Notification>): Notification => ({ ...notification(), ...over });

  it('shows a failed turn in the danger tone', () => {
    const row = mount(NotificationRow, { props: { notification: at({ reason: 'turn-failed', title: 'Deploy failed' }), now: T0 } });
    expect(row.get('.mark').classes()).toContain('tone-danger');
    expect(row.get('[data-testid=notification-reason]').text()).toContain('Failed');
  });

  it('quietens an item that resolved, saying what became of it', () => {
    const row = mount(NotificationRow, { props: { notification: at({ reason: 'approval-needed', read: true, resolved: 'Approved' }), now: T0 } });
    expect(row.classes()).toContain('resolved');
    expect(row.get('.mark').classes()).toContain('tone-neutral');
    expect(row.get('[data-testid=notification-reason]').text()).toBe('Approval needed · Approved');
  });
});

describe('BudgetCard', () => {
  const budget = BudgetRule.parse({ id: 'bgt_s', target: { scope: 'hub' }, period: { window: 86_400_000 }, maxCost: 5, onLimit: 'ask', setBy: 'act_admin' });
  const ask = { run: RunId.parse('run_b'), budget, reason: 'the hub budget of $5.00 is used up' };

  it('says which budget and how much, and lets an admin raise it or leave it', async () => {
    const card = mount(BudgetCard, { props: { ask, fn: 'hub/chat', canRaise: true } });
    expect(card.text()).toContain('The hub budget of $5.00 is used up. Chat waits until it is raised.');
    expect(card.get('.description [data-testid=fn-pill]').attributes('data-fn')).toBe('hub/chat');
    expect(card.get('[data-testid=budget-raise]').text()).toBe('Raise by $5.00 and resume');
    await card.get('[data-testid=budget-raise]').trigger('click');
    await card.get('[data-testid=budget-leave]').trigger('click');
    expect(card.emitted('raise')).toEqual([[5]]);
    expect(card.emitted('leave')).toHaveLength(1);
  });

  it('tells anyone else an admin was asked', () => {
    const card = mount(BudgetCard, { props: { ask, fn: 'hub/chat', canRaise: false } });
    expect(card.find('[data-testid=budget-raise]').exists()).toBe(false);
    expect(card.get('[data-testid=budget-asked]').text()).toBe('An admin has been asked to raise it.');
  });
});
