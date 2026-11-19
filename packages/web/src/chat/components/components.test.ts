import { ApprovalId, BudgetId, HookBlock, QualifiedName, RunId, SessionId, type ChatMessage, type RunStatus } from '@harness/core';
import type { AnyViews } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, type FunctionalComponent } from 'vue';
import { statusLine } from '../logic/runs.ts';
import { messageSuggestions } from '../logic/session.ts';
import { llmCall, message, run, summary, T0, tree } from '../test/fakes.ts';
import ApprovalTray from './ApprovalTray.vue';
import AssistantAnswer from './AssistantAnswer.vue';
import BudgetMeter from './BudgetMeter.vue';
import ChatHeader from './ChatHeader.vue';
import ChatScroller from './ChatScroller.vue';
import Composer from './Composer.vue';
import HoverCard from './HoverCard.vue';
import InvocationForm from './InvocationForm.vue';
import LlmCallDetails from './LlmCallDetails.vue';
import MentionChip from './MentionChip.vue';
import RendererHost from './RendererHost.vue';
import RunCard from './RunCard.vue';
import RunControl from './RunControl.vue';
import RunProgress from './RunProgress.vue';
import SessionList from './SessionList.vue';
import StatusLine from './StatusLine.vue';
import TurnTree from './TurnTree.vue';
import UserMessage from './UserMessage.vue';

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

/** A fn renderer's view for a run of a fn without a form. */
const fnProps = (status: RunStatus): AnyViews['fn'] => ({ run: RunId.parse('run_1'), status, args: {}, state: {}, submit: undefined, system: { online: true, send: {}, run: {} } });

const key = (el: Element, k: string, over: KeyboardEventInit = {}): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over })); };

describe('InvocationForm', () => {
  it('names its fn as a pill in its title, and its args as a form', () => {
    const form = mount(InvocationForm, { props: { invocation: { fn: QualifiedName.parse('fs/read_file'), description: 'Read a file.', args: { name: 'obj', props: {} } }, busy: false } });
    expect(form.get('.title').text()).toBe('Run Read file');
    expect(form.get('.title [data-testid=fn-pill]').attributes('data-fn')).toBe('fs/read_file');
    expect(form.attributes('aria-label')).toBe('Run Read file');
  });
});

describe('RunCard', () => {
  it('shows the label, what it is about, live status and cost; never a raw id', () => {
    const card = mount(RunCard, { props: { run: run({ id: 'run_card', totalCost: 0.02, cost: 0.01 }), now: T0 + 2_300, collapsed: false } });
    expect(card.text()).toContain('Read file');
    expect(card.text()).toContain('docs/harness.md');
    expect(card.get('[data-testid=run-status]').text()).toBe('Read file…');
    expect(card.text()).toContain('2.3s');
    expect(card.text()).toContain('$0.02');
    expect(card.text()).not.toContain('run_card');
    expect(card.classes()).toContain('active');
    // its fn is a pill (which opens the fn), outside the button that opens the run
    const pill = card.get('.line [data-testid=fn-pill]');
    expect(pill.attributes('data-fn')).toBe(card.attributes('data-fn'));
    expect(pill.text()).toBe('Read file');
    expect(card.get('.summary').find('[data-testid=fn-pill]').exists()).toBe(false);
  });

  it('puts a failure in place of its summary, collapses, opens and moves to the background', async () => {
    const failed = run({ status: 'failed', outcome: { status: 'failed', error: { class: 'caller', message: 'No such file' } } });
    const card = mount(RunCard, { props: { run: failed, now: T0, collapsed: true } });
    expect(card.text()).toContain('No such file');
    expect(card.find('[data-testid=run-status]').exists()).toBe(false);
    await card.get('.summary').trigger('click');
    expect(card.emitted('open')).toHaveLength(1);
    // a settled failure has nothing below its line, so no chevron offers to open it
    expect(card.find('[aria-label=Expand]').exists()).toBe(false);
    const live = mount(RunCard, { props: { run: run(), now: T0, collapsed: false } });
    await live.get('[aria-label=Collapse]').trigger('click');
    expect(live.emitted('toggle')?.[0]).toEqual([true]);
    await live.get('[aria-label="Move to background"]').trigger('click');
    expect(live.emitted('background')).toHaveLength(1);
  });

  it('says each fact once: no repeated args in its words, none on the line beside its renderer, the byline as a tooltip', () => {
    const bash = run({ fn: 'fs/bash', args: { command: 'ls -la' }, text: { phase: 'active', one: 'Running ls -la', many: 'Running {n}' } });
    const plain = mount(RunCard, { props: { run: bash, now: T0, collapsed: false, byline: 'You ran this' } });
    expect(plain.text().split('ls -la')).toHaveLength(2);
    expect(plain.find('[data-testid=run-status]').exists()).toBe(false);
    expect(plain.get('.summary').attributes('title')).toBe('You ran this');
    const View: FunctionalComponent = () => h('p', { class: 'custom' }, '$ ls -la');
    const drawn = mount(RunCard, { props: { run: bash, now: T0, collapsed: false, view: { component: View, props: fnProps('running') } } });
    expect(drawn.text().split('ls -la')).toHaveLength(2);
  });

  it('draws the fn’s renderer, and a placeholder when it throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Good: FunctionalComponent<{ status: string }> = (p) => h('p', { class: 'custom' }, `custom ${p.status}`);
    const Bad: FunctionalComponent = () => { throw new Error('boom'); };
    const good = mount(RunCard, { props: { run: run(), now: T0, collapsed: false, view: { component: Good, props: fnProps('running') } } });
    expect(good.get('.custom').text()).toBe('custom running');
    const bad = mount(RendererHost, { props: { view: { component: Bad, props: fnProps('running') }, label: 'bash run' } });
    await flushPromises();
    expect(bad.find('[data-testid=renderer-broken]').text()).toContain("Couldn't show this bash run.");
    expect(error).toHaveBeenCalledOnce();
    expect(bad.emitted('failed')).toHaveLength(1);
    error.mockRestore();
  });
});

