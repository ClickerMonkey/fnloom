import { IDS, SystemName, type ChatMessage, type HookDecl, type UserInfo } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { hookTag } from './enrich.ts';
import { hiddenMessage } from './turns.ts';
import { chatWorld, gin } from './testing.ts';

const turn = IDS.turn.parse('trn_1');
const hookDecl = (name: string, order: number): HookDecl => ({ name, description: `The ${name} hook.`, order, timeout: 1_000 });

async function world(systems: SystemName[] | 'all' = 'all') {
  const w = await chatWorld({ systems });
  const user: UserInfo = { id: w.admin.id, name: 'Ada', email: w.admin.email, role: 'admin', groups: [], timeZone: 'America/New_York', locale: 'en-US' };
  return { ...w, user };
}

describe('what the hub adds to a message', () => {
  it('always adds the person\'s local time', async () => {
    const w = await world();
    const { parts } = await w.chat.enrich.enrich({ session: w.session, turn, text: '', user: w.user });
    expect(parts).toEqual([{ type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'now', text: 'Saturday 2026-11-07T09:30:00-05:00 (America/New_York)' }] }]);
  });

  it('adds suggested context and fns from the index, each in its own extra, best match first with its score', async () => {
    const w = await world();
    w.index.suggestions = [
      { kind: 'fn', name: 'fs/write', description: 'Write a file.', score: 0.7 },
      { kind: 'context', name: 'fs/guide', description: 'How files work.', score: 0.8 },
      { kind: 'fn', name: 'fs/read', description: 'Read a file.', score: 0.9 },
    ];
    const { parts } = await w.chat.enrich.enrich({ session: w.session, turn, text: 'read the readme', user: w.user });
    expect(parts.slice(1)).toEqual([
      { type: 'extra', extra: 'suggested-context', blocks: [{ type: 'suggest-context', items: [{ context: 'fs/guide', why: 'How files work.', score: 0.8 }] }] },
      { type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', items: [{ fn: 'fs/read', why: 'Read a file.', score: 0.9 }, { fn: 'fs/write', why: 'Write a file.', score: 0.7 }] }] },
    ]);
  });

  it('adds no suggestions in a session whose prompts the graph contextor chooses', async () => {
    const w = await world();
    w.index.suggestions = [{ kind: 'fn', name: 'fs/read', description: 'Read a file.', score: 0.9 }];
    const graph = { ...w.session, contextor: { type: 'graph' as const, metrics: {}, spread: { damping: 0.5, hops: 2 }, floorExchanges: 1, shares: { history: 0.45, context: 0.35, fns: 0.2 }, threshold: 0.15, evaluate: 'perMessage' as const } };
    const { parts } = await w.chat.enrich.enrich({ session: graph, turn, text: 'read the readme', user: w.user });
    expect(parts.map((p) => p.type === 'extra' ? p.extra : p.type)).toEqual(['local-time']);
    const { parts: plain } = await w.chat.enrich.enrich({ session: { ...w.session, contextor: { type: 'plain' } }, turn, text: 'read the readme', user: w.user });
    expect(plain.map((p) => p.type === 'extra' ? p.extra : p.type)).toEqual(['local-time', 'suggested-fns']);
  });

  it('skips suggestions when the index fails, and says so in the log', async () => {
    const w = await world();
    w.index.suggestions = new Error('embedder down');
    const { parts } = await w.chat.enrich.enrich({ session: w.session, turn, text: 'hello', user: w.user });
    expect(parts.map((p) => p.type)).toEqual(['extra']);
    expect(w.logs.some((l) => l.msg === 'chat.suggest.failed')).toBe(true);
  });

  it('runs the session systems\' hooks in order and keeps what they add', async () => {
    const w = await world([SystemName.parse('git'), SystemName.parse('crm')]);
    w.catalog.addEntry('hooks', 'git/branch', hookDecl('branch', 2));
    w.catalog.addEntry('hooks', 'crm/ticket', hookDecl('ticket', 1));
    w.catalog.addEntry('hooks', 'web/news', hookDecl('news', 0));
    const git = w.link.connect('git', { hook: async ({ hook, message }) => Promise.resolve([{ type: 'text', tag: 'branch', text: `${hook} on main for "${message.text}" at ${message.time.local}` }]) });
    w.link.connect('crm', { hook: async () => Promise.resolve([{ type: 'load', fns: ['crm/find'] }]) });
    w.link.connect('web', { hook: async () => Promise.resolve([{ type: 'text', tag: 'news', text: 'not allowed here' }]) });
    const { parts } = await w.chat.enrich.enrich({ session: w.session, turn, text: 'ship it', user: w.user });
    expect(parts.slice(1)).toEqual([
      { type: 'hook', hook: 'crm/ticket', blocks: [{ type: 'load', fns: ['crm/find'] }] },
      { type: 'hook', hook: 'git/branch', blocks: [{ type: 'text', tag: 'branch', text: 'branch on main for "ship it" at 2026-11-07T09:30:00-05:00' }] },
    ]);
    expect(git.calls[0]?.data).toMatchObject({ hook: 'branch', message: { session: w.session.id, turn, text: 'ship it', user: w.user } });
  });

  it('leaves out hooks that fail, time out, add nothing, are unavailable or whose system is away', async () => {
    const w = await world();
    for (const [name, order] of [['a/fails', 1], ['b/empty', 2], ['c/off', 3], ['d/away', 4], ['e/slow', 5]] as const) {
      w.catalog.addEntry('hooks', name, { ...hookDecl(name.split('/')[1] ?? name, order), timeout: 20 });
    }
    w.link.connect('a', { hook: async () => Promise.reject(new Error('boom')) });
    w.link.connect('b', { hook: async () => Promise.resolve([]) });
    w.link.connect('c', { hook: async () => Promise.resolve([{ type: 'text', tag: 'x', text: 'y' }]) });
    w.catalog.unavailable.set('c/off', { unavailable: 'disabled', detail: 'switched off' });
    w.link.connect('e', { hook: async (_, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { reject(new Error('timed out')); }); }) });
    const { parts } = await w.chat.enrich.enrich({ session: w.session, turn, text: 'x', user: w.user });
    expect(parts.map((p) => p.type)).toEqual(['extra']);
    expect(w.logs.filter((l) => l.msg === 'chat.hook.failed').map((l) => String(l['hook'])).sort()).toEqual(['a/fails', 'd/away', 'e/slow']);
  });
});

