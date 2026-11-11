import { join, resolve, sep } from 'node:path';
import { ActorId, InstanceName, LINK_PROTOCOL, MAIN_INSTANCE, PACKAGE_FORMAT, SystemName, type SystemDataExport, type SystemPackageManifest } from '@harness/core';
import { readPackage, sealExport, unzip, zip } from '@harness/hub/package';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COMMANDS, findCommand, helpText, runCli, usageOf } from './cli.ts';
import { command, optionsOf, parseCommand, UsageError } from './command.ts';
import { builtManifest, isExternal, isStale, readSystemJson } from '@harness/build';
import { npmSpec } from './commands/install.ts';
import { cases, rename } from './commands/new.ts';
import { instanceLine, systemLines } from './commands/manage.ts';
import { hubTarget } from './hub.ts';
import { FakeHub, putFolder, testIo } from './testing.ts';

const WORK = resolve(sep, 'work');
const NOTES = join(WORK, 'notes');
const MANIFEST: SystemPackageManifest = {
  format: PACKAGE_FORMAT, name: SystemName.parse('notes'), version: '1.2.0', description: 'Notes.', protocol: LINK_PROTOCOL,
  server: { entry: 'server/main.ts', external: { 'better-sqlite3': '^12.0.0' } }, client: { entry: 'client/index.ts' }, instances: 'many',
};
const text = (s: string) => new TextEncoder().encode(s);

/** A notes system folder in memory. */
function notesFolder(io: ReturnType<typeof testIo>, manifest: SystemPackageManifest = MANIFEST): void {
  putFolder(io.memory, NOTES, { 'system.json': JSON.stringify(manifest), 'shared/index.ts': '// contract', 'server/main.ts': '// server', 'client/index.ts': '// client' });
  io.built.names = ['notes'];
}

