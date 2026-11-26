import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROOT } from '../stack.ts';
import { hostedFolders, keptFiles, makeWorkspace } from './authoring.ts';

const FOLDER = join(ROOT, '.harness-test', 'scenarios-authoring-test');

afterAll(() => { rmSync(FOLDER, { recursive: true, force: true }); });

describe('the authoring workspace', () => {
  it('holds the template with its paths reaching the checkout, and its build output kept inside', () => {
    const workspace = makeWorkspace(FOLDER);
    const template = join(workspace, 'systems', 'template');
    expect(existsSync(join(template, 'system.json'))).toBe(true);
    expect(existsSync(join(template, 'shared', 'index.ts'))).toBe(true);
    const config = z.object({ extends: z.string(), compilerOptions: z.object({ outDir: z.string() }), references: z.array(z.object({ path: z.string() })) }).parse(JSON.parse(readFileSync(join(template, 'tsconfig.json'), 'utf8')));
    expect(resolve(template, config.extends)).toBe(join(ROOT, 'tsconfig.base.json'));
    expect(config.references.map((reference) => resolve(template, reference.path))).toEqual([join(ROOT, 'packages', 'core'), join(ROOT, 'packages', 'sdk')]);
    expect(resolve(template, config.compilerOptions.outDir)).toBe(join(workspace, '.types', 'system-template'));
  });

  it('refuses a folder outside the checkout, where nothing would resolve', () => {
    expect(() => makeWorkspace(join(tmpdir(), 'harness-authoring-outside'))).toThrow(/inside the checkout/);
  });

  it('counts what a hosted system kept in its data and state folders, not its bundles', () => {
    const hosted = join(FOLDER, 'dev-systems', 'fs', 'data', 'hosted', 'readings');
    for (const file of ['main/data/readings.json', 'main/state/x.json', 'main/host.json', 'versions/abc/server/main.js']) {
      mkdirSync(dirname(join(hosted, file)), { recursive: true });
      writeFileSync(join(hosted, file), '{}');
    }
    expect(hostedFolders(FOLDER, 'readings')).toEqual([hosted]);
    expect(keptFiles(FOLDER, 'readings')).toBe(2);
    expect(keptFiles(FOLDER, 'other')).toBe(0);
  });
});
