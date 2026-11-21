import { ApiError } from '@ayepi/core';
import { IDS, InstanceName, MAIN_INSTANCE, PairingId, PROXY_TRUST_OPTION, SystemName, type HelloReply, type Manifest } from '@harness/core';
import { wireType, g } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, manifestFor, shop } from '../catalog/fixtures.ts';
import { settle } from '../testing.ts';
import { FakeSystem, linkRig, type LinkRig } from './rig.ts';
import { fingerprint } from './keys.ts';
import { UNKNOWN_ADDRESS } from '../api/client-address.ts';
import { memoryLog } from '../testing.ts';
import { PairingLimits } from './pairing.ts';

const SHOP = SystemName.parse('shop');
/** The shop's config type, as its contract and its `pairingInfo` say it. */
const SHOP_CONFIG = wireType(g.obj({ currency: g.enum(['EUR', 'USD']) }));

let rig: LinkRig | undefined;
afterEach(async () => { await rig?.stop(); rig = undefined; });

/** A waiting pairing reply, or a failure. */
function waiting(reply: HelloReply | object): Extract<HelloReply, { kind: 'pairing' }> {
  if (!('kind' in reply) || reply.kind !== 'pairing') { throw new Error('expected a pairing'); }
  return reply;
}

/** The status and code of an `ApiError` rejection. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof ApiError)) { throw new Error('expected an ApiError'); }
  return { status: error.status, code: error.code };
}

async function start(options: { publicUrl?: string } = {}): Promise<{ rig: LinkRig; manifest: Manifest; system: FakeSystem }> {
  rig = await linkRig(options);
  const manifest = await manifestFor(shop);
  return { rig, manifest, system: new FakeSystem(rig.app, 'shop', manifest) };
}

describe('the pairing link', () => {
  it('opens the pairing page at the address the system dialed, with the code, so a phone that scans it lands on the request', async () => {
    const { system } = await start();
    const reply = waiting(await system.dialing('192.168.50.112:4300').connect());
    expect(reply.url).toBe(`http://192.168.50.112:4300/pair/${reply.pairing}?code=${reply.code ?? ''}`);
  });

  it('uses the public URL when one is set', async () => {
    const { system } = await start({ publicUrl: 'https://hub.example/' });
    const reply = waiting(await system.connect());
    expect(reply.url).toBe(`https://hub.example/pair/${reply.pairing}?code=${reply.code ?? ''}`);
  });

  it('refuses names the hub keeps for itself', async () => {
    const { rig: r, manifest } = await start();
    const memory = new FakeSystem(r.app, 'memory', manifest);
    memory.open();
    expect(await refusal(memory.hello())).toEqual({ status: 403, code: 'RESERVED_NAME' });
  });
});

/** Trust one proxy in front of the hub, so a socket's `X-Forwarded-For` says where it comes from. */
async function trustOneProxy(r: LinkRig): Promise<void> {
  await r.store.table('hubOptions').put({ key: PROXY_TRUST_OPTION, value: { proxies: 1 }, setBy: ADMIN, updatedAt: 0 });
}

