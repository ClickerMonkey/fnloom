import { fn, g } from '@harness/sdk';
import { ConnectionId, SystemName, type FnRecord, type Json, type QualifiedName, type Turn, type UserConnection } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { openScope, type AccessScope, type FnConnection, type FnRef } from '../access/index.ts';
import type { RunInput } from './index.ts';
import { AGENT, ALICE, executionRig, type ExecutionRig } from './testing.ts';

const read = fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] });
const listEvents = fn({ description: 'List events.', args: g.obj({}), returns: g.text(), tags: ['read'] });

const CONNECTION: UserConnection = {
  id: ConnectionId.parse('cnx_1'), system: SystemName.parse('cal'), owner: ALICE, status: 'connected', settings: {}, fns: {},
  share: { visibility: 'private', with: [] }, createdAt: 0, updatedAt: 0,
};

/** A scope that hides some fns and says how per-person fns stand. */
function scope(hidden: readonly string[], connection: (record: FnRef) => FnConnection | undefined): AccessScope {
  return { ...openScope(ALICE), admin: false, seesFn: (record) => !hidden.includes(record.name), mayUse: (record) => !hidden.includes(record.name), connection };
}

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(access: AccessScope): Promise<ExecutionRig> {
  rig = await executionRig({
    access: { scope: () => Promise.resolve(access) },
    connections: { forRun: (connection) => Promise.resolve({ id: connection.id, owner: connection.owner, credentials: { token: 't' }, settings: connection.settings }) },
  });
  rig.catalog.add('fs', 'read', read);
  rig.catalog.add('cal', 'list_events', listEvents);
  await rig.module.start();
  return rig;
}

const input = (turn: Turn, name: QualifiedName, args: Json = {}): RunInput => ({
  fn: name, args, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
});

/** The record a fn name has as a ref. */
const isCal = (record: Pick<FnRecord, 'name'>): boolean => record.name === 'cal/list_events';

describe('visibility at a run start', () => {
  it('refuses a fn its person may not see as if it did not exist', async () => {
    const r = await started(scope(['fs/read'], () => undefined));
    await expect(r.module.runs.start(input(await r.turn(), 'fs/read', { path: 'a' }))).rejects.toMatchObject({ error: { code: 'not-found', message: 'There is no fn fs/read.' } });
  });

  it('refuses a per-person fn until its person connects, naming the page', async () => {
    const r = await started(scope([], (record) => (isCal(record) ? { state: 'missing', page: 'Calendar' } : undefined)));
    await expect(r.module.runs.start(input(await r.turn(), 'cal/list_events'))).rejects.toThrow(/connect your account on the Calendar page/);
  });

  it('sends the connection a per-person fn acts as, and waits for approval when it asks first', async () => {
    const ready = { state: 'ready' as const, connection: CONNECTION, option: { on: true, ask: false } };
    const r = await started(scope([], (record) => (isCal(record) ? ready : undefined)));
    const cal = r.connect('cal');
    const { settled } = await r.module.runs.start(input(await r.turn(), 'cal/list_events'));
    expect(await settled).toMatchObject({ status: 'done' });
    expect(cal.requests[0]?.connection).toEqual({ id: CONNECTION.id, owner: ALICE, credentials: { token: 't' }, settings: {} });

    await rig.module.stop();
    const asking = await started(scope([], (record) => (isCal(record) ? { ...ready, option: { on: true, ask: true } } : undefined)));
    asking.connect('cal');
    // an agent's call (not the person's own) to a fn kept on "ask first" waits for the connection's owner
    const { run } = await asking.module.runs.start({ ...input(await asking.turn(), 'cal/list_events'), caller: AGENT });
    expect((await asking.module.runs.get(run))?.status).toBe('awaiting-approval');
  });
});
