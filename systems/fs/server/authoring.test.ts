/** The `fs/system-authoring` context: the SDK's guide, then where the template is and how to copy it. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fs } from '../shared/index.ts';
import { AUTHORING_SPECIFIER, authoringText, PackagedAuthoring, templateNote, type AuthoringSource } from './authoring.ts';

describe('the system-authoring context', () => {
  it('is a /new-system command that brings the fns to write a system with', () => {
    const def = fs.defs.context['system-authoring'];
    expect(def.dynamic).toBe(true);
    expect(def.command?.name).toBe('new-system');
    expect(def.fns.map((f) => f.name)).toEqual(['fs/write', 'fs/edit', 'fs/bash', 'fs/read']);
    expect(def.alwaysFor).toEqual([]);
  });

  it('is the guide followed by the template note', async () => {
    const source: AuthoringSource = { guide: () => Promise.resolve('# Writing a harness system\n\nAll of it.\n\n'), template: () => '/repo/systems/template/' };
    const text = await authoringText(source);
    expect(text.startsWith('# Writing a harness system\n\nAll of it.\n\n## Making a system here\n')).toBe(true);
    expect(text).toContain('The template system is at `/repo/systems/template/`');
    expect(text).toContain('harness system new <name>');
  });

  it('says where the template is in the repository when it is not on this machine', () => {
    expect(templateNote(undefined)).toContain('`systems/template` in the harness repository (it is not on this machine)');
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
