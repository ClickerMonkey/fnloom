/**
 * Secrets in the admin fns' args over the real modules: a run of hub/configure_system or hub/add_instance whose config
 * holds secret fields is stored with them sealed (its row, its approval, its wording), the system still gets the plain
 * values, a run that waits for approval runs from the sealed args once approved, and the run's secrets go when it settles.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fn, g, manifestOf, system } from '@harness/sdk';
import {
  isJsonObject, MAIN_INSTANCE, mintId, QualifiedName, SealedConfigSecret, SECRET_KEPT, SystemName, InstanceName, type ActorId, type InstallSource, type Json, type RunId, type RunSettled,
  type UserView,
} from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingPush, testSettings } from '../api/testing/rig.ts';
import { userInfo } from '../api/web/access.ts';
import { adminOperations } from '../api/admin-ops.ts';
import { instanceRow, systemRow } from '../catalog/fixtures.ts';
import { allRows } from '../store/rows.ts';
import { memoryLog } from '../testing.ts';
import { SCRIPTED_AS, ScriptedProvider, TEST_MODEL } from '../execution/testing.ts';
import { FakeLauncher, RIG_SETTINGS, systemJson } from '../link/rig.ts';
import { NodeInstaller, type Installer, type SystemPackage } from '../link/process.ts';
import { StoreConfigService } from '../link/config.ts';
import type { RunningHub } from './index.ts';
import { hubModules } from './modules.ts';
import { startHub } from './start.ts';

/** The secret values the tests pass: none may show up in plain text in what the hub stores for a run. */
const TOKEN = 'tok-very-secret-1234';
const HEADER = 'Bearer hdr-very-secret-5678';
const SECRETS = [TOKEN, HEADER, 'hdr-very-secret-5678'];

/** A fleet system whose config has a secret token and secret headers. */
const api = system('apisvc', { description: 'An API service.' }).with({
  config: g.obj({ url: g.text(), token: g.text(), headers: g.obj({ Authorization: g.text() }) }),
  fns: { ping: fn({ description: 'Ping.', args: g.obj({}), returns: g.text(), tags: ['read'] }) },
});
const API = SystemName.parse('apisvc');

/** Writes the system's system.json for any source instead of running npm or git. */
class FakeInstaller implements Installer {
  async fetch(_source: InstallSource, dir: string): Promise<SystemPackage> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'system.json'), JSON.stringify(systemJson('apisvc', '1.0.0', { instances: 'many' })));
    return this.describe(dir);
  }
  describe(dir: string): Promise<SystemPackage> {
    return new NodeInstaller({ npm: RIG_SETTINGS.packaging.HARNESS_NPM, maxBytes: RIG_SETTINGS.packaging.HARNESS_PACKAGE_MAX }).describe(dir);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'harness-arg-secrets-'));
let running: RunningHub;
let admin: UserView;

beforeAll(async () => {
  const base = testSettings();
  running = await startHub({
    port: 0, log: memoryLog().log, pushSender: recordingPush(), signals: false,
    keyMaker: { secret: () => 'k'.repeat(48), vapid: () => ({ publicKey: 'pub', privateKey: 'priv' }) },
    settings: {
      ...base,
      hubEnv: { ...base.hubEnv, HARNESS_DB_FILE: ':memory:', HARNESS_KEYS_FILE: join(dir, 'keys.json'), HARNESS_FILES_DIR: join(dir, 'files'), HARNESS_SYSTEMS_DIR: join(dir, 'systems') },
      logEnv: { ...base.logEnv, HARNESS_LOG_FILES: false },
      // the fake processes an install starts never stop on their own: kill them at once when the hub stops
      linkEnv: { ...base.linkEnv, HARNESS_STOP_TIMEOUT: 100 },
    },
    modules: hubModules({
      llm: () => ({ providers: { [SCRIPTED_AS]: new ScriptedProvider() }, models: [TEST_MODEL] }),
      launcher: new FakeLauncher(), installer: new FakeInstaller(),
    }),
  });
  const { store, catalog } = running.services;
  const id = mintId('actor');
  await store.table('actors').insert({ id, kind: 'user', name: 'Ada', about: '', email: 'ada@example.com', role: 'admin', createdAt: 1, disabled: false });
  admin = { id, kind: 'user', name: 'Ada', email: 'ada@example.com', role: 'admin' };
  await catalog.importManifest({ ...await manifestOf(api, { version: '1.0.0' }), configSecrets: ['token', 'headers'] });
  await store.table('systems').put(systemRow('apisvc', 'connected'));
  await store.table('instances').put(instanceRow('apisvc', 'connected'));
});

