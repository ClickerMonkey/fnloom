import { pickIn } from '../../test/pickers.ts';
import { ActorId, ResourceUri, SystemParts, type Json } from '@harness/core';
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import UiSelect from '../../ui/UiSelect.vue';
import { budget, category, fnRecord, installed, logLine, model, pairing, settingValue, settingView, systemCounts, systemView, T0 } from '../test/fakes.ts';
import { adminNavGroups } from '../logic/nav.ts';
import AdminNav from './AdminNav.vue';
import AllSwitch from './AllSwitch.vue';
import BrowserRow from './BrowserRow.vue';
import BudgetDialog from './BudgetDialog.vue';
import CategoryDialog from './CategoryDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import FnList from './FnList.vue';
import ReviewFnList from './ReviewFnList.vue';
import { fnReviews } from '../logic/review.ts';
import { review } from '../test/review.ts';
import InstallDialog from './InstallDialog.vue';
import InstanceData from './InstanceData.vue';
import InstanceFacts from './InstanceFacts.vue';
import LoadState from './LoadState.vue';
import LogView from './LogView.vue';
import ModelTable from './ModelTable.vue';
import PairingCard from './PairingCard.vue';
import PolicyDialog from './PolicyDialog.vue';
import PriorityDialog from './PriorityDialog.vue';
import ProviderDialog from './ProviderDialog.vue';
import ResolvedView from './ResolvedView.vue';
import RuleRow from './RuleRow.vue';
import SettingCard from './SettingCard.vue';
import SettingDialog from './SettingDialog.vue';
import SpendMeter from './SpendMeter.vue';
import SystemCard from './SystemCard.vue';
import SystemConfig from './SystemConfig.vue';
import SystemOverview from './SystemOverview.vue';
import SystemPartList from './SystemPartList.vue';
import { partGroups } from '../logic/systems.ts';
import TokenDialog from './TokenDialog.vue';
import { FN_MODAL } from '../../fns/state/fn-modal.ts';

afterEach(() => { document.body.innerHTML = ''; });

const stubs = { RouterLink: RouterLinkStub };
const NAMES: Readonly<Record<string, string>> = { act_eng: 'Engineering', act_ada: 'Ada' };
const nameOf = (id: ActorId): string => NAMES[id] ?? id;
const people = [{ id: ActorId.parse('act_ada'), name: 'Ada', kind: 'user' as const, detail: '' }];
const groups = [{ id: ActorId.parse('act_eng'), name: 'Engineering', kind: 'group' as const, detail: '' }];

/** An element in the page (dialogs teleport to the body). */
function find(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (el === null) { throw new Error(`no ${selector}`); }
  return el;
}
const all = (selector: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(selector)];
const click = async (selector: string): Promise<void> => { find(selector).click(); await flushPromises(); };
async function type(el: HTMLElement, value: string): Promise<void> {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
  await flushPromises();
}
async function choose(el: HTMLElement, value: string): Promise<void> {
  if (el instanceof HTMLSelectElement) { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }
  await flushPromises();
}
/** The input under a field's label. */
function field(label: string): HTMLElement {
  const found = all('label').find((l) => l.textContent.trim().startsWith(label));
  const id = found?.getAttribute('for');
  if (id === null || id === undefined) { throw new Error(`no field ${label}`); }
  return find(`#${CSS.escape(id)}`);
}

const inBody = { attachTo: document.body, global: { stubs } } as const;
/** Open a dialog mounted closed, as its owner does (its draft starts fresh on opening). */
async function reveal(wrapper: { setProps: (props: { open: boolean }) => Promise<void> }): Promise<void> {
  await wrapper.setProps({ open: true });
  await flushPromises();
}

describe('UiSelect', () => {
  it('takes only values from its options', async () => {
    const value = ref('a');
    const select = mount(UiSelect, { attachTo: document.body, props: { label: 'Pick', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], modelValue: value.value, 'onUpdate:modelValue': (v: string) => { value.value = v; } } });
    await choose(find('select'), 'b');
    expect(value.value).toBe('b');
    expect(find('label').textContent).toContain('Pick');
    select.unmount();
  });
});

