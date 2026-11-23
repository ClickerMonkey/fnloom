import { IDS, SystemName, type Approval, type HandlerCall, type PairingRequest } from '@harness/core';
import { describe, expect, it, vi } from 'vitest';
import { StoreNotifications } from './notifications.ts';
import { MemoryPresence } from './presence.ts';
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

describe('a notification with a key', () => {
  it('replaces the unread one of the same key in place, and only theirs, only while unread', async () => {
    const w = await chatWorld();
    const bo = await w.user('Bo');
    const link = { system: SystemName.parse('hub') };
    const notice = { reason: 'system-message' as const, link, key: 'sched:weekly' };
    const first = await w.chat.notifications.notify({ ...notice, user: w.admin.id, title: 'Weekly ran', body: '12 rows', tone: 'ok' });
    w.advance(10);
    const second = await w.chat.notifications.notify({
      ...notice, user: w.admin.id, title: 'Weekly failed', body: 'No database', tone: 'failed', also: { label: 'History', link },
    });
    // the same item, now saying the newest; another person's of the same key is their own
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ title: 'Weekly failed', tone: 'failed', also: { label: 'History' }, read: false });
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
    const theirs = await w.chat.notifications.notify({ ...notice, user: bo.id, title: 'Weekly ran', body: '' });
    expect(theirs.id).not.toBe(first.id);
    expect((await w.chat.notifications.list(w.admin.id, {})).items.map((n) => n.title)).toEqual(['Weekly failed']);
    // once read, a new one of the key is a new item; one without a key never replaces
    await w.chat.notifications.read(w.admin.id, [first.id]);
    const third = await w.chat.notifications.notify({ ...notice, user: w.admin.id, title: 'Weekly ran', body: '' });
    expect(third.id).not.toBe(first.id);
    const plain = await w.chat.notifications.notify({ user: w.admin.id, reason: 'system-message', title: 'Plain', body: '', link });
    expect(plain.id).not.toBe(third.id);
    expect((await w.chat.notifications.list(w.admin.id, {})).items.map((n) => n.title)).toEqual(['Plain', 'Weekly ran', 'Weekly failed']);
  });
});

