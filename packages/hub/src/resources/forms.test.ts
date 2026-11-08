import { ResourceUri, type ConvertedVersion, type Section } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RegistryConverters } from './converters.ts';
import { StoreFormService } from './forms.ts';
import type { Converters } from './index.ts';
import { ALICE, bytes, resourcesRig, statOf } from './testing.ts';

const PAGE = '<html><body><main><h1>Guide</h1><p>Hello there.</p><h2>Usage</h2><p>Run it.</p></main></body></html>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const who = { actor: ALICE };

/** Converters that count conversions and can pretend the library moved on to a new converter version. */
class CountingConverters implements Converters {
  readonly inner = new RegistryConverters({ maxRows: 100 });
  conversions = 0;
  version = '';

  typeOf(location: string, mime?: string) { return this.inner.typeOf(location, mime); }
  current(type: string) { return this.inner.current(type).map((id) => `${id}${this.version}`); }
  async convert(input: Parameters<Converters['convert']>[0]) {
    this.conversions += 1;
    const made = await this.inner.convert(input);
    return made === undefined ? undefined : { ...made, converter: `${made.converter}${this.version}` };
  }
  sections(version: ConvertedVersion): Section[] { return this.inner.sections(version); }
}

async function rig() {
  const base = await resourcesRig();
  const converters = new CountingConverters();
  const forms = new StoreFormService({
    store: base.store, content: base.content, raw: base.raw, converters, models: base.models, log: base.log, clock: base.clock, settings: base.settings,
    onForms: (record) => { base.changed.push(record.uri); },
  });
  return { ...base, converters, forms };
}

const uri = (text: string) => ResourceUri.parse(text);

describe('raw content snapshots', () => {
  it('keeps what a system served, and fetches again only when its version changes', async () => {
    const r = await rig();
    const at = uri('file://main/docs/page.html');
    r.raw.serve({ stat: statOf(at, { format: 'html', mime: 'text/html', version: 'v1' }), bytes: bytes(PAGE) });
    const first = await r.forms.snapshot(at, who);
    expect(first.raw.mime).toBe('text/html');
    expect(first.source).toEqual({ from: 'system', system: 'fs', served: 'bytes' });
    await r.forms.snapshot(at, who);
    expect(r.raw.reads).toBe(1);
    r.raw.serve({ stat: statOf(at, { format: 'html', mime: 'text/html', version: 'v2' }), bytes: bytes(`${PAGE}<p>more</p>`) });
    const second = await r.forms.snapshot(at, who);
    expect(r.raw.reads).toBe(2);
    expect(second.raw.hash).not.toBe(first.raw.hash);
  });

  it('refuses a hub resource it doesn\'t have and content over the cap', async () => {
    const r = await rig();
    await expect(r.forms.snapshot(uri('hub://resources/nothing'), who)).rejects.toMatchObject({ status: 404 });
    const big = uri('file://main/big.bin');
    r.raw.serve({ stat: statOf(big), bytes: new Uint8Array(r.settings.HARNESS_IMPORT_MAX + 1) });
    await expect(r.forms.snapshot(big, who)).rejects.toMatchObject({ status: 413 });
  });
});

