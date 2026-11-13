/** Build 5 on the system side: types and fns a fleet instance owns, fn routing, and secret config fields. */
import { InstanceName, isJsonObject, MAIN_INSTANCE, SECRET_KEPT, SealedConfigSecret, SystemName, type Manifest, type TypeDecl } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, instanceRow, manifestFor, shop, systemRow } from '../catalog/fixtures.ts';
import { fromInstance } from '../catalog/catalog.ts';
import { ConfigSecretKeeper, maskSecrets, valueAt, withValueAt } from './config-secrets.ts';
import { linkRig, type LinkRig } from './rig.ts';

const SHOP = SystemName.parse('shop');
const LAPTOP = InstanceName.parse('laptop');
const DESK = InstanceName.parse('desk');

let rig: LinkRig;
let base: Manifest;
beforeEach(async () => {
  rig = await linkRig();
  base = await manifestFor(shop);
});
afterEach(() => rig.stop());

/** The shop manifest with a table type and a query fn owned by one instance. */
function owned(instance: InstanceName, description = 'Orders table.'): Manifest {
  const product = base.types.find((t) => t.name === 'Product');
  const get = base.fns.find((f) => f.name === 'get');
  if (product === undefined || get === undefined) throw new Error('fixture changed');
  const table: TypeDecl = { ...product, name: `${instance}.Orders`, description, instance };
  return { ...base, types: [...base.types, table], fns: [...base.fns, { ...get, name: `${instance}.count`, routing: { to: 'instance', instance } }] };
}

describe('entries a fleet instance owns', () => {
  it('keeps another instance’s types and fns whatever a manifest or patch says, and drops them when it goes', async () => {
    await rig.catalog.importManifest(owned(LAPTOP), LAPTOP);
    expect(await rig.catalog.type('shop/laptop.Orders')).toBeDefined();
    // desk's manifest leaves laptop's out and tries to change one: neither counts
    const desk = owned(DESK);
    const claim = owned(LAPTOP, 'Changed.').types.filter((t) => t.instance === LAPTOP);
    const report = await rig.catalog.importManifest({ ...desk, types: [...desk.types, ...claim] }, DESK);
    expect(report.removed).toEqual([]);
    expect((await rig.catalog.type('shop/laptop.Orders'))?.description).toBe('Orders table.');
    expect(await rig.catalog.fn('shop/laptop.count')).toBeDefined();
    expect(await rig.catalog.fn('shop/desk.count')).toBeDefined();
    // a patch from desk can't remove laptop's fn
    await rig.catalog.importPatch(SHOP, { hash: 'h2', upsert: {}, remove: { fns: ['laptop.count'] } }, DESK);
    expect(await rig.catalog.fn('shop/laptop.count')).toBeDefined();
    const forgotten = await rig.catalog.forgetInstance(SHOP, LAPTOP);
    expect(forgotten.removed.sort()).toEqual(['shop/laptop.Orders', 'shop/laptop.count']);
    expect(await rig.catalog.fn('shop/desk.count')).toBeDefined();
  });

  it('joins a sent manifest with the others’ entries, ignoring claims on them', () => {
    const before = owned(LAPTOP);
    const joined = fromInstance(before, base, DESK);
    expect(joined.types.map((t) => t.name)).toEqual(['Product', 'laptop.Orders']);
    expect(fromInstance(undefined, owned(LAPTOP), DESK).fns.map((f) => f.name)).not.toContain('laptop.count');
  });
});

describe('fn routing', () => {
  it('sends an instance’s fn there even when away, and an `any` fn to the default without asking', async () => {
    await rig.store.table('systems').put(systemRow('shop', 'disconnected', { defaultInstance: DESK }));
    expect(await rig.router.route({ system: SHOP, args: {}, routing: { to: 'instance', instance: LAPTOP } })).toEqual({ instance: { system: SHOP, instance: LAPTOP } });
    expect(await rig.router.route({ system: SHOP, args: {}, routing: { to: 'any' } })).toEqual({ instance: { system: SHOP, instance: MAIN_INSTANCE } });
    // a forward to another instance (`on`) goes there, waiting for it, rather than to whichever is connected
    expect(await rig.router.route({ system: SHOP, args: {}, on: LAPTOP, routing: { to: 'any' } })).toEqual({ instance: { system: SHOP, instance: LAPTOP } });
  });
});

