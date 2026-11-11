import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mintId, type DeliveryId, type DeliveryStatus, type Json } from '@harness/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as vue from 'vue';
import { h, watchEffect } from 'vue';
import { buildClient } from './build.ts';
import { client, type AttachmentViewOf, type ConfigView, type FnView, type FnViewOf, type InputViewOf, type ResourceView, type WithSystem } from './client.ts';
import { ClientRuntime, isClientModule, shareModules, type ClientBridge } from './client-runtime.ts';
import { action, attachment, kind, mention, type } from './declare.ts';
import { fn, type UntypedFn } from './fn.ts';
import { g } from './gin.ts';
import * as sdk from './index.ts';
import { system } from './system.ts';

const shop = system('shop', { description: 'A shop.' })
  .with({
    kinds: { query: kind({ description: 'A query.', applicability: 'Reads.', payload: g.obj({ sql: g.text() }) }) },
    fns: { buy: fn({ description: 'Buy.', args: g.obj({ sku: g.text() }), returns: g.bool(), form: g.obj({ yes: g.bool() }) }) },
    attachments: { receipt: attachment({ description: 'A receipt.', data: g.obj({ total: g.num() }) }) },
    actions: { refund: action({ description: 'Refund.', input: g.obj({ sku: g.text() }), returns: g.obj({ at: g.timestamp() }) }) },
  });

// functional renderers, typed by the contract like a `.vue` file's defineProps
const BuyView = (view: FnViewOf<typeof shop, 'buy'>) => h('div', view.args.sku);
const QueryView = (view: FnView<UntypedFn>) => h('div', view.run);
const ReceiptView = (view: AttachmentViewOf<typeof shop, 'receipt'>) => h('div', String(view.data.total));
const CsvView = (view: ResourceView) => h('table', view.stat.name);

const module = client(shop, { fns: { buy: BuyView }, kinds: { query: QueryView }, attachments: { receipt: ReceiptView }, resources: { csv: CsvView } });

/** A bridge whose deliveries settle when the test says so. */
function fakeBridge() {
  const acts: Array<Parameters<ClientBridge['act']>[0]> = [];
  const forms: Array<{ value: Json }> = [];
  const invokes: Array<Parameters<ClientBridge['invoke']>[0]> = [];
  const followers = new Map<DeliveryId, { status: (s: DeliveryStatus) => void; settle: (result: Json) => void; fail: (e: Error) => void }>();
  let online = true;
  const bridge: ClientBridge = {
    online: () => online,
    act: (input) => { acts.push(input); return Promise.resolve(mintId('delivery')); },
    submit: (input) => { forms.push(input); return Promise.resolve(mintId('delivery')); },
    invoke: (input) => { invokes.push(input); return Promise.resolve(mintId('run')); },
    follow: (id, status) => new Promise((settle, fail) => { followers.set(id, { status, settle, fail }); }),
  };
  return { bridge, acts, forms, invokes, followers, setOnline: (value: boolean) => { online = value; } };
}

