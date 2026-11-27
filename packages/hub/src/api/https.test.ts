/**
 * The hub's https: on by default, an admin's switch wins (kept as the hub option, read back on start), the hub's own
 * certificate made on demand, given certificate files used instead, and the web API: everyone signed in reads it,
 * only an admin switches it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintId, type Tokens } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ScryptHasher } from './hash.ts';
import { HubHttps } from './https.ts';
import { rig, webRig } from './testing/rig.ts';
import { makeAuthority, makeHubCertificate, TlsFolder } from './tls.ts';

const dirs: string[] = [];
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'harness-https-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });
const folder = (): TlsFolder => new TlsFolder(scratch(), { host: 'bagend', addresses: () => ['192.168.50.113', '100.114.88.91'] });

describe('the hub https service', () => {
  it('is on by default with its own certificate, lists a link per address, and keeps an admin\'s switch', async () => {
    const r = await rig();
    const https = new HubHttps({ store: r.store, folder: folder(), on: true, hubUrl: 'http://localhost:4300', clock: () => r.now });
    await https.load();
    https.listening(4300);
    expect(https.enabled()).toBe(true);
    expect(https.authority()).toBeUndefined();
    const material = https.material();
    expect(material?.cert).toContain('BEGIN CERTIFICATE');
    expect(https.view()).toMatchObject({ on: true, source: 'own', host: 'bagend', links: ['https://192.168.50.113:4300/', 'https://100.114.88.91:4300/'] });
    expect(https.view()).toMatchObject({ fingerprint: https.authority()?.fingerprint, authorityName: 'Harness on bagend' });

    const admin = mintId('actor');
    expect(await https.set(false, admin)).toMatchObject({ on: false, links: [], setBy: admin, updatedAt: r.now });
    expect(https.enabled()).toBe(false);
    // a restart reads the choice back
    const again = new HubHttps({ store: r.store, folder: folder(), on: true, hubUrl: 'http://localhost:4300', clock: () => r.now });
    await again.load();
    expect(again.enabled()).toBe(false);
  });

  it('uses given certificate files instead, links their names, and offers no authority of its own', async () => {
    const r = await rig();
    const dir = scratch();
    const ca = makeAuthority('bagend');
    const pair = makeHubCertificate(ca, { ips: ['100.114.88.91'], names: ['bagend'] });
    writeFileSync(join(dir, 'cert.pem'), pair.cert);
    writeFileSync(join(dir, 'key.pem'), pair.key);
    const errors: unknown[] = [];
    const https = new HubHttps({
      store: r.store, folder: folder(), on: true, hubUrl: 'https://bagend.example.ts.net', clock: () => r.now,
      files: { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') }, onError: (error) => { errors.push(error); },
    });
    https.listening(443);
    expect(https.material()).toEqual(pair);
    expect(https.authority()).toBeUndefined();
    expect(https.view()).toMatchObject({ source: 'files', links: ['https://bagend.example.ts.net/', 'https://bagend/', 'https://100.114.88.91/'] });
    expect(https.view().fingerprint).toBeUndefined();
    rmSync(join(dir, 'cert.pem'));
    expect(https.material()).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('the https endpoints', () => {
  it('let everyone signed in read https and only an admin switch it', async () => {
    const r = await rig();
    const web = await webRig(r);
    const admin = web.as(await web.admin());
    const id = mintId('actor');
    await r.store.table('actors').insert({ id, kind: 'user', name: 'Mem', about: '', email: 'mem@example.com', role: 'member', createdAt: 1, disabled: false });
    await r.store.table('credentials').insert({ user: id, kind: 'password', secretHash: await new ScryptHasher(10).hash('member password'), createdAt: 1 });
    const member: Tokens = await web.client.call('signIn', { email: 'mem@example.com', password: 'member password' });

    expect(await web.client.call('https', {}, web.as(member))).toMatchObject({ on: true, source: 'own' });
    await expect(web.client.call('setHttps', { on: false }, web.as(member))).rejects.toMatchObject({ status: 403 });
    expect(await web.client.call('setHttps', { on: false }, admin)).toMatchObject({ on: false, links: [] });
    expect(await r.store.table('hubOptions').get('https')).toMatchObject({ key: 'https', value: false });
  });
});
