/**
 * `@harness/build`: the bundle scan, the context folder's links and cycles with file and line, and a system build
 * that refuses a broken context folder and ships a good one in `dist/context/`.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatContextProblem } from '@harness/sdk/server';
import type { Manifest } from '@harness/core';
import type { ContractSummary, SystemBuilder } from './builder.ts';
import { buildSystem } from './build-system.ts';
import { checkContextFolder } from './context.ts';
import { NodeFiles } from './files.ts';
import { scanBundle } from './scan.ts';

const dirs: string[] = [];
async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-build-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('scanBundle', () => {
  it('lists built-ins, the risky ones as concerns, computed imports, eval, new Function and URLs, by line', () => {
    const report = scanBundle([
      "import { readFile } from 'node:fs/promises';",
      "import path from 'path';",
      "import { z } from 'zod';",
      "const cp = await import('node:child_process');",
      'const name = "x"; await import(name);',
      'eval("1"); new Function("return 1");',
      'const api = "https://api.example.com/v1?q=1"; const doc = `see http://docs.test/a ${name}`;',
      '// https://in-a-comment.test is not code',
    ].join('\n'));
    expect(report.builtins).toEqual(['child_process', 'fs/promises', 'path']);
    expect(report.concerns.map((c) => `${c.line} ${c.kind} ${c.detail}`)).toEqual([
      '1 builtin fs/promises', '4 builtin child_process', '5 dynamic-import import() of a computed name', '6 eval eval()', '6 new-function new Function()',
    ]);
    expect(report.hosts).toEqual(['api.example.com', 'docs.test']);
    expect(report.size).toBeGreaterThan(100);
  });
});

const header = (fields: string, body = 'Text.') => `---\n${fields}\n---\n${body}\n`;
const KNOWN = { system: 'notes', fns: new Set(['notes/add', 'hub/load_context']), context: new Set(['fs/system-authoring']) };

describe('checkContextFolder', () => {
  it('passes a folder whose links all resolve, own keys included, and skips examples in fenced code', async () => {
    const dir = await folder({
      'index.md': header('key: guide\ndescription: Index.\nsummary: Where to start.\nchoices:\n  - to: notes/guide.add\n    when: You are adding a note.', 'See fn:notes/add and [authoring](context:fs/system-authoring).\n\n```md\nAn example of another system: fn:other/gone, context:other/gone.\n```'),
      'add.md': header('key: guide.add\ndescription: Adding.\nsummary: How to add.\nparent: notes/guide\nfns: [notes/add]'),
    });
    const checked = await checkContextFolder(dir, KNOWN);
    expect(checked.problems).toEqual([]);
    expect(checked.files.map((f) => f.decl.name).sort()).toEqual(['guide', 'guide.add']);
  });

  it('says where each broken link and imports cycle is, with the closest names', async () => {
    const dir = await folder({
      'a.md': header('key: a\ndescription: A.\nsummary: A.\nimports: [notes/b]\nfns:\n  - notes/ad', 'Body line.\nUse fn:notes/remove here.'),
      'b.md': header('key: b\ndescription: B.\nsummary: B.\nimports: [notes/a]'),
    });
    const problems = (await checkContextFolder(dir, KNOWN)).problems.map(formatContextProblem);
    expect(problems).toEqual([
      "context/a.md:7:5 broken-link fns links to fn notes/ad, which doesn't exist — did you mean `notes/add`?",
      "context/a.md:10:5 broken-link the body links to fn notes/remove, which doesn't exist",
      'context/b.md:5:11 cycle imports load in a cycle: notes/a → notes/b → notes/a',
    ]);
  });
});

/** A builder that writes stand-in output and declares one contract. */
class StandInBuilder implements SystemBuilder {
  readonly #summary: ContractSummary;
  constructor(summary: ContractSummary) { this.#summary = summary; }
  typecheck(): Promise<string[]> { return Promise.resolve([]); }
  contracts(): Promise<ContractSummary[]> { return Promise.resolve([this.#summary]); }
  manifests(): Promise<Manifest[]> { return Promise.resolve([]); }
  async bundleServer(input: { outDir: string; fileName: string }): Promise<void> {
    await new NodeFiles().write(join(input.outDir, input.fileName), "import 'node:child_process';\nexport {};\n");
  }
  buildClient(): Promise<void> { return Promise.resolve(); }
}

describe('buildSystem', () => {
  const systemJson = JSON.stringify({ format: 1, name: 'notes', version: '0.1.0', description: 'Notes.', protocol: 1, server: { entry: 'server/main.ts', external: {} } });
  const builder = new StandInBuilder({ name: 'notes', fns: ['notes/add'], context: [], requires: [], references: [] });

  it('refuses a context folder with problems, as file:line:col lines', async () => {
    const dir = await folder({ 'system.json': systemJson, 'context/a.md': header('key: a\ndescription: A.\nsummary: A.\nfns: [notes/gone]') });
    const result = await buildSystem(dir, { builder, files: new NodeFiles() });
    expect(result).toEqual({ ok: false, stage: 'context', problems: [expect.stringMatching(/^context\/a\.md:5:\d+ broken-link /)] });
  });

  it('lets a system that requires the hub link the hub fns and the fns it depends on, without a hub catalog', async () => {
    const links = header('key: a\ndescription: A.\nsummary: A.\nfns: [hub/fns_search, todo/list]');
    const dir = await folder({ 'system.json': systemJson, 'context/a.md': links });
    const requiring = new StandInBuilder({ name: 'notes', fns: ['notes/add'], context: [], requires: ['hub', 'todo'], references: ['todo/list'] });
    expect(await buildSystem(dir, { builder: requiring, files: new NodeFiles() }, { typecheck: false })).toMatchObject({ ok: true });
    expect(await buildSystem(dir, { builder, files: new NodeFiles() }, { typecheck: false })).toMatchObject({ ok: false, stage: 'context' });
  });

  it('builds, copies the context folder into dist and scans the bundle', async () => {
    const dir = await folder({ 'system.json': systemJson, 'context/a.md': header('key: a\ndescription: A.\nsummary: A.\nfns: [notes/add]') });
    const result = await buildSystem(dir, { builder, files: new NodeFiles() });
    if (!result.ok) { throw new Error(result.problems.join('\n')); }
    expect(result.scan.builtins).toEqual(['child_process']);
    expect(await readFile(join(dir, 'dist', 'context', 'a.md'), 'utf8')).toContain('key: a');
    expect(JSON.parse(await readFile(join(dir, 'dist', 'system.json'), 'utf8'))).toMatchObject({ name: 'notes', server: { entry: 'server/main.js' } });
  });
});
