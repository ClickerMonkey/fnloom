/**
 * Build 2's admin components: the role, suggestions and limits dialogs, the MCP rule editor, preview, connect panel and secret
 * dialog, the model call details, the day bars, the instance list and the package drop.
 */
import { pickIn } from '../../test/pickers.ts';
import { SystemName } from '@harness/core';
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { fleet, limitsView, mcpView, modelCall, roleView, scopePreview, fnDays } from '../test/build2.ts';
import { T0 } from '../../chat/test/fakes.ts';
import { model } from '../test/fakes.ts';
import { dayBars } from '../logic/metrics.ts';
import DayBars from './DayBars.vue';
import DecisionDialog from './DecisionDialog.vue';
import InstanceList from './InstanceList.vue';
import McpConnect from './McpConnect.vue';
import McpPreview from './McpPreview.vue';
import McpSelectorEditor from './McpSelectorEditor.vue';
import ModelCallDetails from './ModelCallDetails.vue';
import ModelLimitsDialog from './ModelLimitsDialog.vue';
import ModelRoleDialog from './ModelRoleDialog.vue';
import PackageDrop from './PackageDrop.vue';
import SecretDialog from './SecretDialog.vue';

afterEach(() => { document.body.innerHTML = ''; });

const stubs = { RouterLink: RouterLinkStub };
const inBody = { attachTo: document.body, global: { stubs } } as const;
function find(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (el === null) { throw new Error(`no ${selector}`); }
  return el;
}
const click = async (selector: string): Promise<void> => { find(selector).click(); await flushPromises(); };
async function set(selector: string, value: string): Promise<void> {
  const el = find(selector);
  const target = el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el : el.querySelector('input, select');
  if (target instanceof HTMLInputElement) { target.value = value; target.dispatchEvent(new Event('input', { bubbles: true })); }
  if (target instanceof HTMLSelectElement) { target.value = value; target.dispatchEvent(new Event('change', { bubbles: true })); }
  await flushPromises();
}
async function reveal(wrapper: { setProps: (props: { open: boolean }) => Promise<void> }): Promise<void> {
  await wrapper.setProps({ open: true });
  await flushPromises();
}

