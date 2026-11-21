import { mintId } from '@harness/core';
import { RESOURCE_VIEWER, type FnViewOf } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import type { web } from '../shared/index.ts';
import { fakeWebSystem } from './fakes.ts';
import ReadView from './ReadView.vue';
import SearchView from './SearchView.vue';
import { pageFacts, publishedLabel, resultRows, shownUrl, statusChip } from './view.ts';

type SearchProps = FnViewOf<typeof web, 'search'>;
type ReadProps = FnViewOf<typeof web, 'read'>;

const hits = Array.from({ length: 7 }, (_, i) => ({
  title: `Result ${i + 1}`, url: `https://www.site${i + 1}.example/page?token=secret`, snippet: `Snippet ${i + 1}`, score: 0.9 - i / 10,
}));

const searchProps = (props: Partial<SearchProps>): SearchProps => ({
  run: mintId('run'), status: 'done', args: { query: 'cats' }, state: {}, submit: undefined, system: fakeWebSystem().system, ...props,
});
const readProps = (props: Partial<ReadProps>): ReadProps => ({
  run: mintId('run'), status: 'done', args: { url: 'https://example.com/a' }, state: {}, submit: undefined, system: fakeWebSystem().system, ...props,
});

describe('SearchView', () => {
  it('shows the query, the answer and the first results with their sites, without credentials', () => {
    const card = mount(SearchView, { props: searchProps({ result: { uri: 'hub://resources/searches/s', answer: 'They sleep.', results: hits } }) });
    expect(card.find('.query').text()).toBe('cats');
    expect(card.find('.chip').text()).toBe('Done');
    expect(card.find('.answer').text()).toContain('They sleep.');
    expect(card.findAll('.result')).toHaveLength(5);
    expect(card.find('.title').attributes('href')).toBe(hits[0]?.url);
    expect(card.find('.domain').text()).toBe('www.site1.example/page?token=redacted');
    expect(card.find('.badge').text()).toBe('S');
    expect(card.text()).not.toContain('secret');
  });

  it('shows every result when asked, and the filters it ran with', async () => {
    const card = mount(SearchView, { props: searchProps({ args: { query: 'x', topic: 'news', depth: 'advanced', days: 1, include: ['a.example'], exclude: ['b.example'] }, result: { uri: 'hub://resources/searches/s', results: hits } }) });
    expect(card.findAll('.filter').map((f) => f.text())).toEqual(['News', 'Deep', 'Last 1 day', 'Only a.example', 'Not b.example']);
    await card.find('.more').trigger('click');
    expect(card.findAll('.result')).toHaveLength(7);
    expect(card.find('.more').text()).toBe('Show fewer');
  });

  it('shimmers while it runs and says when there are no results', () => {
    const running = mount(SearchView, { props: searchProps({ status: 'running' }) });
    expect(running.find('.placeholder').exists()).toBe(true);
    expect(running.attributes('aria-busy')).toBe('true');
    const empty = mount(SearchView, { props: searchProps({ result: { uri: 'hub://resources/searches/s', results: [] } }) });
    expect(empty.find('.empty').text()).toContain('No results');
  });

  it('starts a web/read of a result, and says when it started or why it could not', async () => {
    const fake = fakeWebSystem();
    const card = mount(SearchView, { props: searchProps({ result: { uri: 'hub://resources/searches/s', results: hits.slice(0, 2) }, system: fake.system }) });
    await card.findAll('button.action')[0]?.trigger('click');
    expect(fake.started).toEqual([{ fn: 'read', args: { url: hits[0]?.url } }]);
    expect(card.findAll('button.action')[0]?.text()).toBe('Starting…');
    fake.start();
    await flushPromises();
    expect(card.find('.note.started').text()).toBe('Reading below');
    await card.findAll('button.action')[1]?.trigger('click');
    fake.refuse('web/read is unavailable');
    await flushPromises();
    expect(card.find('[role="alert"]').text()).toBe('web/read is unavailable');
  });

  it('turns Read off while the system is offline, and shows a failure', () => {
    const card = mount(SearchView, { props: searchProps({ result: { uri: 'hub://resources/searches/s', results: hits.slice(0, 1) }, system: fakeWebSystem(false).system }) });
    expect(card.find('button.action').attributes('disabled')).toBeDefined();
    expect(card.text()).toContain('web is offline');
    const failed = mount(SearchView, { props: searchProps({ status: 'failed', error: { class: 'fatal', message: 'No Tavily API key is set', code: 'no-search-key' } }) });
    expect(failed.find('.problem').text()).toBe('No Tavily API key is set');
    expect(failed.find('.chip').classes()).toContain('bad');
  });

  it('opens a clamped snippet when clicked, or from the keyboard', async () => {
    const card = mount(SearchView, { props: searchProps({ result: { uri: 'hub://resources/searches/s', results: hits.slice(0, 1) } }) });
    await card.find('.snippet').trigger('click');
    expect(card.find('.snippet').classes()).toContain('open');
    expect(card.find('.snippet').attributes('aria-expanded')).toBe('true');
    await card.find('.snippet').trigger('click');
    expect(card.find('.snippet').classes()).not.toContain('open');
    await card.find('.snippet').trigger('keydown', { key: 'Enter' });
    expect(card.find('.snippet').classes()).toContain('open');
    await card.find('.snippet').trigger('keydown', { key: ' ' });
    expect(card.find('.snippet').attributes('aria-expanded')).toBe('false');
  });
});

