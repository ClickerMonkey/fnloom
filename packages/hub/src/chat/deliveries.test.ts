import { IDS, SystemName, type DeliveryId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { CLIENT, chatWorld, gin, makeRun, settle } from './testing.ts';

const fs = SystemName.parse('fs');

async function world(options: { expires?: number } = {}) {
  const w = await chatWorld();
  w.catalog.addEntry('actions', 'fs/rerun', {
    name: 'rerun', description: 'Run a command again.', input: gin({ name: 'obj', props: { command: { type: { name: 'text' } } } }), returns: gin({ name: 'num' }),
    ...(options.expires === undefined ? {} : { expires: options.expires }),
  });
  w.catalog.checker = (_, type, value) => {
    if (type.name === 'num') { return typeof value === 'number' ? [] : ['expected num']; }
    if (type.name === 'obj') { return typeof value === 'object' && value !== null && 'command' in value ? [] : ['expected { command }']; }
    return [];
  };
  const act = async (command: string) => w.chat.deliveries.act({ session: w.session.id, system: fs, action: 'rerun', input: { command }, actor: w.admin.id, client: CLIENT });
  const status = async (id: DeliveryId) => (await w.chat.deliveries.get(id))?.status;
  return { ...w, act, status };
}

describe('actions', () => {
  it('are stored, then delivered as the person, and their typed result kept', async () => {
    const w = await world();
    const peer = w.link.connect('fs', { action: async ({ input }) => Promise.resolve({ result: JSON.stringify(input).length }) });
    const id = await w.act('ls');
    await settle();
    const done = await w.chat.deliveries.get(id);
    expect(done).toMatchObject({ status: 'done', result: 16, attempts: 1 });
    expect([typeof done?.deliveredAt, typeof done?.doneAt]).toEqual(['number', 'number']);
    expect(peer.calls[0]?.data).toMatchObject({ delivery: id, action: 'rerun', input: { command: 'ls' }, session: w.session.id, actor: w.admin.id, user: { id: w.admin.id } });
    expect(peer.calls[0]?.data).toHaveProperty('time.timeZone', 'UTC');
    expect(w.bus.of('delivery').map((e) => e.delivery.status)).toEqual(['queued', 'delivered', 'done']);
  });

  it('wait while the system is offline and go out in order when it connects', async () => {
    const w = await world();
    const stop = w.chat.start();
    const first = await w.act('one');
    w.advance(1);
    const second = await w.act('two');
    expect(await w.status(first)).toBe('queued');
    const seen: string[] = [];
    w.link.connect('fs', { action: async ({ input }) => { seen.push(JSON.stringify(input)); return Promise.resolve({ result: seen.length }); } });
    await settle();
    expect(seen).toEqual(['{"command":"one"}', '{"command":"two"}']);
    expect(await w.status(first)).toBe('done');
    expect(await w.status(second)).toBe('done');
    stop();
  });

  it('go back to the queue when the connection drops mid-delivery, and go out again on reconnect', async () => {
    const w = await world();
    const stop = w.chat.start();
    w.link.connect('fs', { action: async () => new Promise(() => undefined) });
    const id = await w.act('slow');
    await settle();
    expect(await w.status(id)).toBe('delivered');
    w.link.disconnect('fs');
    await settle();
    expect(await w.status(id)).toBe('queued');
    w.link.connect('fs', { action: async () => Promise.resolve({ result: 1 }) });
    await settle();
    expect(await w.chat.deliveries.get(id)).toMatchObject({ status: 'done', attempts: 2 });
    stop();
  });

  it('are sent again, in order, when the hub stopped while one was out', async () => {
    const w = await world();
    const first = await w.act('one');
    w.advance(1);
    const second = await w.act('two');
    // As a previous hub process left it: the first was out when the hub stopped.
    await w.store.table('deliveries').update(first, { status: 'delivered', attempts: 1, deliveredAt: 0 });
    const seen: string[] = [];
    w.link.connect('fs', { action: async ({ input }) => { seen.push(JSON.stringify(input)); return Promise.resolve({ result: seen.length }); } });
    await w.chat.deliveries.flush(fs);
    expect(seen).toEqual(['{"command":"one"}', '{"command":"two"}']);
    expect(await w.chat.deliveries.get(first)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await w.status(second)).toBe('done');
    expect(w.logs.some((l) => l.msg === 'chat.delivery.requeued' && l['reason'] === 'interrupted')).toBe(true);
  });

  it('keep flushing after one flush of the system failed', async () => {
    const w = await world();
    const id = await w.act('one');
    w.link.connect('fs', { action: async () => Promise.resolve({ result: 1 }) });
    w.store.failNextUpdate('deliveries');
    const failed = w.chat.deliveries.flush(fs);
    const next = w.chat.deliveries.flush(fs);
    await expect(failed).rejects.toThrow();
    await next;
    expect(await w.status(id)).toBe('done');
  });

  it('fail with the system\'s error, or when the result is not the declared type', async () => {
    const w = await world();
    let answer: () => Promise<{ result: unknown }> = async () => Promise.reject(new Error('no such command'));
    w.link.connect('fs', { action: async () => answer().then((r) => ({ result: typeof r.result === 'number' ? r.result : 'not a number' })) });
    const broken = await w.act('x');
    await settle();
    expect(await w.chat.deliveries.get(broken)).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'delivery-failed', message: 'no such command' } });
    answer = async () => Promise.resolve({ result: 'text' });
    const wrong = await w.act('y');
    await settle();
    const failed = await w.chat.deliveries.get(wrong);
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.message).toContain('expected num');
  });

  it('expire when they waited too long', async () => {
    const w = await world({ expires: 1_000 });
    const id = await w.act('late');
    w.advance(5_000);
    w.link.connect('fs', { action: async () => Promise.resolve({ result: 1 }) });
    await w.chat.deliveries.flush(fs);
    expect(await w.status(id)).toBe('expired');
  });

  it('are refused unless declared, available, enabled in the session, well typed and sent from inside it', async () => {
    const w = await world();
    const bo = await w.user('Bo');
    const send = (input: Partial<Parameters<typeof w.chat.deliveries.act>[0]>) => w.chat.deliveries.act({
      session: w.session.id, system: fs, action: 'rerun', input: { command: 'ls' }, actor: w.admin.id, client: CLIENT, ...input,
    });
    await expect(send({ actor: bo.id })).rejects.toMatchObject({ code: 'not-found' });
    await expect(send({ action: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(send({ input: 'ls' })).rejects.toMatchObject({ code: 'invalid' });
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_elsewhere'), fn: 'fs/ls', turn: IDS.turn.parse('trn_x'), actor: w.admin.id }));
    await expect(send({ run: IDS.run.parse('run_elsewhere') })).rejects.toMatchObject({ code: 'invalid' });
    w.catalog.unavailable.set('fs/rerun', { unavailable: 'disabled', detail: 'off' });
    await expect(send({})).rejects.toMatchObject({ code: 'unavailable' });
    await w.chat.sessions.update(w.session.id, { systems: [] }, w.admin.id);
    await expect(send({})).rejects.toMatchObject({ code: 'unavailable' });
    expect(await w.store.table('deliveries').count()).toBe(0);
  });
});

describe('form submissions', () => {
  async function waiting(status: 'waiting' | 'done' = 'waiting') {
    const w = await world();
    w.catalog.addFn('fs', { name: 'approve', form: gin({ name: 'num' }) });
    w.catalog.addFn('fs', { name: 'plain' });
    const run = makeRun({ id: IDS.run.parse('run_form'), fn: 'fs/approve', turn: IDS.turn.parse('trn_1'), actor: w.admin.id, session: w.session.id, status });
    await w.store.table('runs').insert(run);
    return { ...w, run: run.id };
  }

  it('go to the waiting run on its system', async () => {
    const w = await waiting();
    const peer = w.link.connect('fs', { form: async () => Promise.resolve() });
    const id = await w.chat.deliveries.submit({ run: w.run, value: 7, actor: w.admin.id });
    await settle();
    expect(await w.chat.deliveries.get(id)).toMatchObject({ status: 'done', kind: { form: w.run, value: 7 }, run: w.run });
    expect(peer.calls[0]).toEqual({ name: 'form', data: { delivery: id, run: w.run, value: 7 } });
  });

  it('are refused for a value of the wrong type, a run not waiting, a fn without a form, or an outsider', async () => {
    const w = await waiting();
    await expect(w.chat.deliveries.submit({ run: w.run, value: 'seven', actor: w.admin.id })).rejects.toMatchObject({ code: 'invalid' });
    const bo = await w.user('Bo');
    await expect(w.chat.deliveries.submit({ run: w.run, value: 7, actor: bo.id })).rejects.toMatchObject({ code: 'not-found' });
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_plain'), fn: 'fs/plain', turn: IDS.turn.parse('trn_1'), actor: w.admin.id, session: w.session.id, status: 'waiting' }));
    await expect(w.chat.deliveries.submit({ run: IDS.run.parse('run_plain'), value: 7, actor: w.admin.id })).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.deliveries.submit({ run: IDS.run.parse('run_none'), value: 7, actor: w.admin.id })).rejects.toMatchObject({ code: 'not-found' });
    const done = await waiting('done');
    await expect(done.chat.deliveries.submit({ run: done.run, value: 7, actor: done.admin.id })).rejects.toMatchObject({ code: 'conflict' });
  });
});
