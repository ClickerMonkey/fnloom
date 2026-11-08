import { describe, expect, it } from 'vitest';
import { addressVerdict, followRedirects, isLocalName, isPrivateAddress, type AddressRules, type HostLookup } from './address.ts';

/** DNS from a table, recording every name asked. */
function tableLookup(table: Readonly<Record<string, readonly string[]>>): HostLookup & { readonly asked: string[] } {
  const asked: string[] = [];
  const lookup: HostLookup = (hostname) => {
    asked.push(hostname);
    const found = table[hostname];
    return found === undefined ? Promise.reject(new Error(`ENOTFOUND ${hostname}`)) : Promise.resolve(found);
  };
  return Object.assign(lookup, { asked });
}

const dns = tableLookup({
  'example.com': ['93.184.215.14'], 'sneaky.example': ['93.184.215.14', '10.0.0.5'], 'v6.example': ['::1'], 'empty.example': [], 'odd.example': ['not an address'],
});

/** The refusal a URL gets, or `ok`. */
async function verdictOf(url: string, rules: AddressRules = { lookup: dns, allowPrivate: false }): Promise<string> {
  const verdict = await addressVerdict(new URL(url), rules);
  return verdict.ok ? 'ok' : verdict.refusal;
}

describe('isPrivateAddress', () => {
  it('knows private, loopback, link-local, shared, documentation, multicast and reserved ranges', () => {
    for (const address of [
      '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.50.112', '169.254.169.254', '100.100.4.74', '0.0.0.0', '192.0.2.1',
      '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd12:3456::1', 'ff02::1',
      '2001:db8::1', '64:ff9b:1::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('lets public addresses through, and says no for names', () => {
    for (const address of ['93.184.215.14', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '2606:2800:220:1::1', '::ffff:8.8.8.8', 'example.com']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('isLocalName', () => {
  it('knows the names of this machine and its network', () => {
    for (const name of ['localhost', 'LOCALHOST.', 'api.localhost', 'printer.local', 'db.internal']) { expect(isLocalName(name), name).toBe(true); }
    for (const name of ['example.com', 'localhost.example.com', 'internal.example']) { expect(isLocalName(name), name).toBe(false); }
  });
});

describe('addressVerdict', () => {
  it('allows public hosts and refuses names with any private address', async () => {
    expect(await verdictOf('https://example.com/a')).toBe('ok');
    expect(await verdictOf('https://sneaky.example/')).toBe('private');
    expect(await verdictOf('https://v6.example/')).toBe('private');
  });

  it('judges literal addresses and local names without asking DNS', async () => {
    const lookup = tableLookup({});
    for (const url of ['http://127.0.0.1:4300/', 'http://[::1]/', 'http://localhost:8080/', 'http://printer.local/', 'http://169.254.169.254/latest/meta-data', 'http://224.0.0.1/']) {
      expect(await verdictOf(url, { lookup, allowPrivate: false }), url).toBe('private');
    }
    expect(await verdictOf('http://93.184.215.14/', { lookup, allowPrivate: false })).toBe('ok');
    expect(lookup.asked).toEqual([]);
  });

  it('refuses names that do not resolve, resolve to nothing or to something that is not an address', async () => {
    const verdict = await addressVerdict(new URL('https://nowhere.example/'), { lookup: dns, allowPrivate: false });
    expect(verdict).toMatchObject({ ok: false, refusal: 'unresolved' });
    expect(verdict.ok ? undefined : verdict.cause).toBeInstanceOf(Error);
    expect(await verdictOf('https://empty.example/')).toBe('unresolved');
    expect(await verdictOf('https://odd.example/')).toBe('private');
  });

  it('refuses schemes other than http and https, even when private addresses are allowed', async () => {
    expect(await verdictOf('ftp://example.com/', { lookup: dns, allowPrivate: true })).toBe('not-http');
    expect(await verdictOf('file:///etc/passwd')).toBe('not-http');
  });

  it('lets every http(s) host through when private addresses are allowed', async () => {
    const rules = { lookup: tableLookup({}), allowPrivate: true };
    expect(await verdictOf('http://127.0.0.1:4300/', rules)).toBe('ok');
    expect(await verdictOf('http://localhost/', rules)).toBe('ok');
  });
});

describe('followRedirects', () => {
  /** A fetch answering from a table, recording each URL and its redirect mode. */
  function scripted(answers: Readonly<Record<string, () => Response>>) {
    const asked: string[] = [];
    const modes: (RequestRedirect | undefined)[] = [];
    const fetch = (input: string, init: RequestInit): Promise<Response> => {
      asked.push(input);
      modes.push(init.redirect);
      const answer = answers[input];
      return answer === undefined ? Promise.reject(new Error(`no answer for ${input}`)) : Promise.resolve(answer());
    };
    return { fetch, asked, modes };
  }
  const redirect = (location: string | null, status = 302) => () => new Response(null, { status, headers: location === null ? {} : { location } });
  const problems = {
    noLocation: (at: URL) => new Error(`no-location ${at.href}`),
    tooMany: (start: URL, limit: number) => new Error(`too-many ${start.href} ${limit}`),
  };

  it('follows relative and absolute redirects, checking every hop, always in manual mode', async () => {
    const { fetch, asked, modes } = scripted({ 'https://a.dev/1': redirect('/2', 301), 'https://a.dev/2': redirect('https://b.dev/3', 308), 'https://b.dev/3': () => new Response('end') });
    const checked: string[] = [];
    const followed = await followRedirects('https://a.dev/1', { redirect: 'follow' }, { fetch, check: (url) => { checked.push(url.href); return Promise.resolve(); }, redirects: 5, problems });
    expect(await followed.response.text()).toBe('end');
    expect(followed.url.href).toBe('https://b.dev/3');
    expect(checked).toEqual(asked);
    expect(asked).toEqual(['https://a.dev/1', 'https://a.dev/2', 'https://b.dev/3']);
    expect(modes).toEqual(['manual', 'manual', 'manual']);
  });

  it('stops before requesting a hop the check refuses', async () => {
    const { fetch, asked } = scripted({ 'https://a.dev/1': redirect('http://inside.lan/secret') });
    const check = (url: URL) => (url.hostname === 'inside.lan' ? Promise.reject(new Error('refused')) : Promise.resolve());
    await expect(followRedirects('https://a.dev/1', {}, { fetch, check, redirects: 5, problems })).rejects.toThrow('refused');
    expect(asked).toEqual(['https://a.dev/1']);
  });

  it('fails a redirect loop past the limit, and a redirect without a location', async () => {
    const check = () => Promise.resolve();
    const loop = scripted({ 'https://a.dev/1': redirect('/1') });
    await expect(followRedirects('https://a.dev/1', {}, { fetch: loop.fetch, check, redirects: 2, problems })).rejects.toThrow('too-many https://a.dev/1 2');
    expect(loop.asked).toHaveLength(3);
    const bare = scripted({ 'https://a.dev/1': redirect(null) });
    await expect(followRedirects('https://a.dev/1', {}, { fetch: bare.fetch, check, redirects: 2, problems })).rejects.toThrow('no-location https://a.dev/1');
  });

  it('returns other statuses as they are, and names fetch failures the caller\'s way', async () => {
    const check = () => Promise.resolve();
    const { fetch } = scripted({ 'https://a.dev/missing': () => new Response('gone', { status: 404 }), 'https://a.dev/304': () => new Response(null, { status: 304 }) });
    expect((await followRedirects('https://a.dev/missing', {}, { fetch, check, redirects: 2, problems })).response.status).toBe(404);
    expect((await followRedirects('https://a.dev/304', {}, { fetch, check, redirects: 2, problems })).response.status).toBe(304);
    await expect(followRedirects('https://a.dev/down', {}, { fetch, check, redirects: 2, problems })).rejects.toThrow('no answer');
    const named = { ...problems, failed: (_error: unknown, at: URL) => new Error(`failed ${at.pathname}`) };
    await expect(followRedirects('https://a.dev/down', {}, { fetch, check, redirects: 2, problems: named })).rejects.toThrow('failed /down');
  });

  it('stops when the caller aborts after the check', async () => {
    const controller = new AbortController();
    const { fetch, asked } = scripted({ 'https://a.dev/1': () => new Response('x') });
    const check = () => { controller.abort(); return Promise.resolve(); };
    await expect(followRedirects('https://a.dev/1', { signal: controller.signal }, { fetch, check, redirects: 2, problems })).rejects.toMatchObject({ name: 'AbortError' });
    expect(asked).toEqual([]);
  });
});
