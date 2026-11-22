import { isHiddenPart, SystemName, type AnnouncedSystems, type ChatMessage, type SystemRecord, type TurnId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { systemRow } from '../catalog/fixtures.ts';
import { isPersonMessage, personWords } from '../contextor/history.ts';
import { announce, OFF_REASONS, ON_REASONS, systemsChanged, systemsNow, systemsPrompt, SYSTEMS_INTRO } from './announce.ts';
import { chatWorld, CLIENT } from './testing.ts';

const name = (s: string): SystemName => SystemName.parse(s);
const ALL = { seesSystem: () => true };

/** The live systems of most tests: fs and git connected, each with a description. */
const LIVE: SystemRecord[] = [systemRow('fs', 'connected', { description: 'Files on the host.' }), systemRow('git', 'connected', { description: 'Git repositories.' })];

describe('the systems as they are now', () => {
  it('reads every system the person sees from the database, on or off with why, in name order, without the hub or removed ones', async () => {
    const w = await chatWorld();
    for (const row of [
      systemRow('web', 'disconnected'), systemRow('fs', 'connected'), systemRow('crm', 'connected', { enabled: { functions: false, renderers: true } }),
      systemRow('db', 'needs-config'), systemRow('new', 'connected', { stage: 'installed' }), systemRow('old', 'removed'), systemRow('hub', 'connected'),
      systemRow('secret', 'connected'), systemRow('mail', 'connected'),
    ]) await w.store.table('systems').put(row);
    const now = await systemsNow(w.store, { seesSystem: (s) => s !== 'secret' }, { systems: [name('fs'), name('crm'), name('db'), name('new'), name('web')] });
    expect(now.on).toEqual([{ name: 'fs', label: 'Fs', description: 'fs system' }]);
    expect(now.off).toEqual([
      { name: 'crm', why: 'admin' }, { name: 'db', why: 'needs-config' }, { name: 'mail', why: 'chat' }, { name: 'new', why: 'held' }, { name: 'web', why: 'disconnected' },
    ]);
  });

  it('tells the model a system\'s longer `about` from its contract instead of its one-line description, when it has one', async () => {
    const w = await chatWorld();
    await w.store.table('systems').put(systemRow('fs', 'connected', { description: 'Files.', about: 'Files and a shell over chosen folders; load fs/guide first.' }));
    await w.store.table('systems').put(systemRow('git', 'connected', { description: 'Git repositories.' }));
    const now = await systemsNow(w.store, ALL, { systems: 'all' });
    expect(now.on.map((s) => s.description)).toEqual(['Files and a shell over chosen folders; load fs/guide first.', 'Git repositories.']);
  });
});

describe('what a message tells the model about the systems', () => {
  const on = (...names: string[]) => names.map((n) => ({ name: name(n), label: n.toUpperCase(), description: `${n} things` }));
  const first = announce(undefined, { on: on('fs', 'git'), off: [{ name: name('web'), why: 'disconnected' }] });

  it('snapshots the first turn\'s set for the system prompt and says nothing in the message', () => {
    expect(first).toEqual({ announced: { prompt: on('fs', 'git'), on: ['fs', 'git'], off: [{ name: 'web', why: 'disconnected' }] } });
  });

  it('says nothing and keeps the snapshot while nothing changed', () => {
    expect(announce(first.announced, { on: on('fs', 'git'), off: [{ name: name('web'), why: 'disconnected' }] })).toEqual({});
  });

  it('announces each kind of change once, with why, and keeps the system prompt\'s set as it was (Phil: announce all changes)', () => {
    let snapshot: AnnouncedSystems | undefined = first.announced;
    const step = (now: Parameters<typeof announce>[1]) => {
      const out = announce(snapshot, now);
      snapshot = out.announced ?? snapshot;
      expect(snapshot?.prompt).toEqual(on('fs', 'git'));
      return out.changed;
    };
    // the person turns git off in the chat; an admin switches fs off; web reconnects
    expect(step({ on: on('web'), off: [{ name: name('fs'), why: 'admin' }, { name: name('git'), why: 'chat' }] })).toEqual({
      type: 'systems-changed',
      on: [{ name: 'web', reason: ON_REASONS.disconnected, label: 'WEB', description: 'web things' }],
      off: [{ name: 'fs', reason: OFF_REASONS.admin }, { name: 'git', reason: OFF_REASONS.chat }],
    });
    // said once: the same state again says nothing
    expect(step({ on: on('web'), off: [{ name: name('fs'), why: 'admin' }, { name: name('git'), why: 'chat' }] })).toBeUndefined();
    // back on, each by the way it went off; the system prompt lists them, so no description again; web disconnects
    expect(step({ on: on('fs', 'git'), off: [{ name: name('web'), why: 'disconnected' }] })).toEqual({
      type: 'systems-changed', on: [{ name: 'fs', reason: ON_REASONS.admin }, { name: 'git', reason: ON_REASONS.chat }], off: [{ name: 'web', reason: OFF_REASONS.disconnected }],
    });
    // a new system is installed, and git is removed (gone from the database)
    expect(step({ on: on('crm', 'fs'), off: [{ name: name('web'), why: 'disconnected' }] })).toEqual({
      type: 'systems-changed', on: [{ name: 'crm', reason: ON_REASONS.new, label: 'CRM', description: 'crm things' }], off: [{ name: 'git', reason: OFF_REASONS.removed }],
    });
  });

  it('keeps a changed reason for an off system the prompt doesn\'t list without telling the model (it never heard of it)', () => {
    const out = announce(first.announced, { on: on('fs', 'git'), off: [{ name: name('web'), why: 'admin' }] });
    expect(out.changed).toBeUndefined();
    expect(out.announced?.off).toEqual([{ name: 'web', why: 'admin' }]);
  });

  it('tells again, once, when a system the prompt lists stays off for a new reason (Phil: announce admin disables)', () => {
    const away = announce(first.announced, { on: on('git'), off: [{ name: name('fs'), why: 'disconnected' }, { name: name('web'), why: 'disconnected' }] });
    expect(away.changed?.off).toEqual([{ name: 'fs', reason: OFF_REASONS.disconnected }]);
    const disabled = announce(away.announced, { on: on('git'), off: [{ name: name('fs'), why: 'admin' }, { name: name('web'), why: 'disconnected' }] });
    expect(disabled.changed).toEqual({ type: 'systems-changed', on: [], off: [{ name: 'fs', reason: OFF_REASONS.admin }] });
    expect(announce(disabled.announced, { on: on('git'), off: [{ name: name('fs'), why: 'admin' }, { name: name('web'), why: 'disconnected' }] })).toEqual({});
  });

  it('writes the lists in the one XML, escaped', () => {
    expect(systemsPrompt([])).toBe('');
    expect(systemsPrompt([{ name: name('fs'), label: 'Files', description: 'Reads <files> & folders.' }])).toBe(
      `<systems>\n${SYSTEMS_INTRO.replace('<systems_changed>', '&lt;systems_changed&gt;')}\n<system name="fs" label="Files">Reads &lt;files&gt; &amp; folders.</system>\n</systems>`,
    );
    expect(systemsChanged({ on: [{ name: name('crm'), reason: 'installed', label: 'CRM', description: 'Tickets.' }], off: [{ name: name('fs'), reason: 'switched off by an admin' }] })).toBe(
      '<systems_changed>\n<on name="crm" label="CRM" reason="installed">Tickets.</on>\n<off name="fs" reason="switched off by an admin" />\n</systems_changed>',
    );
  });
});

describe('system changes through sending messages', () => {
  async function world() {
    const w = await chatWorld();
    for (const row of LIVE) await w.store.table('systems').put(row);
    const send = async (text: string) => w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text }], client: CLIENT });
    const stored = async () => (await w.store.table('sessions').get(w.session.id))?.announcedSystems;
    const changes = (message: ChatMessage) => message.parts.filter((p) => p.type === 'systems-changed');
    const setSystem = async (system: string, patch: Partial<SystemRecord>) => {
      const row = await w.store.table('systems').get(name(system));
      if (row === undefined) throw new Error(`no ${system}`);
      await w.store.table('systems').put({ ...row, ...patch });
    };
    return { ...w, send, stored, changes, setSystem };
  }

  it('snapshots the first turn, then tells each toggle, admin switch, disconnect and install once, before the person\'s words', async () => {
    const w = await world();
    const first = await w.send('hello');
    expect(w.changes(first.message)).toEqual([]);
    expect(await w.stored()).toEqual({
      prompt: [{ name: 'fs', label: 'Fs', description: 'Files on the host.' }, { name: 'git', label: 'Git', description: 'Git repositories.' }], on: ['fs', 'git'], off: [],
    });

    // the person turns git off in this chat; an admin switches fs off
    await w.chat.sessions.update(w.session.id, { systems: [name('fs')] }, w.admin.id);
    await w.setSystem('fs', { enabled: { functions: false, renderers: true } });
    const second = await w.send('list my files');
    expect(w.changes(second.message)).toEqual([{ type: 'systems-changed', on: [], off: [{ name: 'fs', reason: OFF_REASONS.admin }, { name: 'git', reason: OFF_REASONS.chat }] }]);
    expect(w.chat.enrich.render(second.message)).toMatch(/^<systems_changed>\n<off name="fs" reason="switched off by an admin" \/>\n<off name="git" reason="turned off in this chat" \/>\n<\/systems_changed>\n\nlist my files\n\n<local_time>/);
    // the chat hides it, and the prompt's history reads it as the hub's block, not the person's words
    const added = second.message.parts.find((p) => p.type === 'systems-changed');
    expect(added !== undefined && isHiddenPart(added)).toBe(true);
    expect(personWords(w.chat.enrich.render(second.message))).toBe('list my files');
    expect(isPersonMessage({ role: 'user', content: w.chat.enrich.render(second.message) })).toBe(true);

    // said once
    const third = await w.send('and now?');
    expect(w.changes(third.message)).toEqual([]);

    // fs switched back on but disconnected at once is still off, now for that reason, so it is told again; a new
    // system is installed; git back in the chat
    await w.setSystem('fs', { enabled: { functions: true, renderers: true }, status: 'disconnected' });
    await w.store.table('systems').put(systemRow('crm', 'connected', { description: 'Tickets.' }));
    await w.chat.sessions.update(w.session.id, { systems: 'all' }, w.admin.id);
    const fourth = await w.send('what can you do');
    expect(w.changes(fourth.message)).toEqual([{
      type: 'systems-changed', on: [{ name: 'crm', reason: ON_REASONS.new, label: 'CRM', description: 'Tickets.' }, { name: 'git', reason: ON_REASONS.chat }],
      off: [{ name: 'fs', reason: OFF_REASONS.disconnected }],
    }]);

    // fs reconnects
    await w.setSystem('fs', { status: 'connected' });
    const fifth = await w.send('files again');
    expect(w.changes(fifth.message)).toEqual([{ type: 'systems-changed', on: [{ name: 'fs', reason: ON_REASONS.disconnected }], off: [] }]);
    // the system prompt's set never moved
    expect((await w.stored())?.prompt.map((s) => s.name)).toEqual(['fs', 'git']);
    expect((await w.stored())?.on).toEqual(['crm', 'fs', 'git']);
  });

  it('puts the snapshot back when a turn is undone, so a retry tells the same change again', async () => {
    const w = await world();
    const first = await w.send('hello');
    await endTurn(w, first.turn);
    await w.setSystem('git', { status: 'disconnected' });
    const second = await w.send('pull');
    expect(w.changes(second.message)).toHaveLength(1);
    expect((await w.store.table('turns').get(second.turn))?.start?.announcedSystems?.on).toEqual(['fs', 'git']);
    await endTurn(w, second.turn);
    await w.chat.undo.undoTurn(second.turn, w.admin.id);
    expect((await w.stored())?.on).toEqual(['fs', 'git']);
    const retry = await w.send('pull');
    expect(w.changes(retry.message)).toEqual([{ type: 'systems-changed', on: [], off: [{ name: 'git', reason: OFF_REASONS.disconnected }] }]);
  });

  it('lets the hub\'s own and a removed system be: neither is ever announced', async () => {
    const w = await world();
    await w.send('hello');
    await w.store.table('systems').put(systemRow('hub', 'connected'));
    await w.setSystem('git', { status: 'removed' });
    const second = await w.send('again');
    expect(w.changes(second.message)).toEqual([{ type: 'systems-changed', on: [], off: [{ name: 'git', reason: OFF_REASONS.removed }] }]);
    expect(await systemsNow(w.store, ALL, w.session)).toEqual({ on: [{ name: 'fs', label: 'Fs', description: 'Files on the host.' }], off: [] });
  });
});

async function endTurn(w: Awaited<ReturnType<typeof chatWorld>>, turn: TurnId): Promise<void> {
  const root = (await w.store.table('turns').get(turn))?.root;
  if (root !== undefined) await w.store.table('runs').update(root, { status: 'done' });
  await w.chat.turns.settle(turn, 'done');
}