describe('converted forms', () => {
  it('converts the same bytes at two URIs once, and keeps the record\'s badges current', async () => {
    const r = await rig();
    const a = uri('file://main/a.html');
    const b = uri('file://main/copy/a.html');
    for (const at of [a, b]) { r.raw.serve({ stat: statOf(at, { format: 'html', mime: 'text/html' }), bytes: bytes(PAGE) }); }
    const first = await r.forms.forms(a, who);
    const second = await r.forms.forms(b, who);
    expect(r.converters.conversions).toBe(1);
    expect(first.forms.map((f) => f.kind)).toEqual(['markdown']);
    expect(second.forms).toEqual(first.forms);
    expect(second.record.primary).toBe('markdown');
    expect(second.record.forms).toEqual(['markdown']);
    // the copy's record had the shared forms from its first snapshot, so only the first record changed
    expect(r.changed).toEqual([a]);
  });

  it('makes a converted form again when its converter changed, keeping model-made forms', async () => {
    const r = await rig();
    const page = uri('file://main/p.html');
    const image = uri('file://main/i.png');
    r.raw.serve({ stat: statOf(page, { format: 'html', mime: 'text/html' }), bytes: bytes(PAGE) });
    r.raw.serve({ stat: statOf(image, { format: 'image', mime: 'image/png' }), bytes: PNG });
    await r.forms.ensure(page, 'markdown', who);
    await r.forms.ensure(image, 'description', who);
    r.converters.version = '@2';
    const again = await r.forms.ensure(page, 'markdown', who);
    expect(again.converter.endsWith('@2')).toBe(true);
    expect(r.converters.conversions).toBe(2);
    await r.forms.ensure(image, 'description', who);
    expect(r.models.calls).toHaveLength(1);
  });

  it('remembers a converter that declined, and never converts a system\'s own text', async () => {
    const r = await rig();
    const json = uri('file://main/pretty.json');
    r.raw.serve({ stat: statOf(json, { format: 'json', mime: 'application/json' }), bytes: bytes('{\n  "a": 1\n}\n') });
    await r.forms.primary(json, who);
    await r.forms.primary(json, who);
    expect(r.converters.conversions).toBe(1);
    const doc = uri('file://main/report.pdf');
    r.raw.serve({ stat: statOf(doc, { format: 'pdf', mime: 'application/pdf' }), text: '# Report\nIt went well.' });
    const read = await r.forms.primary(doc, who);
    expect(read.form).toBeUndefined();
    expect(read.text).toBe('# Report\nIt went well.');
    expect(r.converters.conversions).toBe(1);
  });

  it('reads the primary form: the version for a page, the raw text for markdown', async () => {
    const r = await rig();
    const page = uri('file://main/p.html');
    const md = uri('file://main/a.md');
    r.raw.serve({ stat: statOf(page, { format: 'html', mime: 'text/html' }), bytes: bytes(PAGE) });
    r.raw.serve({ stat: statOf(md, { format: 'markdown', mime: 'text/markdown' }), bytes: bytes('# A\nb\n') });
    const html = await r.forms.primary(page, who);
    expect(html.form).toBe('markdown');
    expect(html.version?.kind).toBe('markdown');
    expect(html.text).toContain('# Guide');
    expect((await r.forms.primary(md, who)).text).toBe('# A\nb\n');
  });

  it('refuses a form a resource can\'t have, saying what it has', async () => {
    const r = await rig();
    const page = uri('file://main/p.html');
    r.raw.serve({ stat: statOf(page, { format: 'html', mime: 'text/html' }), bytes: bytes(PAGE) });
    const missing = r.forms.ensure(page, 'table', who);
    await expect(missing).rejects.toMatchObject({ status: 404 });
    await expect(missing).rejects.toThrow('(it has markdown)');
    await expect(r.forms.version((await r.forms.ensure(page, 'markdown', who)))).resolves.toMatchObject({ kind: 'markdown' });
  });
});

describe('model-made forms', () => {
  it('describes an image once however many ask at once, and offers what it could make', async () => {
    const r = await rig();
    const image = uri('file://main/i.png');
    r.raw.serve({ stat: statOf(image, { format: 'image', mime: 'image/png' }), bytes: PNG });
    const before = await r.forms.forms(image, who);
    expect(before.offers).toEqual([{ kind: 'description', model: 'test/vision' }, { kind: 'ocr', model: 'test/vision' }]);
    let open: () => void = () => undefined;
    r.models.gate = new Promise<void>((resolve) => { open = resolve; });
    const both = Promise.all([r.forms.ensure(image, 'description', who), r.forms.ensure(image, 'description', who)]);
    open();
    const [one, two] = await both;
    expect(one).toEqual(two);
    expect(r.models.calls).toHaveLength(1);
    expect(await r.forms.text(one)).toBe('description of i.png');
    const after = await r.forms.forms(image, who);
    expect(after.record.primary).toBe('description');
    expect(after.offers.map((o) => o.kind)).toEqual(['ocr']);
  });

  it('reads an image\'s description as its primary text only when making is allowed', async () => {
    const r = await rig();
    const image = uri('file://main/i.png');
    r.raw.serve({ stat: statOf(image, { format: 'image', mime: 'image/png' }), bytes: PNG });
    expect((await r.forms.primary(image, who)).text).toBe('');
    expect(r.models.calls).toHaveLength(0);
    const made = await r.forms.primary(image, who, { make: true });
    expect(made).toMatchObject({ form: 'description', text: 'description of i.png' });
    expect((await r.forms.primary(image, who)).form).toBe('description');
  });
});