describe('lists and cards', () => {
  it('SystemCard shows status, process, what needs the admin and when it was seen', () => {
    const card = mount(SystemCard, { props: { system: systemView({ status: 'disconnected', installed: installed({ status: 'crashed' }), lastSeenAt: T0 - 120_000, enabled: { functions: false, renderers: true } }), now: T0, to: '/x', review: '/x/review' }, global: { stubs } });
    expect(card.text()).toContain('Offline');
    expect(card.text()).toContain('Crashed');
    expect(card.text()).toContain('Functions off');
    expect(card.text()).toContain('Seen 2m');
    expect(card.text()).toContain('12 fns');
    const config = mount(SystemCard, { props: { system: systemView({ status: 'needs-config', needsConfig: true }), now: T0, to: '/x', review: '/x/review' }, global: { stubs } });
    expect(config.text().match(/Needs config/g)).toHaveLength(1);
    // one sign of presence: the status badge, never a second "Online now"; a system not live links to its review
    const live = mount(SystemCard, { props: { system: systemView({ status: 'connected', lastSeenAt: T0 }), now: T0, to: '/x', review: '/x/review' }, global: { stubs } });
    expect(live.text().match(/Connected/g)).toHaveLength(1);
    expect(live.text()).not.toMatch(/Online now|Seen/);
    expect(live.find('[data-testid=system-card-installed]').exists()).toBe(false);
    const installedOnly = mount(SystemCard, { props: { system: systemView({ status: 'connected', stage: 'installed' }), now: T0, to: '/x', review: '/x/review' }, global: { stubs } });
    expect(installedOnly.getComponent<typeof RouterLinkStub>('[data-testid=system-card-installed]').props('to')).toBe('/x/review');
  });

  it('SystemCard shows its counts as chips, each opening its tab, zero counts and a single instance left out, waits and refusals as warnings', () => {
    const props = (counts: Parameters<typeof systemCounts>[0]) => ({ system: systemView({ counts: systemCounts(counts) }), now: T0, to: '/x', review: '/x/review' });
    const card = mount(SystemCard, { props: props({ fns: 12, context: 1, types: 0, instances: 1, pending: 2, refusals: 3 }), global: { stubs } });
    const chips = card.findAllComponents(RouterLinkStub).filter((link) => link.attributes('data-testid')?.startsWith('system-count-') === true);
    expect(chips.map((chip) => chip.text())).toEqual(['12 fns', '1 context', '2 changes wait', '3 refusals']);
    expect(chips.map((chip) => chip.props('to'))).toEqual([
      { name: 'system', params: { name: 'fs', tab: 'fns' } }, { name: 'system', params: { name: 'fs', tab: 'context' } },
      { name: 'review', params: { name: 'fs', tab: 'pending' } }, { name: 'system', params: { name: 'fs', tab: 'refusals' } },
    ]);
    expect(card.findAll('.count.warn').map((chip) => chip.text())).toEqual(['2 changes wait', '3 refusals']);
    const fleet = mount(SystemCard, { props: props({ fns: 1, instances: 2 }), global: { stubs } });
    expect(fleet.find('[data-testid=system-counts]').text()).toBe('1 fn2 instances');
    const empty = mount(SystemCard, { props: props({}), global: { stubs } });
    expect(empty.find('[data-testid=system-counts]').exists()).toBe(false);
  });

  it('AllSwitch says what on and off mean and asks for the other', async () => {
    const all = mount(AllSwitch, { props: { on: true, label: 'Use its fns', onText: 'They can be used.', offText: 'All are off.', testid: 'all' } });
    expect(all.text()).toContain('They can be used.');
    await all.get('[data-testid=all] button').trigger('click');
    expect(all.emitted('switch')).toEqual([[false]]);
    await all.setProps({ on: false });
    expect(all.text()).toContain('All are off.');
    expect(all.classes()).toContain('off');
  });

  it('InstanceFacts lists an instance’s facts, without the address of a hosted one', () => {
    const source = { version: '1.0.0', keyFingerprint: 'SHA256:ab', manifestHash: 'h1', status: 'connected' as const, address: '10.0.0.2', pairedAt: T0 - 60_000, pairedBy: ActorId.parse('act_ada'), lastSeenAt: T0 };
    const facts = mount(InstanceFacts, { props: { source, now: T0, nameOf: () => 'Ada' } });
    expect(facts.findAll('dt').map((dt) => dt.text())).toEqual(['Version', 'Address', 'Key', 'Paired', 'Last seen', 'Manifest']);
    expect(facts.text()).toContain('by Ada');
    expect(facts.text()).toContain('Online now');
    const hosted = mount(InstanceFacts, { props: { source, now: T0, nameOf: () => 'Ada', hosted: true } });
    expect(hosted.findAll('dt').map((dt) => dt.text())).not.toContain('Address');
  });

  it('InstanceData shows its folders or says it keeps its own, and exports with or without secrets', async () => {
    const data = mount(InstanceData, { props: { dirs: { data: '/d', state: '/s', cache: '/c' }, busy: false, exported: undefined } });
    expect(data.text()).toContain('/d');
    await data.get('[data-testid=export-data]').trigger('click');
    await data.get('[data-testid=export-secrets] button').trigger('click');
    expect(data.text()).toContain('plain text');
    await data.get('[data-testid=export-data]').trigger('click');
    expect(data.emitted('export')).toEqual([[false], [true]]);
    await data.setProps({ dirs: undefined, exported: { url: '/zip', size: 2048 } });
    expect(data.text()).toContain('keeps its own folders');
    expect(data.get('[data-testid=export-download]').attributes('href')).toBe('/zip');
  });

  it('PairingCard shows the code to compare and answers', async () => {
    const card = mount(PairingCard, { props: { pairing: pairing({ replaces: 'notes' }), now: T0 } });
    expect(card.get('[data-testid=pairing-code]').text()).toBe('483 912');
    expect(card.text()).toContain('9m');
    expect(card.text()).toContain('replaces the system already paired as notes');
    await card.get('[data-testid=pairing-approve]').trigger('click');
    await card.get('[data-testid=pairing-reject]').trigger('click');
    expect(card.emitted('approve')).toHaveLength(1);
    expect(card.emitted('reject')).toHaveLength(1);
    const token = mount(PairingCard, { props: { pairing: pairing({ method: 'token', code: undefined }), now: T0, busy: true } });
    expect(token.text()).toContain('It brought a pairing token');
    expect(token.find('[data-testid=pairing-code]').exists()).toBe(false);
  });

  it('FnList says why a fn is off, opens a fn in the fn modal and links to its runs', async () => {
    const opened: string[] = [];
    const modal = { open: (name: string) => { opened.push(name); }, within: () => undefined };
    const list = mount(FnList, { props: { fns: [fnRecord(), fnRecord({ name: 'fs/write_file', available: { unavailable: 'disabled', detail: '' }, paused: true })], now: T0, runsOf: (fn: string) => `/runs?fn=${fn}` }, global: { stubs, provide: { [FN_MODAL]: modal } } });
    expect(list.text()).toContain('Read file');
    expect(list.text()).toContain('Turned off');
    expect(list.text()).toContain('Paused');
    expect(list.text()).toContain('140 runs');
    expect(list.text()).toContain('2% failed');
    // its numbers link to its runs; its name opens it in the fn modal, with its switch and numbers, over the list
    expect(list.findAllComponents(RouterLinkStub)[1]?.props('to')).toBe('/runs?fn=fs/write_file');
    await list.findAll('[data-testid=fn-page]')[1]?.trigger('click');
    expect(opened).toEqual(['fs/write_file']);
  });

  it('FnList flags a fn with no examples, and only that one', () => {
    const shown = fnRecord().decl;
    const list = mount(FnList, { props: { fns: [fnRecord({ decl: { ...shown, examples: [{ args: { path: 'a.md' } }] } }), fnRecord({ name: 'fs/write_file' })], now: T0, runsOf: (fn: string) => `/runs?fn=${fn}` }, global: { stubs } });
    const flags = list.findAll('[data-testid=fn-no-examples]');
    expect(flags).toHaveLength(1);
    expect(list.findAll('.fn')[1]?.find('[data-testid=fn-no-examples]').text()).toBe('No examples');
  });

  it('ReviewFnList flags a native fn its author gave no example, and not one with', () => {
    const list = mount(ReviewFnList, { props: { fns: fnReviews(review()) }, global: { stubs } });
    expect(list.find('[data-fn="notes/save"] [data-testid="review-fn-no-examples"]').exists()).toBe(true);
    expect(list.find('[data-fn="notes/find"] [data-testid="review-fn-no-examples"]').exists()).toBe(false);
  });

  it('FnList switches each fn by itself on a system’s page', async () => {
    const list = mount(FnList, { props: { fns: [fnRecord(), fnRecord({ name: 'fs/write_file', disabled: true })], now: T0, runsOf: (fn: string) => `/runs?fn=${fn}`, switchable: true }, global: { stubs } });
    const switches = list.findAll('[data-testid="fn-switch"] [role="switch"]');
    expect(switches.map((one) => one.attributes('aria-checked'))).toEqual(['true', 'false']);
    await switches[1]?.trigger('click');
    expect(list.emitted('switch')).toEqual([['fs/write_file', true]]);
  });

  it('SystemPartList heads each kind of part, says origin, version and audience, and opens a part’s declaration', async () => {
    const parts = SystemParts.parse({
      parts: [
        { section: 'kinds', name: 'fs/file', about: 'A file', origin: 'contract', version: 'abcdef0123456789', decl: { name: 'file' } },
        { section: 'commands', name: '/guide', about: 'The guide', origin: 'runtime', version: '0123456789abcdef', visibility: 'user', owner: 'fs/guide', decl: { name: 'guide' } },
        { section: 'examples', name: 'fs/read #1', about: 'Read a file', origin: 'contract', version: 'ffff000011112222', owner: 'fs/read', decl: { text: 'Read a file' } },
      ],
      more: { examples: 140 },
    });
    const root = { uri: ResourceUri.parse('fs://main/work'), name: 'work', description: 'The work folder', index: 'all' as const, ignore: [], watch: true };
    const list = mount(SystemPartList, {
      props: { groups: partGroups(parts), roots: [root], rootPage: () => '/explore/fs/main/work', ownerPage: (section: string, owner: string) => `/${section}/${owner}` },
      global: { stubs },
    });
    expect(list.findAll('section').map((one) => one.attributes('data-section'))).toEqual(['roots', 'kinds', 'commands', 'examples']);
    expect(list.text()).toContain('From its contract');
    expect(list.text()).toContain('Added while running');
    expect(list.text()).toContain('abcdef01');
    expect(list.text()).toContain('Seen by people');
    expect(list.text()).toContain('Showing the first 1');
    await list.findAll('[data-testid="system-part"]')[1]?.trigger('click');
    expect(list.find('[data-testid="system-part-owner"]').exists()).toBe(true);
    expect(list.text()).toContain('"name": "guide"');
  });

  it('LogView shows lines by stream and offers to follow again', async () => {
    const view = mount(LogView, { attachTo: document.body, props: { lines: [logLine('ok'), logLine('bad', { stream: 'stderr' }), logLine('started', { stream: 'hub' })] } });
    expect(view.findAll('.line')).toHaveLength(3);
    expect(view.find('.stderr').text()).toContain('bad');
    expect(view.text()).toContain('Following live');
    const box = view.get('[data-testid=log]').element;
    Object.defineProperty(box, 'scrollHeight', { value: 1_000 });
    Object.defineProperty(box, 'clientHeight', { value: 100 });
    box.scrollTop = 0;
    await view.get('[data-testid=log]').trigger('scroll');
    expect(view.text()).toContain('Paused while you read');
    await view.get('[data-testid=log-follow]').trigger('click');
    expect(view.text()).toContain('Following live');
    const empty = mount(LogView, { props: { lines: [] } });
    expect(empty.text()).toContain('No output yet');
  });

  it('ModelTable narrows by words and shows prices', async () => {
    const table = mount(ModelTable, { attachTo: document.body, props: { models: [model(), model(), model({ id: 'x/vision', name: 'Seer', capabilities: ['vision'], pricing: { input: 1, output: 2 }, contextWindow: 0 })], providerName: () => 'OpenRouter' } });
    expect(table.findAll('[data-testid=model-row]')).toHaveLength(2);
    expect(table.text()).toContain('Free');
    expect(table.text()).toContain('—');
    await type(find('input'), 'vision');
    expect(table.findAll('[data-testid=model-row]')).toHaveLength(1);
    expect(table.text()).toContain('$1.00 / $2.00');
    await type(find('input'), 'nothing here');
    expect(table.text()).toContain('No models match');
  });

  it('RuleRow, SpendMeter, BrowserRow and LoadState draw their parts', async () => {
    const row = mount(RuleRow, { props: { icon: 'coins', title: 'Whole hub', detail: '$5.00 per day', label: 'budget' }, slots: { measure: '<span class="m">m</span>' } });
    expect(row.find('.m').exists()).toBe(true);
    await row.get('[data-testid=edit]').trigger('click');
    await row.get('[data-testid=remove]').trigger('click');
    expect(row.emitted('edit')).toHaveLength(1);
    expect(row.emitted('remove')).toHaveLength(1);
    expect(row.get('[data-testid=edit]').attributes('aria-label')).toBe('Edit budget');

    const meter = mount(SpendMeter, { props: { spent: 4.5, max: 5 } });
    expect(meter.classes()).toContain('tone-warn');
    expect(meter.attributes('aria-label')).toBe('$4.50 of $5.00 spent');

    const browserRow = mount(BrowserRow, { props: { title: 'Read file', detail: 'docs', at: T0 - 60_000, now: T0, selected: true } });
    expect(browserRow.text()).toContain('1m');
    expect(browserRow.get('button').attributes('aria-current')).toBe('true');
    await browserRow.get('button').trigger('click');
    expect(browserRow.emitted('open')).toHaveLength(1);

    const loading = mount(LoadState, { props: { loading: true, problem: '', ready: false, empty: false }, slots: { default: '<p class="c">content</p>' } });
    expect(loading.find('.c').exists()).toBe(false);
    const failed = mount(LoadState, { props: { loading: false, problem: 'Nope.', ready: true, empty: false }, slots: { default: '<p class="c">content</p>' } });
    expect(failed.text()).toContain('Nope.');
    expect(failed.find('.c').exists()).toBe(true);
    await failed.get('[data-testid=retry]').trigger('click');
    expect(failed.emitted('retry')).toHaveLength(1);
    const empty = mount(LoadState, { props: { loading: false, problem: '', ready: true, empty: true, emptyTitle: 'None' }, slots: { default: '<p class="c">content</p>' } });
    expect(empty.text()).toContain('None');
  });

  it('AdminNav links a group each, opens the current group into its sections and marks the current one', () => {
    const nav = mount(AdminNav, { props: { groups: adminNavGroups({ name: 'runs' }, { systems: 3 }) }, global: { stubs } });
    // seven groups (People among them), the open one (Runs, Model calls) as two links
    expect(nav.findAllComponents(RouterLinkStub)).toHaveLength(8);
    expect(nav.get('[aria-current=page]').text()).toContain('Runs');
    expect(nav.get('[data-testid=admin-nav-model-calls]').text()).toContain('Model calls');
    expect(nav.get('[data-testid=admin-nav-group-systems] .count').text()).toBe('3');
    expect(nav.get('[data-testid=admin-nav-mcps]').text()).toContain('Hub MCP');
  });

  it('SettingCard lists values per actor and asks to edit', async () => {
    const card = mount(SettingCard, { props: { entry: { view: settingView(), values: [settingValue()] }, nameOf, now: T0 } });
    expect(card.text()).toContain('Engineering');
    expect(card.text()).toContain('On groups, people');
    expect(card.text()).toContain('The strictest wins');
    await card.get('[data-testid=setting-add]').trigger('click');
    expect(card.emitted('edit')?.[0]).toEqual([undefined]);
  });
});

