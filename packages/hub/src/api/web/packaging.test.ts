import { InstanceName, MAIN_INSTANCE, PairingId, SystemName, type ContentRef, type InstanceRef } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { instanceRow, systemRow } from '../../catalog/fixtures.ts';
import { rig, webRig, type Fakes } from '../testing/rig.ts';

const NOTES = SystemName.parse('notes');
const ZIP: ContentRef = { hash: 'a'.repeat(64), size: 3, mime: 'application/zip' };

async function signedIn(fakes: Fakes = {}) {
  const r = await rig(fakes);
  const web = await webRig(r);
  const tokens = await web.admin();
  return { r, web, as: web.as(tokens), me: tokens.user.id };
}

describe('the packaging slice', () => {
  it('serves one pairing for the pairing page', async () => {
    const pairing = PairingId.parse('par_1');
    const { web, as } = await signedIn({
      link: {
        pairing: {
          get: (id) => Promise.resolve({
            id, name: NOTES, instance: InstanceName.parse('laptop'), keyFingerprint: 'fp', publicKey: 'pk', version: '1.0.0', address: '10.0.0.2', method: 'code' as const,
            code: 'ABCD-2345', status: 'pending' as const, createdAt: 1, expiresAt: 2, description: 'My laptop',
          }),
        },
      },
    });
    expect(await web.client.call('pairing', { pairing }, as)).toMatchObject({ id: 'par_1', instance: 'laptop', description: 'My laptop' });
  });

  it('lists a system’s instances without their keys, and refuses an unknown system', async () => {
    const { r, web, as } = await signedIn();
    await r.store.table('systems').put(systemRow('notes', 'connected'));
    await r.store.table('instances').put(instanceRow('notes', 'connected', { instance: InstanceName.parse('laptop') }));
    await r.store.table('instances').put(instanceRow('notes', 'disconnected', { instance: InstanceName.parse('desk') }));
    const instances = await web.client.call('instances', { system: NOTES }, as);
    expect(instances.map((i) => i.instance)).toEqual(['desk', 'laptop']);
    expect(instances[0]).not.toHaveProperty('publicKey');
    await expect(web.client.call('instances', { system: SystemName.parse('ghost') }, as)).rejects.toMatchObject({ status: 404 });
  });

  it('installs a package, removes an instance, and exports data with a download link', async () => {
    const calls: unknown[] = [];
    const { web, as, me } = await signedIn({
      link: {
        packages: {
          installZip: (input) => { calls.push(input); return Promise.resolve({ system: NOTES, instance: input.instance ?? MAIN_INSTANCE }); },
          removeInstance: (ref: InstanceRef) => { calls.push(ref); return Promise.resolve(); },
          exportData: (input) => { calls.push(input); return Promise.resolve(ZIP); },
        },
      },
    });
    expect(await web.client.call('installPackage', { zip: ZIP, instance: InstanceName.parse('desk'), data: ZIP, autoStart: false }, as)).toEqual({ system: 'notes', instance: 'desk' });
    expect(await web.client.call('removeInstance', { system: NOTES, instance: InstanceName.parse('desk') }, as)).toEqual({ ok: true });
    const exported = await web.client.call('exportSystemData', { system: NOTES, instance: MAIN_INSTANCE }, as);
    expect(exported.hash).toBe(ZIP.hash);
    expect(exported.url).toContain('notes-main-data.zip');
    expect(calls).toEqual([
      { zip: ZIP, by: me, instance: 'desk', data: ZIP, autoStart: false },
      { system: 'notes', instance: 'desk' },
      { ref: { system: 'notes', instance: 'main' }, withSecrets: false, by: me },
    ]);
  });
});
