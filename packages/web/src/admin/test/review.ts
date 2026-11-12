/**
 * Test doubles for a system's review (build 7): a small `notes` system built with the SDK (two fns, a context item and
 * a type), its review parsed through core's schema as the hub would send it, a refusal, and the review callers.
 */
import { Manifest, RefusalRecord, SystemReview } from '@harness/core';
import { context, fn, g, manifestBody, system, type } from '@harness/sdk';
import { fakeCaller } from '../../test/fakes.ts';
import { T0 } from '../../chat/test/fakes.ts';

/** The sample system: reads and writes notes, with one context item and one type. */
const notes = system('notes', { description: 'Notes in a folder.' })
  .with({
    config: g.obj({ folder: g.text({ minLength: 1 }) }),
    types: { Note: type({ description: 'A note.', shape: g.obj({ id: g.text(), title: g.text() }), display: { label: 'Note', title: 'title' } }) },
    fns: {
      find: fn({ description: 'Find notes.', instructions: 'Search by words in the title.', args: g.obj({ q: g.text() }), returns: g.list(g.text()), tags: ['read'], examples: [{ args: { q: 'plans' } }] }),
      save: fn({ description: 'Save a note.', args: g.obj({ title: g.text() }), returns: g.text(), effects: { mode: 'write', registry: [{ thing: 'context', action: 'create' }] } }),
    },
  })
  .with(({ fns }) => ({ context: { how: context({ description: 'How to keep notes.', content: 'Find first.', fns: [fns.find] }) } }));

/** The sample manifest, as the hub stores it. */
export function notesManifest(hash = 'hash-1', extra: Record<string, unknown> = {}): Manifest {
  return Manifest.parse({ ...manifestBody(notes, { version: '1.0.0' }), hash, grants: { hub: ['ai', 'search'], models: { roles: ['chat'], perRun: 0.05, perDay: 1 }, network: ['api.example.com'] }, ...extra });
}

/** A refusal the hub logged. */
export function refusal(overrides: Record<string, unknown> = {}): RefusalRecord {
  return RefusalRecord.parse({
    id: 'rfs_1', system: 'notes', instance: 'main', rule: 'mode', attempt: 'notes/save', detail: 'notes/find is declared read and called notes/save', fn: 'notes/find', at: T0 - 60_000, ...overrides,
  });
}

/** A made-up content hash that differs for each key: its characters in hex, cut or padded to 64. */
const hexOf = (key: string): string => Array.from({ length: key.length }, (_, at) => key.charCodeAt(at).toString(16).padStart(2, '0')).join('').slice(0, 64).padEnd(64, '0');

/** Preview shots of each component in each state, on a phone and a desktop, light and dark. */
export function previewShots(components: ReadonlyArray<readonly [string, readonly string[]]>): Array<Record<string, unknown>> {
  return components.flatMap(([component, states]) => states.flatMap((state) => ['phone', 'desktop'].flatMap((viewport) => ['light', 'dark'].map((theme) => ({
    component, state, viewport, theme, image: { hash: hexOf(`${component}-${state}-${viewport}-${theme}`), size: 2048, mime: 'image/png' },
  })))));
}

/** The sample system's review: installed, with checks, nothing off, one refusal. */
export function review(overrides: Record<string, unknown> = {}): SystemReview {
  return SystemReview.parse({
    system: 'notes', stage: 'installed', manifest: notesManifest(),
    facts: [{
      fn: 'notes/save', kind: 'native', mode: 'write', reads: [], writes: ['notes/Note'], uses: ['notes/save'], free: true, registry: [{ thing: 'context', action: 'create' }],
      cost: { min: 0, typical: 0, max: 0, basis: 'free', runs: 0 }, longRunning: false,
    }],
    checks: {
      scan: { size: 2048, builtins: ['fs'], concerns: [{ kind: 'eval', line: 12, detail: 'eval call', code: 'eval(src)' }], urls: ['https://api.example.com/v1'], hosts: ['api.example.com'] },
      tests: {
        system: 'notes', version: '1.0.0', ranAt: T0 - 120_000, duration: 1_500, passed: 3, failed: 1, skipped: 1,
        cases: [{ file: 'notes.test.ts', name: 'finds notes', status: 'failed', duration: 20, error: 'expected 2 got 1' }, { file: 'notes.test.ts', name: 'saves', status: 'passed', duration: 5 }],
        previews: previewShots([['NoteCard', ['empty', 'typical', 'long']], ['NoteList', ['loading', 'error']]]),
      },
    },
    off: [],
    refusals: { total: 1, last: [refusal()] },
    ...overrides,
  });
}

/** The review callers, answering with the samples. */
export function fakeReviewApi() {
  return {
    switchPart: fakeCaller<'switchPart'>(({ on }) => Promise.resolve({ on })),
    systemReview: fakeCaller<'systemReview'>(() => Promise.resolve(review())),
    goLive: fakeCaller<'goLive'>(({ hash }) => Promise.resolve({ stage: 'live' as const, hash })),
    approveReview: fakeCaller<'approveReview'>(({ hash }) => Promise.resolve({ hash })),
    rejectReview: fakeCaller<'rejectReview'>(() => Promise.resolve({ ok: true })),
    testCall: fakeCaller<'testCall'>(() => Promise.resolve({ run: 'run_test' })),
    refusals: fakeCaller<'refusals'>(() => Promise.resolve({ items: [refusal()] })),
  };
}