describe('system pages', () => {
  it('SystemOverview switches parts, runs the actions that apply, and asks to upgrade to a version', async () => {
    const overview = mount(SystemOverview, { attachTo: document.body, props: { system: systemView({ installed: installed({ lastExit: { code: 1, at: T0, output: 'Error: boom' } }) }), now: T0, nameOf } });
    await click('[data-testid=enable-renderers] [role=switch]');
    expect(overview.emitted('enable')?.[0]).toEqual(['renderers', false]);
    expect(document.body.querySelector('[data-testid=act-start]')).toBeNull();
    await click('[data-testid=act-restart]');
    expect(overview.emitted('act')?.[0]).toEqual(['restart']);
    await type(field('Upgrade to'), ' 1.2.0 ');
    await click('[data-testid=act-upgrade]');
    expect(overview.emitted('act')?.[1]).toEqual(['upgrade', '1.2.0']);
    expect(overview.text()).toContain('code 1');
    expect(overview.text()).toContain('Error: boom');
    expect(overview.text()).toContain('Paired');
    await overview.setProps({ acting: 'stop' });
    expect(find('[data-testid=act-remove]').hasAttribute('disabled')).toBe(true);
    overview.unmount();
  });

  it('SystemConfig makes a form from the config type and lists what the hub refused', async () => {
    const none = mount(SystemConfig, { props: { type: undefined, value: undefined, needsConfig: false, now: T0 } });
    expect(none.text()).toContain('Nothing to configure');
    const config = mount(SystemConfig, { attachTo: document.body, props: { type: systemView().configType, value: { roots: [{ path: '/w', name: 'w', writable: true }] }, version: 2, setAt: T0, needsConfig: true, now: T0, problems: ['roots: too few'] } });
    expect(config.text()).toContain("It can't be used until it has a valid config.");
    expect(config.text()).toContain('roots: too few');
    expect(config.text()).toContain('Version 2');
    await click('[data-testid=gin-submit]');
    expect(config.emitted('save')?.[0]).toEqual([{ roots: [{ path: '/w', name: 'w', writable: true }] }]);
    config.unmount();
  });
});