describe('arguments', () => {
  const demo = command({
    path: ['demo'], summary: 'Demo.', usage: '<name> [--flag] [--level <n>]',
    args: z.object({ positionals: z.tuple([z.string()]), values: z.object({ flag: z.boolean().default(false), level: z.string().optional() }) }),
    run: () => Promise.resolve(0),
  });

  it('configures parseArgs from the schema and checks the result with it', () => {
    expect(optionsOf(demo.args)).toEqual({ flag: { type: 'boolean' }, level: { type: 'string' } });
    expect(parseCommand(demo, ['x', '--flag', '--level', '3'])).toEqual({ positionals: ['x'], values: { flag: true, level: '3' } });
    expect(parseCommand(demo, ['x'])).toEqual({ positionals: ['x'], values: { flag: false } });
    expect(() => parseCommand(demo, [])).toThrow(UsageError);
    expect(() => parseCommand(demo, ['x', '--nope'])).toThrow(UsageError);
    expect(() => parseCommand(demo, ['x', 'y'])).toThrow(UsageError);
  });

  it('finds the longest command path, lists every command in help, and says how each is called', () => {
    expect(findCommand(['system', 'build', 'x'])?.command.path).toEqual(['system', 'build']);
    expect(findCommand(['system', 'fly'])).toBeUndefined();
    expect(usageOf({ path: ['system', 'list'], usage: '' })).toBe('harness system list');
    for (const c of COMMANDS) { expect(helpText()).toContain(c.summary); }
  });

  it('prints help, refuses unknown commands and bad usage, and reports failures', async () => {
    const io = testIo();
    expect(await runCli([], io)).toBe(0);
    expect(io.lines[0]).toContain('harness');
    expect(await runCli(['system', 'fly'], io)).toBe(2);
    expect(await runCli(['system', 'new'], io)).toBe(2);
    expect(io.warnings.at(-1)).toContain('usage: harness system new <name>');
    expect(await runCli(['system', 'build', 'missing'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('has no system.json');
    expect(await runCli(['system', 'list'], io)).toBe(1);
    expect(io.warnings.at(-1)).toBe('this test has no hub');
  });
});

describe('system new', () => {
  it('names the template’s strings, paths and identifiers after the system', () => {
    expect(cases(SystemName.parse('notes-db'))).toEqual({ camel: 'notesDb', pascal: 'NotesDb', constant: 'NOTES_DB' });
    const source = [
      "export const template = system('template', {});",
      'export const templateEnv = env({ ...systemFields("template") });',
      'export type TemplateConfig = ConfigOf<(typeof template)[\'defs\']>;',
      '# template system',
      'npx tsx systems/template/server/main.ts && zip template-1.0.0.zip',
      '"name": "@harness/system-template"',
      'The template system’s renderers; a templates folder stays.',
      '  TEMPLATE_TIMEOUT: z.number().default(TEMPLATE_DEFAULT), TEMPLATES: 1,',
    ].join('\n');
    expect(rename(source, SystemName.parse('notes-db')).split('\n')).toEqual([
      "export const notesDb = system('notes-db', {});",
      'export const notesDbEnv = env({ ...systemFields("notes-db") });',
      'export type NotesDbConfig = ConfigOf<(typeof notesDb)[\'defs\']>;',
      '# notes-db system',
      'npx tsx systems/notes-db/server/main.ts && zip notes-db-1.0.0.zip',
      '"name": "@harness/system-notes-db"',
      'The notesDb system’s renderers; a templates folder stays.',
      '  NOTES_DB_TIMEOUT: z.number().default(NOTES_DB_DEFAULT), TEMPLATES: 1,',
    ]);
  });

  it('copies a template folder with the name filled in, skipping build output, and refuses a folder that exists', async () => {
    const io = testIo();
    const from = join(WORK, 'tpl');
    putFolder(io.memory, from, {
      'system.json': '{ "name": "template" }', 'shared/index.ts': "system('template', {})", 'node_modules/x/index.js': 'x', 'dist/server/main.js': 'x', 'logo.png': 'binary-template',
    });
    expect(await runCli(['system', 'new', 'notes', '--from', 'tpl', '--dir', '.'], io)).toBe(0);
    expect(io.memory.text(join(NOTES, 'system.json'))).toBe('{ "name": "notes" }');
    expect(io.memory.text(join(NOTES, 'shared', 'index.ts'))).toBe("system('notes', {})");
    expect(io.memory.text(join(NOTES, 'logo.png'))).toBe('binary-template');
    expect([...io.memory.files.keys()].some((p) => p.includes(`notes${sep}node_modules`) || p.includes(`notes${sep}dist`))).toBe(false);
    expect(await runCli(['system', 'new', 'notes', '--from', 'tpl', '--dir', '.'], io)).toBe(1);
    expect(await runCli(['system', 'new', 'template', '--from', 'tpl'], io)).toBe(1);
    expect(await runCli(['system', 'new', 'other', '--from', 'nowhere'], io)).toBe(1);
    expect(await runCli(['system', 'new', 'Bad Name'], io)).toBe(2);
  });

  it('rebases the paths that lead out of the template, so a system made anywhere builds', async () => {
    const io = testIo();
    const from = join(WORK, 'systems', 'template');
    putFolder(io.memory, from, {
      'system.json': '{ "name": "template" }',
      'tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json', compilerOptions: { rootDir: '.', outDir: '../../.types/system-template', tsBuildInfoFile: '../../.types/system-template.tsbuildinfo' },
        include: ['shared'], references: [{ path: '../../packages/core' }],
      }),
      'package.json': JSON.stringify({ name: '@harness/system-template', dependencies: { '@ayepi/env': 'file:../../../ayepi/packages/env', zod: '^4' } }),
    });
    expect(await runCli(['system', 'new', 'notes', '--from', 'systems/template', '--dir', 'elsewhere/deeper'], io)).toBe(0);
    const made = join(WORK, 'elsewhere', 'deeper', 'notes');
    expect(JSON.parse(io.memory.text(join(made, 'tsconfig.json')))).toEqual({
      extends: '../../../tsconfig.base.json', compilerOptions: { rootDir: '.', outDir: '../../../.types/system-notes', tsBuildInfoFile: '../../../.types/system-notes.tsbuildinfo' },
      include: ['shared'], references: [{ path: '../../../packages/core' }],
    });
    expect(JSON.parse(io.memory.text(join(made, 'package.json')))).toEqual({ name: '@harness/system-notes', dependencies: { '@ayepi/env': 'file:../../../../ayepi/packages/env', zod: '^4' } });
    // made where the template sits, nothing moves
    expect(await runCli(['system', 'new', 'other', '--from', 'systems/template', '--dir', 'systems'], io)).toBe(0);
    expect(JSON.parse(io.memory.text(join(WORK, 'systems', 'other', 'tsconfig.json')))).toMatchObject({ extends: '../../tsconfig.base.json' });
  });
});

describe('system build', () => {
  it('typechecks, checks the contract name, bundles the server without its externals, builds the client and writes dist/system.json', async () => {
    const io = testIo();
    notesFolder(io);
    expect(await runCli(['system', 'build', 'notes'], io)).toBe(0);
    expect(io.built.calls).toEqual([
      `typecheck ${NOTES}`,
      `contract ${join(NOTES, 'shared/index.ts')}`,
      `server ${join(NOTES, 'server/main.ts')} -> ${join(NOTES, 'dist', 'server', 'main.js')} external=better-sqlite3`,
      `client ${join(NOTES, 'client/index.ts')} -> ${join(NOTES, 'dist', 'client')}`,
    ]);
    expect(await readSystemJson(io.files, join(NOTES, 'dist'))).toEqual(builtManifest(MANIFEST));
    expect(builtManifest(MANIFEST)).toMatchObject({ server: { entry: 'server/main.js' }, client: { entry: 'client/index.js' } });
  });

  it('stops on type errors and on a contract named otherwise', async () => {
    const io = testIo();
    notesFolder(io);
    io.built.problems = ['server/main.ts(1,1): error TS1005'];
    expect(await runCli(['system', 'build', 'notes'], io)).toBe(1);
    expect(io.warnings).toContain('  server/main.ts(1,1): error TS1005');
    expect(await runCli(['system', 'build', 'notes', '--skip-typecheck'], io)).toBe(0);
    io.built.names = ['jots'];
    expect(await runCli(['system', 'build', 'notes', '--skip-typecheck'], io)).toBe(1);
    expect(io.warnings.at(-1)).toBe('shared/index.ts exports "jots", but system.json names "notes"');
    io.built.names = [];
    expect(await runCli(['system', 'build', 'notes', '--skip-typecheck'], io)).toBe(1);
    expect(io.warnings.at(-1)).toBe('shared/index.ts exports no system contract');
  });

  it('says how many lines of the bundle the scan is concerned about', async () => {
    const io = testIo();
    notesFolder(io);
    io.built.bundleBody = "const run = eval('1');\n";
    expect(await runCli(['system', 'build', 'notes'], io)).toBe(0);
    expect(io.lines.at(-1)).toMatch(/^built notes .* 1 lines of concern in the scan\)$/);
  });

  it('refuses a system.json that is not JSON or not a manifest', async () => {
    const io = testIo();
    putFolder(io.memory, NOTES, { 'system.json': '{ nope' });
    expect(await runCli(['system', 'build', 'notes'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('is not JSON');
    putFolder(io.memory, NOTES, { 'system.json': '{"name":"notes"}' });
    expect(await runCli(['system', 'build', 'notes'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('version');
  });
});

describe('test', () => {
  const report = {
    system: SystemName.parse('notes'), version: '1.0.0', ranAt: 1, duration: 2_300, passed: 3, failed: 1, skipped: 1,
    cases: [
      { file: 'server/notes.test.ts', name: 'notes > saves', status: 'failed' as const, duration: 5, error: 'expected 1 to be 2\n    at server/notes.test.ts:9:3' },
      { file: 'server/notes.test.ts', name: 'notes > titles', status: 'skipped' as const, duration: 0, real: true },
    ],
  };

  it("runs a folder's tests and prints the counts and each failure, failing when one failed", async () => {
    const io = testIo();
    io.tests.report = report;
    expect(await runCli(['test', 'notes', '--previews'], io)).toBe(1);
    expect(io.tests.runs).toEqual([{ dir: NOTES, options: { previews: true } }]);
    expect(io.lines[0]).toBe('notes 1.0.0 (notes): 3 passed, 1 failed, 1 skipped, 1 on a real model in 2.3 s');
    expect(io.lines.slice(1)).toEqual(['  failed: server/notes.test.ts > notes > saves', '    expected 1 to be 2', '    at server/notes.test.ts:9:3']);
  });

  it('prints the report as JSON, and says when a folder has no tests', async () => {
    const io = testIo();
    io.tests.report = { ...report, failed: 0, cases: [] };
    expect(await runCli(['test', '--json', '--filter', 'saves'], io)).toBe(0);
    expect(JSON.parse(io.lines[0] ?? '')).toMatchObject({ system: 'notes', failed: 0 });
    expect(io.tests.runs[0]?.options).toEqual({ previews: false, filters: ['saves'] });
    io.tests.report = undefined;
    expect(await runCli(['test', 'notes'], io)).toBe(0);
    expect(io.lines.at(-1)).toBe('notes has no tests.');
  });
});

describe('system pack', () => {
  it('builds a stale folder, then zips dist/ with every file hashed', async () => {
    const io = testIo();
    notesFolder(io);
    expect(await isStale(io.files, NOTES)).toBe(true);
    expect(await runCli(['system', 'pack', 'notes'], io)).toBe(0);
    const out = join(NOTES, 'notes-1.2.0.zip');
    const checked = readPackage(unzip(await io.files.read(out), 1e6));
    expect(checked.manifest).toMatchObject({ name: 'notes', version: '1.2.0', server: { entry: 'server/main.js' } });
    expect(checked.files.map((f) => f.path)).toEqual(['client/index.js', 'server/main.js']);
    expect(io.lines.at(-1)).toContain('packed notes 1.2.0: 2 files');

    // a fresh dist/ packs again without building, to the same bytes
    io.built.calls.length = 0;
    expect(await isStale(io.files, NOTES)).toBe(false);
    expect(await runCli(['system', 'pack', 'notes', '--out', 'out.zip'], io)).toBe(0);
    expect(io.built.calls).toEqual([]);
    expect(await io.files.read(join(WORK, 'out.zip'))).toEqual(await io.files.read(out));

    // a source change makes it stale
    io.memory.now += 10;
    io.memory.put(join(NOTES, 'server', 'main.ts'), '// changed');
    expect(await isStale(io.files, NOTES)).toBe(true);
  });

  it('packs nothing when the build fails', async () => {
    const io = testIo();
    notesFolder(io);
    io.built.problems = ['bad'];
    expect(await runCli(['system', 'pack', 'notes'], io)).toBe(1);
    expect(await io.files.stat(join(NOTES, 'notes-1.2.0.zip'))).toBeUndefined();
  });
});

describe('system install', () => {
  it('uploads a zip (and a data export) and installs it as a package, then waits for it to connect', async () => {
    const hub = new FakeHub({
      installPackage: (body) => ({ system: SystemName.parse('notes'), instance: InstanceName.parse(body.instance ?? MAIN_INSTANCE) }),
      instances: () => systemView().instances,
    });
    const io = testIo({ hub });
    io.memory.put(join(WORK, 'notes-1.2.0.zip'), text('zip'));
    io.memory.put(join(WORK, 'export.zip'), text('export'));
    io.memory.put(join(WORK, 'config.json'), '{"folder":"/notes"}');
    expect(await runCli(['system', 'install', 'notes-1.2.0.zip', '--instance', 'laptop', '--data', 'export.zip', '--config', 'config.json'], io)).toBe(0);
    expect(hub.uploads.map((u) => [u.name, u.mime])).toEqual([['notes-1.2.0.zip', 'application/zip'], ['export.zip', 'application/zip']]);
    expect(io.lines).toEqual(['installed notes@laptop', 'notes@laptop is connected']);
    expect(hub.called).toEqual(['installPackage', 'instances']);
    expect(hub.closed).toBe(1);
  });

  it('installs a zip alone (no instance, data or config) without starting it when asked', async () => {
    const fields: string[][] = [];
    const hub = new FakeHub({
      installPackage: (body) => { fields.push(Object.keys(body).sort()); return { system: SystemName.parse('notes'), instance: MAIN_INSTANCE }; },
    });
    const io = testIo({ hub });
    io.memory.put(join(WORK, 'notes-1.2.0.zip'), text('zip'));
    expect(await runCli(['system', 'install', 'notes-1.2.0.zip', '--no-start'], io)).toBe(0);
    expect(fields).toEqual([['autoStart', 'zip']]);
    expect(io.lines).toEqual([`installed notes@${MAIN_INSTANCE}`]);
    expect(hub.called).toEqual(['installPackage']);
  });

  it('installs a folder in place and an npm package by spec, and says when one needs config or has not connected', async () => {
    const sources: unknown[] = [];
    let status: 'needs-config' | 'disconnected' = 'needs-config';
    const hub = new FakeHub({
      installSystem: (body) => { sources.push(body.source); return { name: SystemName.parse('notes') }; },
      system: () => ({ ...systemView(), status }),
    });
    const io = testIo({ hub });
    notesFolder(io);
    expect(await runCli(['system', 'install', 'notes'], io)).toBe(0);
    expect(io.lines.at(-1)).toContain('needs config');
    status = 'disconnected';
    expect(await runCli(['system', 'install', '@x/notes@1.2.0', '--wait', '0'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('has not connected yet (disconnected)');
    expect(await runCli(['system', 'install', 'notes', '--no-start'], io)).toBe(0);
    expect(sources).toEqual([{ path: NOTES }, { package: '@x/notes', version: '1.2.0' }, { path: NOTES }]);
    expect(await runCli(['system', 'install', 'notes', '--instance', 'laptop'], io)).toBe(1);
    expect(io.warnings.at(-1)).toBe('--instance and --data go with a package zip');
  });

  it('reads npm specs', () => {
    expect(npmSpec('notes')).toEqual({ package: 'notes', version: 'latest' });
    expect(npmSpec('notes@2.0.0')).toEqual({ package: 'notes', version: '2.0.0' });
    expect(npmSpec('@x/notes')).toEqual({ package: '@x/notes', version: 'latest' });
    expect(npmSpec('@x/notes@')).toEqual({ package: '@x/notes', version: 'latest' });
  });
});

describe('system export-data', () => {
  it('asks the hub for an export and downloads it, with secrets only when confirmed', async () => {
    const exported = zip(sealExport({ info: exportInfo(false), data: [{ path: 'a.md', bytes: text('# a') }] }));
    const asked: unknown[] = [];
    const hub = new FakeHub({
      exportSystemData: (body) => { asked.push(body); return { hash: 'a'.repeat(64), size: exported.length, mime: 'application/zip', url: '/files/export' }; },
    });
    hub.downloads.set('/files/export', exported);
    const io = testIo({ hub });
    expect(await runCli(['system', 'export-data', 'notes', '--instance', 'laptop'], io)).toBe(0);
    expect(await io.files.read(join(WORK, 'notes-laptop-data.zip'))).toEqual(exported);
    expect(await runCli(['system', 'export-data', 'notes', '--with-secrets'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('--yes');
    expect(await runCli(['system', 'export-data', 'notes', '--with-secrets', '--yes', '--out', 'x.zip'], io)).toBe(0);
    expect(asked).toEqual([{ system: 'notes', instance: 'laptop', withSecrets: false }, { system: 'notes', instance: 'main', withSecrets: true }]);
  });
});

describe('managing installed systems', () => {
  it('lists systems with their instances, starts, stops, upgrades and uninstalls', async () => {
    const removed: string[] = [];
    const started: unknown[] = [];
    const hub = new FakeHub({
      systems: () => [systemView()],
      startSystem: (body) => { started.push(body); return { ok: true }; },
      stopSystem: (body) => { started.push(body); return { ok: true }; },
      upgradeSystem: () => ({ from: '1.0.0', to: '1.1.0' }),
      instances: () => systemView().instances,
      removeInstance: (body) => { removed.push(body.instance); return { ok: true }; },
    });
    const io = testIo({ hub });
    expect(await runCli(['system', 'list'], io)).toBe(0);
    expect(io.lines[0]).toContain('2 instances, 1 connected');
    expect(io.lines[1]).toContain('laptop');
    expect(await runCli(['system', 'start', 'notes'], io)).toBe(0);
    expect(await runCli(['system', 'stop', 'notes', '--instance', 'laptop'], io)).toBe(0);
    expect(io.lines.at(-1)).toBe('stopped notes@laptop');
    expect(started).toEqual([{ system: 'notes' }, { system: 'notes', instance: 'laptop' }]);
    expect(await runCli(['system', 'upgrade', 'notes', '--version', '1.1.0'], io)).toBe(0);
    expect(io.lines.at(-1)).toBe('upgraded notes from 1.0.0 to 1.1.0');
    expect(await runCli(['system', 'uninstall', 'notes', '--instance', 'desk'], io)).toBe(0);
    expect(await runCli(['system', 'uninstall', 'notes'], io)).toBe(0);
    expect(removed).toEqual(['desk', 'laptop', 'desk']);
    expect(await runCli(['system', 'uninstall', 'notes', '--instance', 'attic'], io)).toBe(1);
    const empty = testIo({ hub: new FakeHub({ systems: () => [] }) });
    expect(await runCli(['system', 'list'], empty)).toBe(0);
    expect(empty.lines).toEqual(['no systems yet']);
  });

  it('reports what the hub refused', async () => {
    const io = testIo({ hub: new FakeHub({ startSystem: () => { throw new Error('notes is not installed'); } }) });
    expect(await runCli(['system', 'start', 'notes'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('notes is not installed');
  });

  it('draws instance lines', () => {
    const [laptop] = systemView().instances;
    if (laptop === undefined) { throw new Error('no instance'); }
    expect(instanceLine(laptop)).toMatch(/laptop\s+connected\s+1\.2\.0 \(installed, running\)/);
    expect(systemLines({ ...systemView(), instances: [] })).toHaveLength(1);
  });
});

describe('the build seams', () => {
  it('leaves Node, the externals and the build tools out of a server bundle', () => {
    expect(isExternal('node:fs', [])).toBe(true);
    expect(isExternal('fs', [])).toBe(true);
    expect(isExternal('better-sqlite3', ['better-sqlite3'])).toBe(true);
    expect(isExternal('better-sqlite3/lib/x', ['better-sqlite3'])).toBe(true);
    expect(isExternal('vite', [])).toBe(true);
    expect(isExternal('@harness/sdk/build', [])).toBe(true);
    expect(isExternal('@harness/sdk/server', [])).toBe(false);
    expect(isExternal('zod', ['better-sqlite3'])).toBe(false);
  });

  it('finds the hub from options, then settings', () => {
    const io = testIo();
    expect(hubTarget(io.settings, {})).toEqual({ url: 'http://127.0.0.1:4300', token: undefined, admin: undefined });
    expect(hubTarget({ ...io.settings, HARNESS_ADMIN_EMAIL: 'a@b.c', HARNESS_ADMIN_PASSWORD: 'p' }, { hub: 'http://h:1/', token: 't' }))
      .toEqual({ url: 'http://h:1', token: 't', admin: { email: 'a@b.c', password: 'p' } });
  });
});

/** A system view as the hub's `systems` answers, with two instances. */
function systemView() {
  const instance = (name: string, status: 'connected' | 'disconnected', installed: boolean) => ({
    system: SystemName.parse('notes'), instance: InstanceName.parse(name), description: '', status, keyFingerprint: 'fp', version: '1.2.0', manifestHash: 'h',
    ...(installed ? {
      installed: {
        name: SystemName.parse('notes'), instance: InstanceName.parse(name), source: { zip: 'a'.repeat(64), file: 'notes-1.2.0.zip' }, dir: '/s/notes',
        command: { run: 'node', args: [], env: {} }, version: '1.2.0', autoStart: true, restart: { policy: 'on-failure' as const, backoff: 1, maxPerHour: 1 },
        status: 'running' as const, installedBy: 'act_admin', installedAt: 1,
      },
    } : {}),
  });
  return {
    name: SystemName.parse('notes'), description: 'Notes.', status: 'connected' as const, enabled: { functions: true, renderers: true }, version: '1.2.0', manifestHash: 'h',
    actor: 'act_notes', keyFingerprint: 'fp', fns: 2, needsConfig: false, instances: [instance('laptop', 'connected', true), instance('desk', 'disconnected', false)],
  };
}

/** An export's info. */
function exportInfo(withSecrets: boolean): SystemDataExport {
  return { format: PACKAGE_FORMAT, system: SystemName.parse('notes'), instance: InstanceName.parse('laptop'), version: '1.2.0', exportedAt: 1, exportedBy: ActorId.parse('act_admin'), withSecrets };
}
