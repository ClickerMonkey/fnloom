import { RunId, type Notification } from '@harness/core';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import NotificationRow from '../../components/inbox/NotificationRow.vue';
import { notification } from '../../test/fakes.ts';
import { handlerCall, run, session, summary, T0 } from '../test/fakes.ts';
import AttachmentCard from './AttachmentCard.vue';
import BackgroundStrip from './BackgroundStrip.vue';
import ComposerMeta from './ComposerMeta.vue';
import HandlerCard from './HandlerCard.vue';
import HoverCard from './HoverCard.vue';
import LinkCard from './LinkCard.vue';
import RunCard from './RunCard.vue';
import SessionRow from './SessionRow.vue';
import SessionSettings from './SessionSettings.vue';
import TurnNotice from './TurnNotice.vue';

afterEach(() => { document.body.innerHTML = ''; });

describe('HandlerCard', () => {
  it('asks a yes-or-no question like an approval, with buttons named for what they do', async () => {
    const call = handlerCall({
      args: { command: 'seq 1 30', reason: 'not on the safe list' },
      decl: { description: 'Run a command your shell setting would ask about?', args: { name: 'obj' }, returns: { name: 'bool' } },
    });
    const card = mount(HandlerCard, { props: { call, fnLabel: 'Bash' } });
    expect(card.attributes('data-kind')).toBe('confirm');
    expect(card.get('.title').text()).toBe('Run a command your shell setting would ask about?');
    expect(card.text()).toContain('Bash is waiting for your answer.');
    expect(card.get('[data-testid=arg-list]').text()).toContain('seq 1 30');
    expect(card.find('[role=switch]').exists()).toBe(false);
    expect(card.get('[data-testid=handler-yes]').text()).toBe('Run');
    await card.get('[data-testid=handler-yes]').trigger('click');
    await card.get('[data-testid=handler-no]').trigger('click');
    expect(card.emitted('answer')).toEqual([[true], [false]]);
  });

  it('asks anything else with a form built from the answer type', () => {
    const call = handlerCall({ decl: { description: 'Pick a folder', args: { name: 'obj' }, returns: { name: 'text' } } });
    const card = mount(HandlerCard, { props: { call, fnLabel: 'Write file' } });
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
  it('switches agents from its menu and shows the model, which opens the settings', async () => {
    const meta = mount(ComposerMeta, {
      props: {
        agent: 'Chat agent', agents: [{ fn: 'hub/chat', name: 'Chat agent' }, { fn: 'fs/explore', name: 'Explore agent' }], model: 'Llama (free)',
        systems: { total: 2, offline: 0 }, background: 1, spent: 0, compact: false,
      },
      attachTo: document.body,
    });
    expect(meta.get('[data-testid=model-chip]').text()).toBe('Llama (free)');
    await meta.get('[data-testid=agent-picker]').trigger('click');
    await nextTick();
    await nextTick();
    const items = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
    expect(items.map((i) => i.textContent.trim())).toEqual(['Chat agent', 'Explore agent', 'Chat settings…']);
    items[1]?.click();
    expect(meta.emitted('agent')).toEqual([['fs/explore']]);
    await meta.get('[data-testid=model-chip]').trigger('click');
    expect(meta.emitted('settings')).toHaveLength(1);
    expect(meta.get('[data-testid=background-count]').text()).toContain('1');
  });
});

describe('SessionSettings', () => {
  it('picks the agent and the model, and goes back to the agent’s own model', async () => {
    const record = session({ model: { model: 'meta/llama-free' } });
    const settings = mount(SessionSettings, {
      props: {
        session: record, systems: [], notify: 'all', agent: 'Chat agent', nameOf: () => 'Ada',
        agents: [{ fn: 'hub/chat', description: 'The chat agent.' }, { fn: 'fs/explore', description: 'Explores the files.' }],
        models: [{ id: 'meta/llama-free', name: 'Llama (free)' }],
      },
    });
    expect(settings.text()).toContain('The chat agent.');
    const [agent, model] = settings.findAll('select');
    expect(model?.element.value).toBe('model:meta/llama-free');
    await agent?.setValue('fs/explore');
    await model?.setValue('default');
    expect(settings.emitted('agent')).toEqual([['fs/explore']]);
    expect(settings.emitted('model')).toEqual([[null]]);
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