describe('RunProgress and StatusLine', () => {
  it('draws a bar or steps', () => {
    const bar = mount(RunProgress, { props: { progress: { fraction: 0.25, message: 'Indexing' } } });
    expect(bar.get('[role=progressbar]').attributes('aria-valuenow')).toBe('25');
    const steps = mount(RunProgress, { props: { progress: { steps: { fetch: { status: 'done' }, build: { status: 'active', detail: 'vite' } } }, titles: { fetch: 'Fetch sources' } } });
    expect(steps.findAll('.step').map((s) => s.classes())).toEqual([expect.arrayContaining(['done']), expect.arrayContaining(['active'])]);
    expect(steps.text()).toContain('Fetch sources');
    expect(steps.text()).toContain('Build');
  });

  it('sums up what is happening and opens the tree', async () => {
    const line = statusLine([run({ id: 'run_1' }), run({ id: 'run_2' })], T0);
    const status = mount(StatusLine, { props: { line } });
    expect(status.text()).toContain('Read file ×2…');
    await status.trigger('click');
    expect(status.emitted('tree')).toHaveLength(1);
  });
});

describe('UserMessage', () => {
  const parts = (): ChatMessage['parts'] => [
    { type: 'text', text: 'Look at ' }, { type: 'mention', provider: 'fs/files', label: 'harness.md', target: { path: 'docs/harness.md' }, text: 'the doc' },
    { type: 'command', context: 'fs/tree', args: { root: 'src' } },
    { type: 'extra', extra: 'suggested-fns', blocks: [HookBlock.parse({ type: 'suggest-fns', items: [{ fn: 'fs/read_file' }] }), HookBlock.parse({ type: 'text', tag: 'local-time', text: '9:30' })] },
  ];

  it('draws chips, keeps what was added for the model behind a dimmed row, and shows suggestion counts', async () => {
    const m = message({ parts: parts() });
    const view = mount(UserMessage, {
      props: { message: m, mine: true, authorName: 'Ada', now: T0, commandName: () => 'tree', suggestions: messageSuggestions(m, undefined), actions: ['copy', 'reply'] },
    });
    expect(view.get('[data-testid=mention-chip]').text()).toBe('harness.md');
    expect(view.get('[data-testid=command-chip]').text()).toContain('/tree');
    expect(view.text()).not.toContain('<mention');
    expect(view.text()).not.toContain('9:30');
    await view.get('.added-toggle').trigger('click');
    expect(view.text()).toContain('<local-time> 9:30');
    expect(view.get('[data-testid=suggested-fns]').text()).toBe('1');
    expect(view.find('[data-testid=suggested-context]').exists()).toBe(false);
    await view.get('[data-action=reply]').trigger('click');
    expect(view.emitted('action')?.[0]).toEqual(['reply']);
  });

  it('opens a suggestion icon to what was used and what was left out, with the reason', async () => {
    const m = message({
      parts: [{ type: 'text', text: 'hi' }],
      suggestions: { by: 'decision', items: [{ used: true, kind: 'fn', name: 'fs/read_file', score: 0.8 }, { used: false, kind: 'fn', name: 'fs/glob', score: 0.3, reason: 'declined', note: 'not about files' }] },
    });
    const view = mount(UserMessage, { props: { message: m, mine: true, authorName: 'Ada', now: T0, commandName: () => '', suggestions: messageSuggestions(m, undefined), actions: [] }, attachTo: document.body });
    await view.get('[data-testid=suggested-fns]').trigger('click');
    await nextTick();
    const skipped = document.body.querySelector('[data-testid=suggestions-skipped]');
    expect(skipped?.textContent).toContain('The decision model declined it: not about files');
    expect(document.body.textContent).toContain('Chosen by the decision model');
    view.unmount();
  });

  it('shows a message that is only `!` runs as their cards, with no bubble', () => {
    const r = run({ id: 'run_x', fn: 'fs/bash' });
    const m = message({ parts: [{ type: 'invocation', fn: 'fs/bash', run: r.id }] });
    const view = mount(UserMessage, { props: { message: m, mine: true, authorName: 'Ada', now: T0, commandName: () => '', suggestions: { context: [], fns: [] }, actions: [], runs: [r] } });
    expect(view.find('.bubble').exists()).toBe(false);
    expect(view.find('[data-testid=run-card]').exists()).toBe(true);
  });

  it('shows the quote of what it replies to, and jumps to it', async () => {
    const view = mount(UserMessage, {
      props: { message: message(), mine: false, authorName: 'Bea', now: T0, commandName: () => '', suggestions: { context: [], fns: [] }, actions: [], quote: { author: 'Chat agent', excerpt: 'Earlier answer' } },
    });
    expect(view.text()).toContain('Bea');
    await view.get('[data-testid=reply-quote]').trigger('click');
    expect(view.emitted('quote')).toHaveLength(1);
  });
});

