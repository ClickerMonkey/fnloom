import { describe, expect, it } from 'vitest';
import { AddressGuard } from './guard.ts';
import { fetchProblem, guardedFetch } from './http.ts';
import { WebProblem } from './problem.ts';
import { PUBLIC_DNS, html, redirect, scriptedFetch, tableLookup } from './testing.ts';

const guard = new AddressGuard(tableLookup({ ...PUBLIC_DNS, 'inside.example': ['192.168.1.10'] }), false);

/** The problem code a call fails with. */
async function problemOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'none';
  } catch (error) {
    return error instanceof WebProblem ? error.code : `threw ${String(error)}`;
  }
}

describe('guardedFetch', () => {
  it('follows redirects itself, checking every hop, and locates the response at the last one', async () => {
    const base = scriptedFetch({
      'https://example.com/a': redirect('/b', 301),
      'https://example.com/b': redirect('https://www.example.com/c'),
      'https://www.example.com/c': html('<p>here</p>'),
    });
    const response = await guardedFetch({ fetch: base, guard, redirects: 5, maxBytes: 1_000 })('https://example.com/a', {});
    expect(response.url).toBe('https://www.example.com/c');
    expect(await response.text()).toBe('<p>here</p>');
    expect(base.seen.map((r) => [r.url, r.init.redirect])).toEqual([
      ['https://example.com/a', 'manual'], ['https://example.com/b', 'manual'], ['https://www.example.com/c', 'manual'],
    ]);
  });

  it('refuses a redirect into a private address before requesting it', async () => {
    const base = scriptedFetch({ 'https://example.com/a': redirect('https://inside.example/admin') });
    expect(await problemOf(guardedFetch({ fetch: base, guard, redirects: 5, maxBytes: 1_000 })('https://example.com/a', {}))).toBe('private-address');
    expect(base.seen.map((r) => r.url)).toEqual(['https://example.com/a']);
  });

  it('stops after too many redirects, and on a redirect without a location', async () => {
    const loop = scriptedFetch({ 'https://example.com/a': () => redirect('/b'), 'https://example.com/b': () => redirect('/a') });
    expect(await problemOf(guardedFetch({ fetch: loop, guard, redirects: 3, maxBytes: 1_000 })('https://example.com/a', {}))).toBe('redirects');
    expect(loop.seen).toHaveLength(4);
    const bare = scriptedFetch({ 'https://example.com/a': new Response(null, { status: 302 }) });
    expect(await problemOf(guardedFetch({ fetch: bare, guard, redirects: 3, maxBytes: 1_000 })('https://example.com/a', {}))).toBe('redirects');
  });

  it('classes failed statuses: the caller\'s for 4xx, worth a retry for 429 and 5xx', async () => {
    const base = scriptedFetch({
      'https://example.com/busy': new Response('', { status: 503, statusText: 'Service Unavailable' }),
      'https://example.com/slow': new Response('', { status: 429 }),
    });
    const fetchIt = guardedFetch({ fetch: base, guard, redirects: 3, maxBytes: 1_000 });
    expect(await problemOf(fetchIt('https://example.com/missing', {}))).toBe('http-status');
    expect(await problemOf(fetchIt('https://example.com/busy', {}))).toBe('server-busy');
    expect(await problemOf(fetchIt('https://example.com/slow', {}))).toBe('server-busy');
  });

  it('refuses a body over the limit, declared or streamed', async () => {
    const base = scriptedFetch({
      'https://example.com/declared': new Response('x'.repeat(10), { headers: { 'content-length': '5000' } }),
      'https://example.com/streamed': new Response('x'.repeat(5000)),
    });
    const fetchIt = guardedFetch({ fetch: base, guard, redirects: 3, maxBytes: 1_000 });
    expect(await problemOf(fetchIt('https://example.com/declared', {}))).toBe('too-large');
    const streamed = await fetchIt('https://example.com/streamed', {});
    expect(await problemOf(streamed.text())).toBe('too-large');
  });

  it('names URLs in problems with their credentials redacted, a redirect\'s target included', async () => {
    const base = scriptedFetch({
      'https://example.com/a?token=abc123': redirect('https://example.com/signed?X-Amz-Signature=s3cr3t&page=2'),
      'https://example.com/signed?X-Amz-Signature=s3cr3t&page=2': new Response('', { status: 403, statusText: 'Forbidden' }),
      'https://example.com/down?api_key=k3y': new TypeError('fetch failed'),
    });
    const fetchIt = guardedFetch({ fetch: base, guard, redirects: 3, maxBytes: 1_000 });
    const messages = await Promise.all(['https://example.com/a?token=abc123', 'https://example.com/down?api_key=k3y'].map((url) =>
      fetchIt(url, {}).then(() => 'none', (error: unknown) => (error instanceof WebProblem ? error.message : String(error)))));
    expect(messages[0]).toBe('https://example.com/signed?X-Amz-Signature=redacted&page=2 answered 403 Forbidden.');
    expect(messages[1]).toBe('Couldn\'t reach https://example.com/down?api_key=redacted.');
    for (const secret of ['abc123', 's3cr3t', 'k3y']) { expect(messages.join(' ')).not.toContain(secret); }
  });

  it('turns network failures and timeouts into problems, and passes the caller\'s abort through', async () => {
    const abort = new DOMException('stop', 'AbortError');
    const base = scriptedFetch({
      'https://example.com/down': new TypeError('fetch failed'),
      'https://example.com/timeout': new DOMException('slow', 'TimeoutError'),
      'https://example.com/abort': abort,
    });
    const fetchIt = guardedFetch({ fetch: base, guard, redirects: 3, maxBytes: 1_000 });
    expect(await problemOf(fetchIt('https://example.com/down', {}))).toBe('network');
    expect(await problemOf(fetchIt('https://example.com/timeout', {}))).toBe('timeout');
    await expect(fetchIt('https://example.com/abort', {})).rejects.toBe(abort);
  });
});

describe('fetchProblem', () => {
  it('keeps problems as they are', () => {
    const problem = new WebProblem('too-large', 'big');
    expect(fetchProblem(problem, 'https://example.com')).toBe(problem);
  });
});
