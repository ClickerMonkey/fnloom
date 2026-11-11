/**
 * `runSystemTests` on a real system folder (made under `.harness-test/`, so its tests resolve vitest from the repo):
 * passed, failed (first lines of why, listed first) and skipped tests, the `real` mark, a file that doesn't load, and
 * a folder with no tests.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NodeFiles } from './files.ts';
import { runSystemTests } from './tests.ts';

const ROOT = resolve(import.meta.dirname, '../../../.harness-test/build-tests');
const SYSTEM_JSON = JSON.stringify({ format: 1, name: 'notes', version: '1.2.0', description: 'Notes.', protocol: 1, server: { entry: 'server/main.ts', external: {} }, instances: 'one' });

/** A system folder with the given files. */
async function folder(name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const dir = join(ROOT, name);
  await rm(dir, { recursive: true, force: true });
  for (const [path, text] of Object.entries({ 'system.json': SYSTEM_JSON, ...files })) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

describe('runSystemTests', () => {
  it("reports a folder's tests: counts, failures first with why, the real mark, and a file that doesn't load", async () => {
    const dir = await folder('mixed', {
      'server/notes.test.ts': [
        "import { describe, expect, it } from 'vitest';",
        "describe('notes', () => {",
        "  it('adds', () => { expect(1 + 1).toBe(2); });",
        "  it('saves', () => { expect(1).toBe(2); });",
        "  it('titles', { meta: { real: true }, skip: true }, () => undefined);",
        '});',
      ].join('\n'),
      'server/broken.test.ts': "import './missing.ts';\n",
    });
    const report = await runSystemTests(dir, new NodeFiles());
    expect(report).toMatchObject({ system: 'notes', version: '1.2.0', passed: 1, failed: 2, skipped: 1 });
    const cases = report?.cases ?? [];
    expect(cases.slice(0, 2).map((c) => c.status)).toEqual(['failed', 'failed']);
    expect(cases.find((c) => c.name.endsWith('saves'))?.error).toContain('expected 1 to be 2');
    expect(cases.find((c) => c.file === 'server/broken.test.ts')?.name).toBe('(the file)');
    expect(cases.find((c) => c.name.endsWith('titles'))).toMatchObject({ status: 'skipped', real: true });
  }, 60_000);

  it('with previews, tells the tests where to shoot and reads the shots they recorded', async () => {
    const shot = { component: 'NoteCard', state: 'empty', viewport: 'phone', theme: 'dark', image: { hash: 'a'.repeat(64), size: 1, mime: 'image/png' } };
    const dir = await folder('previews', {
      'client/card.test.ts': [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { expect, it } from 'vitest';",
        "it('shoots', () => {",
        "  const out = process.env.HARNESS_PREVIEW_DIR ?? '';",
        "  expect(process.env.HARNESS_PREVIEWS).toBe('true');",
        '  mkdirSync(out, { recursive: true });',
        `  writeFileSync(join(out, 'shots.json'), JSON.stringify({ shots: [${JSON.stringify(shot)}] }));`,
        '});',
      ].join('\n'),
    });
    const report = await runSystemTests(dir, new NodeFiles(), { previews: true });
    expect(report).toMatchObject({ passed: 1, failed: 0, previews: [shot] });
  }, 60_000);

  it('gives nothing for a folder with no tests', async () => {
    expect(await runSystemTests(await folder('empty', { 'server/main.ts': 'export {};\n' }), new NodeFiles())).toBeUndefined();
  }, 60_000);
});