describe('AssistantAnswer', () => {
  it('draws every iteration of a turn as one answer with one avatar, runs in order, and a caret while streaming', () => {
    const first = message({ role: 'assistant', author: 'act_agent', turn: 'trn_a', parts: [{ type: 'text', text: 'Reading.' }], runs: ['run_x', 'run_y'] });
    const second = message({ role: 'assistant', author: 'act_agent', turn: 'trn_a', status: 'streaming', parts: [{ type: 'text', text: 'Done **now**' }] });
    const runs = new Map([[first.id, [run({ id: 'run_x' }), run({ id: 'run_y', fn: 'fs/write_file' })]]]);
    const answer = mount(AssistantAnswer, {
      props: {
        messages: [first, second], authorName: 'Chat agent', now: T0, streaming: true, failed: false, runsOf: (m: ChatMessage) => runs.get(m.id) ?? [],
        collapsed: () => false, viewOf: () => undefined, attachmentView: () => undefined, actions: ['copy'],
        statusLine: statusLine([], T0), waiting: false, grouped: false,
      },
    });
    expect(answer.findAll('.avatar')).toHaveLength(1);
    expect(answer.findAll('[data-testid=run-card]').map((c) => c.attributes('data-run'))).toEqual(['run_x', 'run_y']);
    expect(answer.findAll('[data-testid=answer-text]').at(-1)?.classes()).toContain('caret');
    expect(answer.find('strong').text()).toBe('now');
  });

  it('collapses fn calls in a row into one section, latest fn first, and opens it to show the cards in call order', async () => {
    const m = message({ role: 'assistant', author: 'act_agent', parts: [{ type: 'text', text: 'Done.' }], runs: ['run_a', 'run_b', 'run_c'] });
    const runs = [run({ id: 'run_a', fn: 'fs/read_file', status: 'done' }), run({ id: 'run_b', fn: 'fs/bash', status: 'failed' }), run({ id: 'run_c', fn: 'fs/read_file', status: 'done' })];
    const answer = mount(AssistantAnswer, {
      props: {
        messages: [m], authorName: 'Chat agent', now: T0, streaming: false, failed: false, runsOf: () => runs,
        collapsed: () => true, viewOf: () => undefined, attachmentView: () => undefined, actions: [],
      },
    });
    const group = answer.get('[data-testid=run-group]');
    expect(group.text()).toContain('3 fn calls, 1 failed');
    expect(group.text()).toContain('Read file ×2 · Bash');
    expect(answer.findAll('[data-testid=run-card]')).toHaveLength(0);
    await answer.get('[data-testid=run-group-toggle]').trigger('click');
    expect(answer.findAll('[data-testid=run-card]').map((c) => c.attributes('data-run'))).toEqual(['run_a', 'run_b', 'run_c']);
  });

  it('draws reasoning, runs and words in the order they streamed', () => {
    const live = message({ role: 'assistant', author: 'act_agent', status: 'streaming', parts: [{ type: 'text', text: 'Looking. Found it.' }], runs: ['run_x'] });
    const segments = [
      { kind: 'reasoning', text: 'First, look.' }, { kind: 'text', text: 'Looking. ' }, { kind: 'runs', runs: [RunId.parse('run_x')] },
      { kind: 'reasoning', text: 'It is there.' }, { kind: 'text', text: 'Found it.' },
    ] as const;
    const answer = mount(AssistantAnswer, {
      props: {
        messages: [live], authorName: 'Chat agent', now: T0, streaming: true, failed: false, runsOf: () => [run({ id: 'run_x' })], liveOf: () => segments,
        collapsed: () => false, viewOf: () => undefined, attachmentView: () => undefined, actions: [],
      },
    });
    const order = answer.findAll('[data-testid=reasoning], [data-testid=answer-text], [data-testid=run-card]').map((el) => el.attributes('data-testid'));
    expect(order).toEqual(['reasoning', 'answer-text', 'run-card', 'reasoning', 'answer-text']);
  });

  it('shows the agent working, and no actions, until something of a streaming answer arrives', async () => {
    const empty = message({ role: 'assistant', author: 'act_agent', status: 'streaming', parts: [] });
    const answer = mount(AssistantAnswer, {
      props: {
        messages: [empty], authorName: 'Chat agent', now: T0, streaming: true, failed: false, runsOf: () => [],
        collapsed: () => false, viewOf: () => undefined, attachmentView: () => undefined, actions: ['copy', 'reply'],
      },
    });
    expect(answer.find('[data-testid=answer-typing]').exists()).toBe(true);
    expect(answer.find('.meta').exists()).toBe(false);
    await answer.setProps({ messages: [{ ...empty, parts: [{ type: 'text', text: 'Hello' }] }] });
    expect(answer.find('[data-testid=answer-typing]').exists()).toBe(false);
    expect(answer.find('.meta').exists()).toBe(true);
  });

  it('collapses every card at once and shows reasoning behind a toggle', async () => {
    const m = message({ role: 'assistant', author: 'act_agent', runs: ['run_1', 'run_2'] });
    const answer = mount(AssistantAnswer, {
      props: {
        messages: [{ ...m, parts: [{ type: 'reasoning', text: 'Because the file is there.' }] }], authorName: 'Chat agent', now: T0, streaming: false, failed: false,
        runsOf: () => [run({ id: 'run_1' }), run({ id: 'run_2' })], collapsed: () => false, viewOf: () => undefined, attachmentView: () => undefined, actions: [], grouped: false,
      },
    });
    await answer.get('.collapse-all').trigger('click');
    expect(answer.emitted('collapseAll')?.[0]).toEqual([true]);
    expect(answer.text()).not.toContain('Because');
    await answer.get('.reasoning-toggle').trigger('click');
    expect(answer.text()).toContain('Because the file is there.');
  });
});