describe('notifications from hub events', () => {
  it('ask each approver once while an approval is pending', async () => {
    const w = await chatWorld();
    const stop = w.chat.start();
    const bo = await w.user('Bo');
    w.bus.publish('approval', { session: w.session.id, approval: approval(), approvers: [w.admin.id, bo.id], turnUser: w.admin.id });
    w.bus.publish('approval', { session: w.session.id, approval: approval(), approvers: [w.admin.id, bo.id], turnUser: w.admin.id });
    w.bus.publish('approval', { approval: { ...approval('approved'), id: IDS.approval.parse('apr_2') }, approvers: [w.admin.id], turnUser: w.admin.id });
    await settle();
    const mine = await w.chat.notifications.list(w.admin.id, {});
    expect(mine.items).toEqual([expect.objectContaining({ reason: 'approval-needed', title: 'Approve fs/write?', link: { run: 'run_1' } })]);
    expect((await w.chat.notifications.list(bo.id, {})).items).toHaveLength(1);
    stop();
  });

  it('ask a person for input a run needs from them', async () => {
    const w = await chatWorld();
    const stop = w.chat.start();
    const call: HandlerCall = {
      id: IDS.handlerCall.parse('hcl_1'), run: IDS.run.parse('run_1'), handler: 'confirm', args: { path: 'a.md' }, decl: { description: 'Overwrite a.md?', args: gin({ name: 'any' }), returns: gin({ name: 'bool' }) },
      answerer: { user: w.admin.id }, status: 'pending', createdAt: 0,
    };
    w.bus.publish('handler', { session: w.session.id, call });
    w.bus.publish('handler', { call: { ...call, id: IDS.handlerCall.parse('hcl_2'), answerer: { system: SystemName.parse('fs'), run: call.run } } });
    w.bus.publish('handler', { call: { ...call, id: IDS.handlerCall.parse('hcl_3'), status: 'answered' } });
    await settle();
    expect((await w.chat.notifications.list(w.admin.id, {})).items).toEqual([expect.objectContaining({ reason: 'input-needed', title: 'Overwrite a.md?', body: '`a.md`', link: { run: 'run_1' } })]);
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

  it('resolve action items once what they asked for has happened, keeping what became of them', async () => {
    const w = await chatWorld();
    const stop = w.chat.start();
    const pairing: PairingRequest = {
      id: IDS.pairing.parse('par_1'), name: SystemName.parse('crm'), keyFingerprint: 'f', publicKey: 'k', version: '1', address: '10.0.0.2', method: 'code', code: '1234', status: 'pending', createdAt: 0, expiresAt: 1,
    };
    const call: HandlerCall = {
      id: IDS.handlerCall.parse('hcl_1'), run: IDS.run.parse('run_2'), handler: 'confirm', args: {}, decl: { description: 'Run it?', args: gin({ name: 'any' }), returns: gin({ name: 'bool' }) },
      answerer: { user: w.admin.id }, status: 'pending', createdAt: 0,
    };
    w.bus.publish('approval', { approval: approval(), approvers: [w.admin.id], turnUser: w.admin.id });
    w.bus.publish('handler', { call });
    w.bus.publish('pairing', { pairing });
    w.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'needs-config' });
    w.bus.publish('system.status', { system: SystemName.parse('git'), status: 'needs-config' });
    await settle();
    expect((await w.chat.notifications.list(w.admin.id, { unread: true })).items).toHaveLength(5);

    w.bus.publish('approval', { approval: approval('approved'), approvers: [w.admin.id], turnUser: w.admin.id });
    w.bus.publish('pairing', { pairing: { ...pairing, status: 'approved' } });
    w.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'connected' });
    // the run asking the question ended (it timed out) before anyone answered
    w.bus.publish('run.update', { run: call.run, fn: 'fs/bash', update: { type: 'status', status: 'failed' } });
    await settle();
    const items = (await w.chat.notifications.list(w.admin.id, {})).items;
    const outcome = (reason: string): string | undefined => items.find((n) => n.reason === reason && !('system' in n.link && n.link.system === 'git'))?.resolved;
    expect([outcome('approval-needed'), outcome('input-needed'), outcome('pairing-requested'), outcome('config-needed')]).toEqual(['Approved', 'Run failed', 'Paired', 'Connected']);
    // only git still needs someone
    expect((await w.chat.notifications.list(w.admin.id, { unread: true })).items.map((n) => n.title)).toEqual(['git needs config']);
    expect(w.bus.of('notification').filter((e) => e.notification.resolved !== undefined)).toHaveLength(4);
    stop();
  });

  it('ask admins once to raise a budget that says ask, linking the waiting run', async () => {
    const w = await chatWorld();
    await w.user('Bo');
    const stop = w.chat.start();
    const budget = {
      id: IDS.budget.parse('bgt_1'), target: { scope: 'hub' as const }, period: 'all-time' as const, maxCost: 1, onLimit: 'ask' as const, setBy: w.admin.id,
    };
    const run = IDS.run.parse('run_1');
    w.bus.publish('budget.reached', { budget, run, reason: 'the hub budget of $1.00 is used up' });
    w.bus.publish('budget.reached', { budget, run, reason: 'the hub budget of $1.00 is used up' });
    await settle();
    const items = (await w.chat.notifications.list(w.admin.id, {})).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'spend-limit', link: { run } });
    expect(items[0]?.body).toContain('the hub budget of $1.00 is used up');
    expect((await w.chat.notifications.list(IDS.actor.parse('act_bo'), {})).items).toEqual([]);
    stop();
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
    // a run a system proposed outside any run: every enabled admin
    expect(await w.chat.approvers.approvers({ by: 'admins' }, w.admin.id)).toEqual([w.admin.id]);
  });

  it('hold a needs-config notice for the grace, and drop it when the system connects first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = await chatWorld();
      const notices = new StoreNotifications({ ...w.deps, settings: { ...w.deps.settings, chat: { ...w.deps.settings.chat, HARNESS_CONFIG_NOTICE_GRACE: 30_000 } } }, new MemoryPresence(w.deps));
      const stop = notices.start();
      w.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'needs-config' });
      w.bus.publish('system.status', { system: SystemName.parse('git'), status: 'needs-config' });
      await vi.advanceTimersByTimeAsync(10_000);
      w.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'connected' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await notices.list(w.admin.id, {})).items).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_001);
      await vi.waitFor(async () => { expect((await notices.list(w.admin.id, {})).items.map((n) => n.title)).toEqual(['git needs config']); });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