describe('where a pairing comes from (M5)', () => {
  it('ignores X-Forwarded-For unless the admin trusts a proxy, so a socket cannot pick its own address', async () => {
    const { rig: r, system, manifest } = await start();
    const spoofed = waiting(await system.from('203.0.113.9').connect());
    expect((await r.pairing.get(spoofed.pairing)).address).toBe(UNKNOWN_ADDRESS);
    await trustOneProxy(r);
    const other = new FakeSystem(r.app, 'other', manifest).from('198.51.100.4');
    expect((await r.pairing.get(waiting(await other.connect()).pairing)).address).toBe('198.51.100.4');
  });

  it('limits pairing requests per address, with a code or an auto-pair secret, leaving other addresses alone', async () => {
    rig = await linkRig({ link: { HARNESS_PAIRING_LIMIT: 2 } });
    const manifest = await manifestFor(shop);
    const r = rig;
    await trustOneProxy(r);
    const asker = (name: string, address: string): FakeSystem => new FakeSystem(r.app, name, manifest).from(address);
    waiting(await asker('a1', '10.1.1.1').connect());
    waiting(await asker('a2', '10.1.1.1').connect());
    expect(await refusal(asker('a3', '10.1.1.1').connect())).toEqual({ status: 429, code: 'PAIRING_LIMITED' });
    // an auto-pair secret counts the same, before it is even checked
    const guesser = asker('a4', '10.1.1.1');
    guesser.autoPair = { id: IDS.autoPair.parse('apk_guess'), secret: 'x'.repeat(43) };
    expect(await refusal(guesser.connect())).toEqual({ status: 429, code: 'PAIRING_LIMITED' });
    waiting(await asker('b1', '10.2.2.2').connect());
    expect((await r.pairing.pending()).map((p) => p.name).sort()).toEqual(['a1', 'a2', 'b1']);
  });

  it('counts refused pairing tokens, tries none once an address is out of requests, and never lets a token skip an auto-pair count', async () => {
    rig = await linkRig({ link: { HARNESS_PAIRING_LIMIT: 2 } });
    const manifest = await manifestFor(shop);
    const r = rig;
    await trustOneProxy(r);
    const asker = (name: string, address: string): FakeSystem => new FakeSystem(r.app, name, manifest).from(address);
    // good tokens are an admin's say-so and aren't counted (a hub's bundled systems pair with them from one address)
    for (const name of ['t1', 't2', 't3']) {
      const { token } = await r.pairing.createToken({ name: SystemName.parse(name), expiresIn: 30_000, by: ADMIN });
      await expect(asker(name, '10.5.5.5').connect(token)).resolves.toBeDefined();
    }
    // the attack: guessing tokens without limit
    expect(await refusal(asker('g1', '10.6.6.6').connect('guess-1'))).toEqual({ status: 401, code: 'BAD_PAIRING_TOKEN' });
    expect(await refusal(asker('g2', '10.6.6.6').connect('guess-2'))).toEqual({ status: 401, code: 'BAD_PAIRING_TOKEN' });
    expect(await refusal(asker('g3', '10.6.6.6').connect('guess-3'))).toEqual({ status: 429, code: 'PAIRING_LIMITED' });
    const { token } = await r.pairing.createToken({ name: SystemName.parse('late'), expiresIn: 30_000, by: ADMIN });
    expect(await refusal(asker('late', '10.6.6.6').connect(token))).toEqual({ status: 429, code: 'PAIRING_LIMITED' });
    // an auto-pair secret sent with a token is counted as any auto-pair hello
    const guesser = (name: string): FakeSystem => Object.assign(asker(name, '10.7.7.7'), { autoPair: { id: IDS.autoPair.parse('apk_guess'), secret: 'x'.repeat(43) } });
    await refusal(guesser('h1').connect('tok'));
    await refusal(guesser('h2').connect('tok'));
    expect(await refusal(guesser('h3').connect('tok'))).toEqual({ status: 429, code: 'PAIRING_LIMITED' });
  });

  it('limits pairing requests from every address together', async () => {
    rig = await linkRig({ link: { HARNESS_PAIRING_LIMIT: 5, HARNESS_PAIRING_LIMIT_TOTAL: 2 } });
    const manifest = await manifestFor(shop);
    const r = rig;
    await trustOneProxy(r);
    waiting(await new FakeSystem(r.app, 'a', manifest).from('10.0.0.1').connect());
    waiting(await new FakeSystem(r.app, 'b', manifest).from('10.0.0.2').connect());
    expect(await refusal(new FakeSystem(r.app, 'c', manifest).from('10.0.0.3').connect())).toEqual({ status: 429, code: 'PAIRING_LIMITED' });
  });

  it('collapses repeated requests for one name from one address into one, so admins are told once', async () => {
    const { rig: r, system, manifest } = await start();
    await trustOneProxy(r);
    const first = waiting(await system.from('10.3.3.3').connect());
    const again = new FakeSystem(r.app, 'shop', manifest).from('10.3.3.3');
    const second = waiting(await again.connect());
    expect(second.pairing).toBe(first.pairing);
    expect(second.code).not.toBe(first.code);
    const pending = await r.pairing.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.keyFingerprint).toBe(fingerprint(again.keys.publicKey));
    // only the newest socket speaks for the request now
    expect(await refusal(system.sdk.call('pairingInfo', { pairing: first.pairing, description: 'old', instance: MAIN_INSTANCE }))).toEqual({ status: 403, code: 'NOT_YOUR_PAIRING' });
    expect(new Set(r.bus.of('pairing').map((e) => e.pairing.id))).toEqual(new Set([first.pairing]));
    // another address asking for the same name is its own request
    const elsewhere = waiting(await new FakeSystem(r.app, 'shop', manifest).from('10.4.4.4').connect());
    expect(elsewhere.pairing).not.toBe(first.pairing);
    // and so is another instance from the same address (a fleet's copies on one machine), which keeps the first's
    const laptop = Object.assign(new FakeSystem(r.app, 'shop', manifest).from('10.3.3.3'), { instance: InstanceName.parse('laptop') });
    const third = waiting(await laptop.connect());
    expect(third.pairing).not.toBe(first.pairing);
    expect((await r.pairing.get(first.pairing)).keyFingerprint).toBe(fingerprint(again.keys.publicKey));
  });
});

