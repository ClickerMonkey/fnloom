import { ActorId, linkTargetKey, seesOrigin, SessionId, type ContextOrigin, type MemoryScope } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { removeLinksFrom, writeDerivedLinks } from './graph.ts';
import { decayedUses, DERIVED_WEIGHTS, LEARNED_MAX, learnedWeight, linksOf } from './links.ts';
import { contextorRig, contextRecord } from './testing.ts';

const DAY = 86_400_000;

describe('links of a record', () => {
  it('map every field to its relation and weight', () => {
    const record = contextRecord('fs/skill', {
      imports: ['fs/guide'], fns: ['fs/read'], suggestFns: ['fs/grep'], parent: 'fs/root', next: 'fs/skill-2',
      links: [{ to: { kind: 'resource', uri: 'file:///a.md' }, relation: 'about', weight: 0.9 }, { to: { kind: 'type', name: 'fs/Entry' }, relation: 'related', weight: 0.3 }],
      mentions: { context: ['fs/other'], fns: ['fs/bash'] },
    });
    const edges = linksOf(record, 5).map((e) => [e.relation, e.toKey, e.weight, e.source]);
    expect(edges).toEqual([
      ['imports', 'context:fs/guide', DERIVED_WEIGHTS.imports, 'declared'],
      ['brings', 'fn:fs/read', DERIVED_WEIGHTS.brings, 'declared'],
      ['suggests', 'fn:fs/grep', DERIVED_WEIGHTS.suggests, 'declared'],
      ['parent', 'context:fs/root', DERIVED_WEIGHTS.parent, 'declared'],
      ['next', 'context:fs/skill-2', DERIVED_WEIGHTS.next, 'declared'],
      ['about', 'resource:file:///a.md', 0.9, 'declared'],
      ['related', 'type:fs/Entry', 0.3, 'declared'],
      ['mentions', 'context:fs/other', DERIVED_WEIGHTS.mentions, 'mentioned'],
      ['mentions', 'fn:fs/bash', DERIVED_WEIGHTS.mentions, 'mentioned'],
    ]);
  });

  it('keep one edge per key, the strongest, and never one to the item itself', () => {
    const record = contextRecord('fs/a', { fns: ['fs/read'], links: [{ to: { kind: 'fn', name: 'fs/read' }, relation: 'brings', weight: 0.2 }, { to: { kind: 'context', name: 'fs/a' }, relation: 'related', weight: 1 }] });
    expect(linksOf(record, 0).map((e) => [e.relation, e.weight])).toEqual([['brings', 1]]);
  });

  it('learned weights follow 0.6(1 − e^(−n/4)) and decay by half each half-life', () => {
    expect(learnedWeight(0)).toBe(0);
    expect(learnedWeight(4)).toBeCloseTo(LEARNED_MAX * (1 - Math.exp(-1)));
    expect(learnedWeight(1_000)).toBeLessThanOrEqual(LEARNED_MAX);
    expect(decayedUses(8, 30 * DAY, 30 * DAY)).toBeCloseTo(4);
    expect(decayedUses(8, 0, 30 * DAY)).toBe(8);
  });
});

