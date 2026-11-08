import { describe, expect, it } from 'vitest';
import { AddressGuard } from './guard.ts';
import { WebProblem } from './problem.ts';
import { tableLookup } from './testing.ts';

/** The problem code a check fails with, or `ok`. */
async function verdict(guard: AddressGuard, url: string): Promise<string> {
  try {
    await guard.check(new URL(url));
    return 'ok';
  } catch (error) {
    return error instanceof WebProblem ? error.code : `threw ${String(error)}`;
  }
}

describe('AddressGuard', () => {
  const dns = tableLookup({ 'example.com': ['93.184.215.14'], 'empty.example': [], 'sneaky.example': ['93.184.215.14', '10.0.0.5'], 'v6.example': ['::1'] });

  it('allows public hosts and refuses names that resolve to private addresses', async () => {
    const guard = new AddressGuard(dns, false);
    expect(await verdict(guard, 'https://example.com/a')).toBe('ok');
    expect(await verdict(guard, 'https://sneaky.example/')).toBe('private-address');
    expect(await verdict(guard, 'https://v6.example/')).toBe('private-address');
  });

  it('refuses private addresses and local names without asking DNS', async () => {
    const lookup = tableLookup({});
    const guard = new AddressGuard(lookup, false);
    for (const url of ['http://127.0.0.1:4300/', 'http://[::1]/', 'http://localhost:8080/', 'http://api.localhost/', 'http://printer.local/', 'http://169.254.169.254/latest/meta-data']) {
      expect(await verdict(guard, url), url).toBe('private-address');
    }
    expect(await verdict(guard, 'http://93.184.215.14/')).toBe('ok');
    expect(lookup.asked).toEqual([]);
  });

  it('refuses schemes other than http and https', async () => {
    expect(await verdict(new AddressGuard(dns, true), 'ftp://example.com/')).toBe('bad-url');
    expect(await verdict(new AddressGuard(dns, false), 'file:///etc/passwd')).toBe('bad-url');
  });

  it('lets everything through when private addresses are allowed', async () => {
    const guard = new AddressGuard(tableLookup({}), true);
    expect(await verdict(guard, 'http://127.0.0.1:4300/')).toBe('ok');
    expect(await verdict(guard, 'http://localhost/')).toBe('ok');
  });

  it('calls a name that does not resolve, or resolves to nothing, a network problem', async () => {
    expect(await verdict(new AddressGuard(dns, false), 'https://nowhere.example/')).toBe('network');
    expect(await verdict(new AddressGuard(dns, false), 'https://empty.example/')).toBe('network');
  });
});