describe('what a waiting system says about itself', () => {
  it('keeps it on the request and announces it, from the socket that started the pairing only', async () => {
    const { rig: r, system, manifest } = await start();
    const reply = waiting(await system.connect());
    await system.sdk.call('pairingInfo', { pairing: reply.pairing, description: 'My laptop', instance: InstanceName.parse('laptop'), configType: SHOP_CONFIG });
    expect(await r.pairing.get(reply.pairing)).toMatchObject({ description: 'My laptop', instance: 'laptop', configType: SHOP_CONFIG, status: 'pending' });
    expect(r.bus.of('pairing').at(-1)).toMatchObject({ pairing: { description: 'My laptop' } });

    const stranger = new FakeSystem(r.app, 'shop', manifest);
    stranger.open();
    expect(await refusal(stranger.sdk.call('pairingInfo', { pairing: reply.pairing, description: 'not me', instance: MAIN_INSTANCE }))).toEqual({ status: 403, code: 'NOT_YOUR_PAIRING' });
    expect(await refusal(r.pairing.get(PairingId.parse('par_nope')))).toEqual({ status: 404, code: 'NO_PAIRING' });
  });

  it('shows an expired request as expired', async () => {
    const { rig: r, system } = await start();
    const reply = waiting(await system.connect());
    r.time.now += 61_000;
    expect((await r.pairing.get(reply.pairing)).status).toBe('expired');
  });
});