describe('ClientRuntime', () => {
  it('looks renderers up by fn, falling back to the kind, and by attachment and resource format', () => {
    const runtime = new ClientRuntime(fakeBridge().bridge);
    runtime.register(module);
    expect(runtime.systems()).toEqual(['shop']);
    expect(runtime.fnRenderer('shop/buy')).toBe(BuyView);
    expect(runtime.fnRenderer('other/report', 'shop/query')).toBe(QueryView);
    expect(runtime.fnRenderer('other/report')).toBeUndefined();
    expect(runtime.attachmentRenderer('shop/receipt')).toBe(ReceiptView);
    expect(runtime.resourceViewer('csv')).toBe(CsvView);
    expect(runtime.viewerSystem('csv')).toBe('shop');
    expect(runtime.viewerSystem('pdf')).toBeUndefined();
    expect(runtime.inputRenderer('shop/Nothing')).toBeUndefined();
  });

  it('offers resource viewers that replace the hub\'s preview or add a tab, by format across systems', () => {
    const runtime = new ClientRuntime(fakeBridge().bridge);
    const outline = system('outline', { description: 'Outlines.' });
    const OutlineTab = (view: ResourceView) => h('ol', view.forms.join(','));
    const MarkdownView = (view: ResourceView) => h('article', view.stat.name);
    runtime.register(module);
    runtime.register(client(outline, { resources: { csv: { component: OutlineTab, mode: 'tab', label: 'Outline' }, markdown: { component: MarkdownView, mode: 'replace' } } }));
    expect(runtime.resourceViewers('csv')).toEqual([
      { component: CsvView, system: 'shop', mode: 'replace', label: 'shop' },
      { component: OutlineTab, system: 'outline', mode: 'tab', label: 'Outline' },
    ]);
    // a tab never replaces the preview; the label defaults to the system's name
    expect(runtime.resourceViewers('markdown')).toEqual([{ component: MarkdownView, system: 'outline', mode: 'replace', label: 'outline' }]);
    expect(runtime.resourceViewer('csv')).toBe(CsvView);
    expect(runtime.resourceViewers('pdf')).toEqual([]);
    // a newer build of a system replaces its viewers, and leaves the others'
    runtime.register(client(outline, { resources: { csv: { component: OutlineTab, mode: 'tab', label: 'Tree' } } }));
    expect(runtime.resourceViewers('csv').map((v) => `${v.system}:${v.label}`)).toEqual(['shop:shop', 'outline:Tree']);
    expect(runtime.resourceViewers('markdown')).toEqual([]);
    expect(runtime.resourceViewer('markdown')).toBeUndefined();
  });

  it('sends actions with checked input, follows the delivery live, and decodes the result', async () => {
    const fake = fakeBridge();
    const runtime = new ClientRuntime(fake.bridge);
    runtime.register(module);
    const shopClient = runtime.systemClient('shop');
    const seen: string[] = [];
    const delivery = shopClient.send['refund']?.({ sku: 'a1' });
    if (delivery === undefined) { throw new Error('refund is declared'); }
    watchEffect(() => { seen.push(delivery.status); });
    await vue.nextTick();
    expect(fake.acts).toEqual([{ system: 'shop', action: 'refund', input: { sku: 'a1' } }]);
    await waitUntil(() => fake.followers.size === 1);
    const [id, follower] = [...fake.followers][0] ?? [];
    expect(delivery.id).toBe(id);
    follower?.status('delivered');
    await vue.nextTick();
    follower?.settle({ at: '2026-11-07T00:00:00.000Z' });
    const result = await delivery.result;
    expect(result).toEqual({ at: new Date('2026-11-07T00:00:00.000Z') });
    expect(seen).toEqual(['queued', 'delivered']);
  });

  it("sends a fn renderer's actions from its run, and keeps one client per run", async () => {
    const fake = fakeBridge();
    const runtime = new ClientRuntime(fake.bridge);
    runtime.register(module);
    const run = mintId('run');
    const fromRun = runtime.systemClient('shop', run);
    expect(runtime.systemClient('shop', run)).toBe(fromRun);
    expect(runtime.systemClient('shop')).not.toBe(fromRun);
    fromRun.send['refund']?.({ sku: 'a1' });
    await vue.nextTick();
    expect(fake.acts).toEqual([{ system: 'shop', action: 'refund', input: { sku: 'a1' }, run }]);
    runtime.register(module);
    expect(runtime.systemClient('shop', run)).not.toBe(fromRun);
  });

  it('runs its fns in the session with checked args, and refuses args that do not fit', async () => {
    const fake = fakeBridge();
    const runtime = new ClientRuntime(fake.bridge);
    runtime.register(module);
    const shopClient = runtime.systemClient('shop');
    const run = await shopClient.run['buy']?.({ sku: 'a1' });
    expect(run).toMatch(/^run_/);
    expect(fake.invokes).toEqual([{ fn: 'shop/buy', args: { sku: 'a1' } }]);
    await expect(shopClient.run['buy']?.({ sku: 1 })).rejects.toThrow();
    expect(fake.invokes).toHaveLength(1);
    expect(runtime.systemClient('other').run).toEqual({});
  });

  it('refuses action input that does not fit before sending', () => {
    const fake = fakeBridge();
    const runtime = new ClientRuntime(fake.bridge);
    runtime.register(module);
    expect(() => runtime.systemClient('shop').send['refund']?.({ sku: 1 })).toThrow();
    expect(fake.acts).toEqual([]);
  });

  it('reports whether the system is online from the bridge', () => {
    const fake = fakeBridge();
    const runtime = new ClientRuntime(fake.bridge);
    const shopClient = runtime.systemClient('shop');
    expect(shopClient.online).toBe(true);
    fake.setOnline(false);
    expect(shopClient.online).toBe(false);
  });

  it('submits a run\'s form checked with its form type', async () => {
    const fake = fakeBridge();
    const runtime = new ClientRuntime(fake.bridge);
    const delivery = runtime.submit(mintId('run'), g.obj({ yes: g.bool() }), { yes: true });
    await waitUntil(() => fake.followers.size === 1);
    [...fake.followers.values()][0]?.settle(null);
    await expect(delivery.result).resolves.toBeUndefined();
    expect(fake.forms[0]?.value).toEqual({ yes: true });
  });

  it("gives a fn's renderer a submit checked with the fn's own form type, and none to a fn without a form", async () => {
    const fake = fakeBridge();
    const runtime = new ClientRuntime(fake.bridge);
    expect(runtime.formSubmit('shop/buy', mintId('run'))).toBeUndefined();
    runtime.register(module);
    const submit = runtime.formSubmit('shop/buy', mintId('run'));
    if (submit === undefined) { throw new Error('buy declares a form'); }
    expect(() => submit({ yes: 'nope' })).toThrow();
    void submit({ yes: false });
    await waitUntil(() => fake.forms.length === 1);
    expect(fake.forms[0]?.value).toEqual({ yes: false });
    expect(runtime.formSubmit('shop/other', mintId('run'))).toBeUndefined();
  });

  it('knows a client module when it sees one', () => {
    expect(isClientModule(module)).toBe(true);
    expect(isClientModule({ system: 'x' })).toBe(false);
  });
});

