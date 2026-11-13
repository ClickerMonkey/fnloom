/**
 * Build 8 in the SDK and its test kit: API groups and stored types in the manifest, `ctx.data` against the fake hub's
 * data system (save, find with filters and search, get, table, versions, `expect`, remove), a fn's sensitivity flags
 * asked before a run, a mention provider searching resources for the person, and a scratch git repository.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RecordId, type SensitivityFlag } from '@harness/core';
import { mention, type } from '../declare.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { manifestOf } from '../manifest.ts';
import { system, type SystemImpl } from '../system.ts';
import { scratchFolder, testHub, type TestSystem } from './index.ts';

const Note = type({
  description: 'A note.',
  shape: g.obj({ title: g.text(), body: g.text(), stars: g.num({ whole: true }) }),
  display: { label: 'Note', title: 'title' },
  records: { shape: 'table', owner: 'person', search: { text: ['title', 'body'], embed: true } },
});

const ENV_FLAG: SensitivityFlag = { path: '.env', kind: 'env', rule: 'env-files', access: 'read', action: 'ask', why: 'Env files hold keys.', certain: true };

const notes = system('notes', {
  description: 'Notes kept by the hub.',
  groups: [{ name: 'notes', title: 'Notes', description: 'Add and find notes.' }],
  grants: { hub: ['data'] },
}).with({ types: { Note } }).with(() => ({
  fns: {
    add: fn({ description: 'Add a note.', group: 'notes', args: g.obj({ title: g.text(), body: g.text(), stars: g.num({ whole: true }) }), returns: g.text() }),
    find: fn({ description: 'Find notes.', group: 'notes', args: g.obj({ search: g.optional(g.text()), min: g.optional(g.num()) }), returns: g.list(g.text()) }),
    star: fn({ description: 'Star a note again.', args: g.obj({ id: g.text(), expect: g.num({ whole: true }) }), returns: g.num() }),
    drop: fn({ description: 'Remove a note.', args: g.obj({ id: g.text() }), returns: g.bool() }),
    grid: fn({ description: 'Notes as a table.', args: g.obj({}), returns: g.obj({ rows: g.num(), columns: g.list(g.text()) }) }),
    read: fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), flags: true }),
  },
  mentions: { pages: mention({ title: 'Page', description: 'Pages.', target: g.obj({ uri: g.text() }) }) },
}));

type Defs = (typeof notes)['defs'];
const NoteRef = notes.types.Note;

const impl: SystemImpl<Defs> = {
  fns: {
    add: { async run(args, ctx) { return ctx.done((await ctx.data.save(NoteRef, args)).id); } },
    find: {
      async run(args, ctx) {
        const { items } = await ctx.data.find(NoteRef, {
          ...(args.search === undefined ? {} : { search: args.search }),
          query: { filters: args.min === undefined ? [] : [{ field: 'stars', op: 'gte', value: args.min }], sort: [{ field: 'stars', dir: 'desc' }], limit: 10 },
        });
        return ctx.done(items.map((record) => record.value.title));
      },
    },
    star: {
      async run(args, ctx) {
        const id = recordId(args.id);
        const record = await ctx.data.get(NoteRef, id);
        if (record === undefined) { return ctx.invalid([{ path: 'id', message: 'No such note.' }]); }
        return ctx.done((await ctx.data.save(NoteRef, { ...record.value, stars: record.value.stars + 1 }, { id, expect: args.expect })).version);
      },
    },
    drop: { async run(args, ctx) { return ctx.done(await ctx.data.remove(NoteRef, recordId(args.id))); } },
    grid: { async run(_args, ctx) { const table = await ctx.data.table(NoteRef, { limit: 1 }); return ctx.done({ rows: table.rows.length, columns: table.columns.map((c) => c.name) }); } },
    read: {
      async run(args, ctx) { return ctx.done(args.path); },
      async flags(args) { return args.path.startsWith('.env') ? [{ ...ENV_FLAG, path: args.path }] : []; },
    },
  },
  mentions: {
    pages: {
      async search(query, ctx) { return (await ctx.resources.search(query, { limit: 3 })).map((hit) => ({ label: hit.title, target: { uri: hit.uri } })); },
      async hover() { return undefined; },
      async llm(target) { return target.uri; },
    },
  },
};

/** A record id from a fn's text arg (the fake mints `rec_…` ids). */
function recordId(text: string): RecordId {
  return RecordId.parse(text);
}

let kit: TestSystem<'notes', Defs> | undefined;
afterEach(async () => {
  await kit?.stop();
  kit = undefined;
});

