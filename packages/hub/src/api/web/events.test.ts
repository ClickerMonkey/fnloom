/**
 * Live events over the real web socket path (the assembled plugins, sign-in and event guards on an in-process ayepi
 * server): each person hears only their own events and the sessions they may see, and signing out or being turned
 * off ends what they hear.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Approval, ChatMessage, mintId, NotificationId, PairingId, QualifiedName, Session, SessionId, SystemName, type ActorId, type Notification, type Tokens,
} from '@harness/core';
import { ScryptHasher } from '../hash.ts';
import { settle } from '../../testing.ts';
import { rig, webRig, type Fakes } from '../testing/rig.ts';

const sessionId = SessionId.parse('ses_admins');

/** A frame the socket got: an answer to a frame we sent (`id`), or an event (`type`). */
const Frame = z.object({
  id: z.number().optional(),
  $status: z.number().optional(),
  type: z.string().optional(),
  params: z.unknown().optional(),
  data: z.object({ type: z.string().optional() }).loose().optional(),
}).loose();
type Frame = z.infer<typeof Frame>;

/** A browser socket opened with a token, as the node adapter opens one. */
function browser(web: Awaited<ReturnType<typeof webRig>>, tokens: Tokens) {
  const frames: Frame[] = [];
  const conn = web.app.ws.open((frame) => { frames.push(Frame.parse(JSON.parse(frame))); }, new Request(`http://hub/ws?access_token=${encodeURIComponent(tokens.access)}`));
  let next = 0;
  return {
    frames,
    /** Subscribe; resolves with the answer's status (200, or the refusal's). */
    sub: async (channel: string, params: unknown): Promise<number | undefined> => {
      const id = ++next;
      await web.app.ws.message(conn, JSON.stringify({ id, sub: channel, params }));
      return frames.find((frame) => frame.id === id)?.$status;
    },
    /** The types of the events heard so far. */
    heard: () => frames.flatMap((frame) => (frame.type === undefined ? [] : [`${frame.type}:${frame.data?.type ?? ''}`])),
  };
}

/** The admin's session: only the admin is in it. */
function adminSession(owner: ActorId): Session {
  return Session.parse({
    id: sessionId, title: 'Admin plans', owner, agent: 'hub/chat', participants: [{ actor: owner, role: 'owner', notify: 'all', joinedAt: 1 }], systems: 'all', tools: [], context: [],
    status: 'idle', transcript: [], createdAt: 1, updatedAt: 1, archived: false,
  });
}

/** A session read the test holds open until it says so (to land a sign-out while a guard runs). */
interface Hold {
  readonly reached: () => void;
  readonly until: Promise<void>;
}

async function setup(hold?: Hold) {
  const who: { owner?: ActorId } = {};
  const fakes: Fakes = {
    chat: {
      sessions: {
        get: async (id, viewer) => {
          if (hold !== undefined && viewer !== who.owner) { hold.reached(); await hold.until; }
          // the member is in a session of their own; the admin's session is the admin's alone
          if (id === sessionId) { return viewer === who.owner ? adminSession(viewer) : undefined; }
          return { ...adminSession(viewer), id };
        },
      },
    },
  };
  const r = await rig(fakes);
  const web = await webRig(r);
  const admin = await web.admin();
  who.owner = admin.user.id;
  const id = mintId('actor');
  // made after the admin, so the admin stays the break-glass one
  await r.store.table('actors').insert({ id, kind: 'user', name: 'Mem', about: '', email: 'mem@example.com', role: 'member', createdAt: r.now + 1, disabled: false });
  await r.store.table('credentials').insert({ user: id, kind: 'password', secretHash: await new ScryptHasher(10).hash('member password'), createdAt: r.now + 1 });
  const member = await web.client.call('signIn', { email: 'mem@example.com', password: 'member password' });
  return { r, web, admin, member };
}

function notification(user: ActorId): Notification {
  return { id: NotificationId.parse(`ntf_${user}`), user, reason: 'replied', title: 'Secret', body: 'for you only', link: { session: sessionId }, read: false, pushed: false, createdAt: 1 };
}

const approval = Approval.parse({ id: 'apr_1', run: 'run_1', fn: 'fs/bash', approver: { by: 'admins' }, status: 'pending', decisions: [], createdAt: 1 });

