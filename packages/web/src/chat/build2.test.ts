/**
 * Build 2 in the chat: chat modes and contextors in the session's settings, the context inspector, the selection
 * preview, and refused input shown softly as a retried attempt rather than a failure.
 */
import { InstanceName, SessionId, type ChatModeConfig, type ContextorConfig } from '@harness/core';
import { g } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ChatModeSettings from './components/ChatModeSettings.vue';
import RunCard from './components/RunCard.vue';
import RunDetails from './components/RunDetails.vue';
import SelectionReportView from './components/SelectionReportView.vue';
import SessionSettings from './components/SessionSettings.vue';
import {
  budgetFill, budgetSlices, CONTEXTOR_CHOICES, contextorFrom, defaultContextor, defaultMode, inputBudget, MODE_CHOICES, modeFrom, rankItems, settingsValue,
} from './logic/modes.ts';
import { invalidLine, runInvalid, STATUS_LOOK } from './logic/runs.ts';
import { SelectionPreview } from './state/preview.ts';
import { fakeChatApi, run, selectionReport, session, T0 } from './test/fakes.ts';

const refused = run({
  id: 'run_bad', status: 'invalid-input', args: { file: 'README.md' },
  outcome: { status: 'invalid-input', invalid: { source: 'schema', problems: [{ path: 'path', message: 'Required' }, { path: 'file', message: 'Not a field' }], raw: '{"file":"README.md"}' } },
});

describe('chat modes and contextors', () => {
  it('reads every variant off core, with its settings as a gin type and its defaults', () => {
    expect(MODE_CHOICES.map((c) => c.type)).toEqual(['tools', 'static']);
    expect(CONTEXTOR_CHOICES.map((c) => c.type)).toEqual(['plain', 'suggest', 'graph']);
    expect(MODE_CHOICES[0]?.settings).toBeUndefined();
    expect(MODE_CHOICES[1]?.settings).toMatchObject({ name: 'obj' });
    expect(defaultMode('static')).toEqual({ type: 'static', protocol: 'auto', placement: 'system-end', loadDetail: 'full' });
    expect(defaultContextor('graph')).toMatchObject({ type: 'graph', floorExchanges: 1, shares: { history: 0.45, context: 0.35, fns: 0.2 } });
    expect(settingsValue(defaultMode('static'))).toEqual({ protocol: 'auto', placement: 'system-end', loadDetail: 'full' });
  });

  it('reads edited settings back, refusing invalid ones', () => {
    expect(modeFrom('static', { protocol: 'text' })).toEqual({ type: 'static', protocol: 'text', placement: 'system-end', loadDetail: 'full' });
    expect(modeFrom('static', { protocol: 'smoke-signals' })).toBeUndefined();
    expect(contextorFrom('graph', { threshold: -1 })).toBeUndefined();
    expect(contextorFrom('suggest', { topN: 3 })).toEqual({ type: 'suggest', topN: 3 });
  });

  it('ChatModeSettings picks a variant with its defaults, goes back to the agent’s, and saves edited settings', async () => {
    const choices = MODE_CHOICES;
    const picker = mount(ChatModeSettings<ChatModeConfig>, { props: { label: 'Chat mode', value: undefined, choices, defaults: defaultMode, read: modeFrom, testid: 'mode' } });
    await picker.get('select').setValue('static');
    expect(picker.emitted('change')?.[0]).toEqual([defaultMode('static')]);
    await picker.setProps({ value: defaultMode('static') });
    expect(picker.find('[data-testid=gin-value-view]').exists()).toBe(true);
    await picker.get('select').setValue('agent');
    expect(picker.emitted('change')?.[1]).toEqual([null]);
  });

  it('SessionSettings offers the mode, the contextor and the preview, and passes the choice on', async () => {
    const settings = mount(SessionSettings, {
      props: { session: session({ contextor: { type: 'graph' } }), systems: [], notify: 'all', agent: 'Chat', nameOf: () => 'Ada', preview: { report: selectionReport(), loading: false, problem: '' } },
    });
    expect(settings.find('[data-testid=session-mode]').exists()).toBe(true);
    const contextor = settings.get('[data-testid=session-contextor] select');
    expect(contextor.findAll('option').find((o) => o.attributes('value') === 'graph')?.attributes('selected')).toBeDefined();
    await contextor.setValue('plain');
    expect(settings.emitted('contextor')?.[0]).toEqual([{ type: 'plain' } satisfies ContextorConfig]);
    expect(settings.find('[data-testid=selection-report]').exists()).toBe(true);
    await settings.get('[data-testid=preview-text] textarea').setValue('what is in README?');
    await settings.get('[data-testid=selection-preview] form').trigger('submit');
    expect(settings.emitted('preview')?.[0]).toEqual(['what is in README?']);
  });

  it('asks the session’s contextor what a message would get, and ignores blank text', async () => {
    const api = fakeChatApi();
    const preview = new SelectionPreview(api, SessionId.parse('ses_1'));
    await preview.preview('   ');
    expect(api.previewSelection.calls).toEqual([]);
    await preview.preview(' how big is it? ');
    expect(api.previewSelection.calls).toEqual([[{ session: 'ses_1', text: 'how big is it?' }]]);
    expect(preview.report.value.value?.contextor).toBe('graph');
  });
});

