import { describe, expect, it } from 'vitest';
import { hubCatalog } from './catalog.ts';
import { FakeHub } from './testing.ts';

describe('hubCatalog', () => {
  it('asks the hub by exact name, a hundred names per call, and never lists the whole catalog', async () => {
    const asked: { fns: number[]; contexts: number[] } = { fns: [], contexts: [] };
    const hub = new FakeHub({
      fns: (body) => {
        const filter = body.filters?.[0];
        expect(filter).toMatchObject({ field: 'name', op: 'in' });
        asked.fns.push(body.limit ?? 0);
        return { items: [] };
      },
      contexts: (body) => {
        expect(body.query?.filters?.[0]).toMatchObject({ field: 'name', op: 'in' });
        asked.contexts.push(body.query?.limit ?? 0);
        return { items: [] };
      },
    });
    const fns = Array.from({ length: 150 }, (_, at) => `notes/fn_${at}`);
    expect(await hubCatalog(hub).existing({ fns, context: ['notes/guide'] })).toEqual({ fns: [], context: [] });
    expect(asked).toEqual({ fns: [100, 50], contexts: [1] });
    expect(await hubCatalog(hub).existing({ fns: [], context: [] })).toEqual({ fns: [], context: [] });
    expect(hub.called).toEqual(['fns', 'fns', 'contexts']);
  });
});
