/**
 * HTTPS for the hub with no certificate setup: the hub makes its own certificate authority (once) and, from it, a
 * certificate for this computer's addresses (localhost, its name, every LAN and Tailscale IP), made again when an
 * address changes or it nears its end. A phone or computer that installs the authority trusts the hub, so the page is
 * a secure context: the app installs and web push works there.
 *
 *   <HARNESS_DATA>/tls/ca.key, ca.crt     the authority (ten years; the key never leaves this computer)
 *   <HARNESS_DATA>/tls/hub.key, hub.crt   the hub's certificate (397 days, the most a phone accepts)
 *
 * The authority is limited by name constraints to private addresses, localhost and this computer's name: even with
 * its key, nobody could use it to pass as another website.
 *
 * Ported from hitloop's `src/hub/tls.ts` (Phil's Human In The Loop; same owner), with its folder, names and clock
 * made parameters so it can be tested. Only `node:crypto`: the DER below is just what certificates need.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';

// ── DER, just what certificates need ──

function len(n: number): Buffer {
  if (n < 0x80) { return Buffer.from([n]); }
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) { bytes.unshift(x & 0xff); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const ctx = (n: number, ...parts: Buffer[]): Buffer => tlv(0xa0 | n, ...parts);
const octets = (bytes: Buffer): Buffer => tlv(0x04, bytes);
const bits = (bytes: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.from([unused]), bytes);
const bool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
function int(value: number | Buffer): Buffer {
  let bytes = typeof value === 'number' ? Buffer.from([value]) : value;
  while (bytes.length > 1 && bytes[0] === 0 && ((bytes[1] ?? 0) & 0x80) === 0) { bytes = bytes.subarray(1); }
  if (((bytes[0] ?? 0) & 0x80) !== 0) { bytes = Buffer.concat([Buffer.from([0]), bytes]); }
  return tlv(0x02, bytes);
}
function oid(dotted: string): Buffer {
  const n = dotted.split('.').map(Number);
  const out = [40 * (n[0] ?? 0) + (n[1] ?? 0)];
  for (const v of n.slice(2)) {
    const bytes = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) { bytes.unshift(0x80 | (x & 0x7f)); }
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(date: Date): Buffer {
  const iso = `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}
/** The organisation every certificate names. */
const ORGANISATION = 'Harness';
const dn = (cn: string): Buffer => seq(set(seq(oid('2.5.4.10'), utf8(ORGANISATION))), set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id: string, critical: boolean, value: Buffer): Buffer => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/** An IP address's bytes (4 or 16), or undefined when it isn't one. */
export function ipBytes(ip: string): Buffer | undefined {
  if (isIPv4(ip)) { return Buffer.from(ip.split('.').map(Number)); }
  if (!isIPv6(ip)) { return undefined; }
  const [head = '', tail = ''] = ip.split('::');
  const a = head === '' ? [] : head.split(':');
  const b = ip.includes('::') ? (tail === '' ? [] : tail.split(':')) : [];
  const groups = [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b];
  return Buffer.from(groups.flatMap((g) => [(parseInt(g, 16) >> 8) & 0xff, parseInt(g, 16) & 0xff]));
}

const keyId = (pub: KeyObject): Buffer => createHash('sha1').update(pub.export({ type: 'spki', format: 'der' }).subarray(-65)).digest();

interface CertSpec {
  readonly subject: string;
  readonly issuer: string;
  readonly pub: KeyObject;
  readonly signer: KeyObject;
  readonly issuerKeyId: Buffer;
  readonly days: number;
  readonly extensions: readonly Buffer[];
  readonly now: number;
}

