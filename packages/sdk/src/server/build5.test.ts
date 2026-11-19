/**
 * Build 5 on the system side, against the in-memory hub: fns that ask for approval (declared in the manifest, their
 * preview served on `preview`, a kind's too), runs a system proposes from a run and from outside one, the decision
 * model, registries, contributions and config secrets in the manifest, and the model's result block.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApprovalPreview, ResultTable } from '@harness/core';
import { kind } from '../declare.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { manifestOf } from '../manifest.ts';
import { system } from '../system.ts';
import { ginAs } from '../zod-gin.ts';
import { serve, type RunningSystem } from './index.ts';
import { resultBlock } from './results.ts';
import { FakeHub } from './testing.ts';

const PREVIEW: ApprovalPreview = { title: 'Insert 1 row into orders', parts: [{ type: 'code', language: 'sql', code: 'INSERT …' }], irreversible: false };
const TABLE_DATA = g.obj({ rows: g.list(g.any()) });

const shop = system('shop', {
  description: 'A shop for tests.',
  registries: { visuals: { description: 'Ways to draw rows.', data: TABLE_DATA } },
  contributes: [{ registry: 'shop/visuals', name: 'table', label: 'Table' }, { registry: 'other/charts', name: 'pie', label: 'Pie' }],
  configSecrets: ['connection.password'],
}).with({
  config: g.obj({ connection: g.obj({ host: g.text(), password: g.optional(g.text()) }) }),
  kinds: { write: kind({ description: 'A write.', applicability: 'Writes.', payload: g.obj({ table: g.text() }) }) },
  fns: {
    insert: fn({ description: 'Insert a row.', args: g.obj({ name: g.text() }), returns: g.num(), approval: {} }),
    migrate: fn({ description: 'Change the schema.', args: g.obj({ steps: g.num() }), returns: g.bool() }),
    plain: fn({ description: 'Nothing special.', args: g.obj({}), returns: g.text() }),
  },
});

let running: RunningSystem<'shop'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function start(hub: FakeHub, started?: (propose: () => Promise<void>) => void): Promise<void> {
  running = await serve(shop, {
    fns: {
      insert: {
        async run(args, ctx) { return ctx.done(args.name.length); },
        async preview(args) { return args.name === '' ? { refused: 'A row needs a name.' } : { preview: { ...PREVIEW, title: `Insert ${args.name}` } }; },
      },
      migrate: { async run(_args, ctx) { return ctx.done(true); } },
      plain: {
        async run(_args, ctx) {
          const proposed = await ctx.propose(shop.fns.migrate, { steps: 2 }, { preview: PREVIEW });
          const again = await ctx.propose(shop.fns.migrate, { steps: 2 }, { preview: PREVIEW });
          const decided = await ctx.decide('the overdue query', [{ id: 'q1', text: 'Overdue invoices', score: 0.9 }]);
          return ctx.done(`${proposed.run === again.run ? 'same' : 'different'} ${decided.by}`);
        },
      },
    },
    kinds: {
      write: {
        async check() { return []; },
        async describe() { return { args: { name: 'obj' }, returns: { name: 'num' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, approval: { preview: true, remember: false }, examples: [{ args: {} }] }; },
        async run(_payload, _args, ctx) { return ctx.done(1); },
        async preview(payload, args) { return { preview: { ...PREVIEW, title: `Write ${payload.table} ${JSON.stringify(args)}` } }; },
      },
    },
    lifecycle: {
      async started(ctx) { started?.(async () => { await ctx.propose(shop.fns.migrate, { steps: 1 }, { preview: PREVIEW }); }); },
    },
  }, { hub: 'ws://hub.test/link', state: 'unused', version: '1.0.0' }, hub.host());
  await running.ready();
}

const CONFIG = { connection: { host: 'db', password: 'pw' } };

describe('approval runs', () => {
  it('declares approval in the manifest, defaulting to a preview that is never remembered', async () => {
    const manifest = await manifestOf(shop, { version: '1.0.0' });
    expect(manifest.fns.find((f) => f.name === 'insert')?.approval).toEqual({ preview: true, remember: false });
    expect(manifest.fns.find((f) => f.name === 'plain')?.approval).toBeUndefined();
  });

  it('serves a native fn\'s preview and its refusal, and a kind\'s preview from the payload', async () => {
    const hub = new FakeHub({ config: CONFIG });
    await start(hub);
    const run = hub.runInfo('shop/insert');
    const base = { run: run.id, user: run.user };
    expect(await hub.preview({ ...base, fn: 'insert', args: { name: 'pen' } })).toEqual({ preview: { ...PREVIEW, title: 'Insert pen' } });
    expect(await hub.preview({ ...base, fn: 'insert', args: { name: '' } })).toEqual({ refused: 'A row needs a name.' });
    expect(await hub.preview({ ...base, fn: 'plain', args: {} })).toEqual({ refused: 'plain has no preview.' });
    expect(await hub.preview({ ...base, fn: 'main.add_order', kind: 'shop/write', payload: { table: 'orders' }, args: { n: 1 } }))
      .toEqual({ preview: { ...PREVIEW, title: 'Write orders {"n":1}' } });
  });

  it('refuses to serve a fn that asks for a preview without implementing one', async () => {
    const hub = new FakeHub({ config: CONFIG });
    const bad = system('bad', { description: 'Bad.' }).with({ fns: { go: fn({ description: 'Go.', args: g.obj({}), returns: g.bool(), approval: {} }) } });
    await expect(serve(bad, { fns: { go: { async run(_a, ctx) { return ctx.done(true); } } } }, { hub: 'ws://hub.test/link', state: 'unused', version: '1.0.0' }, hub.host()))
      .rejects.toThrow(/needs a preview/);
  });

  it('proposes a run as a child of the proposing run, once per key, and asks the decision model', async () => {
    const hub = new FakeHub({ config: CONFIG });
    hub.onDecide = () => Promise.resolve({ by: 'decision', picked: [{ id: 'q1' }] });
    await start(hub);
    const run = hub.runInfo('shop/plain');
    const outcome = await hub.run('shop/plain', {}, { run });
    expect(outcome).toMatchObject({ status: 'done', result: 'same decision' });
    expect(hub.proposals).toHaveLength(1);
    expect(hub.proposals[0]).toMatchObject({ fn: 'migrate', args: { steps: 2 }, parent: run.id, approver: 'person', preview: PREVIEW });
    expect(hub.decisions).toEqual([{ run: run.id, question: 'the overdue query', candidates: [{ id: 'q1', text: 'Overdue invoices', score: 0.9 }], max: 1 }]);
  });

  it('proposes a run outside a run for the admins', async () => {
    const hub = new FakeHub({ config: CONFIG });
    let propose: (() => Promise<void>) | undefined;
    await start(hub, (p) => { propose = p; });
    await propose?.();
    expect(hub.proposals).toHaveLength(1);
    expect(hub.proposals[0]).toMatchObject({ fn: 'migrate', args: { steps: 1 }, approver: 'admins' });
    expect(hub.proposals[0]?.parent).toBeUndefined();
  });
});

describe('registries, contributions and config secrets', () => {
  it('lists them in the manifest and the pairing info', async () => {
    const manifest = await manifestOf(shop, { version: '1.0.0' });
    expect(manifest.registries?.map((r) => [r.name, r.description])).toEqual([['visuals', 'Ways to draw rows.']]);
    expect(manifest.registries?.[0]?.data).toMatchObject({ name: 'obj' });
    expect(manifest.contributes?.map((c) => `${c.registry} ${c.name}`)).toEqual(['shop/visuals table', 'other/charts pie']);
    expect(manifest.configSecrets).toEqual(['connection.password']);
  });

  it('refuses a secret path that is not a text field of the config', async () => {
    const wrong = system('wrong', { description: 'Wrong.', configSecrets: ['port'] }).with({ config: g.obj({ port: g.num() }) });
    await expect(manifestOf(wrong, { version: '1.0.0' })).rejects.toThrow(/must be a text field/);
  });

  it('takes a record of text as a secret (the hub seals it whole)', async () => {
    const env = system('env', { description: 'Env.', configSecrets: ['transport.env'] }).with({ config: ginAs(z.object({ transport: z.object({ env: z.record(z.string(), z.string()).optional() }) })) });
    expect((await manifestOf(env, { version: '1.0.0' })).configSecrets).toEqual(['transport.env']);
  });
});

describe('result blocks', () => {
  const table: ResultTable = {
    columns: [{ name: 'name', kind: 'text', nullable: false }, { name: 'total', kind: 'number', nullable: true }],
    rows: Array.from({ length: 30 }, (_, i) => [i === 0 ? 'x'.repeat(500) : `customer ${i}`, i * 10]),
    offset: 0,
    limit: 30,
    total: 95,
    truncated: true,
    sort: [{ column: 'total', dir: 'desc' }],
  };
  const fnInfo = { name: 'database/main.top_customers', signature: 'top_customers(region: text, limit?: num, offset?: num)' };

  it('tells the model what the person sees, how to page, and samples rows within the budget', () => {
    const block = resultBlock(table, { fn: fnInfo, args: { region: 'west' }, budget: 120, cellChars: 40 });
    expect(block.shown).toContain('These 30 rows (of 95) are shown to the person as a table');
    expect(block.shown).toContain('Don\'t repeat them');
    expect(block.nextPage).toEqual({ offset: 30, limit: 30, call: 'database/main.top_customers({"region":"west","offset":30,"limit":30})' });
    expect(block.shown).toContain(block.nextPage?.call);
    expect(block.columns).toEqual([{ name: 'name', kind: 'text', nullable: false }, { name: 'total', kind: 'number', nullable: true }]);
    expect(block.sample.length).toBeGreaterThan(0);
    expect(block.sample.length).toBeLessThan(30);
    expect(block.sample[0]?.['name']).toBe(`${'x'.repeat(40)}…`);
    expect(block.sampleNote).toBe(`The first ${block.sample.length} of 30 rows; the person has them all. Text longer than 40 characters is cut.`);
    expect(block).toMatchObject({ rowCount: 30, total: 95, truncated: true, sort: [{ column: 'total', dir: 'desc' }], fn: fnInfo });
  });

  it('words the block headless when nobody is watching: no one sees the rows, so the model answers from the sample', () => {
    const headless = resultBlock({ ...table, rows: [['Ada', 1], ['Bo', 2]], total: 2, truncated: false }, { fn: fnInfo, watched: false });
    expect(headless.shown).toBe('2 rows were read. Nobody is watching this run, so no one sees them: answer from the sample.');
    expect(headless.shown).not.toContain('shown to the person');
  });

  it('says plainly when nothing matched, and gives every row when they fit', () => {
    expect(resultBlock({ ...table, rows: [], total: 0, truncated: false }, { fn: fnInfo, budget: 100, cellChars: 40 }).shown).toMatch(/^No rows matched/);
    const small = resultBlock({ ...table, rows: [['Ada', 1]], total: 1, truncated: false }, { fn: fnInfo });
    expect(small).toMatchObject({ rowCount: 1, sample: [{ name: 'Ada', total: 1 }] });
    expect(small.sampleNote).toBeUndefined();
    expect(small.nextPage).toBeUndefined();
  });

  it('says text is cut only when a sampled row had its text cut, not a row past the budget', () => {
    const rows = [['Ada', 1], ['Bo', 2], ['y'.repeat(500), 3]];
    const block = resultBlock({ ...table, rows, total: 3, truncated: false }, { fn: fnInfo, budget: 12, cellChars: 40 });
    expect(block.sample.map((row) => row['name'])).toEqual(['Ada', 'Bo']);
    expect(block.sampleNote).toBe('The first 2 of 3 rows; the person has them all.');
  });
});