describe('the text the LLM gets', () => {
  const message = (parts: ChatMessage['parts']): ChatMessage => ({
    id: IDS.message.parse('msg_1'), session: IDS.session.parse('ses_1'), turn, author: IDS.actor.parse('act_ada'), role: 'user', parts, runs: [], status: 'done', replyAll: false,
    answerers: [], createdAt: 0,
  });

  it('writes mentions in place and extras and hooks as tagged blocks after', async () => {
    const w = await world();
    const text = w.chat.enrich.render(message([
      { type: 'text', text: 'Open ' },
      { type: 'mention', provider: 'fs/files', label: 'a "b".md', target: { path: 'a.md' }, text: 'The file <a.md> in the repo.' },
      { type: 'text', text: ' now.' },
      { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'now', text: 'Saturday 09:30' }] },
      { type: 'hook', hook: 'git/branch', blocks: [{ type: 'text', tag: 'branch', text: 'main' }, { type: 'load', context: ['git/guide'], fns: ['git/log'] }] },
    ]));
    expect(text).toBe([
      'Open <mention provider="fs/files" label="a &quot;b&quot;.md">The file &lt;a.md&gt; in the repo.</mention> now.',
      '<local_time>\n<now>Saturday 09:30</now>\n</local_time>',
      '<git_branch>\n<branch>main</branch>\nLoaded: git/guide, git/log\n</git_branch>',
    ].join('\n\n'));
  });

  it('gives the model a form\'s answers in their hidden tag, and nothing a person would see', async () => {
    const w = await world();
    const parts = [{ type: 'input-answer' as const, run: IDS.run.parse('run_9'), title: 'Trip <plan>', value: { days: 3 }, text: 'days: 3\ncity: Rome & Paris' }];
    expect(w.chat.enrich.render(message(parts))).toBe('<input-answer title="Trip &lt;plan&gt;">days: 3\ncity: Rome &amp; Paris</input-answer>');
    expect(hiddenMessage({ parts })).toBe(true);
    expect(hiddenMessage({ parts: [...parts, { type: 'text', text: 'and this' }] })).toBe(false);
  });

  it('writes every other part as a tag', async () => {
    const w = await world();
    const ref = { hash: 'a'.repeat(64), size: 3, mime: 'text/plain' };
    const text = w.chat.enrich.render(message([
      { type: 'command', context: 'fs/plan', args: { goal: 'ship "it"', 'two words': 'x' } },
      { type: 'invocation', run: IDS.run.parse('run_1'), fn: 'fs/read' },
      { type: 'file', ref, name: 'notes.txt' },
      { type: 'link', link: { resource: 'fs://repo/a.md', title: 'a.md' } },
      { type: 'link', link: { url: 'https://example.com/', title: 'Example' } },
      { type: 'link', link: { file: ref, title: 'Notes' } },
      { type: 'link', link: { run: IDS.run.parse('run_2'), title: 'The run' } },
      { type: 'attachment', attachment: 'fs/diff', data: { lines: 2 }, title: 'Diff' },
    ]));
    expect(text).toBe([
      '<command context="fs/plan" goal="ship &quot;it&quot;" two_words="x" /><invocation fn="fs/read" run="run_1" />'
        + `<file name="notes.txt" mime="text/plain" size="3" hash="${ref.hash}" /><link resource="fs://repo/a.md" title="a.md" />`
        + '<link url="https://example.com/" title="Example" />'
        + `<link file="${ref.hash}" title="Notes" /><link run="run_2" title="The run" />`,
      '<attachment name="fs/diff" title="Diff">{"lines":2}</attachment>',
    ].join('\n\n'));
  });

  it('lists suggestions in their block', async () => {
    const w = await world();
    expect(w.chat.enrich.block('suggested_fns', [{ type: 'suggest-fns', items: [{ fn: 'fs/read', why: 'Read <files>.' }, { fn: 'fs/ls' }] }]))
      .toBe('<suggested_fns>\n- fn fs/read: Read &lt;files&gt;.\n- fn fs/ls\n</suggested_fns>');
    expect(w.chat.enrich.block('suggested_context', [{ type: 'suggest-context', items: [{ context: 'fs/guide' }] }])).toBe('<suggested_context>\n- context fs/guide\n</suggested_context>');
  });

  it('makes hook names tag-safe', () => {
    expect(hookTag('fs/git-branch.now')).toBe('fs_git_branch_now');
  });

  it('keeps gin fixtures usable', () => {
    expect(gin({ name: 'text' })).toEqual({ name: 'text' });
  });
});