describe('dialogs', () => {
  it('TokenDialog checks the name and shows the token once made', async () => {
    const dialog = mount(TokenDialog, { ...inBody, props: { open: false, now: T0 } });
    await reveal(dialog);
    await type(field('System name'), 'Bad Name');
    await click('[data-testid=token-create]');
    expect(document.body.textContent).toContain('Lowercase letters');
    expect(dialog.emitted('create')).toBeUndefined();
    await type(field('System name'), 'notes');
    await click('[data-testid=token-create]');
    expect(dialog.emitted('create')?.[0]).toEqual(['notes', 3_600_000, undefined]);
    await dialog.setProps({ token: { token: 'ptk-abc', expiresAt: T0 + 3_600_000 } });
    expect(find('[data-testid=token-made]').textContent).toContain('ptk-abc');
    dialog.unmount();
  });

  it('InstallDialog needs every field of its source', async () => {
    const dialog = mount(InstallDialog, { ...inBody, props: { open: false, from: 'package' } });
    await reveal(dialog);
    await click('[data-testid=install-submit]');
    expect(all('[aria-invalid=true]')).toHaveLength(2);
    await type(field('Package'), '@acme/notes');
    await type(field('Version'), '1.0.0');
    await click('[data-testid=install-submit]');
    expect(dialog.emitted('install')?.[0]).toEqual([{ package: '@acme/notes', version: '1.0.0' }, true]);
    dialog.unmount();
  });

  it('ProviderDialog shows the chosen provider\'s fields', async () => {
    const dialog = mount(ProviderDialog, { ...inBody, props: { open: false, kind: 'openai' } });
    await reveal(dialog);
    expect(field('API key').getAttribute('type')).toBe('password');
    await type(field('API key'), 'sk-1');
    await click('[data-testid=provider-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ provider: 'openai', apiKey: 'sk-1' }]);
    expect(field('Base URL')).toBeDefined();
    await choose(field('Provider'), 'openrouter');
    expect(() => field('Base URL')).toThrow();
    expect(field('API key')).toBeDefined();
    dialog.unmount();
  });

  it('CategoryDialog adds, orders and removes models', async () => {
    const dialog = mount(CategoryDialog, { ...inBody, props: { open: false, category: category(), models: ['openai/gpt-oss-20b:free', 'b/model', 'c/model'] } });
    await reveal(dialog);
    await pickIn(field('Add a model'), 'b/model');
    expect(all('.item code').map((c) => c.textContent)).toEqual(['openai/gpt-oss-20b:free', 'b/model']);
    find('.item:nth-child(2) [aria-label="Move up"]').click();
    await nextTick();
    expect(all('.item code').map((c) => c.textContent)).toEqual(['b/model', 'openai/gpt-oss-20b:free']);
    find('.item:nth-child(2) [aria-label="Remove"]').click();
    await nextTick();
    await click('[data-testid=category-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ name: 'fast', description: 'Quick answers', models: ['b/model'] }]);
    dialog.unmount();
  });

  it('BudgetDialog picks a group from the actors and saves its share', async () => {
    const dialog = mount(BudgetDialog, { ...inBody, props: { open: false, actorsAt: (level: string) => (level === 'group' ? groups : level === 'user' ? people : undefined) } });
    await reveal(dialog);
    await choose(field('Applies to'), 'group');
    await choose(field('Group'), 'act_eng');
    await type(field('Most it may spend'), '3');
    await click('[data-testid=budget-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ target: { scope: 'group', group: 'act_eng' }, period: { window: 86_400_000 }, maxCost: 3, share: 'pooled', onLimit: 'refuse' }]);
    dialog.unmount();
    const editing = mount(BudgetDialog, { ...inBody, props: { open: false, budget: budget({ maxCost: 9 }), actorsAt: () => undefined } });
    await reveal(editing);
    expect(field('Most it may spend')).toHaveProperty('value', '9');
    editing.unmount();
  });

  it('PriorityDialog needs a default or a ceiling', async () => {
    const dialog = mount(PriorityDialog, { ...inBody, props: { open: false, actorsAt: () => undefined } });
    await reveal(dialog);
    await click('[data-testid=priority-save]');
    expect(document.body.textContent).toContain('Set a default, a ceiling, or both.');
    await choose(field('Ceiling'), 'normal');
    await click('[data-testid=priority-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ target: { scope: 'hub' }, max: 'normal' }]);
    dialog.unmount();
  });

  it('PolicyDialog builds a deny with its reason', async () => {
    const dialog = mount(PolicyDialog, { ...inBody, props: { open: false, people, groups } });
    await reveal(dialog);
    await type(field('What it is for'), 'No shell');
    await pickIn(field('Name or pattern'), 'fs/shell');
    const deny = all('[role=radio]').find((r) => r.textContent.trim() === 'Deny');
    deny?.click();
    await flushPromises();
    await click('[data-testid=policy-save]');
    expect(document.body.textContent).toContain('Say why');
    await type(field('Why'), 'Not for agents.');
    await click('[data-testid=policy-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ description: 'No shell', subject: { everyone: true }, target: { fn: 'fs/shell' }, decision: { effect: 'deny', reason: 'Not for agents.' }, priority: 0 }]);
    dialog.unmount();
  });

  it('SettingDialog shows the form once an actor is chosen, starting from its value', async () => {
    const entry = { view: settingView(), values: [settingValue()] };
    const dialog = mount(SettingDialog, { ...inBody, props: { open: false, entry, actors: [...groups, ...people] } });
    await reveal(dialog);
    expect(document.body.querySelector('[data-testid=gin-form]')).toBeNull();
    await choose(field('On'), 'act_eng');
    expect(find('[data-testid=gin-form]')).toBeDefined();
    await click('[data-testid=gin-submit]');
    const saved: [ActorId, Json] | undefined = dialog.emitted<[ActorId, Json]>('save')?.[0];
    expect(saved).toEqual(['act_eng', { tables: ['orders'], readOnly: true }]);
    dialog.unmount();
  });

  it('ConfirmDialog confirms', async () => {
    const dialog = mount(ConfirmDialog, { ...inBody, props: { open: false, title: 'Remove?', body: 'Gone for good.', confirm: 'Remove' } });
    await reveal(dialog);
    expect(document.body.textContent).toContain('Gone for good.');
    await click('[data-testid=confirm]');
    expect(dialog.emitted('confirm')).toHaveLength(1);
    dialog.unmount();
  });
});

describe('ResolvedView', () => {
  it('asks for a person and shows the result with the tightest budget', async () => {
    const view = mount(ResolvedView, { attachTo: document.body, props: { people, resolved: undefined, loading: false, nameOf } });
    expect(find('[data-testid=resolve]').hasAttribute('disabled')).toBe(true);
    await choose(field('Person'), 'act_ada');
    await type(field('In chat'), 'ses_1');
    await click('[data-testid=resolve]');
    expect(view.emitted('resolve')?.[0]).toEqual(['act_ada', 'ses_1']);
    await view.setProps({ resolved: { priority: 'normal', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 60_000 }, budgets: [{ rule: budget().id, scope: { scope: 'hub' }, remaining: 2 }], limitedBy: budget().id } });
    expect(view.text()).toContain('Normal, from the hub default.');
    expect(view.text()).toContain('Tightest');
    expect(view.text()).toContain('$2.00 left');
    view.unmount();
  });
});