describe('model roles and limits', () => {
  it('ModelRoleDialog switches dictation between the browser and a model, offering able models first', async () => {
    const whisper = model({ id: 'openai/whisper-1', name: 'Whisper', capabilities: ['hearing'] });
    const dialog = mount(ModelRoleDialog, { ...inBody, props: { open: false, role: roleView('dictate'), models: [model(), whisper], providers: [] } });
    await reveal(dialog);
    // the browser engine needs no model
    expect(document.body.querySelector('[data-testid=role-model]')).toBeNull();
    await click('[data-testid=role-engine] [role=radio]:last-child');
    // only the models able to hear are offered, until every model is asked for
    const offered = (): (string | null)[] => [...document.body.querySelectorAll('[data-testid=role-model] [data-model]')].map((o) => o.getAttribute('data-model'));
    expect(offered()).toEqual(['openai/whisper-1']);
    expect(document.body.querySelector('[data-testid=role-model] [data-model=default]')).toBeNull();
    await click('[data-testid=role-every-model] [role=switch]');
    expect(offered()).toHaveLength(2);
    await click('[data-testid=role-save]');
    expect(document.body.textContent).toContain('Choose a model.');
    await click('[data-testid=role-model] [data-model="openai/whisper-1"]');
    expect(find('[data-testid=role-chosen]').textContent).toContain('Whisper');
    await set('[data-testid=role-language]', 'en-GB');
    await click('[data-testid=role-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ role: 'dictate', engine: { engine: 'model', model: { model: 'openai/whisper-1' } }, language: 'en-GB' }]);
    dialog.unmount();
  });

  it('ModelRoleDialog sets the decide role to a decision model with a threshold, and no language', async () => {
    const judge = model({ id: 'judge', name: 'Judge', provider: 'ollama', capabilities: ['decision'] });
    const dialog = mount(ModelRoleDialog, { ...inBody, props: { open: false, role: roleView('decide'), models: [model(), judge], providers: [] } });
    await reveal(dialog);
    expect(document.body.querySelector('[data-testid=role-language]')).toBeNull();
    expect([...document.body.querySelectorAll('[data-testid=role-model] [data-model]')].map((o) => o.getAttribute('data-model'))).toEqual(['judge']);
    await click('[data-testid=role-model] [data-model=judge]');
    await set('[data-testid=role-threshold]', '2');
    await click('[data-testid=role-save]');
    expect(document.body.textContent).toContain('The threshold is a probability from 0 to 1.');
    await set('[data-testid=role-threshold]', '0.65');
    await click('[data-testid=role-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ role: 'decide', model: { model: 'judge' }, threshold: 0.65 }]);
    dialog.unmount();
  });

  it('DecisionDialog chooses who picks suggestions: no model, a decision model (the role’s or its own), or an LLM', async () => {
    const judge = model({ id: 'judge', name: 'Judge', provider: 'ollama', capabilities: ['decision'] });
    const mini = model({ id: 'gpt-4o-mini', name: 'Mini', capabilities: ['chat'] });
    const dialog = mount(DecisionDialog, { ...inBody, props: { open: false, view: undefined, models: [judge, mini], sessions: [] } });
    await reveal(dialog);
    const offered = (): (string | null)[] => [...document.body.querySelectorAll('[data-testid=decision-model] [data-model]')].map((o) => o.getAttribute('data-model'));
    // no model: nothing to pick, and saving says so
    expect(document.body.querySelector('[data-testid=decision-model]')).toBeNull();
    await click('[data-testid=decision-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ by: 'none' }]);
    // a decision model offers decision models, and falls back to the Decisions role's
    await click('[data-testid=decision-by] [role=radio]:nth-child(2)');
    expect(offered()).toEqual(['judge']);
    expect(find('[data-testid=decision-model]').textContent).toContain('The Decisions role’s model');
    await click('[data-testid=decision-save]');
    expect(dialog.emitted('save')?.[1]).toEqual([{ by: 'decision', messages: 3, candidates: 20, cap: 6, floor: 0.35 }]);
    await click('[data-testid=decision-model] [data-model=judge]');
    await click('[data-testid=decision-save]');
    expect(dialog.emitted('save')?.[2]).toEqual([{ by: 'decision', model: { model: { model: 'judge' } }, messages: 3, candidates: 20, cap: 6, floor: 0.35 }]);
    // an LLM offers chat models and needs one
    await click('[data-testid=decision-by] [role=radio]:nth-child(3)');
    expect(offered()).toEqual(['gpt-4o-mini']);
    await click('[data-testid=decision-save]');
    expect(document.body.textContent).toContain('Pick the LLM that picks the suggestions.');
    await click('[data-testid=decision-model] [data-model="gpt-4o-mini"]');
    await click('[data-testid=decision-save]');
    expect(dialog.emitted('save')?.[3]).toEqual([{ by: 'llm', model: { model: { model: 'gpt-4o-mini' } }, messages: 3, candidates: 20, cap: 6, floor: 0.35 }]);
    dialog.unmount();
  });

  it('ModelLimitsDialog shows what each limit resolves to and from where, and saves only the admin’s', async () => {
    const dialog = mount(ModelLimitsDialog, { ...inBody, props: { open: false, view: limitsView() } });
    await reveal(dialog);
    expect(document.body.textContent).toContain('Now 4,096 tokens (Provider)');
    await set('[data-testid=limit-contextWindow]', '8192');
    await click('[data-testid=limits-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ contextWindow: 8_192, maxOutputTokens: 512 }]);
    dialog.unmount();
  });
});

describe('hub MCPs', () => {
  it('McpSelectorEditor adds checked entries and removes them', async () => {
    const editor = mount(McpSelectorEditor, { ...inBody, props: { title: 'Include', about: '', selector: { systems: [SystemName.parse('fs')] }, testid: 'inc' } });
    expect(editor.text()).toContain('fs');
    await pickIn(find('[data-testid=inc-types-input]'), 'nope');
    expect(editor.text()).toContain('Write a qualified name');
    expect(editor.emitted('change')).toBeUndefined();
    await pickIn(find('[data-testid=inc-fns-input]'), 'fs/* #read');
    expect(editor.emitted('change')?.[0]).toEqual([{ systems: ['fs'], fns: [{ fn: 'fs/*', tags: ['read'] }] }]);
    await editor.get('[data-part=systems] button').trigger('click');
    expect(editor.emitted('change')?.[1]).toEqual([{}]);
    editor.unmount();
  });

  it('McpPreview lists what rules expose and warns', () => {
    const preview = mount(McpPreview, { props: { preview: scopePreview(), loading: false } });
    // its fns are pills: the friendly label, the qualified name on hover
    expect(preview.get('[data-group=fns] [data-testid=fn-pill]').attributes('data-fn')).toBe('fs/read');
    expect(preview.get('[data-group=fns]').text()).toContain('Read');
    expect(preview.get('[data-group=closure]').text()).toContain('fs/Match');
    expect(preview.findAll('[data-testid=mcp-warning]')).toHaveLength(1);
  });

  it('McpConnect puts the secret in the snippets only when it is known, and asks to try it', async () => {
    const without = mount(McpConnect, { props: { mcp: mcpView() } });
    expect(without.get('[data-testid=mcp-claude]').text()).toContain('<secret>');
    expect(without.get('[data-testid=mcp-try]').attributes('disabled')).toBeDefined();
    const known = mount(McpConnect, { props: { mcp: mcpView(), secret: 'hmcp_abc', tried: { server: { name: 'harness', version: '1' }, tools: [{ name: 'fs_read' }] } } });
    expect(known.get('[data-testid=mcp-claude]').text()).toContain('hmcp_abc');
    expect(known.get('[data-testid=mcp-tried]').text()).toContain('1 tool');
    await known.get('form').trigger('submit');
    expect(known.emitted('try')?.[0]).toEqual(['']);
  });

  it('SecretDialog hides the secret until revealed', async () => {
    const dialog = mount(SecretDialog, { ...inBody, props: { open: false, secret: 'hmcp_secret', title: 'Secret' } });
    await reveal(dialog);
    expect(find('[data-testid=secret-value]').textContent).not.toContain('hmcp');
    await click('[data-testid=secret-reveal]');
    expect(find('[data-testid=secret-value]').textContent).toBe('hmcp_secret');
    dialog.unmount();
  });
});

describe('model calls, metrics and fleets', () => {
  it('ModelCallDetails shows a non-chat call in its own units and links to its run', async () => {
    const call = modelCall({ modality: 'transcribe', units: { modality: 'transcribe', seconds: 14.2, bytes: 226_000 } });
    const details = mount(ModelCallDetails, { props: { call } });
    expect(details.get('[data-testid=model-call-units]').text()).toBe('14s of audio');
    expect(details.find('[data-testid=llm-call]').exists()).toBe(false);
    await details.findAll('button').find((b) => b.text().includes('run'))?.trigger('click');
    expect(details.emitted('run')?.[0]).toEqual([call.run]);
  });

  it('DayBars draws one bar per day, a tooltip for the pointed one, and a table', async () => {
    const bars = dayBars(fnDays(7), 'runs', { period: 7, now: T0 });
    const chart = mount(DayBars, { props: { title: 'Runs per day', bars, format: (v: number) => String(v) } });
    expect(chart.findAll('.column')).toHaveLength(7);
    expect(chart.find('.tip').exists()).toBe(false);
    await chart.findAll('.column')[2]?.trigger('pointerenter');
    expect(chart.get('.tip').text()).toContain(bars[2]?.lines[0] ?? 'missing');
    expect(chart.findAll('tbody tr')).toHaveLength(7);
  });

  it('InstanceList lists a fleet with each one’s page and the default marked', () => {
    const list = mount(InstanceList, { props: { instances: fleet(), now: Date.now(), pageOf: (i: string) => `/i/${i}`, defaultInstance: fleet()[0]?.instance }, global: { stubs } });
    expect(list.findAll('[data-instance]')).toHaveLength(2);
    expect(list.get('[data-instance=main]').text()).toContain('Default');
    expect(list.get('[data-instance=laptop]').text()).toContain('no config yet');
    expect(list.findAllComponents(RouterLinkStub)[1]?.props('to')).toBe('/i/laptop');
  });

  it('PackageDrop takes a dropped zip and refuses anything else', async () => {
    const drop = mount(PackageDrop, { props: { zip: undefined, data: undefined, instance: '' } });
    const files = (file: File): DataTransfer => { const t = new DataTransfer(); t.items.add(file); return t; };
    await drop.get('[data-testid=package-zone]').trigger('drop', { dataTransfer: files(new File(['x'], 'notes.txt')) });
    expect(drop.text()).toContain('isn’t a package zip');
    await drop.get('[data-testid=package-zone]').trigger('drop', { dataTransfer: files(new File(['PK'], 'fs-0.4.0.zip')) });
    expect(drop.emitted('update:zip')?.[0]?.[0]).toBeInstanceOf(File);
  });
});
