/**
 * System packages and fleets, end to end, on a hub of its own: the CLI packs the real fs into a zip, installs it
 * twice as two instances (`laptop` and `desk`) that the hub runs beside itself, each gets its own folders as config
 * and serves its own files, reads route to the instance whose root holds the URI, the CLI exports one instance's
 * data, and removing one instance leaves the other.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env } from '@ayepi/env';
import { InstanceName, SystemName, type InstanceView } from '@harness/core';
import { readExport, readPackage, unzip } from '@harness/hub/package';
import { encodeValue } from '@harness/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCli } from '../packages/cli/src/cli.ts';
import { nodeIo } from '../packages/cli/src/io.ts';
import { waitFor } from '../scripts/hub-client.ts';
import { ROOT, startStack, type Stack } from '../scripts/stack.ts';
import { fileUri } from '../systems/fs/server/paths.ts';
import { fs } from '../systems/fs/shared/index.ts';

/** Where this test's hub runs (the packaging lane's ports and data). */
const packageEnv = env({
  HARNESS_E2E_PACKAGE_PORT: z.number().int().min(4301).max(65535).default(4421),
  HARNESS_E2E_PACKAGE_DATA: z.string().default('.harness-test/packaging/e2e'),
});
const settings = packageEnv.parse();
const FS = SystemName.parse('fs');
const LAPTOP = InstanceName.parse('laptop');
const DESK = InstanceName.parse('desk');
const ADMIN = { email: 'package-e2e@harness.local', password: 'package-e2e-password' };
/** A packed fs starts quickly, but the first start pairs and imports its contract. */
const START = 120_000;

let stack: Stack;
let data: string;

/** Run the CLI as a person would, against this test's hub. */
function cli(...argv: string[]): Promise<number> {
  return runCli(argv, nodeIo(data, { HARNESS_URL: stack.url, HARNESS_ADMIN_EMAIL: ADMIN.email, HARNESS_ADMIN_PASSWORD: ADMIN.password }));
}

/** The fs instances as the hub sees them. */
function instances(): Promise<InstanceView[]> {
  return stack.admin.hub.call('instances', { system: FS });
}

/** A folder with one file, as an instance's root. */
function folder(name: string, text: string): string {
  const path = join(data, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'note.md'), text);
  return path;
}

beforeAll(async () => {
  data = resolve(ROOT, settings.HARNESS_E2E_PACKAGE_DATA);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  stack = await startStack({
    port: settings.HARNESS_E2E_PACKAGE_PORT, data: join(data, 'hub'), admin: ADMIN, build: false, watch: false, only: new Set(['hub']),
    systems: { fs: { roots: [] }, embedder: {} }, hubEnv: { HARNESS_LOG_FILES: 'false' },
    output: (component, line) => { appendFileSync(join(data, 'stack.log'), `${component.padEnd(9)} ${line}\n`); },
  });
}, START);

afterAll(async () => {
  await stack.stop();
});

describe('a packed fs fleet', () => {
  it('packs fs and installs it twice, as two instances the hub runs', async () => {
    expect(await cli('system', 'pack', join(ROOT, 'systems', 'fs'), '--skip-typecheck', '--out', 'fs.zip')).toBe(0);
    expect(await cli('system', 'install', 'fs.zip', '--instance', 'laptop', '--wait', String(START))).toBe(0);
    expect(await cli('system', 'install', 'fs.zip', '--instance', 'desk', '--wait', String(START))).toBe(0);
    const both = await instances();
    expect(both.map((i) => [i.instance, i.installed?.source !== undefined && 'zip' in i.installed.source ? i.installed.source.file : undefined])).toEqual([
      ['desk', 'fs-0.2.0.zip'],
      ['laptop', 'fs-0.2.0.zip'],
    ]);
  }, START * 3);

  it('gives each instance its own folders, and routes reads to the instance whose root holds the file', async () => {
    const laptopRoot = folder('laptop-files', 'on the laptop');
    const deskRoot = folder('desk-files', 'on the desk');
    for (const [instance, path] of [[LAPTOP, laptopRoot], [DESK, deskRoot]] as const) {
      const config = encodeValue(fs.defs.config, { roots: [{ name: instance, path, writable: false, index: 'none' }] });
      expect(await stack.admin.hub.call('configureSystem', { system: FS, instance, config })).toHaveProperty('version');
    }
    await waitFor('both instances connected', async () => {
      const now = await instances();
      return now.length === 2 && now.every((i) => i.status === 'connected') ? now : undefined;
    }, { timeout: START, every: 500 });
    const uriOf = (path: string) => fileUri(join(path, 'note.md'));
    const read = (path: string) => waitFor(`a read of ${path}`, async () => {
      const got = await stack.admin.hub.call('resource', { uri: uriOf(path), want: ['text'] });
      return got.text !== undefined && 'inline' in got.text ? got.text.inline : undefined;
    }, { timeout: 30_000, every: 500 });
    expect(await read(laptopRoot)).toBe('on the laptop');
    expect(await read(deskRoot)).toBe('on the desk');
  }, START * 2);

  it('exports one instance’s data with the CLI', async () => {
    const dataDir = (await instances()).find((i) => i.instance === LAPTOP)?.dirs?.data;
    if (dataDir === undefined) { throw new Error('laptop has no data folder'); }
    mkdirSync(join(dataDir, 'kept'), { recursive: true });
    writeFileSync(join(dataDir, 'kept', 'a.txt'), 'mine');
    expect(await cli('system', 'export-data', 'fs', '--instance', 'laptop', '--out', 'laptop-data.zip')).toBe(0);
    const exported = readExport(unzip(new Uint8Array(readFileSync(join(data, 'laptop-data.zip'))), 1e8));
    expect(exported.info).toMatchObject({ system: 'fs', instance: 'laptop', withSecrets: false });
    expect(exported.data.map((f) => f.path)).toContain('kept/a.txt');
  }, START);

  it('restores that export into a new instance with the CLI', async () => {
    expect(await cli('system', 'install', 'fs.zip', '--instance', 'spare', '--data', 'laptop-data.zip', '--no-start')).toBe(0);
    const dataDir = (await instances()).find((i) => i.instance === InstanceName.parse('spare'))?.dirs?.data;
    if (dataDir === undefined) { throw new Error('spare has no data folder'); }
    expect(readFileSync(join(dataDir, 'kept', 'a.txt'), 'utf8')).toBe('mine');
    expect(await cli('system', 'uninstall', 'fs', '--instance', 'spare')).toBe(0);
  }, START);

  it('packs the embedder too, into a package the hub would take', async () => {
    expect(await cli('system', 'pack', join(ROOT, 'systems', 'embedder'), '--skip-typecheck', '--out', 'embedder.zip')).toBe(0);
    const packed = readPackage(unzip(new Uint8Array(readFileSync(join(data, 'embedder.zip'))), 1e8));
    expect(packed.manifest).toMatchObject({ name: 'embedder', instances: 'one', server: { entry: 'server/main.js' } });
  }, START);

  it('removes one instance and keeps the other', async () => {
    expect(await cli('system', 'uninstall', 'fs', '--instance', 'desk')).toBe(0);
    const after = await instances();
    expect(after.find((i) => i.instance === DESK)).toMatchObject({ status: 'removed' });
    expect(after.find((i) => i.instance === LAPTOP)).toMatchObject({ status: 'connected' });
    expect((await stack.admin.hub.call('system', { system: FS })).status).toBe('connected');
  }, START);
});