describe('ApprovalTray', () => {
  const items = [
    { id: ApprovalId.parse('apr_1'), fn: 'fs/write_file' as const, description: 'Write a file', args: { path: 'README.md', content: 'x'.repeat(400) }, rememberable: true },
    { id: ApprovalId.parse('apr_2'), fn: 'fs/delete' as const, description: '', args: undefined, rememberable: true },
    {
      id: ApprovalId.parse('apr_3'), fn: 'database/run_query' as const, description: '', args: undefined, rememberable: false,
      preview: { title: 'Refund two orders', irreversible: false, parts: [] },
    },
  ];

  it('asks about the oldest first, clamps long args, lists the rest, and approves together only those without a preview', async () => {
    const tray = mount(ApprovalTray, { props: { items } });
    expect(tray.text()).toContain('Allow Write file?');
    expect(tray.get('[data-testid=approvals-others]').text()).toContain('2 more waiting');
    expect(tray.get('[data-testid=approvals-others]').text()).toContain('Refund two orders');
    expect(tray.text()).toContain('Show more');
    await tray.findAll('[role=radio]')[1]?.trigger('click');
    await tray.get('[data-testid=approve]').trigger('click');
    expect(tray.emitted('decide')?.[0]).toEqual(['apr_1', true, 'session', '', undefined]);
    await tray.get('[data-testid=deny]').trigger('click');
    await tray.get('input').setValue('not that file');
    await tray.get('[data-testid=deny-confirm]').trigger('click');
    expect(tray.emitted('decide')?.[1]).toEqual(['apr_1', false, 'session', 'not that file', undefined]);
    await tray.get('[data-testid=approve-all]').trigger('click');
    expect(tray.get('[data-testid=approve-all]').text()).toBe('Approve 2');
    expect(tray.emitted('decideAll')?.[0]).toEqual([['apr_1', 'apr_2'], true, 'session']);
    await tray.get('[data-testid=deny-all]').trigger('click');
    expect(tray.emitted('decideAll')?.[1]).toEqual([['apr_1', 'apr_2', 'apr_3'], false, 'session']);
  });
});

