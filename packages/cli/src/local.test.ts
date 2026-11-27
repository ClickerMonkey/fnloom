import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SystemName } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';
import { bundledSystem, bundledSystems } from './commands/available.ts';
import { withSavedAdmin, type HubTarget } from './hub.ts';
import { ADMIN_FILE, BUNDLED_SYSTEMS_DIR, dataFolder, readAdminFile, sameLocalHub } from './local.ts';
import { FakeHub, putFolder, testIo } from './testing.ts';

const WORK = resolve(sep, 'work');
const SYSTEMS = join(resolve(sep, 'harness'), 'systems');

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
    expect(io.lines).toContain('          harness system install database');
    expect(io.lines.some((line) => line.includes('started by harness start always'))).toBe(true);
    expect(io.lines.join('\n')).not.toContain('template');
  });

  it('finds one by its bare name only', async () => {
    const io = testIo();
    premade(io);
    expect(await bundledSystem(io, 'database', SYSTEMS)).toBe(join(SYSTEMS, 'database'));
    for (const name of ['template', 'nothing', '@x/database', '../database', 'database@1.0.0']) { expect(await bundledSystem(io, name, SYSTEMS)).toBeUndefined(); }
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
