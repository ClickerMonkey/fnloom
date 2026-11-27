import { describe, expect, it } from 'vitest';
import { SystemName } from '@harness/core';
import { goLiveIfInstalled, goLiveWhenPaired, type LiveApi } from './live.ts';

const refused = (status: number): Error => Object.assign(new Error(`refused ${status}`), { status });

/** A hub with systems at stages; `pairsAfter` reviews before a system pairs. */
function fakeHub(stages: Record<string, 'installed' | 'live'>, pairsAfter: Record<string, number> = {}) {
  const calls: { goLive: { system: string; hash: string }[] } = { goLive: [] };
  const api: LiveApi = {
    review: async (system) => {
      const left = pairsAfter[system] ?? 0;
      if (left > 0) { pairsAfter[system] = left - 1; throw refused(404); }
      const stage = stages[system];
      if (stage === undefined) { throw refused(404); }
      return { stage, hash: `hash-${system}` };
    },
    goLive: async (system, hash) => { calls.goLive.push({ system, hash }); stages[system] = 'live'; },
  };
  return { api, calls };
}

describe('putting premade systems live', () => {
  it('puts an installed system live by the hash reviewed, with nothing off', async () => {
    const { api, calls } = fakeHub({ database: 'installed' });
    expect(await goLiveIfInstalled(api, SystemName.parse('database'))).toBe('live');
    expect(calls.goLive).toEqual([{ system: 'database', hash: 'hash-database' }]);
  });

  it('leaves a live system alone and says when one has not paired', async () => {
    const { api, calls } = fakeHub({ fs: 'live' });
    expect(await goLiveIfInstalled(api, SystemName.parse('fs'))).toBe('already');
    expect(await goLiveIfInstalled(api, SystemName.parse('code'))).toBe('not-paired');
    expect(calls.goLive).toEqual([]);
  });

  it('waits for systems to pair, then puts them live, and names the ones that never did', async () => {
    const { api, calls } = fakeHub({ fs: 'installed', input: 'installed' }, { input: 2 });
    const never = await goLiveWhenPaired(api, ['fs', 'input', 'ghost'].map((n) => SystemName.parse(n)), 50, 1);
    expect(calls.goLive.map((c) => c.system).sort()).toEqual(['fs', 'input']);
    expect(never).toEqual(['ghost']);
  });
});
