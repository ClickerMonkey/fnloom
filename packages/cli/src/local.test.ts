import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InstanceName, SystemName } from '@harness/core';
import { zip } from '@harness/hub/package';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';
import { bundledSystem, bundledSystems } from './commands/available.ts';
import { withSavedAdmin, type HubTarget } from './hub.ts';
import { ADMIN_FILE, BUNDLED_SYSTEMS_DIR, PREMADE_DIR, dataFolder, readAdminFile, sameLocalHub } from './local.ts';
import { packagedSystems, startComponents, startedWhen, systemOfComponent } from './premade.ts';
import { FakeHub, putFolder, testIo } from './testing.ts';

const WORK = resolve(sep, 'work');
const SYSTEMS = join(resolve(sep, 'harness'), 'systems');
const PREMADE = join(resolve(sep, 'harness'), 'premade');

/** Premade systems in memory: database (a fleet), schedule, and the template, which is not one to install. */
function premade(io: ReturnType<typeof testIo>, dir = SYSTEMS): void {
  const manifest = (name: string, instances: 'one' | 'many') => JSON.stringify({ format: 1, name, version: '0.1.0', description: `The ${name} system.`, protocol: 1, server: { entry: 'server/main.ts', external: {} }, instances });
  putFolder(io.memory, join(dir, 'database'), { 'system.json': manifest('database', 'many'), 'server/main.ts': '// server' });
  putFolder(io.memory, join(dir, 'schedule'), { 'system.json': manifest('schedule', 'one'), 'server/main.ts': '// server' });
  putFolder(io.memory, join(dir, 'template'), { 'system.json': manifest('template', 'one') });
  putFolder(io.memory, join(dir, 'fs'), { 'system.json': manifest('fs', 'one') });
}

describe('harness start', () => {
  it('starts the stack here with the options it was given', async () => {
    const io = testIo({ cwd: WORK });
    expect(await runCli(['start'], io)).toBe(0);
    expect(await runCli(['start', '--port', '4620', '--data', 'data', '--root', 'notes', '--systems', 'hub,fs'], io)).toBe(0);
    expect(io.started).toEqual([{ cwd: WORK }, { cwd: WORK, port: '4620', data: 'data', root: 'notes', systems: 'hub,fs' }]);
  });

  it('refuses a port that is not a number and a system list that is not one', async () => {
    const io = testIo();
    expect(await runCli(['start', '--port', 'abc'], io)).toBe(2);
    expect(await runCli(['start', '--systems', 'hub fs'], io)).toBe(2);
    expect(await runCli(['start', 'extra'], io)).toBe(2);
    expect(io.started).toEqual([]);
  });
});