describe('RunControl', () => {
  it('lets a person pick which running fns to pause, or all', async () => {
    const runs = [
      { run: RunId.parse('run_a'), fn: 'fs/bash', status: 'running', pause: true, resume: false, cancel: true },
      { run: RunId.parse('run_b'), fn: 'fs/glob', status: 'running', pause: false, resume: false, cancel: true },
    ] as const;
    const control = mount(RunControl, { props: { controls: { pause: true, cancel: true, uncancellable: [], undoLastTurn: false, runs: [...runs] }, running: true, paused: false, stopping: false }, attachTo: document.body });
    await control.get('[data-testid=stop]').trigger('click');
    await nextTick();
    const box = (id: string): HTMLInputElement | null => document.body.querySelector<HTMLInputElement>(`input[data-run=${id}]`);
    expect(box('run_a')?.checked).toBe(true);
    box('run_a')?.click();
    await nextTick();
    // only run_b is chosen now, and it can't pause
    expect(document.body.querySelector<HTMLButtonElement>('[data-verb=pause]')?.disabled).toBe(true);
    document.body.querySelector<HTMLButtonElement>('[data-verb=cancel]')?.click();
    expect(control.emitted('control')?.[0]).toEqual(['cancel', ['run_b']]);
    control.unmount();
  });
});

