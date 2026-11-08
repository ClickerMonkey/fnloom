import { ApiError } from '@ayepi/core';
import { AutoPairId, MAIN_INSTANCE, SystemName, type Manifest, type Welcome } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, manifestFor, shop } from '../catalog/fixtures.ts';
import { settle } from '../testing.ts';
import { FakeSystem, linkRig, type LinkRig } from './rig.ts';

const SHOP = SystemName.parse('shop');
const ref = { system: SHOP, instance: MAIN_INSTANCE };
const DAY = 86_400_000;

/** The status and code an `ApiError` rejection carries. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) { return { status: error.status, code: error.code }; }
    throw error;
  }
  throw new Error('expected a rejection');
}

/** A welcome, or a failed test. */
function welcomed(reply: Awaited<ReturnType<FakeSystem['connect']>>): Welcome {
  if (!('limits' in reply)) { throw new Error('expected a welcome'); }
  return reply;
}

let rig: LinkRig;
let manifest: Manifest;
beforeEach(async () => {
  rig = await linkRig();
  manifest = await manifestFor(shop);
});
afterEach(() => rig.stop());

/** Pair `shop` with a code and auto pair, and return its first welcome's grant. */
async function pairWithAutoPair(expiresIn: number | null): Promise<{ system: FakeSystem; secret: string; id: string }> {
  const system = new FakeSystem(rig.app, 'shop', manifest);
  const reply = await system.connect();
  if ('limits' in reply) { throw new Error('expected pairing'); }
  await rig.pairing.approve(reply.pairing, ADMIN, { autoPair: { expiresIn } });
  await settle(5);
  const grant = welcomed(await system.connect()).autoPair;
  if (grant === undefined) { throw new Error('expected a grant'); }
  return { system, secret: grant.secret, id: grant.id };
}

/** The same instance after losing its key: a new key, bringing its secret. */
function rekeyed(proof: { id: string; secret: string }): FakeSystem {
  const system = new FakeSystem(rig.app, 'shop', manifest);
  system.autoPair = { id: AutoPairId.parse(proof.id), secret: proof.secret };
  return system;
}