describe('secret config fields', () => {
  beforeEach(async () => {
    await rig.catalog.importManifest({ ...base, configSecrets: ['currency'] });
    await rig.store.table('systems').put(systemRow('shop', 'connected'));
    await rig.store.table('instances').put(instanceRow('shop', 'connected'));
  });

  /** The secret the stored config holds. */
  async function storedSecret(): Promise<string> {
    const value = (await rig.instances.get({ system: SHOP, instance: MAIN_INSTANCE }))?.config?.value;
    return SealedConfigSecret.parse(isJsonObject(value) ? value['currency'] : undefined).$secret;
  }

  it('stores a sealed secret, gives the system the plain value, keeps it on SECRET_KEPT and replaces it on change', async () => {
    expect(await rig.config.set(SHOP, { currency: 'USD' }, ADMIN)).toEqual({ version: 1 });
    const first = await storedSecret();
    expect(await rig.vault.reveal(first)).toBe('USD');
    expect(await rig.config.current(SHOP)).toEqual({ value: { currency: 'USD' }, version: 1 });
    await rig.config.set(SHOP, { currency: SECRET_KEPT }, ADMIN);
    expect(await storedSecret()).toBe(first);
    expect(await rig.config.current(SHOP)).toEqual({ value: { currency: 'USD' }, version: 2 });
    await rig.config.set(SHOP, { currency: 'EUR' }, ADMIN);
    expect(await storedSecret()).not.toBe(first);
    expect(await rig.vault.reveal(first)).toBeUndefined();
    expect(await rig.config.set(SHOP, { currency: 'EURO' }, ADMIN)).toHaveProperty('problems');
  });

  it('seals a record of text (environment or header values) whole, keeps it on SECRET_KEPT and reveals it as the record', async () => {
    const keeper = new ConfigSecretKeeper(() => rig.vault);
    const ref = { system: SHOP, instance: MAIN_INSTANCE };
    const env = { GITHUB_TOKEN: 'ghp_1', OTHER: 'x' };
    const first = await keeper.seal(ref, { label: 'GitHub', transport: { env } }, undefined, ['transport.env'], ADMIN);
    expect(first.plain).toEqual({ label: 'GitHub', transport: { env } });
    const sealed = SealedConfigSecret.parse(valueAt(first.sealed, 'transport.env'));
    expect(sealed.json).toBe(true);
    expect(JSON.stringify(first.sealed)).not.toContain('ghp_1');
    expect(maskSecrets(first.sealed)).toEqual({ label: 'GitHub', transport: { env: SECRET_KEPT } });
    expect(await keeper.unseal(first.sealed)).toEqual({ label: 'GitHub', transport: { env } });
    const kept = await keeper.seal(ref, { label: 'GitHub', transport: { env: SECRET_KEPT } }, first.sealed, ['transport.env'], ADMIN);
    expect(kept.plain).toEqual({ label: 'GitHub', transport: { env } });
    expect(valueAt(kept.sealed, 'transport.env')).toEqual(valueAt(first.sealed, 'transport.env'));
    const changed = await keeper.seal(ref, { label: 'GitHub', transport: { env: { GITHUB_TOKEN: 'ghp_2' } } }, first.sealed, ['transport.env'], ADMIN);
    await changed.release();
    expect(await rig.vault.reveal(sealed.$secret)).toBeUndefined();
    expect(await keeper.unseal(changed.sealed)).toEqual({ label: 'GitHub', transport: { env: { GITHUB_TOKEN: 'ghp_2' } } });
  });

  it('shows the web app SECRET_KEPT, and reads and writes dot paths', () => {
    expect(maskSecrets({ a: { $secret: 'sec_1' }, b: [{ $secret: 'sec_2' }], c: 1 })).toEqual({ a: SECRET_KEPT, b: [SECRET_KEPT], c: 1 });
    expect(valueAt({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(withValueAt({ a: { b: 2, c: 3 } }, 'a.b', undefined)).toEqual({ a: { c: 3 } });
    expect(withValueAt({}, 'a.b', 1)).toEqual({ a: { b: 1 } });
  });
});