describe('the context inspector', () => {
  it('splits the window into parts that add up to it, and ranks what was chosen', () => {
    const report = selectionReport();
    const slices = budgetSlices(report.budget);
    expect(slices.reduce((n, s) => n + s.tokens, 0)).toBe(report.budget.window);
    expect(slices.map((s) => s.part)).toEqual(['fixed', 'history', 'context', 'fns', 'margin', 'output', 'free']);
    expect(slices.find((s) => s.part === 'history')?.asked).toBe(1_900);
    expect(inputBudget(report.budget)).toBe(3_338);
    expect(budgetFill(report.budget)).toBeCloseTo(2_826 / 3_338);
    const ranked = rankItems(report.fns);
    expect(ranked.map((f) => f.name)).toEqual(['fs/read', 'fs/bash', 'fs/search']);
    expect(ranked[0]?.weight).toBe(1);
  });

  it('SelectionReportView shows the budget as a bar and a table, the items with their detail, and the cuts', () => {
    const view = mount(SelectionReportView, { props: { report: selectionReport() } });
    expect(view.findAll('[data-testid=budget-bar] .segment')).toHaveLength(7);
    expect(view.get('[data-part=history]').text()).toContain('asked 1,900');
    expect(view.get('[data-testid=selected-context]').text()).toContain('fs/docs');
    expect(view.get('[data-testid=selected-fns]').text()).toContain('Name only');
    expect(view.get('[data-testid=budget-cuts]').text()).toContain('2 older exchanges');
    expect(view.text()).toContain('Static toolset');
    expect(view.find('[data-testid=injected-section]').exists()).toBe(false);
  });

  it('SelectionReportView shows the injected section: its size in the fixed part, its items, what was left out and why, a rebuild', () => {
    const report = selectionReport();
    const view = mount(SelectionReportView, {
      props: {
        report: {
          ...report,
          injected: {
            tokens: 420, items: [{ name: 'input/asking', detail: 'full', tokens: 300 }, { name: 'hub/memory', detail: 'summary', tokens: 120 }],
            leftOut: [{ name: 'web/reading', why: 'system-off', reason: 'this chat does not use web' }], rebuilt: { added: [], dropped: ['web/reading'] },
          },
        },
      },
    });
    const section = view.get('[data-testid=injected-section]');
    expect(section.text()).toContain(`420 of the ${report.budget.fixed.toLocaleString()} fixed tokens · 2 items, 1 at summary`);
    expect(section.text()).toContain('input/asking');
    expect(view.get('[data-testid=injected-left-out]').text()).toContain('web/reading left out: system off (this chat does not use web)');
    expect(view.get('[data-testid=injected-rebuilt]').text()).toContain('dropped web/reading');
  });
});

