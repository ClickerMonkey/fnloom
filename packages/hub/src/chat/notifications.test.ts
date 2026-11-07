import { IDS, SystemName, type Approval, type HandlerCall, type PairingRequest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { chatWorld, gin, settle } from './testing.ts';

const approval = (status: Approval['status'] = 'pending'): Approval => ({
  id: IDS.approval.parse('apr_1'), run: IDS.run.parse('run_1'), fn: 'fs/write', approver: { by: 'turn-user' }, status, decisions: [], createdAt: 0,
});

describe('the inbox', () => {
  it('stores and publishes every notification, pushing it when the user is away', async () => {
    const w = await chatWorld();
    w.push.subscribed.add(w.admin.id);
    const away = await w.chat.notifications.notify({ user: w.admin.id, reason: 'replied', title: 'Reply', body: 'Hi', link: { session: w.session.id } });
    expect(away).toMatchObject({ read: false, pushed: true });
    await w.chat.sessions.presence({ session: w.session.id, user: w.admin.id, focused: true, typing: false });
    const here = await w.chat.notifications.notify({ user: w.admin.id, reason: 'replied', title: 'Reply', body: 'Again', link: { session: w.session.id } });
    expect(here.pushed).toBe(false);
    const elsewhere = await w.chat.notifications.notify({ user: w.admin.id, reason: 'spend-limit', title: 'Budget', body: 'Reached', link: { system: SystemName.parse('hub') } });
    expect(elsewhere.pushed).toBe(false);
    expect(w.push.sent.map((p) => p.notification.id)).toEqual([away.id]);
    await settle();
    expect(w.bus.of('notification').map((n) => n.notification.id)).toEqual([away.id, here.id, elsewhere.id]);
  });

  it('keeps a notification when the push fails, or no browser takes it', async () => {
    const w = await chatWorld();
    expect((await w.chat.notifications.notify({ user: w.admin.id, reason: 'replied', title: 't', body: 'b', link: { session: w.session.id } })).pushed).toBe(false);
    w.push.failWith = new Error('push service down');
    const kept = await w.chat.notifications.notify({ user: w.admin.id, reason: 'replied', title: 't', body: 'b', link: { session: w.session.id } });
    expect(await w.store.table('notifications').get(kept.id)).toMatchObject({ pushed: false });
    expect(w.logs.some((l) => l.msg === 'chat.notification.push.failed')).toBe(true);
  });

  it('lists newest first, unread only on request, and marks only the user\'s own read', async () => {
    const w = await chatWorld();
    const bo = await w.user('Bo');
    const ids = [];
    for (const title of ['a', 'b', 'c']) {
      w.advance(10);
      ids.push((await w.chat.notifications.notify({ user: w.admin.id, reason: 'replied', title, body: '', link: { session: w.session.id } })).id);
    }
    const theirs = await w.chat.notifications.notify({ user: bo.id, reason: 'replied', title: 'bo', body: '', link: { session: w.session.id } });
    expect((await w.chat.notifications.list(w.admin.id, {})).items.map((n) => n.title)).toEqual(['c', 'b', 'a']);
    expect(await w.chat.notifications.read(w.admin.id, [ids[0] ?? '', theirs.id, 'ntf_missing'])).toBe(1);
    expect(await w.chat.notifications.read(w.admin.id, [ids[0] ?? ''])).toBe(0);
    expect((await w.chat.notifications.list(w.admin.id, { unread: true })).items.map((n) => n.title)).toEqual(['c', 'b']);
    const page = await w.chat.notifications.list(w.admin.id, { limit: 2 });
    expect(page.cursor).toBeDefined();
    expect((await w.store.table('notifications').get(theirs.id))?.read).toBe(false);
  });
});

describe('notifications from hub events', () => {
  it('ask each approver once while an approval is pending', async () => {
    const w = await chatWorld();
    const stop = w.chat.start();
    const bo = await w.user('Bo');
    w.bus.publish('approval', { session: w.session.id, approval: approval(), approvers: [w.admin.id, bo.id] });
    w.bus.publish('approval', { session: w.session.id, approval: approval(), approvers: [w.admin.id, bo.id] });
    w.bus.publish('approval', { approval: { ...approval('approved'), id: IDS.approval.parse('apr_2') }, approvers: [w.admin.id] });
    await settle();
    const mine = await w.chat.notifications.list(w.admin.id, {});
    expect(mine.items).toEqual([expect.objectContaining({ reason: 'approval-needed', title: 'Approve fs/write?', link: { approval: 'apr_1' } })]);
    expect((await w.chat.notifications.list(bo.id, {})).items).toHaveLength(1);
    stop();
  });

  it('ask a person for input a run needs from them', async () => {
    const w = await chatWorld();
    const stop = w.chat.start();
    const call: HandlerCall = {
      id: IDS.handlerCall.parse('hcl_1'), run: IDS.run.parse('run_1'), handler: 'confirm', args: {}, decl: { description: 'Overwrite a.md?', args: gin({ name: 'any' }), returns: gin({ name: 'bool' }) },
      answerer: { user: w.admin.id }, status: 'pending', createdAt: 0,
    };
    w.bus.publish('handler', { session: w.session.id, call });
    w.bus.publish('handler', { call: { ...call, id: IDS.handlerCall.parse('hcl_2'), answerer: { system: SystemName.parse('fs'), run: call.run } } });
    w.bus.publish('handler', { call: { ...call, id: IDS.handlerCall.parse('hcl_3'), status: 'answered' } });
    await settle();
    expect((await w.chat.notifications.list(w.admin.id, {})).items).toEqual([expect.objectContaining({ reason: 'input-needed', body: 'Overwrite a.md?', link: { run: 'run_1' } })]);
    stop();
  });

  it('tell admins about pairings and systems that went away or need config', async () => {
    const w = await chatWorld();
    await w.user('Bo');
    await w.user('Root', { role: 'admin' });
    await w.user('Gone', { role: 'admin', disabled: true });
    const stop = w.chat.start();
    const pairing: PairingRequest = {
      id: IDS.pairing.parse('par_1'), name: SystemName.parse('crm'), keyFingerprint: 'f', publicKey: 'k', version: '1', address: '10.0.0.2', method: 'code', code: '1234', status: 'pending', createdAt: 0, expiresAt: 1,
    };
    w.bus.publish('pairing', { pairing });
    w.bus.publish('pairing', { pairing: { ...pairing, id: IDS.pairing.parse('par_2'), status: 'approved' } });
    w.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'disconnected' });
    w.bus.publish('system.status', { system: SystemName.parse('git'), status: 'needs-config' });
    w.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'connected' });
    await settle();
    const reasons = async (id: typeof w.admin.id) => (await w.chat.notifications.list(id, {})).items.map((n) => n.reason).sort();
    expect(await reasons(w.admin.id)).toEqual(['config-needed', 'pairing-requested', 'system-disconnected']);
    expect(await reasons(IDS.actor.parse('act_root'))).toEqual(['config-needed', 'pairing-requested', 'system-disconnected']);
    expect(await reasons(IDS.actor.parse('act_bo'))).toEqual([]);
    expect(await reasons(IDS.actor.parse('act_gone'))).toEqual([]);
    stop();
    w.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'disconnected' });
    await settle();
    expect(await reasons(w.admin.id)).toHaveLength(3);
  });
});

describe('approvers', () => {
  it('are the turn\'s user, one actor, a group\'s members, or nobody for judges and the hub', async () => {
    const w = await chatWorld();
    const group = IDS.actor.parse('act_ops');
    for (const user of ['act_a', 'act_b']) { await w.store.table('memberships').insert({ group, user: IDS.actor.parse(user), addedBy: w.admin.id, addedAt: 0 }); }
    expect(await w.chat.approvers.approvers({ by: 'turn-user' }, w.admin.id)).toEqual([w.admin.id]);
    expect(await w.chat.approvers.approvers({ by: 'actor', actor: IDS.actor.parse('act_x') }, w.admin.id)).toEqual(['act_x']);
    expect((await w.chat.approvers.approvers({ by: 'group', group }, w.admin.id)).sort()).toEqual(['act_a', 'act_b']);
    expect(await w.chat.approvers.approvers({ by: 'judge', fn: 'hub/judge' }, w.admin.id)).toEqual([]);
    expect(await w.chat.approvers.approvers({ by: 'hub' }, w.admin.id)).toEqual([]);
  });
});
