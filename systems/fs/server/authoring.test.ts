/** The authoring context: its start item (`fs/system-authoring`) and the guide's parts, one item each. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTHORING_PARTS, type AuthoringPart } from '../shared/authoring.gen.ts';
import { fs } from '../shared/index.ts';
import { AUTHORING_SPECIFIER, authoringPart, authoringStart, authoringText, PackagedAuthoring, templateNote, type AuthoringSource } from './authoring.ts';
import { sectionOf } from './sections.ts';

/** The parts in the guide's order. */
const PARTS = Object.keys(AUTHORING_PARTS).filter((name): name is AuthoringPart => Object.hasOwn(AUTHORING_PARTS, name));

/** A part's facts, with `next` readable on every part. */
const info = (part: AuthoringPart): { readonly heading: string; readonly title: string; readonly reference: boolean; readonly next?: AuthoringPart } => AUTHORING_PARTS[part];

/** A guide with every part's heading and one line under each, and a template on this machine. */
const FAKE: AuthoringSource = {
  guide: () => Promise.resolve([
    '# Writing a harness system', 'The intro.', '## Contents', '1. ...', ...PARTS.flatMap((name) => [info(name).heading, `About ${name}.`]),
  ].join('\n\n')),
  template: () => '/repo/systems/template/',
};

/** A part's text without the line naming the part after it. */
const bodyOf = (text: string): string => text.replace(/\n\n(?:Next: .*|This is the last part of its kind\.)\n$/, '');

describe('the system-authoring context', () => {
  it('is a /new-system command that brings the fns to write a system with', () => {
    const def = fs.defs.context['system-authoring'];
    expect(def.dynamic).toBe(true);
    expect(def.command?.name).toBe('new-system');
    expect(def.fns.map((f) => f.name)).toEqual(['fs/write', 'fs/edit', 'fs/bash', 'fs/read']);
    expect(def.alwaysFor).toEqual([]);
  });

  it('has one dynamic item per part, each under the start item; the guide’s parts and the reference parts are each a chain', () => {
    for (const name of PARTS) {
      const def = fs.defs.context[name];
      const { next, reference } = info(name);
      expect(def.dynamic, name).toBe(true);
      expect(def.parent?.name, name).toBe('fs/system-authoring');
      expect(def.next?.name, name).toBe(next === undefined ? undefined : `fs/${next}`);
      if (next !== undefined) { expect(info(next).reference, name).toBe(reference); }
      expect(def.suggest, name).toBe(reference ? 'none' : 'both');
    }
    expect(PARTS.filter((name) => info(name).reference)).toEqual(['authoring-internals', 'authoring-core-types']);
  });

  it('starts with the guide’s intro, lists every part with its size, and ends with the template note', async () => {
    const text = await authoringStart(FAKE);
    expect(text.startsWith('# Writing a harness system\n\nThe intro.\n\n## The parts of this guide\n')).toBe(true);
    expect(text).not.toContain('## Contents');
    for (const name of PARTS) { expect(text).toContain(`- \`fs/${name}\`: ${info(name).title} (about `); }
    expect(text.indexOf('fs/authoring-examples')).toBeLessThan(text.indexOf('Reference parts'));
    expect(text.indexOf('fs/authoring-core-types')).toBeGreaterThan(text.indexOf('Reference parts'));
    expect(text).toContain('The template system is at `/repo/systems/template/`');
    expect(text.trimEnd().endsWith('until they pass.')).toBe(true);
  });

  it('serves each part as its section of the guide, naming the part after it', async () => {
    const first = await authoringPart(FAKE, 'authoring-start');
    expect(first).toBe(`${info('authoring-start').heading}\n\nAbout authoring-start.\n\nNext: \`fs/authoring-folder\` (${info('authoring-folder').title}).\n`);
    const last = await authoringPart(FAKE, 'authoring-examples');
    expect(last).toContain('About authoring-examples.');
    expect(last).not.toContain('About authoring-internals.');
    expect(last.trimEnd().endsWith('This is the last part of its kind.')).toBe(true);
    const missing: AuthoringSource = { guide: () => Promise.resolve('# Nothing here\n'), template: () => undefined };
    await expect(authoringPart(missing, 'authoring-gin')).rejects.toThrow(/npm run docs:authoring/);
  });

  it('cuts the real guide into parts that together are all of it after the contents', async () => {
    const source = new PackagedAuthoring();
    const guide = (await source.guide()).replaceAll('\r\n', '\n').trimEnd();
    const parts = await Promise.all(PARTS.map((name) => authoringPart(source, name)));
    expect(guide.endsWith(parts.map(bodyOf).join('\n\n'))).toBe(true);
    // the start item is short: the list of parts, not the guide
    expect((await authoringStart(source)).length).toBeLessThan(8_000);
  });

  it('says where the template is in the repository when it is not on this machine', () => {
    expect(templateNote(undefined)).toContain('`systems/template` in the harness repository (it is not on this machine)');
  });

  it('still gives the whole guide at once, for a model with a big window', async () => {
    expect(await authoringText({ guide: () => Promise.resolve('# All\n\n'), template: () => undefined })).toMatch(/^# All\n\n## Making a system here\n/);
  });
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