describe('live events', () => {
  it('refuses a member who asks for another person’s events or a session they aren’t in', async () => {
    const { web, admin, member } = await setup();
    const mem = browser(web, member);
    await expect(mem.sub('on.user', { user: admin.user.id })).resolves.toBe(403);
    await expect(mem.sub('on.session', { session: sessionId })).resolves.toBe(404);
    await expect(mem.sub('on.user', { user: member.user.id })).resolves.toBe(200);
    // the admin may watch their own session
    await expect(browser(web, admin).sub('on.session', { session: sessionId })).resolves.toBe(200);
  });

  it('gives a member none of another person’s notifications, approvals, sessions or pairings', async () => {
    const { r, web, admin, member } = await setup();
    const mem = browser(web, member);
    const boss = browser(web, admin);
    expect(await mem.sub('on.user', { user: member.user.id })).toBe(200);
    expect(await boss.sub('on.user', { user: admin.user.id })).toBe(200);
    r.bus.publish('notification', { notification: notification(admin.user.id) });
    r.bus.publish('approval', { session: sessionId, approval, approvers: [admin.user.id], turnUser: admin.user.id });
    r.bus.publish('session.changed', { session: { id: sessionId, title: 'Admin plans', owner: admin.user.id, agent: QualifiedName.parse('hub/chat'), status: 'idle', createdAt: 1, updatedAt: 1, archived: false }, participants: [admin.user.id] });
    r.bus.publish('pairing', {
      pairing: { id: PairingId.parse('par_1'), name: SystemName.parse('fs'), keyFingerprint: 'f', publicKey: 'k', version: '1', address: 'a', method: 'code', status: 'pending', createdAt: 1, expiresAt: 2 },
    });
    r.bus.publish('capabilities.changed', {});
    await settle();
    await settle();
    expect(mem.heard()).toEqual(['on.user:capabilities']);
    // the admins are read from the database first, so the pairing may come last
    expect(boss.heard().sort()).toEqual(['on.user:approval', 'on.user:capabilities', 'on.user:notification', 'on.user:pairing', 'on.user:session']);
    // and their own reach them
    r.bus.publish('notification', { notification: notification(member.user.id) });
    await settle();
    expect(mem.heard()).toEqual(['on.user:capabilities', 'on.user:notification']);
  });

  it('ends a sign-in’s live events when it signs out', async () => {
    const { r, web, member } = await setup();
    const mem = browser(web, member);
    expect(await mem.sub('on.user', { user: member.user.id })).toBe(200);
    await web.client.call('signOut', web.as(member));
    await settle();
    r.bus.publish('notification', { notification: notification(member.user.id) });
    await settle();
    expect(mem.heard()).toEqual([]);
    // and the old token can't subscribe again
    expect(await mem.sub('on.user', { user: member.user.id })).toBe(401);
  });

  it('ends a person’s live events when an admin turns them off', async () => {
    const { r, web, admin, member } = await setup();
    const mem = browser(web, member);
    expect(await mem.sub('on.user', { user: member.user.id })).toBe(200);
    await web.client.call('updateUser', { user: member.user.id, disabled: true }, web.as(admin));
    await settle();
    r.bus.publish('notification', { notification: notification(member.user.id) });
    await settle();
    expect(mem.heard()).toEqual([]);
  });

  it('ends a sign-in’s live events when its stolen refresh token is used again', async () => {
    const { r, web, member } = await setup();
    const thief = browser(web, member);
    expect(await thief.sub('on.user', { user: member.user.id })).toBe(200);
    // the owner refreshes; the thief replays the old refresh token, which ends the sign-in
    await web.client.call('refresh', { refresh: member.refresh });
    await expect(web.client.call('refresh', { refresh: member.refresh })).rejects.toMatchObject({ status: 401 });
    await settle();
    r.bus.publish('notification', { notification: notification(member.user.id) });
    await settle();
    expect(thief.heard()).toEqual([]);
  });

  it('ends a sign-in’s live events when its access is revoked', async () => {
    const { r, web, member } = await setup();
    const mem = browser(web, member);
    expect(await mem.sub('on.user', { user: member.user.id })).toBe(200);
    const { items: [session] } = await r.store.table('authSessions').find({ where: { user: member.user.id }, limit: 1 });
    if (session === undefined) { throw new Error('no sign-in'); }
    await r.api.auth.revokeAccess(session.id);
    await settle();
    r.bus.publish('notification', { notification: notification(member.user.id) });
    await settle();
    expect(mem.heard()).toEqual([]);
  });

  it('refuses a subscription when the sign-out lands while its guard is still checking', async () => {
    let reached!: () => void;
    let release!: () => void;
    const atGuard = new Promise<void>((resolve) => { reached = resolve; });
    const until = new Promise<void>((resolve) => { release = resolve; });
    const { r, web, member } = await setup({ reached, until });
    const mem = browser(web, member);
    const own = SessionId.parse('ses_member');
    const answer = mem.sub('on.session', { session: own });
    await atGuard;
    await web.client.call('signOut', web.as(member));
    release();
    expect(await answer).toBe(401);
    r.bus.publish('message', { message: ChatMessage.parse({ id: 'msg_1', session: own, turn: 'trn_1', author: member.user.id, role: 'user', parts: [], runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 1 }) });
    await settle();
    expect(mem.heard()).toEqual([]);
  });
});
