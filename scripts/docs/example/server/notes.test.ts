/**
 * The notes system end to end over the SDK's real link runtime: `serve` connects to an in-memory hub (`FakeHub`), which
 * runs fns the way the real hub does and records what the system sent. The store is in memory and the clock fixed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub } from '@harness/sdk/server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { notes, type NoteValue } from '../shared/index.ts';
import { notesEnv } from './env.ts';
import { cleanTags, createNotesImpl } from './impl.ts';
import { JsonNoteStore, MemoryNoteStore, storesBy } from './store.ts';

// #region test
const CONFIG = { maxNotes: 2, defaultTags: ['Mine'] };

/** Serve the notes system to a fake hub with an in-memory store, and wait until it is ready. */
async function start(): Promise<{ hub: FakeHub; running: RunningSystem<'notes'> }> {
  let next = 0;
  const impl = createNotesImpl({
    settings: notesEnv.parse(),
    open: storesBy(() => new MemoryNoteStore()),
    now: () => new Date(Date.UTC(2026, 0, 1)),
    newId: () => `n${++next}`,
  });
  const hub = new FakeHub({ config: CONFIG });
  const running = await serve(notes, impl, { hub: 'ws://hub.test/link', state: 'unused', version: '0.1.0' }, hub.host());
  await running.ready();
  return { hub, running };
}

describe('notes over the link', () => {
  let running: RunningSystem<'notes'> | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it('sends a manifest with everything the contract declares', async () => {
    const started = await start();
    running = started.running;
    const manifest = started.hub.manifests[0];
    expect(manifest?.name).toBe('notes');
    // local names: the hub qualifies them with the system's name
    expect(manifest?.fns.map((f) => f.name)).toEqual(['add', 'find', 'remove', 'tidy', 'review', 'inbox', 'librarian', 'publish', 'Note.pin']);
    expect(manifest?.context.map((c) => c.name)).toEqual(['guide', 'recent']);
  });

  it('adds a note with the default tags, and refuses one past the limit', async () => {
    const started = await start();
    running = started.running;
    const added = await started.hub.run('notes/add', { title: 'Plan', text: 'Write the guide.', tags: ['Work'] });
    expect(added).toMatchObject({ status: 'done', result: { id: 'n1', title: 'Plan', tags: ['mine', 'work'] } });
    expect(started.hub.attachments).toHaveLength(1);
    await started.hub.run('notes/add', { title: 'Two', text: '…' });
    const third = await started.hub.run('notes/add', { title: 'Three', text: '…' });
    expect(third).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'full' } });
  });

  it('answers a search with nothing to search for as invalid input, not an error', async () => {
    const started = await start();
    running = started.running;
    const outcome = await started.hub.run('notes/find', {});
    expect(outcome).toMatchObject({ status: 'invalid-input', invalid: { problems: [{ path: 'query' }] } });
  });
});
// #endregion test

describe('note stores', () => {
  it('cleans tags: trimmed, lowercase, each once', () => {
    expect(cleanTags([' Work', 'work', '', 'Ideas '])).toEqual(['work', 'ideas']);
  });

  it('keeps notes as JSON in the data folder, read back with the contract\'s type', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'notes-'));
    try {
      const note: NoteValue = { id: 'a', title: 'A', text: 'x', tags: [], pinned: false, updatedAt: new Date(Date.UTC(2026, 0, 2)) };
      const store = new JsonNoteStore(folder);
      expect(await store.all()).toEqual([]);
      await store.put(note);
      const again = new JsonNoteStore(folder);
      expect(await again.get('a')).toEqual(note);
      expect(await again.delete('a')).toBe(true);
      expect(await again.delete('a')).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('opens one store per data folder', () => {
    const open = storesBy(() => new MemoryNoteStore());
    expect(open('x')).toBe(open('x'));
    expect(open('x')).not.toBe(open('y'));
  });
});
