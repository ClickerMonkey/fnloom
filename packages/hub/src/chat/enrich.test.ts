import { ChatModeConfig, IDS, READ_TAG, SuggestDecision, SystemName, type ChatMessage, type HookDecl, type Session, type UserInfo } from '@harness/core';
import { fn, g } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { hookTag, HubMessageEnricher, SUGGESTED_CONTEXT_LINES, SUGGESTED_FNS_LINES, suggestedAfter, suggestedIn } from './enrich.ts';
import { ContextCatalog } from '../contextor/testing.ts';
import { CatalogFnViews } from '../contextor/views.ts';
import { hiddenMessage } from './turns.ts';
import { chatWorld, CLIENT, gin } from './testing.ts';

const turn = IDS.turn.parse('trn_1');
const hookDecl = (name: string, order: number): HookDecl => ({ name, description: `The ${name} hook.`, order, timeout: 1_000 });

async function world(systems: SystemName[] | 'all' = 'all') {
  const w = await chatWorld({ systems });
  const user: UserInfo = { id: w.admin.id, name: 'Ada', email: w.admin.email, role: 'admin', groups: [], timeZone: 'America/New_York', locale: 'en-US' };
  // a decision model that takes every candidate, so the index's fixtures are what is suggested whatever their score
  w.decisions.role = { model: 'judge', threshold: 0.5 };
  w.decisions.answer = () => 1;
  await w.chat.suggestions.set(SuggestDecision.parse({ by: 'decision', floor: 0 }), w.admin.id);
  return { ...w, user };
}

