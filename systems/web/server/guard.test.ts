import { describe, expect, it } from 'vitest';
import { AddressGuard, isPrivateAddress } from './guard.ts';
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

describe('isPrivateAddress', () => {
  it('knows private, loopback, link-local, shared and reserved ranges', () => {
    for (const address of ['127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.50.112', '169.254.169.254', '100.100.4.74', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd12:3456::1', 'ff02::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('lets public addresses through, and says no for names', () => {
    for (const address of ['93.184.215.14', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8', 'example.com']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('AddressGuard', () => {
  const dns = tableLookup({ 'example.com': ['93.184.215.14'], 'sneaky.example': ['93.184.215.14', '10.0.0.5'], 'v6.example': ['::1'] });

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

  it('calls a name that does not resolve a network problem', async () => {
    expect(await verdict(new AddressGuard(dns, false), 'https://nowhere.example/')).toBe('network');
  });
});
