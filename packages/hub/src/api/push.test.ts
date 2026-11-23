import { describe, expect, it } from 'vitest';
import { ActorId, NotificationId, PushId, RunId, SessionId, SystemName, type Notification } from '@harness/core';
import { pushPayload, WebPushService } from './push.ts';
import { testStore } from '../testing.ts';
import { recordingPush } from './testing/rig.ts';

const user = ActorId.parse('act_user');
const notification: Notification = {
  id: NotificationId.parse('ntf_1'), user, reason: 'replied', title: 'Ada replied', body: 'Looks good', link: { session: SessionId.parse('ses_1') },
  read: false, pushed: false, createdAt: 1,
};

async function make(status: (endpoint: string) => number) {
  const store = await testStore();
  const sender = recordingPush(status);
  const errors: unknown[] = [];
  const push = new WebPushService({ store, sender, publicKey: 'BPub', identity: { identity: () => Promise.resolve({ name: 'Family Desk', source: 'env' as const, version: '1' }) }, onError: (error) => { errors.push(error); } });
  const subscribe = (n: number, who = user) => store.table('pushSubscriptions').insert({
    id: PushId.parse(`psh_${n}`), user: who, endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' }, device: 'd', createdAt: n,
  });
  return { store, sender, push, errors, subscribe };
}

describe('WebPushService', () => {
  it('pushes to each of the user’s browsers and removes the ones that are gone', async () => {
    const { store, sender, push, subscribe } = await make((endpoint) => (endpoint.endsWith('/2') ? 410 : 201));
    await subscribe(1);
    await subscribe(2);
    await subscribe(3, ActorId.parse('act_other'));
    await expect(push.send(user, notification)).resolves.toEqual({ sent: 1, gone: 1 });
    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual(['https://push.example/1', 'https://push.example/2']);
    expect(JSON.parse(sender.sent[0]?.payload ?? '{}')).toEqual(JSON.parse(pushPayload(notification, 'Family Desk')));
    expect(JSON.parse(sender.sent[0]?.payload ?? '{}')).toMatchObject({ title: `Family Desk: ${notification.title}` });
    await expect(store.table('pushSubscriptions').get(PushId.parse('psh_2'))).resolves.toBeUndefined();
    await expect(store.table('pushSubscriptions').get(PushId.parse('psh_3'))).resolves.toBeDefined();
  });

  it('reports a sender that throws and keeps the subscription', async () => {
    const { store, push, errors, subscribe } = await make(() => { throw new Error('offline'); });
    await subscribe(1);
    await expect(push.send(user, notification)).resolves.toEqual({ sent: 0, gone: 0 });
    expect(errors).toHaveLength(1);
    await expect(store.table('pushSubscriptions').count()).resolves.toBe(1);
  });

  it('reports a refusal that isn’t “gone” and keeps the subscription', async () => {
    const { store, push, errors, subscribe } = await make(() => 429);
    await subscribe(1);
    await expect(push.send(user, notification)).resolves.toEqual({ sent: 0, gone: 0 });
    expect(errors).toMatchObject([{ message: 'the push service answered 429' }]);
    await expect(store.table('pushSubscriptions').count()).resolves.toBe(1);
  });

  it('carries a second link, key and tone, so the phone tags it by key and offers the link as an action', () => {
    const notice: Notification = {
      ...notification, reason: 'system-message', link: { run: RunId.parse('run_1') }, tone: 'failed', key: 'schedule:schedule/weekly',
      also: { label: 'History', link: { page: { system: SystemName.parse('schedule'), segment: 'item', path: ['weekly'], query: { tab: 'history' } } } },
    };
    expect(JSON.parse(pushPayload(notice, 'Family Desk'))).toEqual({
      id: 'ntf_1', title: 'Family Desk: Ada replied', body: 'Looks good', link: { run: 'run_1' }, reason: 'system-message', tone: 'failed', key: 'schedule:schedule/weekly',
      also: { label: 'History', link: { page: { system: 'schedule', segment: 'item', path: ['weekly'], query: { tab: 'history' } } } },
    });
    // a plain one carries none of them
    expect(JSON.parse(pushPayload(notification, 'Family Desk'))).toEqual({ id: 'ntf_1', title: 'Family Desk: Ada replied', body: 'Looks good', link: { session: 'ses_1' }, reason: 'replied' });
  });

  it('gives its public key', async () => {
    expect((await make(() => 201)).push.publicKey()).toBe('BPub');
  });
});