describe('ReadView', () => {
  const result = { uri: 'hub://resources/web/a', title: 'Page A', finalUrl: 'https://www.example.com/b', text: 'Hello page.', truncated: true, rendered: true, fetched: ['https://example.com/a', 'https://www.example.com/b'] };

  it('shows the page, its facts and the hub viewer\'s compact preview of the kept resource', () => {
    const Viewer = defineComponent({ props: { uri: { type: String, required: true }, compact: Boolean }, setup: (props) => () => h('div', { class: 'viewer' }, `${props.uri} ${String(props.compact)}`) });
    const card = mount(ReadView, { props: readProps({ result }), global: { provide: { [RESOURCE_VIEWER]: Viewer } } });
    expect(card.find('.title').text()).toBe('Page A');
    expect(card.find('.url').text()).toBe('www.example.com/b');
    expect(card.find('.url').attributes('href')).toBe('https://www.example.com/b');
    expect(card.findAll('.fact').map((f) => f.text())).toEqual(['Rendered', 'Redirected', '11 characters, cut short']);
    expect(card.find('.viewer').text()).toBe('hub://resources/web/a true');
    // every URL the read sent out, redirects included
    expect(card.find('.fetched .label').text()).toBe('Fetched:');
    expect(card.findAll('.fetched .hop').map((hop) => hop.text())).toEqual(['https://example.com/a', 'https://www.example.com/b']);
  });

  it('shows the start of the text without a viewer, and the asked URL while it runs', () => {
    const card = mount(ReadView, { props: readProps({ result: { ...result, rendered: false, truncated: false, finalUrl: 'https://example.com/a' } }) });
    expect(card.find('.excerpt').text()).toBe('Hello page.');
    expect(card.findAll('.fact').map((f) => f.text())).toEqual(['11 characters']);
    const running = mount(ReadView, { props: readProps({ status: 'running' }) });
    expect(running.find('.title').text()).toBe('example.com · a');
    expect(running.find('[role="progressbar"]').exists()).toBe(true);
  });

  it('shows why it failed', () => {
    const card = mount(ReadView, { props: readProps({ status: 'failed', error: { class: 'caller', message: '127.0.0.1 is a private or local address', code: 'private-address' } }) });
    expect(card.find('.problem').text()).toContain('private or local');
  });
});

describe('view', () => {
  it('words every status', () => {
    expect(statusChip('running', undefined)).toEqual({ label: 'Running', tone: 'busy' });
    expect(statusChip('failed', { class: 'retry', message: 'slow', code: 'timeout' })).toEqual({ label: 'Timed out', tone: 'bad' });
    expect(statusChip('queued', undefined).tone).toBe('quiet');
    expect(statusChip('done', undefined).tone).toBe('ok');
  });

  it('shapes rows and dates', () => {
    const [row] = resultRows([{ title: 'T', url: 'https://example.com/', snippet: 's', score: 1.4, published: '2025-11-04' }], 'en-US');
    expect(row).toMatchObject({ domain: 'example.com', shown: 'example.com', score: 100, published: 'Nov 4, 2025' });
    expect(publishedLabel('last week')).toBe('last week');
    expect(publishedLabel(undefined)).toBeUndefined();
    expect(shownUrl('http://example.com/a/?key=1')).toBe('example.com/a/?key=redacted');
  });

  it('works out page facts for odd input', () => {
    expect(pageFacts('not a url', undefined)).toMatchObject({ title: 'not a url', domain: 'not a url', moved: false, chars: 0 });
  });
});
