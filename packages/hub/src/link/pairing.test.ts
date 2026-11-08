import { ApiError } from '@ayepi/core';
import { InstanceName, MAIN_INSTANCE, PairingId, SystemName, type HelloReply, type Manifest } from '@harness/core';
import { wireType, g } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, manifestFor, shop } from '../catalog/fixtures.ts';
import { settle } from '../testing.ts';
import { FakeSystem, linkRig, type LinkRig } from './rig.ts';

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

  it('says a waiting machine that renames itself onto a paired instance replaces it, and clears that when it renames away', async () => {
    const { rig: r, system, manifest } = await start();
    waiting(await system.connect());
    const [first] = await r.pairing.pending();
    if (first === undefined) { throw new Error('no pairing'); }
    await r.pairing.approve(first.id, ADMIN);
    const laptop = new FakeSystem(r.app, 'shop', manifest);
    laptop.instance = InstanceName.parse('laptop2');
    const second = waiting(await laptop.connect());
    expect((await r.pairing.get(second.pairing)).replaces).toBeUndefined();
    await laptop.sdk.call('pairingInfo', { pairing: second.pairing, description: 'laptop', instance: MAIN_INSTANCE });
    expect((await r.pairing.get(second.pairing)).replaces).toBe(SHOP);
    await laptop.sdk.call('pairingInfo', { pairing: second.pairing, description: 'laptop', instance: InstanceName.parse('laptop2') });
    expect((await r.pairing.get(second.pairing)).replaces).toBeUndefined();
  });
});