describe('the contract', () => {
  it('puts API groups, a fn\'s group and flags, and a stored type\'s records in the manifest', async () => {
    const manifest = await manifestOf(notes, { version: '1.0.0' });
    expect(manifest.groups).toEqual([{ name: 'notes', title: 'Notes', description: 'Add and find notes.' }]);
    expect(manifest.fns.find((f) => f.name === 'add')).toMatchObject({ group: 'notes' });
    expect(manifest.fns.find((f) => f.name === 'read')).toMatchObject({ flags: true });
    expect(manifest.fns.find((f) => f.name === 'read')?.group).toBeUndefined();
    expect(manifest.types.find((t) => t.name === 'Note')?.records).toEqual({ shape: 'table', owner: 'person', search: { text: ['title', 'body'], embed: true } });
  });

  it('refuses a fn in an undeclared group, and a fn with flags but no flags hook', async () => {
    const stray = system('stray', { description: 'x', groups: [{ name: 'a', title: 'A', description: 'A.' }] })
      .with({ fns: { f: fn({ description: 'x', group: 'b', args: g.obj({}), returns: g.text() }) } });
    await expect(manifestOf(stray, { version: '1.0.0' })).rejects.toThrow(/API group b/);
    const hookless: SystemImpl<Defs> = { ...impl, fns: { ...impl.fns, read: { async run(args, ctx) { return ctx.done(args.path); } } } };
    await expect(testHub(notes, hookless)).rejects.toThrow(/needs a flags\(args, ctx\)/);
  });
});

describe('ctx.data on the fake hub', () => {
  it('saves, finds by filter and search, gets, versions, refuses a stale save, tables and removes', async () => {
    kit = await testHub(notes, impl);
    const milk = (await kit.call('add', { title: 'Milk', body: 'Buy oat milk', stars: 1 })).result;
    await kit.call('add', { title: 'Taxes', body: 'File by April', stars: 3 });
    expect((await kit.call('find', {})).result).toEqual(['Taxes', 'Milk']);
    expect((await kit.call('find', { search: 'oat' })).result).toEqual(['Milk']);
    expect((await kit.call('find', { min: 2 })).result).toEqual(['Taxes']);
    expect((await kit.call('star', { id: milk, expect: 1 })).result).toBe(2);
    expect((await kit.run('star', { id: milk, expect: 1 })).outcome.status).toBe('failed');
    expect(kit.records('Note').find((r) => r.id === milk)).toMatchObject({ title: 'Milk', version: 2, owner: 'act_tester', value: { stars: 2 } });
    expect((await kit.call('grid', {})).result).toEqual({ rows: 1, columns: ['title', 'body', 'stars', 'id'] });
    expect((await kit.call('drop', { id: milk })).result).toBe(true);
    expect(kit.records('Note').map((r) => r.title)).toEqual(['Taxes']);
    expect(kit.hub.data.versions.filter((v) => v.record === milk).map((v) => v.change)).toEqual(['created', 'updated', 'removed']);
  });
});

describe('flags and mentions', () => {
  it('asks a fn\'s flags hook which sensitive files a run would touch', async () => {
    kit = await testHub(notes, impl);
    expect(await kit.flags('read', { path: '.env.local' })).toEqual([{ ...ENV_FLAG, path: '.env.local' }]);
    expect(await kit.flags('read', { path: 'README.md' })).toEqual([]);
    expect(await kit.flags('add', { title: 'x', body: 'y', stars: 0 })).toEqual([]);
  });

  it('lets a mention provider search resources for the person asking', async () => {
    kit = await testHub(notes, impl);
    kit.hub.onMentionResources = (search) => Promise.resolve([{ uri: 'web://page/1', title: `About ${search.query}`, preview: '', score: 1 }]);
    const { options, searches } = await kit.mentions('pages', 'otters');
    expect(options).toEqual([{ label: 'About otters', target: { uri: 'web://page/1' } }]);
    expect(searches).toMatchObject([{ query: 'otters', limit: 3 }]);
    expect(searches[0]?.request).toMatch(/^mrq_/);
  });
});

describe('scratchFolder', () => {
  it('makes a git repository with its files committed, for change and sensitivity tests', async () => {
    const repo = await scratchFolder({ git: true, files: { 'a.txt': 'one\n', '.gitignore': 'dist/\n' } });
    try {
      expect(repo.git('status', '--porcelain')).toBe('');
      repo.write('a.txt', 'two\n');
      repo.write('dist/out.js', 'x');
      expect(repo.git('status', '--porcelain')).toBe(' M a.txt\n');
      expect(repo.read('a.txt')).toBe('two\n');
    } finally {
      await repo.dispose();
    }
  });
});