describe('Composer', () => {
  const base = {
    text: '', placeholder: 'Message', tokens: [], canSend: true, sending: false, running: false, paused: false, stopping: false,
    picker: { open: false, kind: undefined, items: [], active: 0, loading: false }, files: [], replyAll: { shown: false, on: false }, answerers: 'Chat agent will answer',
    canAttach: true, voice: { available: true, state: 'idle' as const, startedAt: 0, problem: '' }, now: T0, touch: false,
  };

  it('sends on Enter with a keyboard, breaks lines with Shift+Enter, and leaves Enter to the textarea on touch', () => {
    const composer = mount(Composer, { props: base, attachTo: document.body });
    const area = composer.get('textarea').element;
    key(area, 'Enter');
    key(area, 'Enter', { shiftKey: true });
    expect(composer.emitted('send')).toHaveLength(1);
    const touch = mount(Composer, { props: { ...base, touch: true }, attachTo: document.body });
    key(touch.get('textarea').element, 'Enter');
    expect(touch.emitted('send')).toBeUndefined();
    key(touch.get('textarea').element, 'Enter', { ctrlKey: true });
    expect(touch.emitted('send')).toHaveLength(1);
  });

  it('gives arrows, Enter and Escape to the picker only while it is open', () => {
    const items = [{ kind: 'command' as const, key: 'c', command: { name: 'tree', context: 'fs/tree' as const, args: [], description: 'Tree' } }];
    const composer = mount(Composer, { props: { ...base, text: '/t', picker: { open: true, kind: 'command' as const, items, active: 0, loading: false } }, attachTo: document.body });
    const area = composer.get('textarea').element;
    key(area, 'ArrowDown');
    key(area, 'Enter');
    key(area, 'Escape');
    expect(composer.emitted('pickerMove')?.[0]).toEqual([1]);
    expect(composer.emitted('pick')?.[0]).toEqual([items[0]]);
    expect(composer.emitted('pickerDismiss')).toHaveLength(1);
    expect(composer.emitted('send')).toBeUndefined();
    expect(composer.get('[data-testid=composer-picker]').text()).toContain('/tree');
  });

  it('offers Stop with only what the turn allows, recalls on Up, and shows staged files and the reply strip', async () => {
    const composer = mount(Composer, {
      props: {
        ...base, running: true, controls: { pause: false, cancel: true, uncancellable: [RunId.parse('run_s')], undoLastTurn: false },
        files: [{ id: 1, name: 'a.txt', size: 10, mime: 'text/plain', status: 'uploading', progress: 0.4 }], reply: { author: 'Chat agent', excerpt: 'Sure' },
      },
      attachTo: document.body,
    });
    await composer.get('[data-testid=stop]').trigger('click');
    await nextTick();
    const enabled = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid=run-control] [data-verb]')].filter((b) => !b.disabled).map((b) => b.dataset['verb']);
    expect(enabled).toEqual(['cancel']);
    expect(document.body.textContent).toContain('1 run will finish');
    document.body.querySelector<HTMLButtonElement>('[data-verb=cancel]')?.click();
    expect(composer.emitted('control')?.[0]).toEqual(['cancel', undefined]);
    key(composer.get('textarea').element, 'ArrowUp');
    expect(composer.emitted('recall')).toHaveLength(1);
    expect(composer.get('[data-testid=staged-files]').text()).toContain('40%');
    await composer.get('[data-testid=reply-strip] button').trigger('click');
    expect(composer.emitted('clearReply')).toHaveLength(1);
  });

  it('marks chips in the text and attaches pasted files', async () => {
    const composer = mount(Composer, { props: { ...base, text: 'see @harness.md now', tokens: ['@harness.md'] } });
    expect(composer.get('mark.chip').text()).toBe('@harness.md');
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
    composer.get('textarea').element.dispatchEvent(paste);
    expect(composer.emitted('attach')?.[0]).toEqual([[file]]);
  });
});

describe('mentions', () => {
  it('asks for a card after a short hover, and draws its states', async () => {
    vi.useFakeTimers();
    const chip = mount(MentionChip, { props: { label: 'harness.md', provider: 'fs/files' } });
    await chip.trigger('mouseenter');
    expect(chip.emitted('hover')).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(chip.emitted('hover')).toHaveLength(1);
    const loading = mount(HoverCard, { props: { label: 'x', hover: undefined, loading: true } });
    expect(loading.find('[aria-label=Loading]').exists()).toBe(true);
    const gone = mount(HoverCard, { props: { label: 'harness.md', hover: undefined, loading: false } });
    expect(gone.text()).toContain("harness.md isn't available right now.");
    const card = mount(HoverCard, { props: { label: 'x', loading: false, hover: { title: 'harness.md', fields: [{ label: 'Size', value: '12 KB' }], open: { resource: 'file:///docs/harness.md' } } } });
    expect(card.text()).toContain('Size12 KB');
    await card.get('button').trigger('click');
    expect(card.emitted('open')).toHaveLength(1);
  });
});

