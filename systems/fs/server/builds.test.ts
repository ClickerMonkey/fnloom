/**
 * `HarnessBuilds`: a build copies `dist/` into the version folder with its package.json, hashes the bundle, reads the
 * contract's manifest and words the card's lines; a broken folder or contract is refused, typecheck problems come back,
 * and the source hash changes with any source file but not with `dist/`.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFiles, summaryOf, type ContractSummary, type SystemBuilder } from '@harness/build';
import { SystemName, type Manifest } from '@harness/core';
import { manifestOf } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { fs } from '../shared/index.ts';
import { HarnessBuilds } from './builds.ts';
import { InstallRefused, scanLines } from './hosting.ts';

const dirs: string[] = [];
async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-fs-builds-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text, 'utf8');
  }
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A builder that bundles stand-in output and reads the fs contract. */
class StandInBuilder implements SystemBuilder {
  problems: string[] = [];
  contractName = SystemName.parse('fs');
  typecheck(): Promise<string[]> { return Promise.resolve(this.problems); }
  async contracts(): Promise<ContractSummary[]> { return [await summaryOf(fs)]; }
  async manifests(_module: string, options: { version: string }): Promise<Manifest[]> {
    const manifest = await manifestOf(fs, { version: options.version });
    return [{ ...manifest, name: this.contractName }];
  }
  async bundleServer(input: { outDir: string; fileName: string }): Promise<void> {
    await new NodeFiles().write(join(input.outDir, input.fileName), "import 'node:child_process';\nfetch('https://example.com');\nexport {};\n");
  }
  buildClient(): Promise<void> { return Promise.resolve(); }
}

const systemJson = JSON.stringify({ format: 1, name: 'fs', version: '0.2.0', description: 'Files.', protocol: 1, server: { entry: 'server/main.ts', external: {} } });

describe('HarnessBuilds', () => {
  it('builds into the version folder with the card lines', async () => {
    const dir = await folder({ 'system.json': systemJson, 'server/main.ts': 'export {};\n' });
    const out = join(await folder({}), 'v1');
    const builds = new HarnessBuilds({ builder: new StandInBuilder(), files: new NodeFiles() });
    const result = await builds.build(dir, out);
    if (!('built' in result)) { throw new Error(result.problems.join('\n')); }
    const { built } = result;
    expect(JSON.parse(await readFile(join(out, 'package.json'), 'utf8'))).toEqual({ name: 'fs', version: '0.2.0', private: true, type: 'module' });
    expect(built.bundleHash).toBe(await builds.bundleHash(built.entry));
    expect(built.manifestHash).toMatch(/\S/);
    // the contract goes with the card, hashed as the subject binds it
    expect(built.contract).toMatchObject({ name: 'fs', hash: built.manifestHash });
    expect(built.fns.some((line) => line.startsWith('fs/read'))).toBe(true);
    expect(built.adds.some((line) => line.startsWith('Types: '))).toBe(true);
    expect(built.scan.builtins).toEqual(['child_process']);
    expect(scanLines(built.scan)).toContain('Node built-ins: child_process.');
  });

  it('returns typecheck problems and refuses a folder without system.json or a missing contract', async () => {
    const dir = await folder({ 'system.json': systemJson, 'server/main.ts': 'export {};\n' });
    const builder = new StandInBuilder();
    const builds = new HarnessBuilds({ builder, files: new NodeFiles() });
    builder.problems = ['server/main.ts:1:1 Broken.'];
    expect(await builds.build(dir, join(dir, 'out'))).toEqual({ problems: ['server/main.ts:1:1 Broken.'] });
    builder.problems = [];
    builder.contractName = SystemName.parse('other');
    expect(await builds.build(dir, join(dir, 'out2'))).toEqual({ problems: ['shared/index.ts exports "other", but system.json names "fs"'] });
    await expect(builds.build(await folder({ 'readme.md': 'x' }), join(dir, 'out3'))).rejects.toBeInstanceOf(InstallRefused);
  });

  it('hashes the sources, not dist', async () => {
    const dir = await folder({ 'system.json': systemJson, 'server/main.ts': 'export {};\n' });
    const builds = new HarnessBuilds({ builder: new StandInBuilder(), files: new NodeFiles() });
    const first = await builds.sourceHash(dir);
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'dist', 'server.js'), 'built', 'utf8');
    expect(await builds.sourceHash(dir)).toBe(first);
    await writeFile(join(dir, 'server', 'main.ts'), 'export const changed = 1;\n', 'utf8');
    expect(await builds.sourceHash(dir)).not.toBe(first);
  });

  it('hashes the same reading the files side by side as one after another', async () => {
    const dir = await folder({ 'system.json': systemJson, 'server/main.ts': 'export {};\n', 'server/a.ts': 'a', 'server/b.ts': 'b', 'shared/index.ts': 'c' });
    const one = await new HarnessBuilds({ builder: new StandInBuilder(), files: new NodeFiles(), readParallel: 1 }).sourceHash(dir);
    expect(await new HarnessBuilds({ builder: new StandInBuilder(), files: new NodeFiles(), readParallel: 4 }).sourceHash(dir)).toBe(one);
  });
});