describe('ClientRuntime views', () => {
  const Stamp = type({ description: 'A stamped note.', shape: g.obj({ note: g.text(), at: g.timestamp() }), display: { label: 'Stamp', title: 'note' } });
  const log = system('log', { description: 'A log.' }).with({ types: { Stamp } }).with(({ types }) => ({
    kinds: { tail: kind({ description: 'A tail.', applicability: 'Reads.', payload: g.obj({}) }) },
    fns: {
      stamp: fn({ description: 'Stamp.', args: g.obj({ at: g.timestamp() }), returns: g.obj({ at: g.timestamp() }), state: g.obj({ since: g.timestamp(), label: g.text() }) }),
      plain: fn({ description: 'Plain.', args: g.obj({}), returns: g.text() }),
    },
    attachments: { card: attachment({ description: 'A card.', data: g.obj({ at: g.timestamp() }) }) },
    mentions: { notes: mention({ title: 'Notes', description: 'Notes.', target: g.obj({ at: g.timestamp() }), of: types.Stamp }) },
  }));
  const StampView = (view: FnViewOf<typeof log, 'stamp'>) => h('time', view.args.at.toISOString());
  const TailView = (view: FnView<UntypedFn>) => h('pre', JSON.stringify(view.args));
  const CardView = (view: AttachmentViewOf<typeof log, 'card'>) => h('time', view.data.at.toISOString());
  const StampInput = (view: InputViewOf<typeof log, 'Stamp'>) => h('input', { value: view.modelValue?.note ?? '' });
  const NotesCard = () => h('div');
  const logModule = client(log, { fns: { stamp: StampView }, kinds: { tail: TailView }, attachments: { card: CardView }, inputs: { Stamp: StampInput }, mentions: { notes: NotesCard } });
  const at = '2026-11-07T10:00:00.000Z';
  const runtime = new ClientRuntime(fakeBridge().bridge);
  runtime.register(logModule);
  const run = mintId('run');
  const wire = { fn: 'log/stamp' as const, kind: undefined, run, status: 'done' as const, args: { at }, result: { at }, state: { since: at, label: 'x' } };

  it("decodes a fn's args, result and state with its own gin types", () => {
    const view = runtime.fnView(wire);
    expect(view?.component).toBe(StampView);
    expect(view?.props).toMatchObject({ run, status: 'done', args: { at: new Date(at) }, result: { at: new Date(at) }, state: { since: new Date(at), label: 'x' } });
    expect(view?.props.submit).toBeUndefined();
    expect(view?.props.system).toBe(runtime.systemClient('log', run));
  });

  it('draws no view when the run does not fit its types, so the default card shows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(runtime.fnView({ ...wire, args: { at: 'not a time' } })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('client.view.unfit', expect.objectContaining({ name: 'log/stamp' }));
    warn.mockRestore();
  });

  it("gives a kind's renderer the JSON as it is, with the kind's own system", () => {
    const view = runtime.fnView({ ...wire, fn: 'other/report', kind: 'log/tail', args: { at } });
    expect(view?.component).toBe(TailView);
    expect(view?.props.args).toEqual({ at });
    expect(view?.props.system).toBe(runtime.systemClient('log', run));
    expect(runtime.fnView({ ...wire, fn: 'other/report' })).toBeUndefined();
    expect(runtime.fnView({ ...wire, fn: 'log/plain' })).toBeUndefined();
  });

  it("decodes an attachment's data and a mention's target", () => {
    expect(runtime.attachmentView({ attachment: 'log/card', data: { at }, title: 'Card' })?.props).toMatchObject({ data: { at: new Date(at) }, title: 'Card' });
    expect(runtime.attachmentView({ attachment: 'log/none', data: {}, title: 'None' })).toBeUndefined();
    const mentioned = runtime.mentionView({ provider: 'log/notes', label: 'Note', target: { at }, hover: undefined });
    expect(mentioned?.component).toBe(NotesCard);
    expect(mentioned?.props.target).toEqual({ at: new Date(at) });
  });

  it("reads a custom input's value with the type's shape and writes edits back as JSON", () => {
    const input = runtime.inputView('log/Stamp');
    if (input === undefined) { throw new Error('Stamp has an input'); }
    expect(input.component).toBe(StampInput);
    expect(input.decode({ note: 'hi', at })).toEqual({ note: 'hi', at: new Date(at) });
    expect(input.decode(undefined)).toBeUndefined();
    expect(input.encode({ note: 'hi', at: new Date(at) })).toEqual({ note: 'hi', at });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(input.encode({ note: 1 })).toBeUndefined();
    warn.mockRestore();
    expect(runtime.inputView('log/Missing')).toBeUndefined();
  });
});

