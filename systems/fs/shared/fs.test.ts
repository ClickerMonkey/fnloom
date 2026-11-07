import { Manifest } from '@harness/core';
import { manifestOf, parseValue } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { Previous, fs } from './index.ts';

describe('the fs contract', () => {
  it('makes a manifest the hub accepts', async () => {
    const manifest = await manifestOf(fs, { version: '0.0.0', resources: true, events: ['resources'] });
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.fns.map((f) => f.name).sort()).toEqual(['Entry.reveal', 'bash', 'cd', 'edit', 'explore', 'glob', 'grep', 'list', 'read', 'remove', 'restart', 'write']);
    expect(manifest.requires).toEqual(['hub']);
    expect(manifest.mentions[0]?.of).toBe('fs/Entry');
  });

  it('shares the working folder between cd and bash through the same state field', async () => {
    const manifest = await manifestOf(fs, { version: '0.0.0' });
    const state = (name: string) => JSON.stringify(manifest.fns.find((f) => f.name === name)?.state);
    expect(state('cd')).toBe(state('bash'));
    expect(manifest.actions[0]?.state).toEqual(manifest.fns.find((f) => f.name === 'bash')?.state);
  });

  it('keeps an earlier file as a content ref (or null) for undo', () => {
    const hash = 'a'.repeat(64);
    expect(parseValue(Previous, { path: 'a.txt', previous: { hash, size: 3, mime: 'text/plain' } })).toEqual({ path: 'a.txt', previous: { hash, size: 3, mime: 'text/plain' } });
    expect(parseValue(Previous, { path: 'a.txt', previous: null }).previous).toBeNull();
    expect(() => parseValue(Previous, { path: 'a.txt', previous: { hash: 'nope', size: 3, mime: 'x' } })).toThrow();
  });
});
