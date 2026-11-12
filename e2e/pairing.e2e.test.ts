/**
 * QR pairing and a fleet, on the real stack: a second fs process (instance `desk`) started with only the hub's URL
 * prints a QR code of its pairing link and a code; the pairing page's data (`pairing`) shows what the system said
 * about itself and its config type; approving with an instance name and a config pairs, configures and connects it
 * in one step. Then two fs instances are attached at once: a resource URI routes to the instance whose root holds it,
 * and a call that names neither is refused as invalid input naming the machines. The desk instance is removed after.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InstanceName, PairingId, QualifiedName, SystemName, type SessionId } from '@harness/core';
import { encodeValue } from '@harness/sdk';
import { SYSTEM_ENV } from '@harness/sdk/server';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { halt, ROOT, runComponent, type Child } from '../scripts/stack.ts';
import { fileUri } from '../systems/fs/server/paths.ts';
import { fs } from '../systems/fs/shared/index.ts';
import { admin, invoke, settings, settle } from './kit.ts';

const FS = SystemName.parse('fs');
const DESK = InstanceName.parse('desk');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** The pairing link a waiting system prints: `/pair/<id>?code=<code>`. */
const PAIR_LINK = /\/pair\/(par_[a-z0-9]+)\?code=([A-Za-z0-9-]+)/;

let me: SignedIn;
let session: SessionId;
let desk: Child | undefined;
let printed = '';
const folder = resolve(ROOT, settings.HARNESS_E2E_DATA, 'desk-files');

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e fleet' })).id;
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'desk-note.md'), '# On the desk\n\nOnly the desk instance serves this.\n');
});

afterAll(async () => {
  if (desk !== undefined) { await halt(desk, 10_000); }
  // the fleet is only this suite's: the rest of the run sees one fs again
  await me.hub.call('removeInstance', { system: FS, instance: DESK }).catch(() => undefined);
  me.close();
});

describe('QR pairing', () => {
  let pairing: PairingId;
  let code = '';

  it('prints a QR code of the pairing link and the code when a system starts with only the hub’s URL', async () => {
    const hub = inject('e2eHub').url;
    desk = runComponent('fs', [TSX, join(ROOT, 'systems', 'fs', 'server', 'main.ts')], {
      cwd: ROOT, output: (_component, line) => { printed += `${line}\n`; },
      env: {
        [SYSTEM_ENV.hub]: `${hub.replace(/^http/, 'ws')}/link`, [SYSTEM_ENV.state]: resolve(ROOT, settings.HARNESS_E2E_DATA, 'desk-state'),
        [SYSTEM_ENV.instance]: DESK, HARNESS_PAIRING_QR: 'always', HARNESS_LOG_JSON: 'false',
      },
    });
    const [, id, shown] = await waitFor('the pairing link', () => Promise.resolve(PAIR_LINK.exec(printed) ?? undefined), { timeout: 120_000, every: 250 });
    pairing = PairingId.parse(id);
    code = shown ?? '';
    // the link is logged first; then a QR code is drawn in block characters, with the code in a banner
    await waitFor('the QR code', () => Promise.resolve(/The request lasts until/.test(printed) ? true : undefined), { timeout: 30_000, every: 250 });
    expect(printed).toMatch(/[█▀▄]{6,}/);
    expect(printed).toContain(code);
  }, 150_000);

  it('gives the pairing page what the system said about itself', async () => {
    const request = await waitFor('the system’s pairing info', async () => {
      const got = await me.hub.call('pairing', { pairing });
      return got.configType !== undefined ? got : undefined;
    }, { timeout: 30_000 });
    expect(request).toMatchObject({ name: FS, instance: DESK, method: 'code', code, status: 'pending' });
    expect(request.description).toMatch(/files/i);
  });

  it('pairs, configures and connects the instance in one approval', async () => {
    const config = encodeValue(fs.defs.config, { roots: [{ name: 'desk', path: folder, writable: false, index: 'none' }] });
    expect(await me.hub.call('approvePairing', { pairing, approve: true, instance: DESK, config })).toMatchObject({ system: FS });
    const instances = await waitFor('two fs instances connected', async () => {
      const now = await me.hub.call('instances', { system: FS });
      return now.filter((i) => i.status === 'connected').length === 2 ? now : undefined;
    }, { timeout: 60_000, every: 500 });
    // an instance another suite removed stays listed as removed
    expect(instances.filter((i) => i.status === 'connected').map((i) => i.instance).sort()).toEqual(['desk', 'main']);
  }, 90_000);
});

describe('two fs instances at once', () => {
  it('route a resource to the instance whose root holds it', async () => {
    const text = await waitFor('the desk note', async () => {
      const read = await me.hub.call('resource', { uri: fileUri(join(folder, 'desk-note.md')), want: ['text'] });
      return read.text !== undefined && 'inline' in read.text ? read.text.inline : undefined;
    }, { timeout: 30_000, every: 500 });
    expect(text).toContain('Only the desk instance serves this.');
    // the main instance still serves its own root
    const readme = await me.hub.call('resource', { uri: fileUri(join(ROOT, 'README.md')), want: ['text'] });
    expect(readme.text !== undefined && 'inline' in readme.text ? readme.text.inline : '').toContain('# harness');
  });

  it('refuse a call that names no machine as invalid input naming both', async () => {
    const run = await invoke(me, session, QualifiedName.parse('fs/read'), { path: 'README.md', limit: 1 });
    expect(run.status).toBe('invalid-input');
    expect(run.outcome).toMatchObject({ status: 'invalid-input', invalid: { problems: [{ path: 'on' }] } });
    const message = run.outcome?.status === 'invalid-input' ? run.outcome.invalid.problems[0]?.message ?? '' : '';
    expect(message).toContain('on=main');
    expect(message).toContain('on=desk');
  });
});