function certificate(s: CertSpec): string {
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const from = new Date(s.now - 3_600_000);
  const tbs = seq(
    ctx(0, int(2)),
    int(serial),
    ECDSA_SHA256,
    dn(s.issuer),
    seq(time(from), time(new Date(from.getTime() + s.days * 86_400_000))),
    dn(s.subject),
    s.pub.export({ type: 'spki', format: 'der' }),
    ctx(3, seq(...s.extensions, ext('2.5.29.14', false, octets(keyId(s.pub))), ext('2.5.29.35', false, seq(tlv(0x80, s.issuerKeyId))))),
  );
  const signature = sign('sha256', tbs, s.signer);
  const der = seq(tbs, ECDSA_SHA256, bits(signature));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`;
}

/** The private IPv4 ranges the authority may vouch for (address, mask). */
export const PERMITTED_IPS: readonly (readonly [string, string])[] = [
  ['127.0.0.0', '255.0.0.0'],
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['169.254.0.0', '255.255.0.0'],
  // carrier-grade NAT, as Tailscale and some VPNs use
  ['100.64.0.0', '255.192.0.0'],
];
/** The IPv6 ranges: loopback, unique local and link local. */
const PERMITTED_IP6: readonly (readonly [string, string])[] = [
  ['::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fc00::', 'fe00::'],
  ['fe80::', 'ffc0::'],
];

/** A host name the certificates may carry ("bagend", and "bagend.local"), from the computer's name. */
export function hostName(raw: string = hostname()): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'harness';
}

/** A key and its certificate, as PEM. */
export interface KeyPair {
  readonly key: string;
  readonly cert: string;
}

/** A new authority for this computer, constrained to private addresses, localhost and `host`; ten years. */
export function makeAuthority(host: string, now: number = Date.now()): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const subtree = (b: Buffer): Buffer => seq(b);
  const ranges = [...PERMITTED_IPS, ...PERMITTED_IP6].flatMap(([address, mask]) => {
    const a = ipBytes(address);
    const m = ipBytes(mask);
    return a === undefined || m === undefined ? [] : [subtree(tlv(0x87, Buffer.concat([a, m])))];
  });
  const constraints = seq(ctx(0,
    subtree(tlv(0x82, Buffer.from('localhost'))),
    subtree(tlv(0x82, Buffer.from('local'))),
    subtree(tlv(0x82, Buffer.from(host))),
    ...ranges,
  ));
  const subject = `Harness on ${host}`;
  const cert = certificate({
    subject, issuer: subject, pub: publicKey, signer: privateKey, issuerKeyId: keyId(publicKey), days: 3650, now,
    extensions: [
      ext('2.5.29.19', true, seq(bool(true), int(0))),
      // digitalSignature, keyCertSign, cRLSign
      ext('2.5.29.15', true, bits(Buffer.from([0x86]), 1)),
      ext('2.5.29.30', true, constraints),
    ],
  });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

/** A certificate's subject's common name ('' when it has none). */
function commonName(x: X509Certificate): string {
  return x.subject.split('\n').find((line) => line.startsWith('CN='))?.slice(3) ?? '';
}

/** What the hub's certificate covers. */
export interface Addresses {
  readonly ips: readonly string[];
  readonly names: readonly string[];
}

/** A certificate for the hub from `ca`, for these addresses; 397 days. */
export function makeHubCertificate(ca: KeyPair, want: Addresses, now: number = Date.now()): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caCert = new X509Certificate(ca.cert);
  const ips = want.ips.flatMap((ip) => { const b = ipBytes(ip); return b === undefined ? [] : [tlv(0x87, b)]; });
  const san = seq(...want.names.map((n) => tlv(0x82, Buffer.from(n))), ...ips);
  const cert = certificate({
    subject: want.names[0] ?? 'localhost',
    issuer: commonName(caCert) || 'Harness',
    pub: publicKey, signer: createPrivateKey(ca.key), issuerKeyId: keyId(caCert.publicKey), days: 397, now,
    extensions: [
      ext('2.5.29.19', true, seq()),
      // digitalSignature
      ext('2.5.29.15', true, bits(Buffer.from([0x80]), 7)),
      // serverAuth
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, san),
    ],
  });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

/** Virtual adapters (WSL, Hyper-V, Docker, VMs): a phone can't reach these. */
const VIRTUAL = /vethernet|wsl|hyper-v|docker|vmnet|virtualbox|vbox|^br-|^veth|^virbr|loopback/i;

/** This computer's IPv4 addresses other devices can reach (Wi-Fi, Ethernet, Tailscale), virtual adapters left out. */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  return Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((n) => n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

/** Whether `ip` is in the range `address`/`mask`. */
function inRange(ip: string, address: string, mask: string): boolean {
  const x = ipBytes(ip);
  const b = ipBytes(address);
  const k = ipBytes(mask);
  if (x === undefined || b === undefined || k === undefined || x.length !== b.length) { return false; }
  return x.every((v, i) => (v & (k[i] ?? 0)) === ((b[i] ?? 0) & (k[i] ?? 0)));
}

/** The addresses the hub's certificate should cover: loopback, the private ones of `lan`, localhost and the host name. */
export function wantedAddresses(host: string, lan: readonly string[]): Addresses {
  const ips = ['127.0.0.1', '::1', ...lan.filter((ip) => PERMITTED_IPS.some(([a, m]) => inRange(ip, a, m)))];
  return { ips: [...new Set(ips)], names: ['localhost', host, `${host}.local`] };
}

/** The hub's certificate and what it covers. */
export interface Tls extends KeyPair {
  /** The authority's certificate (PEM). */
  readonly ca: string;
  readonly ips: readonly string[];
  readonly names: readonly string[];
  /** When the hub's certificate ends (ms since the epoch). */
  readonly expires: number;
  /** The authority's SHA-256 fingerprint, to compare on the phone. */
  readonly fingerprint: string;
}

/** The authority as a device installs it. */
export interface Authority {
  /** Its name (the subject's common name), as a device lists it. */
  readonly name: string;
  readonly pem: string;
  readonly der: Buffer;
  readonly fingerprint: string;
}

/** What a `TlsFolder` needs from the computer (tests give fixed ones). */
export interface TlsFolderOptions {
  /** The host name the certificates carry (`hostName()`). */
  readonly host?: string;
  /** The addresses other devices reach this computer at now (`lanAddresses`). */
  readonly addresses?: () => readonly string[];
  readonly clock?: () => number;
}

/** Made again this long before a certificate ends. */
const RENEW_BEFORE = 30 * 86_400_000;

/** Write a file whole (a reader never sees half of it). */
function writeWhole(file: string, text: string, secret: boolean): void {
  const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  if (secret) {
    try { chmodSync(tmp, 0o600); } catch { /* Windows: the folder's own permissions */ }
  }
  renameSync(tmp, file);
}

/** The authority and the hub's certificate in a folder of the hub's data. */
export class TlsFolder {
  readonly #dir: string;
  readonly #host: string;
  readonly #addresses: () => readonly string[];
  readonly #clock: () => number;

  constructor(dir: string, options: TlsFolderOptions = {}) {
    this.#dir = dir;
    this.#host = options.host ?? hostName();
    this.#addresses = options.addresses ?? lanAddresses;
    this.#clock = options.clock ?? Date.now;
  }

  /** The host name the certificates carry. */
  get host(): string { return this.#host; }

  /** The addresses other devices reach this computer at now, that the hub's certificate covers (loopback left out). */
  reachable(): string[] {
    return wantedAddresses(this.#host, this.#addresses()).ips.filter((ip) => ip !== '127.0.0.1' && ip !== '::1');
  }

  #file(name: string): string { return join(this.#dir, name); }

  #read(key: string, cert: string): KeyPair | undefined {
    try { return { key: readFileSync(this.#file(key), 'utf8'), cert: readFileSync(this.#file(cert), 'utf8') }; } catch { return undefined; }
  }

  /** The authority and the hub's certificate: made when missing, made again when an address changed or it nears its end. */
  ensure(): Tls {
    mkdirSync(this.#dir, { recursive: true });
    const now = this.#clock();
    let ca = this.#read('ca.key', 'ca.crt');
    if (ca !== undefined && Date.parse(new X509Certificate(ca.cert).validTo) < now + RENEW_BEFORE) { ca = undefined; }
    const fresh = ca === undefined;
    if (ca === undefined) {
      ca = makeAuthority(this.#host, now);
      writeWhole(this.#file('ca.key'), ca.key, true);
      writeWhole(this.#file('ca.crt'), ca.cert, false);
    }
    const want = wantedAddresses(this.#host, this.#addresses());
    const caX = new X509Certificate(ca.cert);
    let leaf = fresh ? undefined : this.#read('hub.key', 'hub.crt');
    if (leaf !== undefined && !covers(leaf.cert, caX, want, now)) { leaf = undefined; }
    if (leaf === undefined) {
      leaf = makeHubCertificate(ca, want, now);
      writeWhole(this.#file('hub.key'), leaf.key, true);
      writeWhole(this.#file('hub.crt'), leaf.cert, false);
    }
    return { ...leaf, ca: ca.cert, ...want, expires: Date.parse(new X509Certificate(leaf.cert).validTo), fingerprint: caX.fingerprint256 };
  }

  /** The authority, if made, without making anything. */
  authority(): Authority | undefined {
    try {
      const pem = readFileSync(this.#file('ca.crt'), 'utf8');
      const x = new X509Certificate(pem);
      return { name: commonName(x), pem, der: x.raw, fingerprint: x.fingerprint256 };
    } catch {
      return undefined;
    }
  }

  /** Start again: a new authority next time (every device has to install the new one). */
  reset(): void {
    for (const name of ['ca.key', 'ca.crt', 'hub.key', 'hub.crt']) { rmSync(this.#file(name), { force: true }); }
  }
}

/** Whether a hub certificate is still good: signed by the authority, not near its end, and naming every address. */
function covers(pem: string, ca: X509Certificate, want: Addresses, now: number): boolean {
  try {
    const x = new X509Certificate(pem);
    return Date.parse(x.validTo) > now + RENEW_BEFORE && x.verify(ca.publicKey)
      && want.ips.every((ip) => x.checkIP(ip) !== undefined) && want.names.every((n) => x.checkHost(n, { wildcards: false }) !== undefined);
  } catch {
    return false;
  }
}
