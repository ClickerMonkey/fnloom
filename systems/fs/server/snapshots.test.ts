import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { contentHash } from '@harness/sdk/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskSnapshots, pruned } from './snapshots.ts';
import { tempFolder } from './testing.ts';

const text = (value: string) => new TextEncoder().encode(value);
const MB = 1024 * 1024;

describe('undo snapshots', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  beforeEach(async () => { tmp = await tempFolder(); });
  afterEach(() => tmp.cleanup());

  it('keeps the newest copies of each file and deletes the rest', async () => {
    let now = 0;
    const snapshots = new DiskSnapshots(`${tmp.path}/s`, () => ({ perFile: 2, totalMb: 100 }), () => (now += 1));
    const refs = [];
    for (const n of [1, 2, 3]) { refs.push(await snapshots.save(text(`a${n}`), 'text/plain', '/r/a.txt')); }
    const other = await snapshots.save(text('b1'), 'text/plain', '/r/b.txt');
    expect(await snapshots.load(refs[0] ?? other)).toBeUndefined();
    expect(new TextDecoder().decode(await snapshots.load(refs[2] ?? other))).toBe('a3');
    expect(await snapshots.load(other)).toBeDefined();
    const kept = (await readdir(`${tmp.path}/s`)).filter((name) => name !== 'index.json');
    expect(kept.sort()).toEqual([refs[1]?.hash, refs[2]?.hash, other.hash].sort());
    // a new fs reads the index back and goes on pruning from it
    const again = new DiskSnapshots(`${tmp.path}/s`, () => ({ perFile: 2, totalMb: 100 }), () => (now += 1));
    await again.save(text('a4'), 'text/plain', '/r/a.txt');
    expect(await again.load(refs[1] ?? other)).toBeUndefined();
  });

  it('drops the oldest copies once all of them use more than the total, counting copies from before the index', async () => {
    await mkdir(`${tmp.path}/s`, { recursive: true });
    const old = new Uint8Array(700 * 1024).fill(1);
    await writeFile(`${tmp.path}/s/${contentHash(old)}`, old);
    const snapshots = new DiskSnapshots(`${tmp.path}/s`, () => ({ perFile: 20, totalMb: 1 }));
    const ref = await snapshots.save(new Uint8Array(700 * 1024).fill(2), 'application/octet-stream', '/r/big.bin');
    expect(await readdir(`${tmp.path}/s`)).toEqual(expect.arrayContaining([ref.hash]));
    expect(await readdir(`${tmp.path}/s`)).not.toContain(contentHash(old));
  });

  it('always keeps the newest copy, even one over the total', () => {
    const big = { hash: 'a'.repeat(64), path: '/r/x', size: 3 * MB, at: 1 };
    expect(pruned([big], { perFile: 1, totalMb: 1 })).toEqual([big]);
  });
});
