import { describe, expect, it } from 'vitest';
import { WebProblem } from './problem.ts';
import { TavilyResponse, TavilySearch, cleanSnippet, shapeResults, tavilyRequest } from './tavily.ts';

/** A Tavily `/search` response as recorded (trimmed), with the oddities real answers have. */
const RECORDED = {
  query: 'vue 3 composition api',
  follow_up_questions: null,
  answer: 'The Composition API is a set of APIs that lets you author Vue components with imported functions.',
  images: [],
  results: [
    {
      title: 'Composition API FAQ | Vue.js',
      url: 'https://vuejs.org/guide/extras/composition-api-faq',
      content: '# Composition API FAQ\n\n**Composition API** is a set of APIs that allows us to author Vue components using imported functions instead of declaring options.',
      score: 0.81,
      raw_content: null,
    },
    {
      title: '',
      url: 'https://example.com/untitled',
      content: 'An untitled page.',
      score: 0.4,
      raw_content: null,
      published_date: 'Tue, 04 Nov 2025 10:00:00 GMT',
    },
    {
      title: 'Introduction | Vue.js',
      url: 'https://vuejs.org/guide/introduction',
      content: null,
      score: 0.92,
      raw_content: null,
    },
    { title: 'broken', url: 'not a url', content: 'x', score: 0.99, raw_content: null },
  ],
  response_time: 1.12,
};

/** A fetch that answers once with `body` at `status`, recording the request. */
function answering(body: unknown, status = 200) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn: typeof fetch = (input, init) => {
    seen.push({ url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetchFn, seen };
}

const options = { url: 'https://api.tavily.test', timeout: 5_000, limit: 5, snippetChars: 120 };

async function problemOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'none';
  } catch (error) {
    return error instanceof WebProblem ? `${error.code}/${error.errorClass}` : `threw ${String(error)}`;
  }
}

describe('Tavily search', () => {
  it('posts the query with the key and shapes the recorded answer: best first, titled, cleaned', async () => {
    const { fetchFn, seen } = answering(RECORDED);
    const search = new TavilySearch({ ...options, fetch: fetchFn });
    const results = await search.search({ query: 'vue 3 composition api', depth: 'advanced', include: ['vuejs.org'], exclude: [] }, { key: 'tvly-test' });
    expect(seen[0]?.url).toBe('https://api.tavily.test/search');
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer tvly-test');
    const body = seen[0]?.init?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({
      query: 'vue 3 composition api', search_depth: 'advanced', topic: 'general', max_results: 5, include_answer: true, include_domains: ['vuejs.org'],
    });
    expect(results.answer).toBe(RECORDED.answer);
    expect(results.results.map((r) => r.url)).toEqual([
      'https://vuejs.org/guide/introduction', 'https://vuejs.org/guide/extras/composition-api-faq', 'https://example.com/untitled',
    ]);
    expect(results.results[0]).toEqual({ title: 'Introduction | Vue.js', url: 'https://vuejs.org/guide/introduction', snippet: '', score: 0.92 });
    expect(results.results[1]?.snippet).toEqual(expect.stringMatching(/^Composition API FAQ Composition API is a set of APIs that allows us to author Vue components using imported functions…\[\d+ more characters cut: read the page with web\/read\]$/));
    expect(results.results[2]).toMatchObject({ title: 'https://example.com/untitled', published: 'Tue, 04 Nov 2025 10:00:00 GMT' });
  });

  it('needs a key', async () => {
    const { fetchFn, seen } = answering(RECORDED);
    expect(await problemOf(new TavilySearch({ ...options, fetch: fetchFn }).search({ query: 'x' }, { key: undefined }))).toBe('no-search-key/fatal');
    expect(seen).toHaveLength(0);
  });

  it('classes refusals: a bad key or plan is fatal, a rate limit worth a retry, a bad request the caller\'s', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { detail: { error: 'Unauthorized: missing or invalid API key.' } }, 'search-refused/fatal'],
      [432, { detail: { error: 'This request exceeds your plan\'s set usage limit.' } }, 'search-refused/fatal'],
      [429, { detail: 'Too many requests' }, 'search-busy/retry'],
      [502, 'bad gateway', 'search-busy/retry'],
      [400, { detail: { error: 'Query is too long.' } }, 'search-invalid/caller'],
    ];
    for (const [status, body, expected] of cases) {
      const { fetchFn } = answering(body, status);
      expect(await problemOf(new TavilySearch({ ...options, fetch: fetchFn }).search({ query: 'x' }, { key: 'k' })), String(status)).toBe(expected);
    }
    const { fetchFn } = answering({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, 401);
    await expect(new TavilySearch({ ...options, fetch: fetchFn }).search({ query: 'x' }, { key: 'k' })).rejects.toThrow('Tavily answered 401: Unauthorized: missing or invalid API key.');
  });

  it('refuses an answer that is not a search response', async () => {
    const { fetchFn } = answering({ results: 'nope' });
    expect(await problemOf(new TavilySearch({ ...options, fetch: fetchFn }).search({ query: 'x' }, { key: 'k' }))).toBe('search-garbled/retry');
  });

  it('calls a failed connection busy, and passes the caller\'s cancel through', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await problemOf(new TavilySearch({ ...options, fetch: down }).search({ query: 'x' }, { key: 'k' }))).toBe('search-busy/retry');
    const slow: typeof fetch = () => Promise.reject(new DOMException('slow', 'TimeoutError'));
    expect(await problemOf(new TavilySearch({ ...options, fetch: slow }).search({ query: 'x' }, { key: 'k' }))).toBe('search-busy/retry');
    const controller = new AbortController();
    controller.abort();
    const aborted: typeof fetch = () => Promise.reject(new DOMException('cancelled', 'AbortError'));
    await expect(new TavilySearch({ ...options, fetch: aborted }).search({ query: 'x' }, { key: 'k', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('shaping', () => {
  it('builds the request from the args with defaults, leaving out empty filters', () => {
    expect(tavilyRequest({ query: 'news', topic: 'news', days: 3, limit: 2, include: [], exclude: ['spam.example'] }, 5)).toEqual({
      query: 'news', search_depth: 'basic', topic: 'news', max_results: 2, include_answer: true, days: 3, exclude_domains: ['spam.example'],
    });
  });

  it('keeps at most the limit, and leaves out an empty answer', () => {
    const shaped = shapeResults(TavilyResponse.parse({ ...RECORDED, answer: '  ' }), 50, 1);
    expect(shaped.answer).toBeUndefined();
    expect(shaped.results).toHaveLength(1);
  });

  it('cleans and cuts snippets at a word', () => {
    expect(cleanSnippet('## Title\n\n*bold*   text', 100)).toBe('Title bold text');
    expect(cleanSnippet('one two three four five six', 15)).toBe('one two three…[14 more characters cut: read the page with web/read]');
    expect(cleanSnippet('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij…[16 more characters cut: read the page with web/read]');
  });
});
