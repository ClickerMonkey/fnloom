/**
 * Building the guide over a copy of the fixture package, as the CLI builds the real one: a written guide is current
 * until an export changes, and a new export nobody placed stops the build.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuideProblems, type Topic } from './compose.ts';
import { buildGuide, filesUnder, folderListing, isCurrent, readText, type GuideConfig } from './guide.ts';

const FIXTURE = fileURLToPath(new URL('fixtures/mini/', import.meta.url));

const OUTLINE: readonly Topic[] = [
  { id: 'make', title: 'Making shapes', exports: ['shape', 'Point', 'BRUSHES', 'SIZES'] },
  { id: 'paint', title: 'Painting', exports: ['Painter', 'Mood', 'Canvas'] },
  { id: 'types', title: 'Core types', exports: [] },
];

// each build makes a TypeScript program, which takes seconds on a busy machine
describe('buildGuide', { timeout: 60_000 }, () => {
  let root = '';
  let config: GuideConfig;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-docs-'));
    cpSync(FIXTURE, join(root, 'pkg'), { recursive: true });
    mkdirSync(join(root, 'prose'));
    writeFileSync(join(root, 'prose', 'make.md'), 'Make shapes first.\n\n<!-- include: pkg/index.ts -->\n');
    writeFileSync(join(root, 'prose', 'paint.md'), 'Then paint them.\n');
    writeFileSync(join(root, 'prose', 'types.md'), '<!-- generate: listing -->\n');
    config = {
      root,
      title: 'Painting guide',
      intro: 'All about painting.',
      entries: [{ specifier: '@fixture/mini', file: join(root, 'pkg', 'index.ts') }],
      reach: (file) => file.endsWith('pkg/core.ts'),
      reachDepth: 1,
      outline: OUTLINE,
      proseDir: join(root, 'prose'),
      generators: () => ({ listing: () => folderListing(root, 'prose') }),
    };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('builds the guide from the package, the prose and the generators', () => {
    const text = buildGuide(config);
    expect(text).toContain('# Painting guide');
    expect(text).toContain('## 1. Making shapes\n\nMake shapes first.');
    expect(text).toContain('#### `Canvas`');
    expect(text).toContain('#### `prose/make.md`');
    expect(text).toContain('Refers to: [`Color`](#core-color)');
  });

  it('is current until an export changes, whatever the line ends of the written file', () => {
    const file = join(root, 'GUIDE.md');
    writeFileSync(file, buildGuide(config).replaceAll('\n', '\r\n'));
    expect(isCurrent(file, buildGuide(config))).toBe(true);

    const index = join(root, 'pkg', 'index.ts');
    writeFileSync(index, readFileSync(index, 'utf8').replace('export const BRUSHES = 3;', 'export const BRUSHES = 4;'));
    expect(isCurrent(file, buildGuide(config))).toBe(false);
  });

  it('stops when an export is added and no topic places it', () => {
    const index = join(root, 'pkg', 'index.ts');
    writeFileSync(index, `${readFileSync(index, 'utf8')}\n/** New. */\nexport const EXTRA = 1;\n`);
    expect(() => buildGuide(config)).toThrow(GuideProblems);
    expect(() => buildGuide(config)).toThrow('EXTRA');
  });

  it('makes the same guide from sources with Windows line ends', () => {
    const before = buildGuide(config);
    for (const name of ['index.ts', 'core.ts']) {
      const path = join(root, 'pkg', name);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    }
    const after = buildGuide(config);
    expect(after).not.toContain('\r');
    expect(after).toBe(before);
  });

  it('says a missing guide is not current', () => {
    expect(isCurrent(join(root, 'none.md'), 'x')).toBe(false);
  });
});

describe('files', () => {
  it('reads text with Unix line ends, and nothing for a folder or a missing file', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-docs-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'one\r\ntwo');
      expect(readText(join(root, 'a.txt'))).toBe('one\ntwo');
      expect(readText(root)).toBeUndefined();
      expect(readText(join(root, 'b.txt'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists a folder sorted, skipping node_modules and dist, and shows it file by file', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-docs-'));
    try {
      mkdirSync(join(root, 'sys', 'node_modules'), { recursive: true });
      mkdirSync(join(root, 'sys', 'server'));
      writeFileSync(join(root, 'sys', 'node_modules', 'x.js'), '');
      writeFileSync(join(root, 'sys', 'system.json'), '{}');
      writeFileSync(join(root, 'sys', 'server', 'main.ts'), 'run();');
      expect(filesUnder(join(root, 'sys'))).toEqual(['server/main.ts', 'system.json']);
      expect(folderListing(root, 'sys')).toBe('#### `sys/server/main.ts`\n\n```ts\nrun();\n```\n\n#### `sys/system.json`\n\n```json\n{}\n```');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
