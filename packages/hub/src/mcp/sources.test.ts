/**
 * A hub MCP's resources and prompts keep to its scope: types, context and resource roots it includes are listed and
 * read, what it leaves out answers nothing, and a narrowed scope is checked again on every read and prompt.
 */
import { ContentRef, HubMcpId, InstanceName, QualifiedName, ResourceUri, SystemName, TypeRecord, type ContextRecord, type ResourceRead } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { contextRecord } from '../contextor/testing.ts';
import type { McpScope } from './index.ts';
import { HubMcpPrompts, HubMcpResources, viewName, viewUri, type HubMcpSourcesDeps } from './sources.ts';

const MCP = HubMcpId.parse('mcp_small');
const FS = SystemName.parse('fs');
const ENTRY = QualifiedName.parse('fs/Entry');
const SECRET = QualifiedName.parse('fs/Secret');
const GUIDE = QualifiedName.parse('fs/guide');
const PLAN = QualifiedName.parse('fs/plan');
const HIDDEN = QualifiedName.parse('fs/hidden');
const TREE = QualifiedName.parse('fs/tree');
const DOCS = ResourceUri.parse('file:///docs/');
const PRIVATE = ResourceUri.parse('file:///private/');

/** A type record of an object with one text field. */
function typeRecord(name: QualifiedName, description: string): TypeRecord {
  return TypeRecord.parse({ name, system: 'fs', description, display: { label: name }, def: { name: 'obj', props: { path: { type: { name: 'text' } } } }, references: [], updatedAt: 0 });
}

/** A world with an included and an excluded type, context item (one with a command) and resource root. */
function world() {
  const types = new Map([[ENTRY, typeRecord(ENTRY, 'One file.')], [SECRET, typeRecord(SECRET, 'Hidden.')]]);
  const context = new Map<QualifiedName, ContextRecord>([
    [GUIDE, contextRecord(GUIDE, { description: 'How to use fs.', content: 'Use fs/read for files.' })],
    [PLAN, contextRecord(PLAN, { description: 'Plan a change.', content: 'Plan it step by step.', command: { name: 'plan', args: [{ name: 'goal', hint: 'what to do', required: true }] } })],
    [HIDDEN, contextRecord(HIDDEN, { description: 'Not for MCPs.', content: 'Secret notes.', command: { name: 'hidden', args: [] } })],
    [TREE, contextRecord(TREE, { description: 'The folder tree.', command: { name: 'tree', args: [] } })],
  ]);
  const root = (uri: ResourceUri, name: string) => ({ system: FS, instance: InstanceName.parse('main'), root: { uri, name, description: `The ${name}.`, index: 'all' as const, ignore: [], watch: false } });
  const reads: string[] = [];
  const bytes = new TextEncoder().encode('# Long\nText kept by ref.');
  const ref = ContentRef.parse({ hash: 'a'.repeat(64), size: bytes.length, mime: 'text/markdown' });
  let scope: McpScope = {
    fns: new Set(), types: new Set([ENTRY]), context: new Set([GUIDE, PLAN, TREE]), allowsResource: (uri) => uri.startsWith(DOCS),
  };
  const deps: HubMcpSourcesDeps = {
    scopes: () => ({ scope: () => Promise.resolve(scope) }),
    catalog: () => ({
      type: (name) => Promise.resolve(types.get(name)),
      typeClosure: (names) => Promise.resolve({ order: names.filter((n) => types.has(n)), missing: names.filter((n) => !types.has(n)) }),
      context: (name) => Promise.resolve(context.get(name)),
    }),
    resources: () => ({
      roots: () => [root(DOCS, 'docs'), root(PRIVATE, 'private')],
      read: (uri) => {
        reads.push(uri);
        const stat = { uri, name: uri, type: 'file' as const, mime: 'text/markdown', version: '1' };
        const read: ResourceRead = uri.endsWith('long.md') ? { stat, text: { ref } } : uri.endsWith('empty.md') ? { stat } : { stat, text: { inline: '# Intro' } };
        return Promise.resolve(read);
      },
    }),
    content: () => ({ read: () => Promise.resolve(bytes) }),
  };
  return { deps, reads, narrow: (next: Partial<McpScope>) => { scope = { ...scope, ...next }; } };
}

const signal = new AbortController().signal;

