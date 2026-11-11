/**
 * Context folders on the system side: each file's header checked with file and line, duplicate keys, the change
 * between two reads by key, the folder sent as context when the system starts, and live changes in dev.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { contextChange, formatContextProblem, parseContextFile, readContextFolder } from './context-files.ts';
import { sdkEnv } from './env.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

const file = (header: string, body = 'Body text.') => `---\n${header}\n---\n\n${body}\n`;
const GOOD = 'key: guide.start\ntitle: Start here\ndescription: Where to begin.\nsummary: The index of the guide.\nfns: [notes/ask]';

const dirs: string[] = [];
async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-context-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

let running: RunningSystem<'notes'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('a context file', () => {
  it('becomes a declaration: the header, its key as the name and its body as the content', () => {
    const parsed = parseContextFile('context/start.md', file(GOOD));
    expect(parsed.problems).toEqual([]);
    expect(parsed.file?.decl).toMatchObject({ name: 'guide.start', title: 'Start here', summary: 'The index of the guide.', fns: ['notes/ask'], imports: [], content: 'Body text.' });
    expect(parsed.file?.bodyLine).toBe(8);
  });

  it('says where a header is wrong: no fence, bad YAML, an unknown or ill-typed key, a missing summary', () => {
    const codes = (text: string) => parseContextFile('context/a.md', text).problems.map(formatContextProblem);
    expect(codes('# no header')).toEqual(['context/a.md:1:1 header starts with a YAML header between --- lines']);
    expect(codes(file('key: a\nsummary: [unclosed'))[0]).toMatch(/^context\/a\.md:\d+:\d+ header YAML: /);
    expect(codes(file(`${GOOD}\ncolour: red`))).toEqual([expect.stringMatching(/^context\/a\.md:7:1 header /)]);
    expect(codes(file(`${GOOD}\ntags: 3`))).toEqual([expect.stringMatching(/^context\/a\.md:7:1 header tags: /)]);
    expect(codes(file('key: a\ndescription: A.'))).toEqual([expect.stringMatching(/^context\/a\.md:2:1 missing-summary summary: /)]);
  });
});

describe('a context folder', () => {
  it('reads every markdown file below it and refuses a key used twice', async () => {
    const dir = await folder({ 'start.md': file(GOOD), 'deep/again.md': file(GOOD.replace('Start here', 'Again')), 'notes.txt': 'ignored' });
    const read = await readContextFolder(dir);
    expect(read.files.map((f) => f.file)).toEqual(['context/deep/again.md']);
    expect(read.problems.map(formatContextProblem)).toEqual(['context/start.md:2:1 duplicate-key key guide.start is already used by context/deep/again.md']);
    expect(await readContextFolder(join(dir, 'missing'))).toEqual({ files: [], problems: [] });
  });

  it('changes by key: new and edited entries upserted, gone ones removed, nothing for no change', () => {
    const a = parseContextFile('a.md', file(GOOD)).file?.decl;
    const b = parseContextFile('b.md', file(GOOD.replace('guide.start', 'guide.next'))).file?.decl;
    if (a === undefined || b === undefined) { throw new Error('fixtures did not parse'); }
    const edited = { ...a, content: 'New text.' };
    expect(contextChange(new Map([[a.name, a]]), new Map([[a.name, a]]))).toBeUndefined();
    expect(contextChange(new Map([[a.name, a], [b.name, b]]), new Map([[a.name, edited]]))).toEqual({ upsert: { context: [edited] }, remove: { context: ['guide.next'] } });
  });
});

const notes = system('notes', { description: 'Notes.' }).with({ fns: { ask: fn({ description: 'Ask.', args: g.obj({}), returns: g.text() }) } });

describe('serving a context folder', () => {
  it('sends the folder as context, stops on a broken one, and sends saved changes live when watching', async () => {
    const dir = await folder({ 'start.md': file(GOOD) });
    const hub = new FakeHub();
    running = await serve(notes, { fns: { ask: { async run(_a, ctx) { return ctx.done('ok'); } } } }, { hub: 'ws://hub.test/link', state: 'unused', context: dir }, hub.host({ env: { ...sdkEnv.parse(), HARNESS_CONTEXT_WATCH: true, HARNESS_CONTEXT_DEBOUNCE: 20 } }));
    await running.ready();
    expect(hub.manifests.at(-1)?.context.map((c) => c.name)).toEqual(['guide.start']);

    await writeFile(join(dir, 'start.md'), file(GOOD, 'Edited.'));
    await expect.poll(() => hub.patches.at(-1)?.upsert.context?.[0]?.content, { timeout: 5_000 }).toBe('Edited.');

    const broken = await folder({ 'bad.md': '# no header' });
    await expect(serve(notes, { fns: { ask: { async run(_a, ctx) { return ctx.done('ok'); } } } }, { hub: 'ws://hub.test/link', state: 'unused', context: broken }, new FakeHub().host())).rejects.toThrow(/context\/bad\.md:1:1 header/);
  });
});