describe('buildClient', () => {
  const folders: string[] = [];
  afterAll(async () => { await Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))); });

  it('bundles a system\'s renderers with vue and the SDK external, and the chat loads it sharing its own copies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-client-'));
    folders.push(root);
    await writeFile(join(root, 'Hello.vue'), '<script setup lang="ts">\nimport { ref } from "vue";\nconst n = ref(1);\n</script>\n<template><b class="hello">hello {{ n }}</b></template>\n');
    await writeFile(join(root, 'index.ts'), [
      'import { client, fn, g, system } from "@harness/sdk";',
      'import Hello from "./Hello.vue";',
      'const greet = system("greet", { description: "Greets." }).with({ fns: { hi: fn({ description: "Hi.", args: g.obj({}), returns: g.text() }) } });',
      'export default client(greet, { fns: { hi: Hello } });',
    ].join('\n'));
    const out = join(root, 'dist');
    const bundle = await buildClient({ entry: join(root, 'index.ts'), outDir: out, minify: false });
    expect(bundle.assets.entry).toBe('index.js');
    const code = new TextDecoder().decode(bundle.files.find((f) => f.path === 'index.js')?.bytes);
    expect(code).toMatch(/Symbol\.for\(["']harness\.shared["']\)/);
    // Vue's and the SDK's implementations are not in the bundle, only reads of the chat's copies
    expect(code).not.toMatch(/function (createRenderer|createRegistry)\(/);
    expect(bundle.assets.files.find((f) => f.path === 'index.js')?.size).toBeLessThan(20_000);
    shareModules({ vue, sdk });
    const runtime = new ClientRuntime(fakeBridge().bridge);
    const loaded = await runtime.load(pathToFileURL(join(out, 'index.js')).href);
    expect(loaded.system).toBe('greet');
    expect(runtime.fnRenderer('greet/hi')).toBeDefined();
  }, 60_000);

  it('folds the renderers\' CSS into the entry, so loading it styles them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-client-css-'));
    folders.push(root);
    await writeFile(join(root, 'Styled.vue'), '<template><b class="styled">hi</b></template>\n<style scoped>.styled { color: rebeccapurple; }</style>\n');
    await writeFile(join(root, 'index.ts'), [
      'import { client, fn, g, system } from "@harness/sdk";',
      'import Styled from "./Styled.vue";',
      'const look = system("look", { description: "Looks." }).with({ fns: { hi: fn({ description: "Hi.", args: g.obj({}), returns: g.text() }) } });',
      'export default client(look, { fns: { hi: Styled } });',
    ].join('\n'));
    const bundle = await buildClient({ entry: join(root, 'index.ts'), outDir: join(root, 'dist'), minify: false });
    expect(bundle.files.map((f) => f.path)).toEqual(['index.js']);
    const code = new TextDecoder().decode(bundle.files[0]?.bytes);
    expect(code).toContain('rebeccapurple');
    expect(code).toContain("document.createElement('style')");
  }, 60_000);
});