describe('the context graph', () => {
  it('rewrites exactly a record\'s derived edges and keeps the others', async () => {
    const r = await contextorRig();
    await r.graph.author({ from: 'fs/a', to: { kind: 'fn', name: 'fs/write' }, relation: 'related', weight: 0.7, by: 'act_alice' });
    await r.graph.derive(contextRecord('fs/a', { fns: ['fs/read'], imports: ['fs/b'] }));
    expect((await r.graph.links('fs/a')).map((e) => e.toKey).sort()).toEqual(['context:fs/b', 'fn:fs/read', 'fn:fs/write']);
    await writeDerivedLinks(r.store, contextRecord('fs/a', { fns: ['fs/grep'] }), 9);
    const after = await r.graph.links('fs/a');
    expect(after.map((e) => [e.toKey, e.source]).sort()).toEqual([['fn:fs/grep', 'declared'], ['fn:fs/write', 'authored']]);
    expect(after.find((e) => e.source === 'authored')?.by).toBe('act_alice');
    expect((await r.graph.backlinks({ kind: 'fn', name: 'fs/grep' })).map((e) => e.from)).toEqual(['fs/a']);
    await removeLinksFrom(r.store, 'fs/a');
    expect(await r.graph.links('fs/a')).toEqual([]);
  });

  it('replaces an item\'s resource edges wholesale', async () => {
    const r = await contextorRig();
    await r.graph.replaceResourceLinks('resource/a', [{ to: { kind: 'resource', uri: 'file:///a.md' }, relation: 'about', weight: 1 }]);
    await r.graph.replaceResourceLinks('resource/a', [{ to: { kind: 'context', name: 'resource/b' }, relation: 'next', weight: 0.6 }]);
    expect((await r.graph.links('resource/a')).map((e) => [e.toKey, e.source])).toEqual([['context:resource/b', 'resource']]);
  });

  it('learns co-use, and reads learned weights decayed', async () => {
    const r = await contextorRig();
    r.catalog.addContext(contextRecord('fs/guide'));
    r.catalog.addFn('fs/read');
    await r.graph.learn(['fs/read', 'fs/guide', 'fs/read']);
    await r.graph.learn(['fs/read', 'fs/guide']);
    const [edge] = await r.graph.links('fs/guide');
    expect(edge?.to).toEqual({ kind: 'fn', name: 'fs/read' });
    expect(edge?.uses).toBe(2);
    expect(edge?.weight).toBeCloseTo(learnedWeight(2));
    r.time.now += 30 * DAY;
    expect((await r.graph.links('fs/guide'))[0]?.weight).toBeCloseTo(learnedWeight(1));
    await r.graph.learn(['fs/guide']);
    expect(await r.graph.links('fs/read')).toEqual([]);
  });

  it('finds neighbours both ways with the strongest path weight', async () => {
    const r = await contextorRig();
    await r.graph.derive(contextRecord('fs/skill', { fns: ['fs/read'], suggestFns: ['fs/grep'] }));
    await r.graph.derive(contextRecord('fs/other', { imports: ['fs/skill'] }));
    const near = await r.graph.neighbours(['fs/skill'], 1, 10);
    expect([...near]).toEqual([['fs/other', 1], ['fs/read', 1], ['fs/grep', 0.5]]);
    expect((await r.graph.neighbours(['fs/other'], 2, 10)).get('fs/read')).toBe(1);
    expect((await r.graph.neighbours(['fs/skill'], 1, 1)).size).toBe(1);
    const removed = await r.graph.remove({ from: 'fs/skill', toKey: linkTargetKey({ kind: 'fn', name: 'fs/read' }), relation: 'brings' });
    expect(removed).toBe(true);
  });
});

describe('who sees a context item', () => {
  const alice = ActorId.parse('act_alice');
  const bob = ActorId.parse('act_bob');
  const here = SessionId.parse('ses_here');
  const memory = (scope: MemoryScope): ContextOrigin => ({ type: 'memory', scope, author: bob });

  it('sees every item that is not memory, and memory only in its scope or as its author', () => {
    expect(seesOrigin(undefined, { actor: alice })).toBe(true);
    expect(seesOrigin({ type: 'system' }, { actor: alice })).toBe(true);
    expect(seesOrigin(memory({ to: 'everyone' }), { actor: alice })).toBe(true);
    expect(seesOrigin(memory({ to: 'user', user: alice }), { actor: alice })).toBe(true);
    expect(seesOrigin(memory({ to: 'user', user: bob }), { actor: alice })).toBe(false);
    expect(seesOrigin(memory({ to: 'session', session: here }), { actor: alice, session: here })).toBe(true);
    expect(seesOrigin(memory({ to: 'session', session: here }), { actor: alice })).toBe(false);
    expect(seesOrigin(memory({ to: 'session', session: here }), { actor: bob })).toBe(true);
  });
});