describe('what the hub adds to a message', () => {
  it('always adds the person\'s local time', async () => {
    const w = await world();
    const { parts } = await w.chat.enrich.enrich({ session: w.session, turn, text: '', user: w.user });
    expect(parts).toEqual([{ type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'now', text: 'Saturday 2026-11-07T09:30:00-05:00 (America/New_York)' }] }]);
  });

  it('adds suggested context and fns from the index, each in its own extra, best match first with its score and card', async () => {
    const w = await world();
    w.catalog.addFn('fs', { name: 'read', description: 'Read a file.', tags: [READ_TAG] });
    w.catalog.addFn('fs', { name: 'write', description: 'Write a file.' });
    w.catalog.addContext('fs', { name: 'guide', title: 'Files', description: 'How files work.' });
    w.index.suggestions = [
      { kind: 'fn', name: 'fs/write', description: 'Write a file.', score: 0.7 },
      { kind: 'context', name: 'fs/guide', description: 'How files work.', score: 0.8 },
      { kind: 'fn', name: 'fs/read', description: 'Read a file.', score: 0.9 },
    ];
    const { parts } = await w.chat.enrich.enrich({ session: w.session, turn, text: 'read the readme', user: w.user });
    expect(parts.slice(1)).toEqual([
      { type: 'extra', extra: 'suggested-context', blocks: [{ type: 'suggest-context', toolset: 'tools', items: [{ context: 'fs/guide', title: 'Files', why: 'How files work.', score: 0.8 }] }] },
      { type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', toolset: 'tools', items: [
        { fn: 'fs/read', why: 'Read a file.', score: 0.9, card: { label: 'Read', mode: 'read' } },
        { fn: 'fs/write', why: 'Write a file.', score: 0.7, card: { label: 'Write', mode: 'write' } },
      ] }] },
    ]);
    // the fixture catalog has no signatures: the cards go without, and the log says why
    expect(w.logs.filter((l) => l.msg === 'chat.suggest.signature-unreadable')).toHaveLength(2);
  });

  it('adds no suggestions in a session whose prompts the graph contextor chooses', async () => {
    const w = await world();
    w.catalog.addFn('fs', { name: 'read', description: 'Read a file.' });
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

  it('writes suggestions as cards in their block, escaped, not wrapped twice', async () => {
    const w = await world();
    const card = { label: 'Read', mode: 'read' as const, args: 'obj{path: text}', returns: 'text' };
    expect(w.chat.enrich.block('suggested_fns', [{ type: 'suggest-fns', toolset: 'tools', items: [{ fn: 'fs/read', why: 'Read <files>.', card }, { fn: 'fs/ls' }] }])).toBe([
      '<suggested_fns>', SUGGESTED_FNS_LINES.tools,
      '<fn name="fs/read" label="Read" mode="read" available="yes">', 'Read &lt;files&gt;.', '<args>obj{path: text}</args>', '<returns>text</returns>', '</fn>',
      // a suggestion written before cards were snapshotted shows what it has
      '<fn name="fs/ls" label="Ls" available="yes" />',
      '</suggested_fns>',
    ].join('\n'));
    expect(w.chat.enrich.block('suggested_context', [{ type: 'suggest-context', items: [{ context: 'fs/guide', title: 'Files & folders', why: 'How files work.' }] }]))
      .toBe(`<suggested_context>\n${SUGGESTED_CONTEXT_LINES.tools}\n<context key="fs/guide" title="Files &amp; folders">How files work.</context>\n</suggested_context>`);
    // a hook's suggestions sit in its own tag
    expect(w.chat.enrich.block('crm_ticket', [{ type: 'suggest-context', toolset: 'static', items: [{ context: 'crm/guide' }] }]))
      .toBe(`<crm_ticket>\n<suggested_context>\n${SUGGESTED_CONTEXT_LINES.static}\n<context key="crm/guide" />\n</suggested_context>\n</crm_ticket>`);
  });

  it('says how to use a suggestion only in the ways the toolset it was sent in can (regression: "or call one by name")', () => {
    // tools mode: a fn must be loaded before it is called; nothing is called by name
    expect(SUGGESTED_FNS_LINES.tools).toContain('hub/load_fns');
    expect(SUGGESTED_FNS_LINES.tools).not.toMatch(/by (its )?name/);
    expect(SUGGESTED_CONTEXT_LINES.tools).toContain('hub/load_context');
    // the static toolset runs any fn by name, and has no hub/load_fns or hub/load_context (its load replaces them)
    expect(SUGGESTED_FNS_LINES.static).toContain('run one by its name');
    expect(SUGGESTED_FNS_LINES.static).not.toContain('hub/load');
    expect(SUGGESTED_CONTEXT_LINES.static).not.toContain('hub/load');
    for (const line of [...Object.values(SUGGESTED_FNS_LINES), ...Object.values(SUGGESTED_CONTEXT_LINES)]) expect(line).toContain('Nothing is suggested twice');
    for (const line of Object.values(SUGGESTED_FNS_LINES)) expect(line).toContain('available="no"');
  });

  it('makes hook names tag-safe', () => {
    expect(hookTag('fs/git-branch.now')).toBe('fs_git_branch_now');
  });

  it('keeps gin fixtures usable', () => {
    expect(gin({ name: 'text' })).toEqual({ name: 'text' });
  });
});

