/**
 * Run outcomes and what the hub records about them, on the real stack: args that don't fit a fn settle as
 * `invalid-input` (the fn never runs, the problems are named by path), a fn that really fails settles `failed`, and
 * both are counted apart in the fn's metrics with its timings. The index's embedding calls to the embedder system are
 * `ModelCall` records like every other model call.
 */
import { INVALID_INPUT_CODE, QualifiedName, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { admin, invoke, settle } from './kit.ts';

const READ = QualifiedName.parse('fs/read');

let me: SignedIn;
let session: SessionId;

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e runs' })).id;
});

afterAll(() => { me.close(); });

describe('invalid input and errors', () => {
  it('settle args that do not fit the fn as invalid input, named by path, without running it', async () => {
    const run = await invoke(me, session, READ, { path: 42 });
    expect(run.status).toBe('invalid-input');
    expect(run.outcome).toMatchObject({ status: 'invalid-input', invalid: { source: 'schema', problems: [{ path: 'path' }] } });
    expect(run.startedAt).toBeUndefined();
  });

  it('settle a fn that really fails as failed, with its error', async () => {
    const run = await invoke(me, session, READ, { path: 'no/such/file.md' });
    expect(run.status).toBe('failed');
    expect(run.outcome).toMatchObject({ status: 'failed', error: { code: 'not-found' } });
    expect(run.outcome?.status === 'failed' ? run.outcome.error.code : undefined).not.toBe(INVALID_INPUT_CODE);
  });

  it('run a fn whose args fit', async () => {
    const run = await invoke(me, session, READ, { path: 'README.md', limit: 3 });
    expect(run.status).toBe('done');
  });
});

describe('fn metrics', () => {
  it('count each outcome apart, with timings, per fn', async () => {
    const metrics = await waitFor('fs/read metrics', async () => {
      const [found] = await me.hub.call('fnMetrics', { fn: READ });
      return found !== undefined && found.outcomes['invalid-input'] >= 1 && found.outcomes.failed >= 1 && found.outcomes.done >= 1 ? found : undefined;
    }, { timeout: 30_000, every: 500 });
    expect(metrics).toMatchObject({ fn: READ, system: 'fs' });
    expect(metrics.runs).toBeGreaterThanOrEqual(3);
    expect(metrics.p50).toBeGreaterThanOrEqual(0);
    expect(metrics.p95).toBeGreaterThanOrEqual(metrics.p50 ?? 0);
    const days = await me.hub.call('fnMetricsDays', { fn: READ, days: 7 });
    expect(days.at(-1)?.outcomes['invalid-input']).toBeGreaterThanOrEqual(1);
    const record = (await me.hub.call('systemFns', { system: metrics.system })).find((fn) => fn.name === READ);
    expect(record?.stats.outcomes['invalid-input']).toBeGreaterThanOrEqual(1);
  });
});

describe('model calls', () => {
  it('record the index’s embedding calls to the embedder system', async () => {
    const calls = await waitFor('embed model calls', async () => {
      const page = await me.hub.call('modelCalls', { query: { filters: [{ field: 'modality', op: 'is' as const, value: 'embed' }], limit: 20 } });
      return page.items.some((call) => call.status === 'done') ? page.items : undefined;
    }, { timeout: 60_000, every: 1_000 });
    const call = calls.find((c) => c.status === 'done');
    // the hub asked (for its index), so the call names no system; the embedder system is its provider
    expect(call).toMatchObject({ modality: 'embed', provider: 'embedder', units: { modality: 'embed', dimensions: 768 } });
    expect(call?.system).toBeUndefined();
    expect(['index', 'search']).toContain(call?.purpose);
    expect(call?.units.modality === 'embed' ? call.units.texts : 0).toBeGreaterThan(0);
  });
});
