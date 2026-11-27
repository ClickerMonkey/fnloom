/**
 * The hub's own certificates: an authority limited to private addresses and this computer's name, and a hub
 * certificate from it naming every address, kept until an address changes or it nears its end.
 */
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostName, ipBytes, lanAddresses, makeAuthority, makeHubCertificate, TlsFolder, wantedAddresses } from './tls.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const dirs: string[] = [];
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'harness-tls-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });

/** The DER of a certificate's extension, found by its OID's bytes. */
const hasExtension = (cert: X509Certificate, oidBytes: number[]): boolean => cert.raw.includes(Buffer.from([0x06, oidBytes.length, ...oidBytes]));
/** Name constraints, 2.5.29.30. */
const NAME_CONSTRAINTS = [0x55, 0x1d, 0x1e];

describe('the certificate builder', () => {
  it('makes an authority for ten years, constrained to private addresses, localhost and the host', () => {
    const ca = new X509Certificate(makeAuthority('bagend', NOW).cert);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toContain('CN=Harness on bagend');
    expect(ca.verify(ca.publicKey)).toBe(true);
    const years = (Date.parse(ca.validTo) - Date.parse(ca.validFrom)) / DAY / 365;
    expect(years).toBeGreaterThan(9.9);
    expect(hasExtension(ca, NAME_CONSTRAINTS)).toBe(true);
    // the constraint subtrees: the names and the private ranges (192.168.0.0/16 as address and mask)
    expect(ca.raw.includes(Buffer.from('localhost'))).toBe(true);
    expect(ca.raw.includes(Buffer.from('bagend'))).toBe(true);
    expect(ca.raw.includes(Buffer.from([192, 168, 0, 0, 255, 255, 0, 0]))).toBe(true);
    expect(ca.raw.includes(Buffer.from([100, 64, 0, 0, 255, 192, 0, 0]))).toBe(true);
  });

  it('makes a hub certificate naming every address, signed by the authority, for 397 days', () => {
    const authority = makeAuthority('bagend', NOW);
    const want = wantedAddresses('bagend', ['192.168.50.113', '100.114.88.91', '8.8.8.8']);
    const leaf = new X509Certificate(makeHubCertificate(authority, want, NOW).cert);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(new X509Certificate(authority.cert).publicKey)).toBe(true);
    expect(leaf.checkIssued(new X509Certificate(authority.cert))).toBe(true);
    for (const ip of ['127.0.0.1', '::1', '192.168.50.113', '100.114.88.91']) { expect(leaf.checkIP(ip), ip).toBe(ip); }
    // a public address is never asked for: the authority couldn't vouch for it
    expect(leaf.checkIP('8.8.8.8')).toBeUndefined();
    for (const name of ['localhost', 'bagend', 'bagend.local']) { expect(leaf.checkHost(name), name).toBe(name); }
    expect(leaf.subjectAltName).toContain('IP Address:192.168.50.113');
    expect(Math.round((Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY)).toBe(397);
    expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
  });

  it('reads addresses and names as certificates want them', () => {
    expect(hostName('BagEnd_PC')).toBe('bagend-pc');
    expect(hostName('---')).toBe('harness');
    expect(ipBytes('fe80::1')).toEqual(Buffer.from([0xfe, 0x80, ...Array<number>(13).fill(0), 1]));
    expect(ipBytes('not an ip')).toBeUndefined();
    expect(lanAddresses({
      'Wi-Fi': [{ family: 'IPv4', address: '192.168.50.113', internal: false, netmask: '', mac: '', cidr: null }],
      Tailscale: [{ family: 'IPv4', address: '100.114.88.91', internal: false, netmask: '', mac: '', cidr: null }],
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false, netmask: '', mac: '', cidr: null }],
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true, netmask: '', mac: '', cidr: null }],
    })).toEqual(['192.168.50.113', '100.114.88.91']);
  });
});

describe('the folder', () => {
  it('makes the authority once and keeps the hub certificate until an address changes or it nears its end', () => {
    const dir = scratch();
    let addresses = ['192.168.1.20'];
    let now = NOW;
    const folder = new TlsFolder(dir, { host: 'bagend', addresses: () => addresses, clock: () => now });
    expect(folder.authority()).toBeUndefined();
    const first = folder.ensure();
    expect(first.ips).toContain('192.168.1.20');
    expect(folder.authority()?.fingerprint).toBe(first.fingerprint);
    expect(folder.authority()?.name).toBe('Harness on bagend');
    expect(readFileSync(join(dir, 'ca.crt'), 'utf8')).toBe(first.ca);

    expect(folder.ensure().cert).toBe(first.cert);
    addresses = ['192.168.1.20', '10.0.0.7'];
    const moved = folder.ensure();
    expect(moved.cert).not.toBe(first.cert);
    expect(moved.ca).toBe(first.ca);
    expect(new X509Certificate(moved.cert).checkIP('10.0.0.7')).toBe('10.0.0.7');

    now = NOW + 380 * DAY;
    const renewed = folder.ensure();
    expect(renewed.cert).not.toBe(moved.cert);
    expect(renewed.ca).toBe(first.ca);

    folder.reset();
    expect(folder.authority()).toBeUndefined();
    expect(folder.ensure().fingerprint).not.toBe(first.fingerprint);
  });
});
