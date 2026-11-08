/** Listing a live contract for the guide: signatures in gin code, shortened when long, and empty sections left out. */
import { fn, g, hub, kind, mention, system, type } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { briefType, contractListing } from './contract-listing.ts';

const Wide = g.obj(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, g.optional(g.text({ minLength: 1 }))])));

const tiny = system('listing-fixture', { description: 'A fixture.' }).with({
  types: { Item: type({ description: 'An item.', shape: g.obj({ id: g.text() }), display: { label: 'Item', title: 'id' } }) },
  kinds: { macro: kind({ description: 'A macro.', applicability: 'For macros.', payload: g.obj({ steps: g.list(g.text()) }) }) },
  fns: {
    ping: fn({ description: 'Ping.', args: g.obj({ times: g.optional(g.num()) }), returns: g.literal('pong'), tags: ['read'] }),
    dump: fn({ description: 'Everything.', args: g.obj({}), returns: g.list(Wide) }),
  },
  mentions: { items: mention({ title: 'Items', description: 'Any item.', target: g.obj({ id: g.text() }) }) },
});

describe('briefType', () => {
  it('keeps a short type whole', () => {
    expect(briefType(g.obj({ id: g.text() }))).toBe(g.obj({ id: g.text() }).toCode());
  });

  it('shortens a long object to its field names, optional ones marked, and a list to its item', () => {
    expect(briefType(Wide, 100)).toMatch(/^obj\{ field0\?, field1\?, .* … \}$/);
    expect(briefType(g.list(Wide), 100)).toMatch(/^list<obj\{ field0\?, /);
  });
});

describe('contractListing', () => {
  const text = contractListing(tiny);

  it('lists fns with their qualified names, tags and signatures', () => {
    expect(text).toContain('#### Fns of `listing-fixture`');
    expect(text).toContain('- `listing-fixture/ping`: Ping. Tags: `read`.');
    expect(text).toContain(`(${g.obj({ times: g.optional(g.num()) }).toCode()}) => ${g.literal('pong').toCode()}`);
    expect(text).toContain('obj{ field0?, ');
  });

  it('lists kinds, types and mentions, and leaves out empty sections', () => {
    expect(text).toContain('- `listing-fixture/macro`: A macro. For macros.');
    expect(text).toContain('- `listing-fixture/Item`: An item.');
    expect(text).toContain('- `listing-fixture/items` (Items): Any item.');
    expect(text).not.toContain('Sectioners of');
  });

  it('lists the hub contract, every fn of it', () => {
    const listing = contractListing(hub);
    for (const name of Object.keys(hub.defs.fns)) { expect(listing).toContain(`\`hub/${name}\``); }
    expect(listing).toContain('#### Sectioners of `hub`');
  });
});
