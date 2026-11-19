import { QualifiedName, SystemName, type Json } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { heldDetail, heldLine, heldSystems, runBlocks } from './held.ts';
import type { RunView } from './runs.ts';

type Shown = Pick<RunView, 'fn' | 'outcome'>;

const done = (fn: string, result: Json): Shown => ({ fn: QualifiedName.parse(fn), outcome: { status: 'done', result } });
const held = (fn: string, system = fn.split('/')[0] ?? '') => ({ code: 'held', reason: `${fn} changed and waits for an admin to approve it`, system });
const off = (fn: string) => ({ code: 'disabled', reason: `${fn} is switched off`, system: fn.split('/')[0] ?? '' });

describe('heldSystems', () => {
  it('finds a held system in every hub fn that refuses (regression: "You there?")', () => {
    const runs = [
      done('hub/load_fns', { loaded: [], refused: [{ fn: 'database/create_table', ...held('database/create_table') }] }),
      done('hub/load', { loaded: [], refused: [{ name: 'notes/tag', ...held('notes/tag') }] }),
      done('hub/load_context', { loaded: ['shop/guide'], fns: [], fnsRefused: [{ fn: 'shop/order', ...held('shop/order') }], refused: [] }),
      done('hub/fns_search', { items: [{ item: 'fn', name: 'mail/send', system: 'mail', description: 'Send.', available: false, blocked: held('mail/send') }] }),
    ];
    expect(heldSystems(runs)).toEqual([
      { system: 'database', fns: ['database/create_table'] },
      { system: 'notes', fns: ['notes/tag'] },
      { system: 'shop', fns: ['shop/order'] },
      { system: 'mail', fns: ['mail/send'] },
    ]);
  });

  it('gives one entry per system for the whole turn, each fn once, in the order the runs met them', () => {
    const runs = [
      done('hub/fns_search', { items: [
        { item: 'fn', name: 'database/create_table', system: 'database', description: 'Create.', available: false, blocked: held('database/create_table') },
        { item: 'fn', name: 'database/insert_rows', system: 'database', description: 'Insert.', available: false, blocked: held('database/insert_rows') },
        { item: 'fn', name: 'fs/read', system: 'fs', description: 'Read.', available: true },
      ], next: 3 }),
      done('hub/load_fns', { loaded: [], refused: [{ fn: 'database/create_table', ...held('database/create_table') }] }),
      done('hub/load_fns', { loaded: [], refused: [{ fn: 'database/create_table', ...held('database/create_table') }, { fn: 'database/drop', ...held('database/drop') }] }),
    ];
    expect(heldSystems(runs)).toEqual([{ system: 'database', fns: ['database/create_table', 'database/insert_rows', 'database/drop'] }]);
  });

  it('goes by the code alone: switched off, offline, missing or system-less blocks are no banner, whatever the reason says', () => {
    const runs = [
      done('hub/load_fns', { loaded: [], refused: [
        { fn: 'fs/write', ...off('fs/write') },
        // the reason's words never decide it
        { fn: 'fs/make', code: 'disabled', reason: 'fs/make changed and waits for an admin to approve it', system: 'fs' },
        { fn: 'git/push', code: 'system-disconnected', reason: 'git is not connected', system: 'git' },
        { fn: 'nope', code: 'not-a-name', reason: 'nope is not system/name' },
        { fn: 'odd', code: 'held', reason: 'held without a system' },
      ] }),
    ];
    expect(heldSystems(runs)).toEqual([]);
  });

  it('reads only finished hub fns with their own result shape', () => {
    const block = { loaded: [], refused: [{ fn: 'database/create_table', ...held('database/create_table') }] };
    const failed: Shown = { fn: QualifiedName.parse('hub/load_fns'), outcome: { status: 'failed', error: { class: 'fatal', code: 'x', message: 'boom' } } };
    expect(runBlocks(failed)).toEqual([]);
    expect(runBlocks({ fn: QualifiedName.parse('hub/load_fns') })).toEqual([]);
    // another fn with the same result shape is not a refusal
    expect(runBlocks(done('database/query', block))).toEqual([]);
    // a result that doesn't fit (an older hub's bare names) blocks nothing, and doesn't throw
    expect(runBlocks(done('hub/load_fns', { loaded: [], refused: ['database/create_table'] }))).toEqual([]);
    expect(runBlocks(done('hub/load_context', 'not an object'))).toEqual([]);
  });
});

describe('held words', () => {
  it('names the system and the fns it held', () => {
    expect(heldLine({ system: SystemName.parse('database') })).toBe('database has changes waiting for review');
    expect(heldDetail({ fns: ['database/create_table'] })).toBe('database/create_table is off until then.');
    expect(heldDetail({ fns: ['database/create_table', 'database/insert_rows', 'database/drop'] })).toBe('database/create_table, database/insert_rows and database/drop are off until then.');
    expect(heldDetail({ fns: [] })).toBe('');
  });
});
