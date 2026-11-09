/**
 * Resources on the real stack: uploads become hub resources whose raw bytes the hub keeps and whose converted forms
 * it makes with `@aeye/resources` (markdown for a web page, tables for a workbook, pages for a pdf). Both versions can
 * be read; sectioning runs over the converted form; and a resource becomes context, one item per section under a
 * parent, linked back to the resource, which a second run updates rather than repeats.
 */
import { QualifiedName, ResourceUri, Section, type ResourceRecord, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { minimalPdf, workbook } from './files.ts';
import { admin, invoke, settle, upload } from './kit.ts';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE = '<html><head><title>Field guide</title></head><body><h1>Start</h1><p>Unpack the kit.</p><h2>Use</h2><p>Water it daily.</p><h2>Stop</h2><p>Let it rest.</p></body></html>';

let me: SignedIn;
let session: SessionId;
const stamp = Date.now().toString(36);

/** A resource's sections, as the LLM reads them (`hub/resource_outline`), once there are at least `least`. */
function outline(uri: ResourceUri, least: number): Promise<Section[]> {
  return waitFor(`the sections of ${uri}`, async () => {
    const run = await invoke(me, session, QualifiedName.parse('hub/resource_outline'), { uri });
    const sections = run.outcome?.status === 'done' ? z.array(Section).parse(run.outcome.result) : [];
    return sections.length >= least ? sections : undefined;
  }, { timeout: 30_000, every: 1_000 });
}

/** Upload bytes and import them as a hub resource. */
async function imported(name: string, mime: string, bytes: Uint8Array): Promise<ResourceRecord> {
  const content = await upload(me, name, mime, bytes);
  return me.hub.call('importResource', { content, name });
}

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e resources' })).id;
});

afterAll(() => { me.close(); });

describe('raw and converted versions', () => {
  let page: ResourceRecord;

  it('keep a web page’s raw html and make its markdown, its primary form', async () => {
    page = await imported(`guide-${stamp}.html`, 'text/html', new TextEncoder().encode(PAGE));
    expect(page.uri.startsWith('hub://resources/')).toBe(true);
    expect(page).toMatchObject({ source: { from: 'upload' }, raw: { mime: 'text/html' }, primary: 'markdown' });
    expect(page.forms).toContain('markdown');
    const forms = await me.hub.call('resourceForms', { uri: page.uri });
    expect(forms.forms.map((f) => f.kind)).toContain('markdown');
    const raw = await me.hub.call('readResource', { uri: page.uri, form: 'raw' });
    expect(raw.text).toContain('<h2>Use</h2>');
    const markdown = await me.hub.call('readResource', { uri: page.uri, form: 'markdown' });
    expect(markdown.text).toContain('## Use');
    expect(markdown.text).not.toContain('<p>');
  });

  it('section the page over its markdown', async () => {
    const sections = await outline(page.uri, 3);
    expect(sections.every((s) => s.form === 'markdown')).toBe(true);
    expect(sections.map((s) => s.title)).toEqual(expect.arrayContaining(['Start', 'Use', 'Stop']));
  });

  it('make a workbook’s tables, one per sheet, and read one table', async () => {
    const book = await imported(`book-${stamp}.xlsx`, XLSX_MIME, workbook({ Scores: [['name', 'score'], ['ada', 3], ['bob', 5]], Weather: [['city', 'rain'], ['Leeds', 120]] }));
    expect(book).toMatchObject({ primary: 'table' });
    const table = await me.hub.call('readResource', { uri: book.uri, form: 'table' });
    expect(table.text).toContain('ada');
    expect(table.text).toContain('Leeds');
    const sections = await outline(book.uri, 2);
    expect(sections.map((s) => s.title)).toEqual(['Scores', 'Weather']);
  });

  it('make a pdf’s pages', async () => {
    const pdf = await imported(`page-${stamp}.pdf`, 'application/pdf', minimalPdf(['Harness test page one', 'It has two lines.']));
    expect(pdf).toMatchObject({ primary: 'pages' });
    const pages = await me.hub.call('readResource', { uri: pdf.uri, form: 'pages' });
    expect(pages.text).toContain('Harness test page one');
  });

  it('list the uploads in the browser, grouped by type', async () => {
    const browsed = await me.hub.call('browseResources', { search: stamp, group: 'type', limit: 20 });
    expect(browsed.items.map((r) => r.stat.name).sort()).toEqual([`book-${stamp}.xlsx`, `guide-${stamp}.html`, `page-${stamp}.pdf`]);
    expect(browsed.facets.map((f) => f.value)).toEqual(expect.arrayContaining(['web', 'table', 'document']));
  });

  describe('to context', () => {
    it('make one item per section and a parent, linked back to the resource', async () => {
      const made = await me.hub.call('contextFromResource', { uri: page.uri });
      expect(made.created).toHaveLength(4);
      expect(made.links).toBeGreaterThanOrEqual(3);
      const items = await me.hub.call('contexts', { query: { text: 'guide', filters: [{ field: 'origin', op: 'is' as const, value: 'resource' }], limit: 50 } });
      const mine = items.items.filter((item) => made.created.includes(item.name));
      expect(mine).toHaveLength(4);
      const parent = mine.find((item) => item.decl.parent === undefined);
      expect(parent).toBeDefined();
      const child = mine.find((item) => item.decl.parent !== undefined);
      if (child === undefined) { throw new Error('no section item'); }
      const view = await me.hub.call('contextItem', { name: child.name });
      expect(view.links.some((link) => link.to.kind === 'resource' && link.to.uri === ResourceUri.parse(page.uri))).toBe(true);
      expect(view.record.origin).toMatchObject({ type: 'resource' });
    });

    it('update the same items when made again', async () => {
      const again = await me.hub.call('contextFromResource', { uri: page.uri });
      expect(again.created).toEqual([]);
      expect(again.updated).toHaveLength(4);
    });
  });
});
