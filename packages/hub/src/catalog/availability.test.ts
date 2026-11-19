import { fn, g } from '@harness/sdk';
import { ActorId, KindRecord, SystemName, type FnRecord, type QualifiedName, type SystemRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { TestCatalog } from '../execution/testing.ts';
import { AvailabilityRules, roleUnsetDetail, systemAvailability } from './availability.ts';

const SHOP = SystemName.parse('shop');

function system(fields: Partial<SystemRecord> = {}): SystemRecord {
  return {
    name: SHOP, description: 'A shop.', status: 'connected', enabled: { functions: true, renderers: true }, version: '1',
    manifestHash: 'h', actor: ActorId.parse('act_shop'), ...fields,
  };
}

/** Shop fns whose deps are the given local names. */
function fns(deps: Record<string, readonly string[]>): Map<string, FnRecord> {
  const catalog = new TestCatalog();
  const out = new Map<string, FnRecord>();
  for (const [name, on] of Object.entries(deps)) {
    const record = catalog.add('shop', name, fn({ description: name, args: g.obj({}), returns: g.bool() }));
    out.set(record.name, { ...record, decl: { ...record.decl, deps: on.map((d): QualifiedName => `shop/${d}`) } });
  }
  return out;
}

describe('availability rules', () => {
  it('says a system waiting to be paired is not usable yet', () => {
    expect(systemAvailability(SHOP, system({ status: 'pairing' }))).toEqual({ unavailable: 'system-disconnected', detail: 'shop is waiting to be paired' });
  });

  it('offers nothing of an installed system, unless the stage is set aside (kinds described, test calls)', () => {
    expect(systemAvailability(SHOP, system({ stage: 'installed' }))).toEqual({ unavailable: 'held', detail: 'shop is installed and waits for an admin to review it and go live' });
    expect(systemAvailability(SHOP, system({ stage: 'installed' }), { staged: false })).toBe(true);
    expect(systemAvailability(SHOP, system({ stage: 'live' }))).toBe(true);
  });

  it('holds a fn waiting for review, and takes the fns of a switched-off kind with it', () => {
    const records = fns({ order: [], list: [] });
    const order = records.get('shop/order');
    if (order === undefined) { throw new Error('no order'); }
    records.set('shop/order', { ...order, decl: { ...order.decl, kind: 'shop/report' } });
    const report: KindRecord = KindRecord.parse({ name: 'shop/report', system: SHOP, decl: { name: 'report', description: 'r', applicability: 'a', payload: { name: 'text' }, approveChanges: false } });
    const kinds = new Map([[report.name, report]]);
    const rules = new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds, fns: records, held: new Set(['shop/list']), kindsOff: new Set(['shop/report']) });
    expect(rules.fn('shop/list')).toEqual({ unavailable: 'held', detail: 'shop/list changed and waits for an admin to approve it' });
    expect(rules.fn('shop/order')).toEqual({ unavailable: 'disabled', detail: 'its kind shop/report is switched off' });
  });

  it('keeps a fn that needs an unset model role off, with the role named, and the fns that depend on it (plan item 7)', () => {
    const records = fns({ crawl: [], plan: ['crawl'], read: [] });
    const crawl = records.get('shop/crawl');
    if (crawl === undefined) { throw new Error('no crawl'); }
    records.set('shop/crawl', { ...crawl, decl: { ...crawl.decl, roles: ['decide'] } });
    const unset = new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds: new Map(), fns: records, rolesUnset: new Set(['decide']) });
    expect(unset.fn('shop/crawl')).toEqual({ unavailable: 'role-unset', detail: roleUnsetDetail('shop/crawl', 'decide') });
    expect(unset.fn('shop/plan')).toMatchObject({ unavailable: 'dep-unavailable' });
    expect(unset.fn('shop/read')).toBe(true);
    expect(new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds: new Map(), fns: records, rolesUnset: new Set(['ocr']) }).fn('shop/crawl')).toBe(true);
  });

  it('makes a fn whose dep does not exist unavailable, naming the dep', () => {
    const rules = new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds: new Map(), fns: fns({ order: ['missing'] }) });
    expect(rules.fn('shop/order')).toEqual({ unavailable: 'dep-unavailable', detail: 'shop/missing: shop/missing does not exist' });
  });

  it('counts a dep cycle as available as far as the cycle goes, and still follows deps out of it', () => {
    const cycle = new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds: new Map(), fns: fns({ a: ['b'], b: ['a'] }) });
    expect(cycle.fn('shop/a')).toBe(true);
    expect(cycle.fn('shop/b')).toBe(true);
    const broken = new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds: new Map(), fns: fns({ a: ['b'], b: ['a', 'gone'] }) });
    expect(broken.fn('shop/a')).toMatchObject({ unavailable: 'dep-unavailable' });
    expect(broken.fn('shop/b')).toMatchObject({ unavailable: 'dep-unavailable' });
  });

  it('gives every member of a broken cycle the same answer whichever fn is asked first', () => {
    const make = (): AvailabilityRules => new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds: new Map(), fns: fns({ a: ['b', 'gone'], b: ['a'], c: ['b'] }) });
    const aFirst = make();
    const fromA = [aFirst.fn('shop/a'), aFirst.fn('shop/b'), aFirst.fn('shop/c')];
    const bFirst = make();
    const fromB = [bFirst.fn('shop/b'), bFirst.fn('shop/c'), bFirst.fn('shop/a')];
    expect(fromA).toEqual([
      { unavailable: 'dep-unavailable', detail: 'shop/gone: shop/gone does not exist' },
      { unavailable: 'dep-unavailable', detail: 'shop/a: shop/gone: shop/gone does not exist' },
      { unavailable: 'dep-unavailable', detail: 'shop/b: shop/a: shop/gone: shop/gone does not exist' },
    ]);
    expect([fromB[2], fromB[0], fromB[1]]).toEqual(fromA);
  });

  it('makes a cycle unavailable when one member is paused, and leaves fns outside it alone', () => {
    const all = fns({ a: ['b'], b: ['a'], free: [] });
    const b = all.get('shop/b');
    if (b === undefined) { throw new Error('missing fixture'); }
    all.set('shop/b', { ...b, paused: true });
    const rules = new AvailabilityRules({ systems: new Map([['shop', system()]]), kinds: new Map(), fns: all });
    expect(rules.fn('shop/a')).toEqual({ unavailable: 'dep-unavailable', detail: 'shop/b: shop/b is paused' });
    expect(rules.fn('shop/b')).toEqual({ unavailable: 'paused', detail: 'shop/b is paused' });
    expect(rules.fn('shop/free')).toBe(true);
  });
});