describe('auto pair', () => {
  it('revokes the secrets of an instance that is removed, so only a new pairing brings it back', async () => {
    const { secret, id } = await pairWithAutoPair(90 * DAY);
    await rig.packages.removeInstance(ref, ADMIN);
    expect((await rig.store.table('autoPairSecrets').get(AutoPairId.parse(id)))?.revokedAt).toBeDefined();
    expect(await refusal(rekeyed({ id, secret }).connect())).toEqual({ status: 401, code: 'AUTO_PAIR_REFUSED' });
  });

  it('grants a secret once, keeps only its hash, and lists it without hashes', async () => {
    const { system, secret, id } = await pairWithAutoPair(90 * DAY);
    expect(welcomed(await system.connect()).autoPair).toBeUndefined();
    const row = await rig.store.table('autoPairSecrets').get(id);
    expect(row).toMatchObject({ system: 'shop', instance: 'main', uses: 0, expiresAt: rig.time.now + 90 * DAY, createdBy: ADMIN });
    expect(JSON.stringify(row)).not.toContain(secret);
    const views = await rig.autoPairs.list(SHOP);
    expect(views.map((v) => v.id)).toEqual([id]);
    expect(Object.keys(views[0] ?? {})).not.toContain('secretHash');
    expect(JSON.stringify(rig.records)).not.toContain(secret);
  });

  it('re-pairs a new key with the secret, rotates it, and keeps the previous good until the new one is used', async () => {
    const first = await pairWithAutoPair(null);
    const again = rekeyed(first);
    const welcome = welcomed(await again.connect());
    const rotated = welcome.autoPair;
    expect(rotated?.id).toBe(first.id);
    expect(rotated?.secret).not.toBe(first.secret);
    expect((await rig.instances.get(ref))?.publicKey).toBe(again.keys.publicKey);
    expect((await rig.store.table('autoPairSecrets').get(first.id))?.uses).toBe(1);

    // the welcome was lost: the old secret still works once more, and rotates again
    const lost = welcomed(await rekeyed(first).connect()).autoPair;
    if (lost === undefined) { throw new Error('expected a grant'); }
    // once the newest is used, the older ones are gone
    welcomed(await rekeyed(lost).connect());
    rig.time.now += 60_000; // past the rig's rate window (three attempts a minute)
    expect(await refusal(rekeyed(first).connect())).toEqual({ status: 401, code: 'AUTO_PAIR_REFUSED' });
    expect(JSON.stringify(rig.records)).not.toContain(first.secret);
  });

  it('refuses expired, revoked, wrong and other-system secrets alike, and rate limits attempts', async () => {
    const { secret, id } = await pairWithAutoPair(DAY);
    expect(await refusal(rekeyed({ id, secret: 'x'.repeat(43) }).connect())).toEqual({ status: 401, code: 'AUTO_PAIR_REFUSED' });
    const other = new FakeSystem(rig.app, 'other', manifest);
    other.autoPair = { id: AutoPairId.parse(id), secret };
    expect(await refusal(other.connect())).toMatchObject({ status: 401, code: 'AUTO_PAIR_REFUSED' });
    expect(await refusal(rekeyed({ id, secret: 'y'.repeat(43) }).connect())).toEqual({ status: 401, code: 'AUTO_PAIR_REFUSED' });
    // three attempts on this secret in the window (the rig's limit): even the right secret waits
    expect(await refusal(rekeyed({ id, secret }).connect())).toEqual({ status: 429, code: 'AUTO_PAIR_LIMITED' });
    rig.time.now += DAY;
    expect(await refusal(rekeyed({ id, secret }).connect())).toEqual({ status: 401, code: 'AUTO_PAIR_REFUSED' });
  });

  it('stops working once revoked, and a token can grant it too', async () => {
    const { token } = await rig.pairing.createToken({ name: SHOP, expiresIn: 30_000, autoPair: { expiresIn: null }, by: ADMIN });
    const system = new FakeSystem(rig.app, 'shop', manifest);
    expect('limits' in await system.connect(token)).toBe(false);
    await settle(5);
    const grant = welcomed(await system.connect()).autoPair;
    if (grant === undefined) { throw new Error('expected a grant'); }
    expect(await rig.autoPairs.revoke(grant.id, ADMIN)).toBe(true);
    expect(await rig.autoPairs.revoke(grant.id, ADMIN)).toBe(false);
    expect((await rig.autoPairs.list())[0]?.revokedAt).toBe(rig.time.now);
    expect(await refusal(rekeyed(grant).connect())).toEqual({ status: 401, code: 'AUTO_PAIR_REFUSED' });
  });

  it('hands a fresh secret to an instance that lost its grant, and drops the previous hash once the current is shown', async () => {
    const { system, id, secret } = await pairWithAutoPair(null);
    system.autoPair = undefined;
    const again = welcomed(await system.connect()).autoPair;
    expect(again?.id).toBe(id);
    expect(again?.secret).not.toBe(secret);
    expect(welcomed(await system.connect()).autoPair).toBeUndefined();

    const rekey = rekeyed({ id, secret: again?.secret ?? '' });
    welcomed(await rekey.connect());
    expect((await rig.store.table('autoPairSecrets').get(AutoPairId.parse(id)))?.previousHash).toBeDefined();
    welcomed(await rekey.connect());
    expect((await rig.store.table('autoPairSecrets').get(AutoPairId.parse(id)))?.previousHash).toBeUndefined();
    rig.time.now += 60_000;
    expect(await refusal(rekeyed({ id, secret: again?.secret ?? '' }).connect())).toEqual({ status: 401, code: 'AUTO_PAIR_REFUSED' });
  });

  it('lets only one of two sockets spend the same secret', async () => {
    const first = await pairWithAutoPair(null);
    const results = await Promise.allSettled([rekeyed(first).connect(), rekeyed(first).connect()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
