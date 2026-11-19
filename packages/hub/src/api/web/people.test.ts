/**
 * The People endpoints over the real web API and store: people and groups by their lists (searched, filtered and
 * paged in SQL), a group's members, and the admin's writes (a person's role and sign-in, memberships, the
 * first-sign-in policy), with the break-glass admin protected.
 */
import { describe, expect, it } from 'vitest';
import { IdentityProviderConfig } from '@harness/core';
import { rig, testSettings, webRig } from '../testing/rig.ts';

const ACME = IdentityProviderConfig.parse({ id: 'acme', label: 'Acme', issuer: 'https://id.example.test', clientId: 'c' });

async function people(sso = false) {
  const base = testSettings();
  const providers = sso ? [ACME] : [];
  const r = await rig({}, { ...base, authEnv: { ...base.authEnv, HARNESS_SSO_PROVIDERS: providers } });
  const web = await webRig(r);
  const owner = await web.admin();
  const as = web.as(owner);
  const add = (name: string, role: 'admin' | 'member' = 'member') => web.client.call('addUser', { email: `${name.toLowerCase()}@example.com`, name, role }, as);
  return { r, web, owner, as, add };
}

describe('the People endpoints', () => {
  it('lists people searched, filtered and sorted by the users list, with how each signs in', async () => {
    const { web, as, add, owner } = await people(true);
    await add('Ann');
    await add('Bo', 'admin');
    await add('Cy');
    const all = await web.client.call('people', {}, as);
    expect(all.items.map((p) => p.name)).toEqual(['Admin', 'Ann', 'Bo', 'Cy']);
    const admin = all.items.find((p) => p.id === owner.user.id);
    expect(admin).toMatchObject({ breakGlass: true, password: true, identities: [], groups: [] });
    expect(all.items.find((p) => p.name === 'Ann')).toMatchObject({ breakGlass: false, password: false, role: 'member' });
    expect((await web.client.call('people', { text: 'bo@exa' }, as)).items.map((p) => p.name)).toEqual(['Bo']);
    expect((await web.client.call('people', { filters: [{ field: 'role', op: 'is', value: 'admin' }], sort: [{ field: 'name', dir: 'desc' }] }, as)).items.map((p) => p.name)).toEqual(['Bo', 'Admin']);
    const first = await web.client.call('people', { limit: 2 }, as);
    expect(first.items).toHaveLength(2);
    const rest = await web.client.call('people', { limit: 2, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) }, as);
    expect(rest.items.map((p) => p.name)).toEqual(['Bo', 'Cy']);
  });

  it('keeps groups, their members and their counts', async () => {
    const { web, as, add } = await people();
    const ann = (await add('Ann')).id;
    const bo = (await add('Bo')).id;
    const team = (await web.client.call('addGroup', { name: 'Team', about: 'Everyone on the team.' }, as)).id;
    await web.client.call('addGroup', { name: 'Ops', about: '' }, as);
    await web.client.call('setMembership', { group: team, user: ann, member: true }, as);
    await web.client.call('setMembership', { group: team, user: bo, member: true }, as);
    const groups = await web.client.call('groups', {}, as);
    expect(groups.items.map((g) => [g.name, g.members])).toEqual([['Ops', 0], ['Team', 2]]);
    expect((await web.client.call('groups', { text: 'everyone' }, as)).items.map((g) => g.name)).toEqual(['Team']);
    await expect(web.client.call('setMembership', { group: team, user: bo, member: false }, as)).resolves.toEqual({ ok: true });
    const members = await web.client.call('groupMembers', { group: team }, as);
    expect(members.group).toMatchObject({ name: 'Team', members: 1 });
    expect(members.items.map((u) => u.name)).toEqual(['Ann']);
    const annView = (await web.client.call('people', { text: 'ann' }, as)).items[0];
    expect(annView?.groups).toEqual([{ id: team, name: 'Team', synced: false }]);
  });

  it('changes a person, but never demotes or turns off the break-glass admin or the asker', async () => {
    const { web, as, add, owner, r } = await people(true);
    const ann = (await add('Ann')).id;
    await web.client.call('updateUser', { user: ann, role: 'admin', name: 'Ann Lee' }, as);
    expect(await r.store.table('actors').get(ann)).toMatchObject({ role: 'admin', name: 'Ann Lee' });
    await expect(web.client.call('updateUser', { user: owner.user.id, role: 'member' }, as)).rejects.toThrow(/break-glass/);
    await expect(web.client.call('updateUser', { user: owner.user.id, disabled: true }, as)).rejects.toThrow(/break-glass/);
    // Ann, now an admin who signs in through the provider, can't take away her own role or sign-in
    const signed = await r.api.auth.signInExternal({ provider: ACME, issuer: ACME.issuer, sub: 'ann', claims: { email: 'ann@example.com', email_verified: true } }, 'test');
    if (!('tokens' in signed)) throw new Error(signed.refused);
    await expect(web.client.call('updateUser', { user: ann, role: 'member' }, web.as(signed.tokens))).rejects.toThrow(/your own/);
    // the owner can turn her sign-in off: her session stops at once
    await web.client.call('updateUser', { user: ann, disabled: true }, as);
    expect(await r.store.table('actors').get(ann)).toMatchObject({ disabled: true });
    await expect(web.client.call('me', web.as(signed.tokens))).rejects.toThrow();
  });

  it('keeps the first-sign-in policy the admin sets, and refuses a bad one', async () => {
    const { web, as } = await people(true);
    expect((await web.client.call('signInSettings', {}, as)).policy).toEqual({ mode: 'invite' });
    await web.client.call('setSignInPolicy', { mode: 'domains', domains: [' Example.COM '] }, as);
    expect((await web.client.call('signInSettings', {}, as)).policy).toEqual({ mode: 'domains', domains: ['example.com'] });
    await expect(web.client.call('setSignInPolicy', { mode: 'domains', domains: [] }, as)).rejects.toThrow();
    await expect(web.client.call('setSignInPolicy', { mode: 'domains', domains: ['not a domain'] }, as)).rejects.toThrow();
  });

  it('is for admins only', async () => {
    const { web, as, r } = await people();
    await web.client.call('addUser', { email: 'mo@example.com', name: 'Mo', role: 'member' }, as);
    const mo = (await web.client.call('people', { text: 'mo' }, as)).items[0];
    if (mo === undefined) throw new Error('no Mo');
    // a member's session, made directly (members sign in through a provider)
    const tokens = await r.api.auth.signInExternal({ provider: ACME, issuer: ACME.issuer, sub: 'mo', claims: { email: 'mo@example.com', email_verified: true } }, 'test');
    if (!('tokens' in tokens)) throw new Error(tokens.refused);
    // their own account is theirs to read
    await expect(web.client.call('account', web.as(tokens.tokens))).resolves.toMatchObject({
      name: 'Mo', role: 'member', password: false, identities: [{ provider: 'acme', label: 'acme', email: 'mo@example.com' }],
    });
    await expect(web.client.call('people', {}, web.as(tokens.tokens))).rejects.toThrow();
    await expect(web.client.call('signInSettings', {}, web.as(tokens.tokens))).rejects.toThrow();
  });
});
