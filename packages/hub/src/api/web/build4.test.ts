import { manifestFromSpec } from '@ayepi/core';
import { ConnectionId, hubWebSpec, QualifiedName, SystemName, type ConnectPage } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope } from '../../access/index.ts';
import { rig, webRig, type Fakes } from '../testing/rig.ts';

const CAL = SystemName.parse('cal');
const HIDDEN = SystemName.parse('hidden');
const page = (system: SystemName): ConnectPage => ({
  system, ready: true, connections: [],
  decl: { title: 'Calendar', description: 'Yours.', how: { flow: 'oauth' }, settings: { name: 'object', props: {} }, fns: {} },
});

async function signedIn(fakes: Fakes) {
  const web = await webRig(await rig(fakes));
  const tokens = await web.admin();
  return { web, as: web.as(tokens), me: tokens.user.id };
}

describe('build 4 endpoints', () => {
  it('serve visibility and per-person connections as the person, hiding systems they can\'t see', async () => {
    const calls: unknown[][] = [];
    const fn = QualifiedName.parse('cal/list_events');
    const connection = ConnectionId.parse('cnx_1');
    const { web, as, me } = await signedIn({
      access: {
        info: () => Promise.resolve({ multiUser: true }),
        scope: (actor) => Promise.resolve({ ...openScope(actor), seesSystem: (system) => system !== HIDDEN }),
        views: (asker, targets) => { calls.push(['views', asker, targets]); return Promise.resolve([]); },
        set: (asker, target, rule) => { calls.push(['set', asker, target, rule]); return Promise.resolve({ target, sharing: { owner: asker, ...rule }, editable: true }); },
      },
      connections: {
        pages: () => Promise.resolve([page(CAL), page(HIDDEN)]),
        connect: (asker, system) => { calls.push(['connect', asker, system]); return Promise.resolve({ url: 'https://accounts.example/auth', binding: { cookie: 'harness_connect_c1', value: 'v', maxAge: 600, secure: false } }); },
        disconnect: (asker, id) => { calls.push(['disconnect', asker, id]); return Promise.resolve(true); },
      },
    });
    await expect(web.client.call('accessInfo', {}, as)).resolves.toEqual({ multiUser: true });
    await web.client.call('access', { targets: [{ kind: 'fn', fn }] }, as);
    await web.client.call('setAccess', { target: { kind: 'fn', fn }, sharing: { visibility: 'private', with: [] } }, as);
    expect((await web.client.call('connectPages', {}, as)).map((p) => p.system)).toEqual([CAL]);
    await expect(web.client.call('connect', { system: CAL }, as)).resolves.toEqual({ url: 'https://accounts.example/auth' });
    await expect(web.client.call('connect', { system: HIDDEN }, as)).rejects.toMatchObject({ status: 404 });
    // the answer sets the cookie that ties the sign-in to this browser, on the callback path only
    const { method, path } = manifestFromSpec(hubWebSpec).endpoints['connect'] ?? { method: 'POST', path: '' };
    const raw = await web.app.fetch(new Request(`http://hub${path}`, { method, headers: { ...as.headers, 'content-type': 'application/json' }, body: JSON.stringify({ system: CAL }) }));
    expect(raw.headers.get('set-cookie')).toBe('harness_connect_c1=v; Path=/connect/callback; Max-Age=600; HttpOnly; SameSite=Lax');
    expect(await raw.json()).toEqual({ url: 'https://accounts.example/auth' });
    await expect(web.client.call('disconnect', { connection }, as)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      ['views', me, [{ kind: 'fn', fn }]], ['set', me, { kind: 'fn', fn }, { visibility: 'private', with: [] }], ['connect', me, CAL], ['connect', me, CAL], ['disconnect', me, connection],
    ]);
  });
});