describe('suggestions as sent', () => {
  /** A world whose enricher reads signatures from a contextor catalog holding `fs/read`, with instructions and examples. */
  async function carded(mode: 'tools' | 'static') {
    const w = await world();
    const described = {
      description: 'Read a text file.', instructions: 'Read whole files under 2000 lines.', tags: [READ_TAG], promptExamples: 1,
      examples: [{ args: { path: 'notes.txt' }, result: 'buy milk', note: 'a small file' }, { args: { path: 'big.md' } }],
    };
    const signatures = new ContextCatalog();
    signatures.addFn('fs/read', fn({ ...described, args: g.obj({ path: g.text() }), returns: g.text() }));
    w.catalog.addFn('fs', { ...described, name: 'read' });
    const enrich = new HubMessageEnricher(w.deps, w.chat.suggestions, new CatalogFnViews(signatures));
    const session: Session = { ...w.session, mode: ChatModeConfig.parse({ type: mode }) };
    w.index.suggestions = [{ kind: 'fn', name: 'fs/read', description: 'Read a text file.', score: 0.9 }];
    return { ...w, enrich, session };
  }

  const message = (parts: ChatMessage['parts']): ChatMessage => ({
    id: IDS.message.parse('msg_1'), session: IDS.session.parse('ses_1'), turn, author: IDS.actor.parse('act_ada'), role: 'user', parts, runs: [], status: 'done', replyAll: false,
    answerers: [], createdAt: 0,
  });

  it('in tools mode, carry the signature but not the instructions: the native tool carries those once loaded', async () => {
    const w = await carded('tools');
    const { parts } = await w.enrich.enrich({ session: w.session, turn, text: 'read notes', user: w.user });
    expect(parts[1]).toEqual({ type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', toolset: 'tools', items: [
      { fn: 'fs/read', why: 'Read a text file.', score: 0.9, card: { label: 'Read', mode: 'read', args: 'obj{path: text}', returns: 'text' } },
    ] }] });
  });

  it('in the static toolset, snapshot the instructions and examples into the part, so later prompts read the same card', async () => {
    const w = await carded('static');
    const { parts } = await w.enrich.enrich({ session: w.session, turn, text: 'read notes', user: w.user });
    const before = w.enrich.render(message(parts.slice(1)));
    expect(before).toBe([
      '<suggested_fns>', SUGGESTED_FNS_LINES.static,
      '<fn name="fs/read" label="Read" mode="read" available="yes">', 'Read a text file.', '<args>obj{path: text}</args>', '<returns>text</returns>',
      '<instructions>Read whole files under 2000 lines.</instructions>',
      '<example note="a small file">{"path":"notes.txt"} → "buy milk"</example>',
      '<more_examples count="1">Read them with hub/fn_examples {"fn":"fs/read","query":"what you are about to do"}</more_examples>',
      '</fn>', '</suggested_fns>',
    ].join('\n'));
    // the fn changes after the message was sent: the message still reads as it was sent
    const record = w.catalog.fnRecords.get('fs/read');
    if (record === undefined) throw new Error('no fs/read');
    w.catalog.fnRecords.set('fs/read', { ...record, decl: { ...record.decl, instructions: 'Something else.', examples: [] } });
    expect(w.enrich.render(message(parts.slice(1)))).toBe(before);
  });

  it('carry what blocks a held fn, in the hub\'s words, and leave out one the model may not see', async () => {
    const w = await carded('tools');
    const record = w.catalog.fnRecords.get('fs/read');
    if (record === undefined) throw new Error('no fs/read');
    w.catalog.fnRecords.set('fs/read', { ...record, available: { unavailable: 'held', detail: 'fs/read changed and waits for an admin to approve it' } });
    w.catalog.addFn('fs', { name: 'secret', visibility: 'user' });
    w.index.suggestions = [
      { kind: 'fn', name: 'fs/read', description: 'Read a text file.', score: 0.9 }, { kind: 'fn', name: 'fs/secret', description: 'Secret.', score: 0.8 },
      { kind: 'fn', name: 'fs/gone', description: 'Gone.', score: 0.7 },
    ];
    const { parts } = await w.enrich.enrich({ session: w.session, turn, text: 'read notes', user: w.user });
    expect(suggestedIn(parts)).toEqual(['fs/read']);
    expect(w.enrich.render(message(parts.slice(1)))).toContain('<fn name="fs/read" label="Read" mode="read" available="no" reason="fs/read changed and waits for an admin to approve it">');
  });

  it('suggest a fn or context once in a chat: never again in a later turn, nor twice in one message (Phil: never suggested twice)', async () => {
    const w = await world();
    w.catalog.addFn('fs', { name: 'read', description: 'Read a file.' });
    w.catalog.addContext('fs', { name: 'guide', description: 'How files work.' });
    w.index.suggestions = [{ kind: 'fn', name: 'fs/read', description: 'Read a file.', score: 0.9 }, { kind: 'context', name: 'fs/guide', description: 'How files work.', score: 0.8 }];
    // a hook suggests what the hub already did, and one thing more
    w.catalog.addEntry('hooks', 'crm/ticket', { name: 'ticket', description: 'Tickets.', order: 1, timeout: 1_000 });
    w.catalog.addFn('crm', { name: 'find', description: 'Find a ticket.' });
    w.link.connect('crm', { hook: async () => Promise.resolve([{ type: 'suggest-fns', items: [{ fn: 'fs/read' }, { fn: 'crm/find', why: 'Find a ticket.' }] }]) });
    const first = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'read the readme' }], client: CLIENT });
    expect(suggestedIn(first.message.parts)).toEqual(['fs/guide', 'fs/read', 'crm/find']);
    // kept in the hub database with the session
    expect((await w.store.table('sessions').get(w.session.id))?.suggested).toEqual(['fs/guide', 'fs/read', 'crm/find']);
    const second = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'read it again' }], client: CLIENT });
    expect(suggestedIn(second.message.parts)).toEqual([]);
    expect(second.message.parts.map((p) => (p.type === 'extra' ? p.extra : p.type))).toEqual(['text', 'local-time']);
    // something new still is
    w.catalog.addFn('fs', { name: 'write', description: 'Write a file.' });
    w.index.suggestions = [...w.index.suggestions, { kind: 'fn', name: 'fs/write', description: 'Write a file.', score: 0.7 }];
    const third = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'now write it' }], client: CLIENT });
    expect(suggestedIn(third.message.parts)).toEqual(['fs/write']);
    expect((await w.store.table('sessions').get(w.session.id))?.suggested).toEqual(['fs/guide', 'fs/read', 'crm/find', 'fs/write']);
  });

  it('never suggest what the session has loaded, nor context the person may not see or that is gone', async () => {
    const w = await world();
    w.catalog.addFn('fs', { name: 'read', description: 'Read a file.' });
    w.catalog.addFn('fs', { name: 'write', description: 'Write a file.' });
    w.catalog.addContext('fs', { name: 'guide', description: 'How files work.' });
    w.catalog.addContext('fs', { name: 'tips', description: 'Tips.' });
    // Bo's own memory: Ada may not see it
    const bo = IDS.actor.parse('act_bo');
    const mine = w.catalog.addContext('fs', { name: 'mine', description: 'Notes of Bo.' });
    w.catalog.contexts.set(mine.name, { ...mine, origin: { type: 'memory', author: bo, scope: { to: 'user', user: bo } } });
    w.index.suggestions = [
      { kind: 'fn', name: 'fs/read', description: 'Read a file.', score: 0.9 }, { kind: 'fn', name: 'fs/write', description: 'Write a file.', score: 0.8 },
      { kind: 'context', name: 'fs/guide', description: 'How files work.', score: 0.9 }, { kind: 'context', name: 'fs/tips', description: 'Tips.', score: 0.8 },
      { kind: 'context', name: 'fs/mine', description: 'Notes of Bo.', score: 0.7 }, { kind: 'context', name: 'fs/gone', description: 'Gone.', score: 0.6 },
    ];
    // "not in your tools yet" would be false for what the session already loaded
    const session: Session = { ...w.session, tools: ['fs/read'], context: ['fs/guide'] };
    const { parts } = await new HubMessageEnricher(w.deps, w.chat.suggestions).enrich({ session, turn, text: 'files', user: w.user });
    expect(suggestedIn(parts)).toEqual(['fs/tips', 'fs/write']);
  });

  it('keep what a session was suggested when nothing new is', () => {
    expect(suggestedAfter({ suggested: ['fs/read'] }, [])).toEqual({});
    expect(suggestedAfter({}, [{ type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', items: [{ fn: 'fs/read' }] }] }])).toEqual({ suggested: ['fs/read'] });
  });
});
