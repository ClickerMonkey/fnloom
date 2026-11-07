/**
 * The whole hub process on a free port: lifecycle, the HTTP front (API prefix, health, the web build with its
 * single-page fallback), browser sockets with realtime events, the link socket, and shutdown. Other modules are fakes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, wsTransport } from '@ayepi/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hubWebSpec, type HubWebSpec, type UserEvent } from '@harness/core';
import { fakeModules, recordingPush, testSettings } from '../api/testing/rig.ts';
import { memoryLog } from '../testing.ts';
import type { HubSettings } from './env.ts';
import type { RunningHub } from './index.ts';
import { ensureHubActor, startHub } from './start.ts';

const dir = mkdtempSync(join(tmpdir(), 'harness-hub-'));
const lifecycle: string[] = [];
let hub: RunningHub;

function settingsFor(data: string): HubSettings {
  const base = testSettings();
  const web = join(data, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>harness</title>');
  writeFileSync(join(web, 'assets', 'app.js'), 'export {}');
  return {
    ...base,
    hubEnv: { ...base.hubEnv, HARNESS_DATA: data, HARNESS_HOST: '0.0.0.0', HARNESS_KEYS_FILE: join(data, 'keys.json'), HARNESS_FILES_DIR: join(data, 'files'), HARNESS_LOG_DIR: join(data, 'logs') },
    httpEnv: { ...base.httpEnv, HARNESS_WEB_DIST: web },
    logEnv: { ...base.logEnv, HARNESS_LOG_FILES: false },
    authEnv: { ...base.authEnv, HARNESS_ADMIN_EMAIL: undefined, HARNESS_ADMIN_PASSWORD: undefined },
  };
}

beforeAll(async () => {
  hub = await startHub({
    settings: settingsFor(dir), port: 0, log: memoryLog().log, pushSender: recordingPush(),
    keyMaker: { secret: () => `secret-${Math.random().toString(36).padEnd(40, '0')}`, vapid: () => ({ publicKey: 'pub', privateKey: 'priv' }) },
    modules: fakeModules({
      catalog: { manifest: () => Promise.resolve(undefined) },
      link: {
        connections: { stopAll: () => { lifecycle.push('links.stopAll'); return Promise.resolve(); } },
        supervisor: {
          startAll: () => { lifecycle.push('supervisor.startAll'); return Promise.resolve(); },
          stopAll: () => { lifecycle.push('supervisor.stopAll'); return Promise.resolve(); },
        },
      },
    }),
  });
});

afterAll(async () => {
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

const api = () => client<HubWebSpec>({ baseUrl: `${hub.url}/api`, manifest: hubWebSpec, validate: hubWebSpec });

describe('a running hub', () => {
  it('starts installed systems once it is up and reports healthy', async () => {
    expect(lifecycle).toEqual(['supervisor.startAll']);
    expect(hub.port).toBeGreaterThan(0);
    const live = await fetch(`${hub.url}/healthz`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ ok: true });
    expect((await fetch(`${hub.url}/readyz`)).status).toBe(200);
  });

  it('serves the web API under /api', async () => {
    await expect(api().call('setup')).resolves.toMatchObject({ needsAdmin: true, name: 'Harness' });
    const tokens = await api().call('createAdmin', { email: 'admin@example.com', name: 'Admin', password: 'correct horse battery' });
    await expect(api().call('me', { headers: { authorization: `Bearer ${tokens.access}` } })).resolves.toMatchObject({ email: 'admin@example.com' });
  });

  it('serves the web app, with the page itself for app routes', async () => {
    const page = await fetch(`${hub.url}/sessions/ses_1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>harness</title>');
    expect((await fetch(`${hub.url}/assets/app.js`)).headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${hub.url}/assets/none.js`)).status).toBe(404);
  });

  it('carries the web API and its events over the browser socket', async () => {
    const tokens = await api().call('signIn', { email: 'admin@example.com', password: 'correct horse battery' });
    const socket = wsTransport(`${hub.url.replace('http', 'ws')}/ws?access_token=${encodeURIComponent(tokens.access)}`, { heartbeat: false });
    const sdk = client<HubWebSpec>({ baseUrl: `${hub.url}/api`, manifest: hubWebSpec, ws: socket, prefer: 'ws' });
    try {
      await expect(sdk.call('me')).resolves.toMatchObject({ id: tokens.user.id });
      const heard = new Promise<UserEvent>((resolve) => { sdk.on('user', (event) => { resolve(event); }); });
      // The subscription travels after the socket is open; give it a moment, then announce.
      await new Promise((resolve) => setTimeout(resolve, 100));
      hub.services.bus.publish('capabilities.changed', {});
      await expect(heard).resolves.toEqual({ type: 'capabilities' });
    } finally {
      socket.close();
    }
  });

  it('accepts system sockets on /link and refuses other upgrade paths', async () => {
    const base = hub.url.replace('http', 'ws');
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${base}/link`);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => { resolve(false); };
    });
    expect(opened).toBe(true);
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${base}/elsewhere`);
      ws.onopen = () => { ws.close(); resolve(false); };
      ws.onerror = () => { resolve(true); };
    });
    expect(refused).toBe(true);
  });

  it('has made its own actor, once', async () => {
    const id = await ensureHubActor(hub.services.store, () => 0);
    await expect(ensureHubActor(hub.services.store, () => 0)).resolves.toBe(id);
    await expect(hub.services.store.table('actors').get(id)).resolves.toMatchObject({ kind: 'system', system: 'hub' });
  });
});

describe('stopping', () => {
  it('stops installed systems, tells links, then closes the port', async () => {
    const order: string[] = [];
    const second = await startHub({
      settings: settingsFor(mkdtempSync(join(dir, 'second-'))), port: 0, log: memoryLog().log, pushSender: recordingPush(),
      keyMaker: { secret: () => 'x'.repeat(40), vapid: () => ({ publicKey: 'pub', privateKey: 'priv' }) },
      modules: fakeModules({
        catalog: { manifest: () => Promise.resolve(undefined) },
        link: {
          connections: { stopAll: () => { order.push('links'); return Promise.resolve(); } },
          supervisor: { startAll: () => Promise.resolve(), stopAll: () => { order.push('installed'); return Promise.resolve(); } },
        },
      }),
    });
    const url = second.url;
    await second.stop();
    expect(order).toEqual(['installed', 'links']);
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });
});