describe('premade systems', () => {
  it('lists the ones this harness carries, never the template, saying which harness start runs', async () => {
    const io = testIo();
    premade(io);
    expect((await bundledSystems(io, SYSTEMS)).map((s) => [s.folder, s.instances])).toEqual([['database', 'many'], ['fs', 'one'], ['schedule', 'one']]);
    premade(io, BUNDLED_SYSTEMS_DIR);
    expect(await runCli(['system', 'available'], io)).toBe(0);
    expect(io.lines).toContain('          harness system install database, which fetches its own dependencies (installs widgets with it)');
    expect(io.lines.some((line) => line.includes('started by harness start always'))).toBe(true);
    expect(io.lines.join('\n')).not.toContain('template');
  });

  it('lists a heavy one from its package zip when its folder is not here (the published package)', async () => {
    const io = testIo();
    putFolder(io.memory, join(SYSTEMS, 'fs'), { 'system.json': JSON.stringify({ format: 1, name: 'fs', version: '0.1.0', description: 'Files.', protocol: 1, server: { entry: 'server/main.ts', external: {} } }) });
    const manifest = { format: 1, name: 'web', version: '0.1.0', description: 'The web.', protocol: 1, server: { entry: 'server/main.js', external: { puppeteer: '^25.0.0' } }, instances: 'one' };
    await io.memory.write(join(PREMADE, 'web.zip'), zip([{ path: 'system.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) }]));
    await io.memory.write(join(PREMADE, 'stray.zip'), zip([]));
    expect((await bundledSystems(io, SYSTEMS, PREMADE)).map((s) => [s.folder, s.packaged, s.description])).toEqual([['fs', false, 'Files.'], ['web', true, 'The web.']]);
    expect(await bundledSystem(io, 'web', SYSTEMS, PREMADE)).toBe(join(PREMADE, 'web.zip'));
    expect(await bundledSystem(io, 'stray', SYSTEMS, PREMADE)).toBeUndefined();
  });

  it('finds one by its bare name only', async () => {
    const io = testIo();
    premade(io);
    expect(await bundledSystem(io, 'database', SYSTEMS)).toBe(join(SYSTEMS, 'database'));
    for (const name of ['template', 'nothing', '@x/database', '../database', 'database@1.0.0']) { expect(await bundledSystem(io, name, SYSTEMS)).toBeUndefined(); }
  });

  it('starts the lightweight ones, and the ones that need settings once they are set', () => {
    expect(startComponents({})).toEqual(['hub', 'fs', 'input', 'code', 'schedule', 'api']);
    expect(startComponents({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', HARNESS_EMBEDDER_URL: 'http://e' })).toEqual(['hub', 'fs', 'input', 'code', 'schedule', 'api', 'calendar', 'embedder']);
    expect(startComponents({ GOOGLE_CLIENT_ID: 'id' })).not.toContain('calendar');
    // the heavy ones and widgets (which goes with database) are installed, never started
    for (const name of ['database', 'web', 'claude', 'widgets']) { expect(startedWhen(name)).toBeUndefined(); }
    expect(packagedSystems().sort()).toEqual(['claude', 'database', 'web']);
    expect(systemOfComponent('calendar')).toBe('google-calendar');
    expect(systemOfComponent('web-system')).toBe('web');
    expect(systemOfComponent('fs')).toBe('fs');
  });

  it('installs one by its bare name from its folder; a folder of that name here, or a version, wins', async () => {
    const sources: unknown[] = [];
    const hub = new FakeHub({
      installSystem: (body) => { sources.push(body.source); return { name: SystemName.parse('database') }; },
      system: () => { throw new Error('not asked'); },
    });
    const io = testIo({ hub, cwd: WORK });
    premade(io, BUNDLED_SYSTEMS_DIR);
    expect(await runCli(['system', 'install', 'database', '--no-start'], io)).toBe(0);
    expect(await runCli(['system', 'install', 'database@1.0.0', '--no-start'], io)).toBe(0);
    putFolder(io.memory, join(WORK, 'database'), { 'system.json': '{}' });
    expect(await runCli(['system', 'install', 'database', '--no-start'], io)).toBe(0);
    expect(sources).toEqual([{ path: join(BUNDLED_SYSTEMS_DIR, 'database') }, { package: 'database', version: '1.0.0' }, { path: join(WORK, 'database') }]);
  });

  it('installs database with widgets when the hub has no widgets yet, and a heavy one from its package zip', async () => {
    const sources: unknown[] = [];
    const zips: unknown[] = [];
    let widgets = false;
    const hub = new FakeHub({
      installSystem: (body) => { sources.push(body.source); widgets = true; return { name: SystemName.parse('widgets') }; },
      installPackage: (body) => { zips.push(body.zip); return { system: SystemName.parse('database'), instance: InstanceName.parse('main') }; },
      system: () => {
        if (!widgets) { throw Object.assign(new Error('no such system'), { status: 404 }); }
        return {
          name: SystemName.parse('widgets'), description: 'Widgets.', status: 'connected', enabled: { functions: true, renderers: true }, version: '0.1.0', manifestHash: 'h',
          actor: 'act_widgets', keyFingerprint: 'fp', counts: { fns: 1, context: 0, types: 0, parts: 0, instances: 1, pending: 0, refusals: 0 }, instanceMode: 'one', needsConfig: false, instances: [],
        };
      },
    });
    const io = testIo({ hub, cwd: WORK });
    putFolder(io.memory, join(BUNDLED_SYSTEMS_DIR, 'widgets'), { 'system.json': JSON.stringify({ format: 1, name: 'widgets', version: '0.1.0', protocol: 1, server: { entry: 'server/main.ts', external: {} } }) });
    await io.memory.write(join(PREMADE_DIR, 'database.zip'), zip([{ path: 'system.json', bytes: new TextEncoder().encode('{}') }]));
    expect(await runCli(['system', 'install', 'database', '--no-start'], io)).toBe(0);
    expect(zips).toHaveLength(1);
    expect(sources).toEqual([{ path: join(BUNDLED_SYSTEMS_DIR, 'widgets') }]);
    // widgets is there now: a second database instance doesn't install it again
    expect(await runCli(['system', 'install', 'database', '--instance', 'shop', '--no-start'], io)).toBe(0);
    expect(zips).toHaveLength(2);
    expect(sources).toHaveLength(1);
  });

  it('leaves a system harness start runs alone when the hub already has it', async () => {
    const hub = new FakeHub({
      installSystem: () => { throw new Error('not asked'); },
      system: () => ({
        name: SystemName.parse('fs'), description: 'Files.', status: 'connected', enabled: { functions: true, renderers: true }, version: '0.2.0', manifestHash: 'h',
        actor: 'act_fs', keyFingerprint: 'fp', counts: { fns: 1, context: 0, types: 0, parts: 0, instances: 1, pending: 0, refusals: 0 }, instanceMode: 'many', needsConfig: false, instances: [],
      }),
    });
    const io = testIo({ hub, cwd: WORK });
    premade(io, BUNDLED_SYSTEMS_DIR);
    expect(await runCli(['system', 'install', 'fs'], io)).toBe(0);
    expect(hub.called).not.toContain('installSystem');
    expect(io.lines.some((line) => line.includes('fs is already on this hub'))).toBe(true);
  });

  it('says widgets wants database when it is installed alone', async () => {
    const hub = new FakeHub({
      installSystem: () => ({ name: SystemName.parse('widgets') }),
      system: () => { throw Object.assign(new Error('no such system'), { status: 404 }); },
    });
    const io = testIo({ hub, cwd: WORK });
    putFolder(io.memory, join(BUNDLED_SYSTEMS_DIR, 'widgets'), { 'system.json': '{}' });
    expect(await runCli(['system', 'install', 'widgets', '--no-start'], io)).toBe(0);
    expect(io.lines.some((line) => line.includes('install database too'))).toBe(true);
  });
});

describe('the admin account harness start saved', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });

  it('is in the data folder: the option, else HARNESS_DATA, else ~/.harness', () => {
    expect(dataFolder(WORK, 'data', { HARNESS_DATA: 'other' })).toBe(join(WORK, 'data'));
    expect(dataFolder(WORK, undefined, { HARNESS_DATA: 'other' })).toBe(join(WORK, 'other'));
    expect(dataFolder(WORK, undefined, {})).toBe(join(homedir(), '.harness'));
  });

  it('reads back, and a missing or broken file is no account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-admin-'));
    dirs.push(dir);
    expect(readAdminFile(dir)).toBeUndefined();
    writeFileSync(join(dir, ADMIN_FILE), '{ not json');
    expect(readAdminFile(dir)).toBeUndefined();
    writeFileSync(join(dir, ADMIN_FILE), JSON.stringify({ url: 'http://127.0.0.1:4300', email: 'admin@harness.local', password: 'a-long-password' }));
    expect(readAdminFile(dir)).toEqual({ url: 'http://127.0.0.1:4300', email: 'admin@harness.local', password: 'a-long-password' });
  });

  it('signs in to that same hub on this machine only, and never over a sign-in that was given', () => {
    const saved = { url: 'http://127.0.0.1:4620', email: 'admin@harness.local', password: 'a-long-password' };
    const admin = { email: saved.email, password: saved.password };
    const target = (url: string, extra: Partial<HubTarget> = {}): HubTarget => ({ url, token: undefined, admin: undefined, ...extra });
    expect(withSavedAdmin(target('http://localhost:4620'), saved).admin).toEqual(admin);
    expect(withSavedAdmin(target('https://127.0.0.1:4620'), saved).admin).toEqual(admin);
    expect(withSavedAdmin(target('http://127.0.0.1:4300'), saved).admin).toBeUndefined();
    expect(withSavedAdmin(target('http://192.168.1.5:4620'), saved).admin).toBeUndefined();
    expect(withSavedAdmin(target('http://127.0.0.1:4620', { token: 't' }), saved)).toEqual(target('http://127.0.0.1:4620', { token: 't' }));
    const given = { email: 'me@example.com', password: 'mine-mine-mine' };
    expect(withSavedAdmin(target('http://127.0.0.1:4620', { admin: given }), saved).admin).toEqual(given);
    expect(withSavedAdmin(target('http://127.0.0.1:4620'), undefined).admin).toBeUndefined();
    expect(sameLocalHub('http://127.0.0.1', 'http://localhost:80')).toBe(true);
    expect(sameLocalHub('not a url', 'http://127.0.0.1:4300')).toBe(false);
  });
});
