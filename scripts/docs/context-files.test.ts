import { CONTEXT_BODY_REFERENCE } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { contextFiles } from './context-files.ts';
import { AUTHORING_GROUPS } from './context-graph.ts';
import { OUTLINE } from './outline.ts';
import { guideParts } from './parts.ts';

/** A guide with every topic of the real outline, the first with an API reference under it. */
const GUIDE = OUTLINE.map((topic, index) => `## ${index + 1}. ${topic.title}\n\nAbout ${topic.id}.${index === 0 ? '\n\n### Reference: start here\n\n#### `x`\n\nAn export.' : ''}`).join('\n\n');

/** A header's key and the qualified names it links to. */
function linksOf(text: string): { key: string; links: string[] } {
  const key = /^key: "([^"]+)"$/m.exec(text)?.[1] ?? '';
  const header = text.slice(0, text.indexOf('\n---', 4));
  const links = [...header.matchAll(/"(fs\/[^"]+)"/g)].map((match) => match[1] ?? '');
  const body = [...text.matchAll(CONTEXT_BODY_REFERENCE)].map((match) => match[2] ?? '');
  return { key: `fs/${key}`, links: [...links, ...body] };
}

describe('the authoring guide as a context folder', () => {
  const files = contextFiles(guideParts(GUIDE, OUTLINE));

  it('starts with a shallow index whose choices are the topic groups, each worded as a decision', () => {
    const index = files[0]?.text ?? '';
    expect(files[0]?.path).toBe('index.md');
    expect([...index.matchAll(/^ {2}- to: /gm)]).toHaveLength(AUTHORING_GROUPS.length);
    expect([...index.matchAll(/^ {4}when: "Pick this/gm)]).toHaveLength(AUTHORING_GROUPS.length);
    expect(index).toContain('fn:fs/install_system');
  });

  it('gives every part a stable key, a summary, its group as parent and the fns it is written with; a reference brings none', () => {
    const fns = files.find((file) => file.path === 'parts/fns.md')?.text ?? '';
    expect(fns).toContain('key: "authoring.fns"');
    expect(fns).toContain('parent: "fs/authoring.topics.fns"');
    expect(fns).toContain('fns: ["fs/read", "fs/write", "fs/edit", "fs/bash"]');
    expect(files.find((file) => file.path === 'parts/packaging.md')?.text).toContain('"fs/install_system"');
    const reference = files.find((file) => file.path === 'parts/start.reference.md')?.text ?? '';
    expect(reference).toContain('suggest: "none"');
    expect(reference).not.toContain('fns:');
    expect(files.find((file) => file.path === 'parts/start.md')?.text).toContain('to: "fs/authoring.start.reference"');
  });

  // iteration 1 (2026-11-22): ordinary requests found these guides before the fns they needed
  it('marks every piece as developer material, so a search ranks it below what an ordinary request needs', () => {
    expect(files.filter((file) => !file.text.includes('niche: "developer"')).map((file) => file.path)).toEqual([]);
  });

  it('links only to items it writes, apart from the fs fns it brings', () => {
    const keys = new Set(files.map((file) => linksOf(file.text).key));
    const broken = files.flatMap((file) => linksOf(file.text).links.filter((link) => !keys.has(link) && !/^fs\/(read|write|edit|bash|install_system|system_status)$/.test(link)).map((link) => `${file.path} → ${link}`));
    expect(broken).toEqual([]);
    expect(keys.size).toBe(files.length);
  });
});

describe('a part over the item budget', () => {
  it('is cut into pieces under it, each a choice of the part and linked to the next', () => {
    const big = Array.from({ length: 12 }, (_, n) => `### Section ${String(n + 1)}\n\n${'Words. '.repeat(600)}`).join('\n\n');
    const guide = OUTLINE.map((topic, index) => `## ${index + 1}. ${topic.title}\n\nAbout ${topic.id}.${topic.id === 'hub' ? `\n\n${big}` : ''}`).join('\n\n');
    const files = contextFiles(guideParts(guide, OUTLINE));
    const part = files.find((file) => file.path === 'parts/hub.md')?.text ?? '';
    const pieces = files.filter((file) => file.path.startsWith('parts/hub/'));
    expect(pieces.length).toBeGreaterThan(1);
    expect(part).toContain(`This part is in ${String(pieces.length)} pieces`);
    expect([...part.matchAll(/^ {2}- to: "fs\/authoring\.hub\./gm)]).toHaveLength(pieces.length);
    expect(pieces[0]?.text).toContain('parent: "fs/authoring.hub"');
    expect(pieces[0]?.text).toContain('next: "fs/authoring.hub.');
    expect(pieces.every((file) => file.text.length <= 25_000)).toBe(true);
  });
});
