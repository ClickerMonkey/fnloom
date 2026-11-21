/**
 * The outside-images setting over the web API (M4): everyone signed in reads it, asking first by default; only an
 * admin sets it, and the hub option keeps the choice.
 */
import { mintId, type Tokens } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ScryptHasher } from '../hash.ts';
import { rig, webRig } from '../testing/rig.ts';

describe('the outside-images setting endpoints', () => {
  it('asks first by default, lets an admin choose always, and refuses a member', async () => {
    const r = await rig();
    const web = await webRig(r);
    const admin = web.as(await web.admin());
    const id = mintId('actor');
    await r.store.table('actors').insert({ id, kind: 'user', name: 'Mem', about: '', email: 'mem@example.com', role: 'member', createdAt: 1, disabled: false });
    await r.store.table('credentials').insert({ user: id, kind: 'password', secretHash: await new ScryptHasher(10).hash('member password'), createdAt: 1 });
    const member: Tokens = await web.client.call('signIn', { email: 'mem@example.com', password: 'member password' });

    expect(await web.client.call('outsideImages', {}, web.as(member))).toEqual({ value: 'ask' });
    await expect(web.client.call('setOutsideImages', { value: 'always' }, web.as(member))).rejects.toMatchObject({ status: 403 });
    const set = await web.client.call('setOutsideImages', { value: 'always' }, admin);
    expect(set).toMatchObject({ value: 'always' });
    expect(set.setBy).toBeTypeOf('string');
    expect(await web.client.call('outsideImages', {}, web.as(member))).toMatchObject({ value: 'always' });
    expect(await r.store.table('hubOptions').get('outsideImages')).toMatchObject({ key: 'outsideImages', value: 'always' });
  });
});