describe('a hub MCP\'s resources', () => {
  it('lists the included types, the context with text and the roots in scope, and nothing it leaves out', async () => {
    const w = world();
    const { resources } = await new HubMcpResources(MCP, w.deps).list();
    expect(resources.map((r) => r.uri)).toEqual([viewUri('types', ENTRY), viewUri('context', GUIDE), viewUri('context', PLAN), DOCS]);
    expect(resources[0]).toMatchObject({ name: ENTRY, mimeType: 'text/x-typescript' });
    expect(resources[1]).toMatchObject({ mimeType: 'text/markdown', description: 'How to use fs.' });
  });

  it('reads an included type, context item and resource, and answers nothing outside the scope', async () => {
    const w = world();
    const source = new HubMcpResources(MCP, w.deps);
    const [type] = (await source.read(viewUri('types', ENTRY), signal)) ?? [];
    expect(type).toMatchObject({ uri: viewUri('types', ENTRY), mimeType: 'text/x-typescript' });
    expect(type !== undefined && 'text' in type ? type.text : '').toContain('type fs/Entry = obj{path: text}');
    expect(await source.read(viewUri('context', GUIDE), signal)).toEqual([{ uri: viewUri('context', GUIDE), mimeType: 'text/markdown', text: 'Use fs/read for files.' }]);
    expect(await source.read('file:///docs/intro.md', signal)).toEqual([{ uri: 'file:///docs/intro.md', mimeType: 'text/markdown', text: '# Intro' }]);
    expect(await source.read('file:///docs/long.md', signal)).toEqual([{ uri: 'file:///docs/long.md', mimeType: 'text/markdown', text: '# Long\nText kept by ref.' }]);
    expect(await source.read('file:///docs/empty.md', signal)).toEqual([{ uri: 'file:///docs/empty.md', mimeType: 'text/markdown', text: '' }]);
    // excluded: a type, a context item, a root, an unknown type, a dynamic item with no text, and a URI that isn't one
    for (const uri of [viewUri('types', SECRET), viewUri('context', HIDDEN), 'file:///private/keys.txt', viewUri('types', QualifiedName.parse('fs/Nope')), viewUri('context', TREE), 'not a uri']) {
      expect(await source.read(uri, signal)).toBeUndefined();
    }
    expect(w.reads).toEqual(['file:///docs/intro.md', 'file:///docs/long.md', 'file:///docs/empty.md']);
  });

  it('checks the scope again on every read, so a narrowed MCP stops serving what it dropped', async () => {
    const w = world();
    const source = new HubMcpResources(MCP, w.deps);
    expect(await source.read(viewUri('context', GUIDE), signal)).toBeDefined();
    w.narrow({ types: new Set(), context: new Set(), allowsResource: () => false });
    for (const uri of [viewUri('types', ENTRY), viewUri('context', GUIDE), 'file:///docs/intro.md']) expect(await source.read(uri, signal)).toBeUndefined();
    expect((await source.list()).resources).toEqual([]);
  });

  it('names views by kind', () => {
    expect(viewUri('types', ENTRY)).toBe('harness://types/fs/Entry');
    expect(viewName('types', 'harness://types/fs/Entry')).toBe(ENTRY);
    expect(viewName('context', 'harness://types/fs/Entry')).toBeUndefined();
    expect(viewName('context', 'harness://context/not-a-name')).toBeUndefined();
  });
});

describe('a hub MCP\'s prompts', () => {
  it('lists only in-scope context with a command and text, with its arguments', async () => {
    const w = world();
    const prompts = new HubMcpPrompts(MCP, w.deps);
    expect(prompts.prompts()).toEqual([]);
    await prompts.refresh();
    expect(prompts.prompts()).toEqual([{ name: 'plan', title: 'plan', description: 'Plan a change.', arguments: [{ name: 'goal', description: 'what to do', required: true }] }]);
  });

  it('fills a prompt with the item\'s text and the args given, and refuses one the rules narrowed away', async () => {
    const w = world();
    const prompts = new HubMcpPrompts(MCP, w.deps);
    await prompts.refresh();
    expect(await prompts.get('plan', { goal: 'ship it' })).toEqual({ description: 'Plan a change.', messages: [{ role: 'user', content: { type: 'text', text: 'Plan it step by step.\n\ngoal: ship it' } }] });
    expect(await prompts.get('plan', {})).toMatchObject({ messages: [{ content: { text: 'Plan it step by step.' } }] });
    expect(await prompts.get('hidden', {})).toBeUndefined();
    // the rules change before the list is rebuilt: the prompt is checked against the scope again
    w.narrow({ context: new Set([GUIDE]) });
    expect(await prompts.get('plan', { goal: 'ship it' })).toBeUndefined();
    await prompts.refresh();
    expect(prompts.prompts()).toEqual([]);
  });
});