/** Wait until a condition holds (a few ticks at most). */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) { await new Promise((resolve) => setTimeout(resolve, 1)); }
  if (!condition()) { throw new Error('condition never held'); }
}

describe('config components', () => {
  const tuned = system('tuned', {
    description: 'Tuned.',
    configComponent: { component: 'Setup', mode: 'replace' },
    grants: { hub: ['ai'], models: { roles: ['chat'], perRun: 0.5 }, network: ['api.example.com'] },
  }).with({ config: g.obj({ url: g.text(), since: g.timestamp() }) });
  type Cfg = { url: string; since: Date };
  const Setup = (view: ConfigView<Cfg> & WithSystem<typeof tuned.defs>) => h('div', view.config?.url ?? '');

  it('client() refuses a config component the contract does not name, and a named one that is missing', () => {
    expect(() => client(tuned, {})).toThrow(/no component/u);
    expect(() => client(shop, { configs: { Setup: (_: ConfigView<{}> & WithSystem<typeof shop.defs>) => h('div') } })).toThrow(/not the contract's configComponent/u);
  });

  it('mounts it with the typed config, and hands edits and checks back as JSON', async () => {
    const runtime = new ClientRuntime(fakeBridge().bridge);
    runtime.register(client(tuned, { configs: { Setup } }));
    const changes: Json[] = [];
    const checked: Json[] = [];
    const mount = runtime.configView('tuned', {
      config: { url: 'https://a', since: '2026-01-02T00:00:00.000Z' },
      validate: (value) => { checked.push(value); return Promise.resolve([]); },
      change: (value) => { changes.push(value); },
    });
    expect(mount?.mode).toBe('replace');
    expect(mount?.component).toBe(Setup);
    const config = mount?.props.config;
    expect(config).toEqual({ url: 'https://a', since: new Date('2026-01-02T00:00:00.000Z') });
    mount?.props.change({ url: 'https://b', since: new Date('2026-02-01T00:00:00.000Z') });
    expect(changes).toEqual([{ url: 'https://b', since: '2026-02-01T00:00:00.000Z' }]);
    await expect(mount?.props.validate({ url: 'x', since: new Date(0) })).resolves.toEqual([]);
    expect(checked).toHaveLength(1);
    expect(runtime.configView('shop', { config: undefined, validate: () => Promise.resolve([]), change: () => undefined })).toBeUndefined();
  });

  it('puts grants and the config component on the manifest', () => {
    const body = sdk.manifestBody(tuned, { version: '1.0.0' });
    expect(body.grants).toEqual({ hub: ['ai'], models: { roles: ['chat'], perRun: 0.5 }, network: ['api.example.com'] });
    expect(body.configComponent).toEqual({ component: 'Setup', mode: 'replace' });
    expect(sdk.manifestBody(shop, { version: '1.0.0' }).grants).toBeUndefined();
  });
});
