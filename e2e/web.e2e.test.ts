/**
 * The web system on the real stack (it runs when `TAVILY_API_KEY` is set; the suite is skipped otherwise): a Tavily
 * search, then reading a page, which imports it as a hub resource (`hub/resource_import`, approved as a person would)
 * fetched back through `web/fetch_raw`. The hub keeps the raw html and makes its markdown, which `web/read` answers
 * with, and both versions can be read.
 */
import { QualifiedName, SystemName, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { admin, Approver, invoke, SessionWatch, settings, settle } from './kit.ts';

const WEB = SystemName.parse('web');
const PAGE_URL = 'https://example.com/';

/** What `web/search` answers, the parts read here. */
const SearchResult = z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })) });
/** What `web/read` answers, the parts read here. */
const ReadResult = z.object({ uri: z.string(), title: z.string(), finalUrl: z.string(), text: z.string(), rendered: z.boolean() });

let me: SignedIn;
let session: SessionId;
let watch: SessionWatch;
let approver: Approver;

describe.skipIf(settings.TAVILY_API_KEY === undefined)('the web system', () => {
  beforeAll(async () => {
    me = await admin();
    await settle(me);
    await waitFor('the web system to connect', async () => ((await me.hub.call('systems')).find((s) => s.name === WEB)?.status === 'connected' ? true : undefined), { timeout: 60_000 });
    session = (await me.hub.call('createSession', { title: 'e2e web' })).id;
    watch = new SessionWatch(me, session);
    approver = new Approver(me, watch);
  });

  afterAll(() => {
    watch.stop();
    me.close();
  });

  it('searches the web with Tavily', async () => {
    const run = await invoke(me, session, QualifiedName.parse('web/search'), { query: 'vitest test runner documentation', limit: 3 });
    expect(run.status).toBe('done');
    const found = SearchResult.parse(run.outcome?.status === 'done' ? run.outcome.result : undefined);
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results[0]?.url).toMatch(/^https?:\/\//);
  });

  it('reads a page into a hub resource and answers with its markdown', async () => {
    const { result: run, approvals } = await approver.during(invoke(me, session, QualifiedName.parse('web/read'), { url: PAGE_URL, maxChars: 2_000 }));
    expect(run.status).toBe('done');
    // importing is a write the person approves (unless a policy allows it)
    expect(approvals.map((a) => a.fn)).toContain('hub/resource_import');
    const page = ReadResult.parse(run.outcome?.status === 'done' ? run.outcome.result : undefined);
    expect(page.uri.startsWith('hub://resources/')).toBe(true);
    expect(page.title).toMatch(/Example Domain/);
    expect(page.text).toContain('documentation examples');
    expect(page.text).not.toContain('<html');

    const uri = (await me.hub.call('browseResources', { source: 'web', search: 'example', limit: 10 })).items.find((r) => r.uri === page.uri)?.uri;
    if (uri === undefined) { throw new Error(`${page.uri} is not in the resource browser`); }
    const record = (await me.hub.call('resourceForms', { uri })).record;
    expect(record).toMatchObject({ source: { from: 'web' }, primary: 'markdown' });
    const raw = await me.hub.call('readResource', { uri, form: 'raw' });
    expect(raw.text.toLowerCase()).toContain('<html');
    const markdown = await me.hub.call('readResource', { uri, form: 'markdown' });
    expect(markdown.text).toContain('documentation examples');
    expect(markdown.text).not.toContain('<p');
  });
});
