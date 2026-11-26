/**
 * The template system, copied as an author starts one, with a page drawn by a `.vue` file: it builds with the real
 * builder (`tsc -b`, the contract read in its sandbox, the server bundled, the client built) because the template
 * declares what a `.vue` module is (`client/vue-shim.d.ts`). Without that file `tsc -b` stops at the import (TS2307).
 * The copy sits two folders under the checkout, as `systems/template` does, so its outward paths reach the same places.
 */
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scrubbedEnv } from '@harness/sdk/server';
import { z } from 'zod';
import { buildSystem } from './build-system.ts';
import { ViteBuilder } from './builder.ts';
import { NodeFiles } from './files.ts';

const checkout = resolve(import.meta.dirname, '../../..');
const dir = join(checkout, '.harness-test', 'vue-page-template');
/** What a build leaves in the template folder, never copied. */
const BUILD_OUTPUT = new Set(['node_modules', 'dist', '.types']);
/** The part of a `tsconfig.json` the copy changes. */
const TsconfigOut = z.looseObject({ compilerOptions: z.looseObject({}) });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/** The template copied into `dir`, its build output kept in the copy, with a page component in `client/LogPage.vue`. */
async function copyWithPage(): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await cp(join(checkout, 'systems', 'template'), dir, { recursive: true, filter: (from) => !relative(join(checkout, 'systems', 'template'), from).split(sep).some((part) => BUILD_OUTPUT.has(part)) });
  const tsconfig = join(dir, 'tsconfig.json');
  const config = TsconfigOut.parse(JSON.parse(await readFile(tsconfig, 'utf8')));
  config.compilerOptions = { ...config.compilerOptions, outDir: '.types/out', tsBuildInfoFile: '.types/build.tsbuildinfo' };
  await writeFile(tsconfig, JSON.stringify(config, null, 2));
  const contract = join(dir, 'shared', 'index.ts');
  const text = await readFile(contract, 'utf8');
  await writeFile(contract, text.replace("grants: { hub: ['ai', 'settings'] },", "grants: { hub: ['ai', 'settings'] },\n  pages: [{ segment: 'log', title: 'Log', component: 'LogPage' }],"));
  await writeFile(join(dir, 'client', 'LogPage.vue'), [
    '<script setup lang="ts">',
    "import { ref } from 'vue';",
    'const count = ref(0);',
    '</script>',
    '',
    '<template>',
    '  <main class="log"><button type="button" @click="count += 1">Seen {{ count }}</button></main>',
    '</template>',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'client', 'index.ts'), [
    "import { client } from '@harness/sdk';",
    "import { template } from '../shared/index.ts';",
    "import LogPage from './LogPage.vue';",
    '',
    'export default client(template, { pages: { LogPage } });',
    '',
  ].join('\n'));
}

describe('a template copy with a .vue page', () => {
  const builder = new ViteBuilder({ probeTimeout: 60_000, probeEnv: scrubbedEnv(process.env) });

  it('typechecks and builds, client and all, and fails the typecheck without the template\'s .vue declaration', { timeout: 240_000 }, async () => {
    await copyWithPage();
    const built = await buildSystem(dir, { builder, files: new NodeFiles() });
    if (!built.ok) { throw new Error(`${built.stage}: ${built.problems.join('\n')}`); }
    expect(built.manifest.name).toBe('template');
    expect((await stat(join(dir, 'dist', 'client', 'index.js'))).isFile()).toBe(true);

    await rm(join(dir, 'client', 'vue-shim.d.ts'));
    await rm(join(dir, '.types'), { recursive: true, force: true });
    const problems = await builder.typecheck(dir);
    expect(problems.join('\n')).toMatch(/TS2307.*\.vue/);
  });
});