describe('session list and header', () => {
  it('lists chats with live dots, and renames in place', async () => {
    const items = [summary({ id: 'ses_1', title: 'Router', status: 'running', updatedAt: T0 }), summary({ id: 'ses_2', title: 'Docs', updatedAt: T0 - 3_600_000 })];
    const list = mount(SessionList, {
      props: { items, current: SessionId.parse('ses_1'), search: '', archived: false, loading: false, loaded: true, hasMore: false, loadingMore: false, creating: false, now: T0 },
      attachTo: document.body,
    });
    const rows = list.findAll('[data-testid=session-row]');
    expect(rows.map((r) => r.attributes('data-status'))).toEqual(['running', 'idle']);
    expect(rows[0]?.text()).toContain('Working');
    expect(rows[1]?.text()).toContain('1h');
    await rows[1]?.get('.open').trigger('click');
    expect(list.emitted('open')?.[0]).toEqual(['ses_2']);
    await list.get('[data-testid=new-chat]').trigger('click');
    expect(list.emitted('create')).toHaveLength(1);
  });

  it('leaves the empty state to the chat home when it shows beside the list', async () => {
    const base = { items: [], search: '', archived: false, loading: false, loaded: true, hasMore: false, loadingMore: false, creating: false, now: T0 };
    expect(mount(SessionList, { props: base }).text()).toContain('No chats yet');
    const beside = mount(SessionList, { props: { ...base, homeShown: true } });
    expect(beside.text()).not.toContain('No chats yet');
    expect(beside.findAll('[data-testid=new-chat]')).toHaveLength(1);
    await beside.setProps({ search: 'zzz' });
    expect(beside.text()).toContain('No chats match');
  });

  it('keeps the phone header to one row, with the rest in its menu', async () => {
    const header = mount(ChatHeader, { props: { title: 'Router', status: 'running', people: [{ name: 'Ada', agent: false }], compact: true, canUndo: true, hasTurn: true, archived: false }, attachTo: document.body });
    expect(header.find('[data-testid=open-tree]').exists()).toBe(false);
    expect(header.get('[data-testid=session-status]').text()).toBe('Working');
    await header.get('[data-testid=open-sessions]').trigger('click');
    expect(header.emitted('sessions')).toHaveLength(1);
    await header.get('[data-testid=chat-title]').trigger('click');
    await header.get('[data-testid=title-input]').setValue('Router v2');
    await header.get('[data-testid=title-input]').trigger('keydown', { key: 'Enter' });
    expect(header.emitted('rename')?.[0]).toEqual(['Router v2']);
  });
});

describe('inspectors', () => {
  it('draws a nested tree with live statuses and LLM leaves', async () => {
    const nested = tree({ children: [tree({ run: { id: RunId.parse('run_c'), fn: 'fs/edit', status: 'running', cost: 0, totalCost: 0 }, llmCalls: [], children: [tree({ run: { id: RunId.parse('run_g'), fn: 'fs/read_file', status: 'queued', cost: 0, totalCost: 0 }, llmCalls: [] })] })] });
    const view = mount(TurnTree, { props: { tree: nested, loading: false, live: (id) => (id === 'run_c' ? 'done' : undefined) } });
    expect(view.findAll('[data-testid=tree-node]')).toHaveLength(3);
    expect(view.get('[data-run=run_c] [data-status]').attributes('data-status')).toBe('done');
    await view.get('[data-testid=tree-llm]').trigger('click');
    expect(view.emitted('llm')?.[0]).toEqual(['llm_1']);
  });

  it('shows what the model saw, with the hub’s additions picked out', async () => {
    const call = mount(LlmCallDetails, { props: { call: llmCall() } });
    expect(call.get('[data-testid=llm-cost]').text()).toBe('$0.002');
    expect(call.get('[data-testid=llm-messages]').text()).toContain('<local-time> 9:30');
    expect(call.text()).toContain('You are the chat agent.');
  });

  it('shows the cost so far and every budget in its tooltip', async () => {
    const meter = mount(BudgetMeter, {
      props: { spent: 0.5, meter: { label: 'This session', fraction: 0.9, tone: 'warn', text: '$0.05 left · This session', rows: [{ key: BudgetId.parse('bgt_1'), label: 'This session', left: 0.05, tightest: true }] } },
      attachTo: document.body,
    });
    expect(meter.get('[data-testid=session-cost]').text()).toBe('$0.50');
    expect(meter.get('[data-testid=budget-meter]').classes()).toContain('tone-warn');
    await meter.get('[data-testid=budget-meter]').trigger('click');
    await nextTick();
    expect(document.body.textContent).toContain('tightest');
  });
});

describe('ChatScroller', () => {
  it('draws rows by key, marks the beginning, and asks for older history near the top', async () => {
    const scroller = mount(ChatScroller, {
      props: { items: [{ key: 'a' }, { key: 'b' }], hasOlder: true, loadingOlder: false, beginning: false },
      slots: { item: ({ item }: { item: { key: string } }) => h('p', item.key) },
    });
    expect(scroller.findAll('[data-key]').map((r) => r.attributes('data-key'))).toEqual(['a', 'b']);
    await scroller.get('[data-testid=thread]').trigger('scroll');
    expect(scroller.emitted('older')).toHaveLength(1);
    await scroller.setProps({ hasOlder: false, beginning: true });
    expect(scroller.find('[data-testid=beginning]').exists()).toBe(true);
    expect(scroller.find('[data-testid=jump-latest]').exists()).toBe(false);
  });
});

