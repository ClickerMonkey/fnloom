/**
 * SSO's People pages (admins, `peopleSlice`): people and groups through the `users` and `groups` lists (searched,
 * filtered, sorted and paged in SQL), each row filled in with keyed and indexed reads (how the person signs in, their
 * groups; a group's member count); a group's members; the sign-in settings; a provider check; and test sign-ins. The
 * writes (a person's role or sign-in, memberships, the first-sign-in policy) are admin operations in the settings slice.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { peopleSlice, UserView, type Actor, type GroupView, type PersonView, type UserActor } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { allRows } from '../../store/rows.ts';
import { breakGlassAdmin } from '../identities.ts';
import type { HubReads } from '../reads.ts';
import { newTestId, UnknownProvider } from '../sso.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** People as the list shows them: how each signs in and the groups they are in. */
export async function personViews(hub: Pick<HubServices, 'store' | 'api'>, actors: readonly Actor[]): Promise<PersonView[]> {
  const { store } = hub;
  const breakGlass = await breakGlassAdmin(store);
  const users = actors.filter((actor): actor is UserActor => actor.kind === 'user');
  return Promise.all(users.map(async (user) => {
    const [credential, identities, memberships, password] = await Promise.all([
      store.table('credentials').get({ user: user.id, kind: 'password' }),
      allRows(store.table('externalIdentities'), { where: { user: user.id } }),
      allRows(store.table('memberships'), { where: { user: user.id } }),
      hub.api.auth.passwordAllowed(user),
    ]);
    const groups = await Promise.all(memberships.map(async (m) => ({ membership: m, group: await store.table('actors').get(m.group) })));
    return {
      ...UserView.parse(user), disabled: user.disabled, createdAt: user.createdAt, breakGlass: breakGlass?.id === user.id,
      password: credential !== undefined && password,
      identities: identities.map((i) => ({
        provider: i.provider, label: hub.api.sso.providers.find((p) => p.id === i.provider)?.label ?? i.provider,
        ...(i.email === undefined ? {} : { email: i.email }), lastSignInAt: i.lastSignInAt,
      })),
      groups: groups.flatMap(({ membership, group }) => (group?.kind === 'group' ? [{ id: group.id, name: group.name, synced: membership.provider !== undefined }] : [])),
    };
  }));
}

/** A group as the Groups list shows it: with how many people are in it (an indexed count). */
async function groupView(hub: Pick<HubServices, 'store'>, group: Pick<Actor, 'id' | 'name' | 'about' | 'createdAt'>): Promise<GroupView> {
  return { id: group.id, name: group.name, about: group.about, createdAt: group.createdAt, members: await hub.store.table('memberships').count({ group: group.id }) };
}

/** The People plugin. Requires the systems plugin, which binds `adminOnly`. */
export function peoplePlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, reads: HubReads) {
  const { sso } = hub.api;
  const known = <T>(work: () => Promise<T>): Promise<T> => work().catch((error: unknown) => {
    if (error instanceof UnknownProvider) throw reject(404, 'PROVIDER_NOT_FOUND', error.message);
    throw error;
  });
  return plugin({ name: 'web.people', spec: peopleSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof peopleSlice> => ({
      people: async ({ data, user }) => {
        const found = await reads.lists.page('users', data, user);
        return { items: await personViews(hub, found.items), ...(found.cursor === undefined ? {} : { cursor: found.cursor }) };
      },
      groups: async ({ data, user }) => {
        const found = await reads.lists.page('groups', data, user);
        const items = await Promise.all(found.items.map((group) => groupView(hub, group)));
        return { items, ...(found.cursor === undefined ? {} : { cursor: found.cursor }) };
      },
      groupMembers: async ({ data }) => {
        const group = await hub.store.table('actors').get(data.group);
        if (group?.kind !== 'group') throw reject(404, 'GROUP_NOT_FOUND', `no group ${data.group}`);
        const found = await hub.store.table('memberships').find({ where: { group: data.group }, limit: data.limit ?? 50, ...(data.cursor === undefined ? {} : { cursor: data.cursor }) });
        const members = await Promise.all(found.items.map((m) => hub.store.table('actors').get(m.user)));
        return {
          group: await groupView(hub, group), items: members.flatMap((m) => (m?.kind === 'user' ? [UserView.parse(m)] : [])),
          ...(found.cursor === undefined ? {} : { cursor: found.cursor }),
        };
      },
      signInSettings: () => sso.settings(),
      checkSsoProvider: ({ data }) => known(() => sso.check(data.provider)),
      testSsoSignIn: ({ data, user, cookie }) => known(async () => {
        const test = newTestId();
        const started = await sso.start(data.provider, { test: { id: test, admin: user.id } });
        const { name, value, path, maxAge, secure } = started.cookie;
        cookie(name, value, { path, maxAge, httpOnly: true, sameSite: 'Lax', secure });
        hub.log.info('sso.test.started', { provider: data.provider, user: user.id });
        return { url: started.url, test };
      }),
      ssoTestResult: ({ data, user }) => {
        const result = sso.testResult(data.test, user.id);
        if (result === undefined) throw reject(404, 'TEST_NOT_FOUND', 'That test sign-in has expired or hasn\'t come back yet.');
        return result;
      },
    }));
}
