import { ContextorConfig, IDS, mintId, type CacheSupport, type ModelCall, type TurnId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { cacheMissOf } from './cache.ts';
import { chatWorld } from './testing.ts';

type World = Awaited<ReturnType<typeof chatWorld>>;

let counter = 0;

/** Store an agent's chat call of the world's session at `at`, reading `cached` tokens. */
async function call(w: World, turn: TurnId, at: number, cached: number, caching: CacheSupport = 'yes', extra: Partial<Pick<ModelCall, 'system' | 'purpose'>> = {}): Promise<ModelCall> {
  const row: ModelCall = {
    id: mintId('modelCall', () => String(++counter)), provider: 'p', model: 'm', run: IDS.run.parse(`run_${counter}`), turn, session: w.session.id, cost: 0, status: 'done',
    sent: 0, received: 0, queued: 0, startedAt: at, modality: 'chat', units: { modality: 'chat', input: 1_000, output: 10, cached, caching }, ...extra,
  };
  return w.store.table('modelCalls').insert(row);
}

const TURN_A = IDS.turn.parse('trn_a');
const TURN_B = IDS.turn.parse('trn_b');

describe('cache misses in full-history chat', () => {
  it('marks a reply whose first call read no cache after an earlier call did', async () => {
    const w = await chatWorld();
    await call(w, TURN_A, 100, 0);
    await call(w, TURN_A, 200, 900);
    const missed = await call(w, TURN_B, 1_000, 0);
    await call(w, TURN_B, 1_100, 950);
    expect(await cacheMissOf(w.deps, { session: w.session.id, turn: TURN_B, createdAt: 900 })).toEqual({ call: missed.id, at: 1_000 });
  });

  it('draws nothing when the call hit the cache, nothing earlier did, or the model is not known to cache', async () => {
    const w = await chatWorld();
    await call(w, TURN_A, 100, 0);
    // nothing earlier read the cache: the first reply of a chat always reads it in full
    await call(w, TURN_B, 1_000, 0);
    expect(await cacheMissOf(w.deps, { session: w.session.id, turn: TURN_B, createdAt: 900 })).toBeUndefined();
    const later = IDS.turn.parse('trn_c');
    await call(w, later, 2_000, 800);
    const unknown = IDS.turn.parse('trn_d');
    await call(w, unknown, 3_000, 0, 'unknown');
    expect(await cacheMissOf(w.deps, { session: w.session.id, turn: unknown, createdAt: 2_900 })).toBeUndefined();
    // a system's own call or the hub's work is not the reply's
    const other = IDS.turn.parse('trn_e');
    await call(w, other, 4_000, 0, 'yes', { purpose: 'suggestions' });
    expect(await cacheMissOf(w.deps, { session: w.session.id, turn: other, createdAt: 3_900 })).toBeUndefined();
  });

  it('draws nothing when the graph contextor picks what each prompt carries', async () => {
    const w = await chatWorld();
    await w.store.table('sessions').update(w.session.id, { contextor: ContextorConfig.parse({ type: 'graph' }) });
    await call(w, TURN_A, 100, 900);
    await call(w, TURN_B, 1_000, 0);
    expect(await cacheMissOf(w.deps, { session: w.session.id, turn: TURN_B, createdAt: 900 })).toBeUndefined();
  });
});