describe('refused input', () => {
  it('reads as thinking harder, never as a failure', () => {
    expect(STATUS_LOOK['invalid-input'].tone).toBe('neutral');
    expect(runInvalid(refused)?.source).toBe('schema');
    expect(invalidLine(runInvalid(refused) ?? { source: 'json', problems: [{ path: '', message: 'x' }] })).toBe('The model’s call didn’t fit the fn’s args: path: Required (+1 more)');
    expect(STATUS_LOOK['invalid-input'].word).toBe('Thinking harder');
  });

  it('RunCard shows it softly with what was wrong; RunDetails lists every problem and what the model wrote', async () => {
    const card = mount(RunCard, { props: { run: refused, now: T0, collapsed: false } });
    expect(card.classes()).toContain('status-invalid-input');
    expect(card.get('[data-testid=run-retried]').text()).toBe('Thinking harder · no bearing on the result');
    expect(card.get('[data-testid=run-retried]').attributes('title')).toContain('path: Required');
    expect(card.text()).not.toMatch(/error|failed/i);
    expect(card.find('.error-text').exists()).toBe(false);
    const details = mount(RunDetails, { props: { run: refused, loading: false, now: T0 } });
    await flushPromises();
    const invalid = details.get('[data-testid=run-invalid]');
    expect(invalid.text()).toContain('No bearing on the result');
    expect(invalid.text()).not.toMatch(/error|failed/i);
    expect(invalid.findAll('li')).toHaveLength(2);
    expect(invalid.text()).toContain('{"file":"README.md"}');
    expect(details.find('[data-testid=run-error]').exists()).toBe(false);
  });
});

describe('fleets and typed args in the run inspector', () => {
  const onLaptop = run({ id: 'run_fleet', status: 'done', fn: 'fs/read', instance: 'laptop', args: { path: 'README.md', lines: 20 }, outcome: { status: 'done', result: 'ok' } });

  it('shows the instance a fleet run ran on, and not the main one', () => {
    const card = mount(RunCard, { props: { run: onLaptop, now: T0, collapsed: false } });
    expect(card.get('[data-testid=run-instance]').text()).toBe('@laptop');
    const main = mount(RunCard, { props: { run: { ...onLaptop, instance: InstanceName.parse('main') }, now: T0, collapsed: false } });
    expect(main.find('[data-testid=run-instance]').exists()).toBe(false);
    const details = mount(RunDetails, { props: { run: onLaptop, loading: false, now: T0 } });
    expect(details.get('[data-testid=run-instance]').text()).toBe('@laptop');
  });

  it('draws the args by their gin type when it is known, and offers the run’s model calls to admins', async () => {
    const argsType = g.obj({ path: g.text(), lines: g.num() }).toJSON();
    const typed = mount(RunDetails, { props: { run: onLaptop, loading: false, now: T0, tab: 'args', argsType, canSeeCalls: true } });
    await flushPromises();
    const view = typed.get('[data-testid=run-args-typed] [data-testid=gin-value-view]');
    expect(view.attributes('data-readonly')).toBe('true');
    expect(view.text()).toContain('README.md');
    await typed.get('[data-testid=run-model-calls]').trigger('click');
    expect(typed.emitted('calls')).toEqual([['run_fleet']]);
    const plain = mount(RunDetails, { props: { run: onLaptop, loading: false, now: T0, tab: 'args' } });
    await flushPromises();
    expect(plain.find('[data-testid=run-args-typed]').exists()).toBe(false);
    expect(plain.text()).toContain('README.md');
    expect(plain.find('[data-testid=run-model-calls]').exists()).toBe(false);
  });
});