afterAll(async () => {
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Start a run of a hub admin fn in a fresh turn of the admin's, as a chat call would. */
async function call(name: string, args: Json, caller: ActorId = admin.id): Promise<{ run: RunId; settled: Promise<RunSettled> }> {
  const { store, execution, clock } = running.services;
  const user = await userInfo(running.services, admin);
  const turn = mintId('turn');
  const limits = await execution.limits.resolve({ user, turn });
  const now = clock();
  await store.table('turns').insert({ id: turn, actor: admin.id, user, time: { now, timeZone: user.timeZone, local: '' }, status: 'running', limits, cost: 0, errors: { max: 1 }, createdAt: now });
  return execution.runs.start({
    fn: QualifiedName.parse(`hub/${name}`), args, turn, key: name, actor: admin.id, caller, priority: limits.priority, background: false, handlers: [],
  });
}

/** Everything the hub keeps for a run, as text: its row, its approvals and the log. */
async function stored(run: RunId): Promise<string> {
  const { store } = running.services;
  const row = await store.table('runs').get(run);
  const approvals = await allRows(store.table('approvals'), { where: { run: run } });
  return JSON.stringify({ row, approvals });
}

/** Whether no secret value shows in the text. */
function clean(text: string): boolean {
  return SECRETS.every((secret) => !text.includes(secret));
}

/** The sealed secret at a key of a run's stored config arg. */
async function sealedArg(run: RunId, key: string): Promise<SealedConfigSecret> {
  const row = await running.services.store.table('runs').get(run);
  const args = row?.args;
  const config = isJsonObject(args) ? args['config'] : undefined;
  return SealedConfigSecret.parse(isJsonObject(config) ? config[key] : undefined);
}

const CONFIG = { url: 'https://api.example.com', token: TOKEN, headers: { Authorization: HEADER } };

describe('secrets in the admin fns’ args', () => {
  it('stores a configure_system run with its secret fields sealed, configures the system with the plain values, and removes the run’s secrets', async () => {
    const { run, settled } = await call('configure_system', { system: API, config: CONFIG });
    const done = await settled;
    expect(done).toMatchObject({ status: 'done' });
    expect(done).toHaveProperty('result.version');
    expect(clean(await stored(run))).toBe(true);
    const row = await running.services.store.table('runs').get(run);
    // the fields that aren't secret stay readable in the run's args
    expect(row?.args).toMatchObject({ system: 'apisvc', config: { url: 'https://api.example.com' } });
    expect((await sealedArg(run, 'token')).json).toBeUndefined();
    expect((await sealedArg(run, 'headers')).json).toBe(true);
    // the system is sent the plain values, and its stored config holds its own sealed copies
    expect(await running.services.link.config.current(API)).toMatchObject({ value: CONFIG });
    const instance = await running.services.store.table('instances').get({ system: API, instance: MAIN_INSTANCE });
    expect(clean(JSON.stringify(instance))).toBe(true);
    // the run's own secrets are gone once it settled
    await expect.poll(async () => running.services.api.secrets.reveal((await sealedArg(run, 'token')).$secret)).toBeUndefined();
  });

  it('keeps a secret on SECRET_KEPT, as the web app does', async () => {
    const { settled } = await call('configure_system', { system: API, config: { ...CONFIG, url: 'https://two.example.com', token: SECRET_KEPT, headers: SECRET_KEPT } });
    expect(await settled).toMatchObject({ status: 'done' });
    expect(await running.services.link.config.current(API)).toMatchObject({ value: { ...CONFIG, url: 'https://two.example.com' } });
  });

  it('runs a configure_system run that waited for approval from its sealed args once approved', async () => {
    const ops = adminOperations(running.services);
    const policy = await ops.set_policy({ description: 'ask the admins', subject: { everyone: true }, target: {}, decision: { effect: 'ask', approver: { by: 'admins' } }, priority: 1 }, admin.id);
    try {
      const config = { ...CONFIG, token: `${TOKEN}-approved` };
      const { run, settled } = await call('configure_system', { system: API, config });
      const waiting = await running.services.store.table('runs').get(run);
      expect(waiting?.status).toBe('awaiting-approval');
      const text = await stored(run);
      expect(clean(text)).toBe(true);
      expect(text).not.toContain(`${TOKEN}-approved`);
      const [approval] = await allRows(running.services.store.table('approvals'), { where: { run: run } });
      if (approval === undefined) throw new Error('no approval');
      await running.services.execution.policies.answer(approval.id, { by: admin.id, approve: true, remember: 'once' });
      expect(await settled).toMatchObject({ status: 'done' });
      expect(await running.services.link.config.current(API)).toMatchObject({ value: config });
      expect(clean(await stored(run))).toBe(true);
    } finally {
      await ops.remove_rule({ kind: 'policy', id: policy.id }, admin.id);
    }
  });

  it('removes the secrets of a run whose approval is declined, without configuring', async () => {
    const ops = adminOperations(running.services);
    const policy = await ops.set_policy({ description: 'ask the admins', subject: { everyone: true }, target: {}, decision: { effect: 'ask', approver: { by: 'admins' } }, priority: 1 }, admin.id);
    try {
      const before = await running.services.link.config.current(API);
      const { run, settled } = await call('configure_system', { system: API, config: { ...CONFIG, token: 'declined-token' } });
      const sealed = await sealedArg(run, 'token');
      expect(await running.services.api.secrets.reveal(sealed.$secret)).toBe('declined-token');
      const [approval] = await allRows(running.services.store.table('approvals'), { where: { run: run } });
      if (approval === undefined) throw new Error('no approval');
      await running.services.execution.policies.answer(approval.id, { by: admin.id, approve: false, remember: 'once' });
      expect(await settled).toMatchObject({ status: 'cancelled' });
      await expect.poll(() => running.services.api.secrets.reveal(sealed.$secret)).toBeUndefined();
      expect(await running.services.link.config.current(API)).toEqual(before);
    } finally {
      await ops.remove_rule({ kind: 'policy', id: policy.id }, admin.id);
    }
  });

  describe('a `{ $secret }` reference the caller wrote', () => {
    /** A secret stored for something else (a provider's key), whose id a caller might have seen. */
    const otherSecret = () => running.services.api.secrets.store({ name: 'provider:openrouter', owner: admin.id, value: 'not-for-this-system' });

    it('is refused at a field that isn’t secret, from the admin fn and the web operation, and never revealed', async () => {
      const other = await otherSecret();
      const before = await running.services.link.config.current(API);
      const { run, settled } = await call('configure_system', { system: API, config: { ...CONFIG, url: { $secret: other } } });
      expect(await settled).toMatchObject({ status: 'failed', error: { code: 'invalid-input', data: { source: 'validation', problems: [{ path: 'config.url' }] } } });
      expect(JSON.stringify(await running.services.store.table('runs').get(run))).not.toContain('not-for-this-system');
      const ops = adminOperations(running.services);
      const answer = await ops.configure_system({ system: API, config: { ...CONFIG, url: { $secret: other } } }, admin.id);
      expect(answer).toHaveProperty('problems');
      expect(JSON.stringify(answer)).toContain('names a stored secret at url');
      await expect(ops.add_instance({ system: API, instance: InstanceName.parse('three'), config: { ...CONFIG, url: { $secret: other } } }, admin.id))
        .rejects.toMatchObject({ status: 422, code: 'CONFIG_INVALID' });
      await expect(ops.install_system({ source: { package: '@x/apisvc', version: '1.0.0' }, config: { note: { $secret: other } } }, admin.id))
        .rejects.toMatchObject({ status: 422, code: 'CONFIG_INVALID' });
      expect(await running.services.link.config.current(API)).toEqual(before);
      expect(await running.services.api.secrets.reveal(other)).toBe('not-for-this-system');
    });

    it('is refused at a secret field when it names another system’s secret', async () => {
      const other = await otherSecret();
      const before = await running.services.link.config.current(API);
      const { settled } = await call('configure_system', { system: API, config: { ...CONFIG, token: { $secret: other } } });
      expect(await settled).toMatchObject({ status: 'failed', error: { code: 'invalid-input', data: { problems: [{ path: 'config.token' }] } } });
      const answer = await adminOperations(running.services).configure_system({ system: API, config: { ...CONFIG, token: { $secret: other } } }, admin.id);
      expect(answer).toHaveProperty('problems');
      expect(JSON.stringify(answer)).toContain('names a stored secret at token');
      // even the system's own stored secret, named by its id, is refused: SECRET_KEPT keeps it
      const instance = await running.services.store.table('instances').get({ system: API, instance: MAIN_INSTANCE });
      const value = instance?.config?.value;
      const own = SealedConfigSecret.parse(isJsonObject(value) ? value['token'] : undefined);
      const again = await adminOperations(running.services).configure_system({ system: API, config: { ...CONFIG, token: { $secret: own.$secret } } }, admin.id);
      expect(again).toHaveProperty('problems');
      expect(await running.services.link.config.current(API)).toEqual(before);
    });

    it('is not needed to keep the system’s own secret: SECRET_KEPT round-trips it, from the web operation too', async () => {
      const ops = adminOperations(running.services);
      expect(await ops.configure_system({ system: API, config: { ...CONFIG, token: 'own-kept-token' } }, admin.id)).toHaveProperty('version');
      const storedToken = async (): Promise<string> => {
        const value = (await running.services.store.table('instances').get({ system: API, instance: MAIN_INSTANCE }))?.config?.value;
        return SealedConfigSecret.parse(isJsonObject(value) ? value['token'] : undefined).$secret;
      };
      const first = await storedToken();
      expect(await ops.configure_system({ system: API, config: { ...CONFIG, url: 'https://kept.example.com', token: SECRET_KEPT } }, admin.id)).toHaveProperty('version');
      const { settled } = await call('configure_system', { system: API, config: { ...CONFIG, url: 'https://kept2.example.com', token: SECRET_KEPT } });
      expect(await settled).toMatchObject({ status: 'done' });
      expect(await storedToken()).toBe(first);
      expect(await running.services.link.config.current(API)).toMatchObject({ value: { ...CONFIG, url: 'https://kept2.example.com', token: 'own-kept-token' } });
    });
  });

  it('stores an add_instance run with its secret fields sealed, and gives the new instance the plain values', async () => {
    const { link } = running.services;
    // a fleet system installed once on this hub, so another instance is added from the same source
    await link.supervisor.install({ source: { package: '@x/apisvc', version: '1.0.0' }, autoStart: false, by: admin.id });
    const two = InstanceName.parse('two');
    const { run, settled } = await call('add_instance', { system: API, instance: two, description: 'Second', config: CONFIG });
    expect(await settled).toMatchObject({ status: 'done', result: { system: 'apisvc', instance: 'two' } });
    expect(clean(await stored(run))).toBe(true);
    expect((await sealedArg(run, 'headers')).json).toBe(true);
    // the config waits for the instance's contract; applied, the instance holds the plain values
    if (!(link.config instanceof StoreConfigService)) throw new Error('not the store config service');
    await link.config.applyPending({ system: API, instance: two }, admin.id);
    expect(await link.config.current(API, two)).toMatchObject({ value: CONFIG });
    expect(clean(JSON.stringify(await running.services.store.table('instances').get({ system: API, instance: two })))).toBe(true);
  });

  it('seals the whole config of an install, whose system isn’t known yet', async () => {
    const { run, settled } = await call('install_system', { source: { package: '@x/apisvc', version: '1.0.0' }, config: CONFIG, autoStart: false });
    await settled;
    const row = await running.services.store.table('runs').get(run);
    expect(clean(JSON.stringify(row))).toBe(true);
    const args = row?.args;
    expect(SealedConfigSecret.parse(isJsonObject(args) ? args['config'] : undefined).json).toBe(true);
  });
});
