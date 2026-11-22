/** The authoring context: its start item (`fs/system-authoring`), and the guide as fs's context folder. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkContextFolder } from '@harness/build';
import { qualify } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { fs } from '../shared/index.ts';
import { AUTHORING_SPECIFIER, authoringStart, authoringText, PackagedAuthoring, templateNote, type AuthoringSource } from './authoring.ts';
import { sectionOf } from './sections.ts';

/** The fns the start item brings, and every item of the guide but a reference with it. */
const START_FNS = ['fs/read', 'fs/write', 'fs/edit', 'fs/bash', 'fs/install_system', 'fs/system_status'];

/** fs's context folder. */
const CONTEXT = fileURLToPath(new URL('../context', import.meta.url));

/** A template on this machine. */
const FAKE: AuthoringSource = { guide: () => Promise.resolve('# Writing a harness system\n'), template: () => '/repo/systems/template/' };

describe('the system-authoring context', () => {
  it('is a /new-system command that brings the fns to write and install a system, and loads the guide index with it', () => {
    const def = fs.defs.context['system-authoring'];
    expect(def.dynamic).toBe(true);
    expect(def.command?.name).toBe('new-system');
    expect(def.fns.map((f) => f.name)).toEqual(START_FNS);
    expect(def.imports.map((ref) => ref.name)).toEqual(['fs/authoring']);
    expect(def.inject).toBeUndefined();
  });

  it('names the fns it brings, how to walk the guide and where the template is, and ends with installing', () => {
    const text = authoringStart(FAKE);
    expect(text).toContain('This brings fs/read, fs/write, fs/edit and fs/bash');
    expect(text).toContain('with `hub/ctx_load`');
    expect(text).not.toContain('ctx_get');
    expect(text).toContain('The template system is at `/repo/systems/template/`');
    expect(text).toContain('so never\n`mkdir` first');
    expect(text.trimEnd().endsWith('the end of its output after a crash.')).toBe(true);
  });

  it('says where the template is in the repository when it is not on this machine', () => {
    expect(templateNote(undefined)).toContain('`systems/template` in the harness repository (it is not on this machine)');
  });

  it('still gives the whole guide at once, for a model with a big window', async () => {
    expect(await authoringText({ guide: () => Promise.resolve('# All\n\n'), template: () => undefined })).toMatch(/^# All\n\n## Making a system here\n/);
  });
});

describe('the guide as a context folder', () => {
  const contract = fs.defs;
  const known = {
    system: 'fs',
    fns: new Set(Object.keys(contract.fns).map((name) => qualify('fs', name))),
    context: new Set(Object.keys(contract.context).map((name) => qualify('fs', name))),
  };

  // reads and checks every file of the folder (90 KB of guide); slow on a loaded machine
  it('builds clean: every header, key and link checks out against the fs contract', { timeout: 30_000 }, async () => {
    const checked = await checkContextFolder(CONTEXT, known);
    expect(checked.problems).toEqual([]);
    const keys = checked.files.map((file) => file.header.key);
    // the start item's import is a real item, and the index offers every group
    expect(keys).toContain('authoring');
    expect(checked.files.find((file) => file.header.key === 'authoring')?.header.choices?.map((choice) => choice.to).sort()).toEqual(keys.filter((key) => key.startsWith('authoring.topics.')).map((key) => `fs/${key}`).sort());
  });

  // it reads every item of the guide's folder: under coverage on a full run that can pass the 5 s default
  it('has short summaries, and every item but a reference brings the fns its text names', async () => {
    const { files } = await checkContextFolder(CONTEXT, known);
    for (const file of files) {
      expect(file.header.summary.length, file.file).toBeLessThanOrEqual(160);
      const reference = file.header.tags.includes('reference');
      expect(file.header.fns.slice(0, 4), file.file).toEqual(reference ? [] : START_FNS.slice(0, 4));
    }
    expect(files.find((file) => file.header.key === 'authoring.packaging')?.header.fns).toContain('fs/install_system');
  }, 30_000);
});

describe('sectionOf', () => {
  it('cuts from a heading line to the next one asked for, trimmed, and finds a heading on the first line', () => {
    const text = '## A\r\none\n\n## B\ntwo\n## C\nthree';
    expect(sectionOf(text, '## A', '## B')).toBe('## A\none');
    expect(sectionOf(text, '## B', '## C')).toBe('## B\ntwo');
    expect(sectionOf(text, '## C')).toBe('## C\nthree');
    expect(sectionOf(text, '## B')).toBe('## B\ntwo\n## C\nthree');
    expect(sectionOf(text, '## D')).toBeUndefined();
    // a heading is a whole line, not part of one
    expect(sectionOf('x ## A\n', '## A')).toBeUndefined();
  });
});

describe('PackagedAuthoring', () => {
  it('reads the guide the specifier resolves to, and finds the template two folders up from it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-authoring-'));
    try {
      const guide = join(root, 'packages', 'sdk', 'AUTHORING.md');
      await mkdir(join(root, 'packages', 'sdk'), { recursive: true });
      await writeFile(guide, '# The guide\n');
      const asked: string[] = [];
      const source = new PackagedAuthoring((specifier) => { asked.push(specifier); return pathToFileURL(guide).href; }, () => true);
      expect(await source.guide()).toBe('# The guide\n');
      expect(asked).toEqual([AUTHORING_SPECIFIER]);
      expect(source.template()).toBe(join(root, 'systems', 'template'));
      expect(new PackagedAuthoring(() => pathToFileURL(guide).href, () => false).template()).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the guide that ships with the installed SDK', async () => {
    const text = await new PackagedAuthoring().guide();
    expect(text.startsWith('# Writing a harness system')).toBe(true);
    expect(new PackagedAuthoring().template()).toBeDefined();
  });
});
