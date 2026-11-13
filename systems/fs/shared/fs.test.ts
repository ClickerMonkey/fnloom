import { type ChangeSet, Manifest, type SensitivityRule } from '@harness/core';
import { expectType, manifestOf, parseValue, type ConfigOf, type Equal } from '@harness/sdk';
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Previous, fs, type BashOutput, type FsContract } from './index.ts';

describe('the fs contract', () => {
  it('makes a manifest the hub accepts', async () => {
    const manifest = await manifestOf(fs, { version: '0.0.0', resources: true, events: ['resources'] });
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.fns.map((f) => f.name).sort()).toEqual(['Entry.reveal', 'bash', 'cd', 'edit', 'explore', 'glob', 'grep', 'install_system', 'list', 'read', 'remove', 'restart', 'restart_system', 'stop_system', 'system_status', 'write']);
    expect(manifest.requires).toEqual(['hub']);
    expect(manifest.mentions[0]?.of).toBe('fs/Entry');
  });

  it('carries the core change set and sensitivity rules exactly, and asks for flags on every fn that touches files', async () => {
    expectType<Equal<NonNullable<BashOutput['changes']>, z.input<typeof ChangeSet>>>(true);
    expectType<Equal<NonNullable<ConfigOf<FsContract['defs']>['sensitive']>[number], z.input<typeof SensitivityRule>>>(true);
    const manifest = await manifestOf(fs, { version: '0.0.0' });
    expect(manifest.fns.filter((f) => f.flags === true).map((f) => f.name).sort()).toEqual(['bash', 'edit', 'glob', 'grep', 'list', 'read', 'remove', 'write']);
  });

  it('shares the working folder between cd and bash through the same state field', async () => {
    const manifest = await manifestOf(fs, { version: '0.0.0' });
    const state = (name: string) => JSON.stringify(manifest.fns.find((f) => f.name === name)?.state);
    expect(state('cd')).toBe(state('bash'));
    expect(manifest.actions).toEqual([]);
  });

  it('keeps an earlier file as a content ref (or null) for undo', () => {
    const hash = 'a'.repeat(64);
    expect(parseValue(Previous, { path: 'a.txt', previous: { hash, size: 3, mime: 'text/plain' } })).toEqual({ path: 'a.txt', previous: { hash, size: 3, mime: 'text/plain' } });
    expect(parseValue(Previous, { path: 'a.txt', previous: null }).previous).toBeNull();
    expect(() => parseValue(Previous, { path: 'a.txt', previous: { hash: 'nope', size: 3, mime: 'x' } })).toThrow();
  });
});