describe('approving with config and an instance name', () => {
  it('refuses a config that does not fit and pairs nothing', async () => {
    const { rig: r, system } = await start();
    const reply = waiting(await system.connect());
    await system.sdk.call('pairingInfo', { pairing: reply.pairing, description: 'shop', instance: MAIN_INSTANCE, configType: SHOP_CONFIG });
    expect(await refusal(r.pairing.approve(reply.pairing, ADMIN, { config: { currency: 'yen' } }))).toEqual({ status: 422, code: 'BAD_CONFIG' });
    expect(await r.instances.of(SHOP)).toEqual([]);
    expect((await r.pairing.get(reply.pairing)).status).toBe('pending');
  });

  it('refuses a config that names a stored secret ({ $secret }), revealing nothing and pairing nothing', async () => {
    const { rig: r, system } = await start();
    const reply = waiting(await system.connect());
    await system.sdk.call('pairingInfo', { pairing: reply.pairing, description: 'shop', instance: MAIN_INSTANCE, configType: SHOP_CONFIG });
    const other = await r.vault.store({ name: 'provider:openrouter', owner: ADMIN, value: 'not-for-shop' });
    expect(await refusal(r.pairing.approve(reply.pairing, ADMIN, { config: { currency: { $secret: other } } }))).toEqual({ status: 422, code: 'BAD_CONFIG' });
    expect(await r.instances.of(SHOP)).toEqual([]);
    expect((await r.pairing.get(reply.pairing)).status).toBe('pending');
  });

  it('refuses a config when the system never said what its config is', async () => {
    const { rig: r, system } = await start();
    const reply = waiting(await system.connect());
    expect(await refusal(r.pairing.approve(reply.pairing, ADMIN, { config: { currency: 'EUR' } }))).toEqual({ status: 422, code: 'BAD_CONFIG' });
  });

  it('pairs under the chosen name with the config set, so the first welcome carries it and the system is usable at once', async () => {
    const { rig: r, system, manifest } = await start();
    const reply = waiting(await system.connect());
    await system.sdk.call('pairingInfo', { pairing: reply.pairing, description: 'shop', instance: MAIN_INSTANCE, configType: SHOP_CONFIG });
    const paired = await r.pairing.approve(reply.pairing, ADMIN, { instance: InstanceName.parse('front'), config: { currency: 'EUR' } });
    expect(paired).toMatchObject({ system: 'shop', instance: 'front', config: { value: { currency: 'EUR' }, version: 1, setBy: ADMIN } });
    expect(await r.pairing.get(reply.pairing)).toMatchObject({ status: 'approved', instance: 'front' });
    await settle(5);
    expect(system.paired).toEqual([reply.pairing]);

    // the system still asks to be main; its key says it is front
    const welcome = await system.connect();
    expect(welcome).toMatchObject({ instance: 'front', config: { value: { currency: 'EUR' }, version: 1 }, sendManifest: true });
    await system.sdk.call('manifest', manifest);
    await settle(5);
    expect((await r.instances.get({ system: SHOP, instance: InstanceName.parse('front') }))?.status).toBe('connected');
    expect((await r.store.table('systems').get(SHOP))?.status).toBe('connected');
  });

  it('checks a config against the contract the hub has, over what a waiting system said', async () => {
    const { rig: r, system, manifest } = await start();
    await r.catalog.importManifest(manifest);
    const reply = waiting(await system.connect());
    await system.sdk.call('pairingInfo', { pairing: reply.pairing, description: 'shop', instance: MAIN_INSTANCE, configType: wireType(g.obj({})) });
    expect(await refusal(r.pairing.approve(reply.pairing, ADMIN, { config: {} }))).toEqual({ status: 422, code: 'BAD_CONFIG' });
  });

  it('pairs a second instance of a known system beside the first', async () => {
    const { rig: r, system, manifest } = await start();
    waiting(await system.connect());
    const [first] = await r.pairing.pending();
    if (first === undefined) { throw new Error('no pairing'); }
    await r.pairing.approve(first.id, ADMIN);
    const desk = new FakeSystem(r.app, 'shop', manifest);
    desk.instance = InstanceName.parse('desk');
    const second = waiting(await desk.connect());
    expect((await r.pairing.get(second.pairing)).replaces).toBeUndefined();
    await r.pairing.approve(second.pairing, ADMIN);
    expect((await r.instances.of(SHOP)).map((i) => i.instance)).toEqual(['desk', 'main']);
  });

  it('refuses renaming a new machine onto another paired instance, which would hand it that key', async () => {
    const { rig: r, system, manifest } = await start();
    waiting(await system.connect());
    const [first] = await r.pairing.pending();
    if (first === undefined) { throw new Error('no pairing'); }
    const main = await r.pairing.approve(first.id, ADMIN);
    const desk = new FakeSystem(r.app, 'shop', manifest);
    desk.instance = InstanceName.parse('desk');
    const second = waiting(await desk.connect());
    expect(await refusal(r.pairing.approve(second.pairing, ADMIN, { instance: MAIN_INSTANCE }))).toEqual({ status: 409, code: 'INSTANCE_TAKEN' });
    expect((await r.instances.get({ system: SHOP, instance: MAIN_INSTANCE }))?.keyFingerprint).toBe(main.keyFingerprint);
    expect((await r.pairing.get(second.pairing)).status).toBe('pending');
  });

  it('refuses a waiting machine that renames itself onto a paired instance, as a code never replaces a key', async () => {
    const { rig: r, system, manifest } = await start();
    waiting(await system.connect());
    const [first] = await r.pairing.pending();
    if (first === undefined) { throw new Error('no pairing'); }
    await r.pairing.approve(first.id, ADMIN);
    const laptop = new FakeSystem(r.app, 'shop', manifest);
    laptop.instance = InstanceName.parse('laptop2');
    const second = waiting(await laptop.connect());
    expect(await refusal(laptop.sdk.call('pairingInfo', { pairing: second.pairing, description: 'laptop', instance: MAIN_INSTANCE }))).toEqual({ status: 403, code: 'REKEY_NEEDS_TOKEN' });
    expect(await r.pairing.get(second.pairing)).toMatchObject({ instance: 'laptop2' });
    expect((await r.pairing.get(second.pairing)).replaces).toBeUndefined();
    await laptop.sdk.call('pairingInfo', { pairing: second.pairing, description: 'laptop', instance: InstanceName.parse('laptop3') });
    expect(await r.pairing.get(second.pairing)).toMatchObject({ instance: 'laptop3', description: 'laptop' });
  });

  it('refuses approving a code request saved as replacing a key', async () => {
    const { rig: r, system } = await start();
    const reply = waiting(await system.connect());
    const saved = await r.pairing.get(reply.pairing);
    await r.store.table('pairings').put({ ...saved, replaces: SHOP });
    expect(await refusal(r.pairing.approve(reply.pairing, ADMIN))).toEqual({ status: 403, code: 'REKEY_NEEDS_TOKEN' });
    expect(await r.instances.get({ system: SHOP, instance: MAIN_INSTANCE })).toBeUndefined();
  });
});

describe('pairing limits over IPv6', () => {
  it('counts every address of one /64 together, so changing address gets no more tries', async () => {
    const limits = new PairingLimits({ perAddress: 2, total: 100, window: 60_000, clock: () => 1_000, log: memoryLog().log });
    await limits.check('2001:db8:1:2::a', SHOP);
    await limits.check('2001:db8:1:2::b', SHOP);
    await expect(limits.check('2001:db8:1:2:ffff::c', SHOP)).rejects.toMatchObject({ status: 429 });
    await expect(limits.check('2001:db8:1:3::1', SHOP)).resolves.toBeUndefined();
  });
});
