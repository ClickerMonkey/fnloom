import { fn, g } from '@harness/sdk';
import { ActorId, SystemName, type FnRecord, type QualifiedName, type SystemRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { TestCatalog } from '../execution/testing.ts';
import { AvailabilityRules, systemAvailability } from './availability.ts';

const SHOP = SystemName.parse('shop');

function system(fields: Partial<SystemRecord> = {}): SystemRecord {
  return {
    name: SHOP, description: 'A shop.', status: 'connected', enabled: { functions: true, renderers: true }, keyFingerprint: 'fp', publicKey: 'k', version: '1',
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
