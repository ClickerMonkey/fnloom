import { ADMIN_TAG, InstanceName, NameGlob, QualifiedName, SystemName, type FnRecord, type McpRules, type McpSelector } from '@harness/core';
import { fn, g } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { TestCatalog } from '../execution/testing.ts';
import { exposable, resolveRules, scopeOf, selectsResource, type ScopeWorld } from './scopes.ts';

const FS = SystemName.parse('fs');
const WEB = SystemName.parse('web');
const HUB = SystemName.parse('hub');

/** The fns every world here has. */
function records(): FnRecord[] {
  const catalog = new TestCatalog();
  const read = catalog.add('fs', 'read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
  const write = catalog.add('fs', 'write', fn({ description: 'Write a file.', args: g.obj({ path: g.text(), text: g.text() }), returns: g.bool() }));
  const bash = catalog.add('fs', 'bash', fn({ description: 'Run a shell command.', args: g.obj({ command: g.text() }), returns: g.text() }));
  const search = catalog.add('web', 'search', fn({ description: 'Search the web.', args: g.obj({ query: g.text() }), returns: g.text(), tags: ['read'] }));
  const admin = catalog.add('hub', 'create_mcp', fn({ description: 'Make an MCP.', args: g.obj({}), returns: g.obj({}), tags: [ADMIN_TAG] }));
  const off = catalog.add('fs', 'off', fn({ description: 'Off.', args: g.obj({}), returns: g.text() }), { disabled: true });
  const hidden = catalog.add('fs', 'raw', fn({ description: 'Raw.', args: g.obj({}), returns: g.text(), visibility: 'none' }));
  return [read, { ...write, decl: { ...write.decl, deps: [QualifiedName.parse('fs/read')] } }, bash, search, admin, off, hidden];
}

/** A world over the fns above, types `fs/Entry` (used by fs/read) and `web/Page`, and two context items. */
function world(): ScopeWorld {
  return {
    fns: records(),
    types: [{ name: QualifiedName.parse('fs/Entry'), system: FS }, { name: QualifiedName.parse('fs/Stat'), system: FS }, { name: QualifiedName.parse('web/Page'), system: WEB }],
    context: [
      { name: QualifiedName.parse('fs/guide'), system: FS, fns: [QualifiedName.parse('fs/read'), QualifiedName.parse('fs/bash')] },
      { name: QualifiedName.parse('web/howto'), system: WEB, fns: [] },
    ],
    roots: [{ uri: 'file://main/', system: FS }, { uri: 'https://', system: WEB }],
    references: (record) => (record.name === 'fs/read' ? [QualifiedName.parse('fs/Entry')] : []),
    closure: (names) => Promise.resolve({ order: names.includes(QualifiedName.parse('fs/Entry')) ? [QualifiedName.parse('fs/Stat'), QualifiedName.parse('fs/Entry')] : [...names], missing: [] }),
  };
}

const none: McpSelector = {};
const rules = (include: McpSelector, exclude: McpSelector = none): McpRules => ({ include, exclude });

describe('what an MCP exposes', () => {
  it('selects nothing with empty rules', async () => {
    expect(await resolveRules(rules(none), world())).toEqual({ fns: [], types: [], closure: [], context: [], resources: [], reach: [], warnings: [] });
  });

  it('takes whole systems, minus excluded fns, never admin, off or hidden fns', async () => {
    const preview = await resolveRules(rules({ systems: [FS, HUB] }, { fns: [{ fn: 'fs/bash' }] }), world());
    expect(preview.fns).toEqual(['fs/read', 'fs/write']);
    expect(preview.context).toEqual(['fs/guide']);
    expect(preview.resources).toEqual([{ uri: 'file://main/', system: 'fs' }]);
    expect(preview.warnings).toEqual(['fs/guide brings fs/bash, which is not exposed; it brings only exposed fns.']);
  });

  it('matches fns the way policies do: globs, tags and kinds', async () => {
    expect((await resolveRules(rules({ fns: [{ fn: 'fs/*', tags: ['read'] }] }), world())).fns).toEqual(['fs/read']);
    expect((await resolveRules(rules({ fns: [{ tags: ['read'] }] }), world())).fns).toEqual(['fs/read', 'web/search']);
  });

  it('never includes by a `when` predicate, and always excludes by one', async () => {
    expect((await resolveRules(rules({ fns: [{ fn: 'fs/read', when: { name: 'bool' } }] }), world())).fns).toEqual([]);
    expect((await resolveRules(rules({ systems: [FS] }, { fns: [{ fn: 'fs/read', when: { name: 'bool' } }] }), world())).fns).toEqual(['fs/bash', 'fs/write']);
  });

  it('exposes the types an exposed fn needs, warning when one was excluded', async () => {
    const preview = await resolveRules(rules({ fns: [{ fn: 'fs/read' }] }, { types: [NameGlob.parse('fs/Stat')] }), world());
    expect(preview.types).toEqual(['fs/Entry', 'fs/Stat']);
    expect(preview.closure).toEqual(['fs/Entry', 'fs/Stat']);
    expect(preview.warnings).toEqual(['fs/Stat is excluded, but another exposed type needs it, so it is exposed.']);
    expect((await resolveRules(rules({ types: [NameGlob.parse('web/*')] }), world())).types).toEqual(['web/Page']);
  });

  it('lists the fns exposed fns may call that aren’t exposed themselves', async () => {
    expect((await resolveRules(rules({ fns: [{ fn: 'fs/write' }] }), world())).reach).toEqual(['fs/read']);
    expect((await resolveRules(rules({ fns: [{ fn: 'fs/write' }, { fn: 'fs/read' }] }), world())).reach).toEqual([]);
  });

  it('selects resources by prefix or by system, minus what is excluded', async () => {
    const preview = await resolveRules(rules({ resources: [{ uri: 'file://main/docs/' }], systems: [WEB] }, { resources: [{ uri: 'https://' }] }), world());
    expect(preview.resources).toEqual([{ uri: 'file://main/docs/' }]);
    const scope = scopeOf(rules({ resources: [{ uri: 'file://main/docs/', system: FS }] }, { resources: [{ uri: 'file://main/docs/private/' }] }), preview, () => ({ system: FS }));
    expect(scope.allowsResource('file://main/docs/a.md')).toBe(true);
    expect(scope.allowsResource('file://main/docs/private/b.md')).toBe(false);
    expect(scope.allowsResource('file://main/src/c.ts')).toBe(false);
    expect(selectsResource({ resources: [{ uri: 'file://', system: WEB }] }, 'file://x', { system: FS })).toBe(false);
  });

  it('select a prefix on one instance only when that instance serves it', () => {
    const laptop = { resources: [{ uri: 'file://', system: FS, instance: InstanceName.parse('laptop') }] };
    expect(selectsResource(laptop, 'file://x', { system: FS, instance: InstanceName.parse('laptop') })).toBe(true);
    expect(selectsResource(laptop, 'file://x', { system: FS, instance: InstanceName.parse('desk') })).toBe(false);
    expect(selectsResource(laptop, 'file://x', undefined)).toBe(false);
  });

  it('never exposes admin-tagged fns, whatever the rules', () => {
    const [read, , , , admin] = records();
    expect(read === undefined ? false : exposable(read)).toBe(true);
    expect(admin === undefined ? true : exposable(admin)).toBe(false);
  });
});
