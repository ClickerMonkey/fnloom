import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent, agents, context, fn, g, hook, hub, manifestOf, system } from './index.ts';
import { contextFolder } from './testing/index.ts';

const support = system('support', { description: 'Tickets.' }).with({
  fns: { triage: agent({ description: 'Sorts a ticket.', args: g.obj({ ticket: g.text() }), returns: g.text(), instructions: 'You sort tickets.' }) },
});

const crm = system('crm', { description: 'Customers.' })
  .with({
    fns: {
      lookup: fn({ description: 'Find a customer.', args: g.obj({ name: g.text() }), returns: g.text() }),
      reviewer: agent({ description: 'Reviews a deal.', args: g.obj({ deal: g.text() }), returns: g.text(), instructions: 'You review deals.', injected: { maxTokens: 1500 } }),
      small: agent({ description: 'Small.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', injected: { detail: 'summary' } }),
      quiet: agent({ description: 'Quiet.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', injected: 'none' }),
    },
  })
  .with(({ fns }) => ({
    context: {
      deals: context({
        title: 'Deals', description: 'How deals are reviewed.', content: 'Look the customer up first.', fns: [fns.lookup],
        inject: { into: [fns.reviewer, agents.startingWith(hub.fns.chat), agents.of(support), '*/review*'], order: 40, requires: [fns.lookup], mode: 'tools' },
      }),
      brief: context({ description: 'Be brief.', content: 'Short answers.', inject: { into: [agents.all] } }),
      plain: context({ description: 'Not injected.', content: 'x' }),
    },
    hooks: { stage: hook({ description: 'The deal stage.', explains: 'The deal\'s stage. Mention it only when it matters.', order: 50 }) },
  }));

describe('injected context in the SDK', () => {
  it('marks agents\' refs with their kind, and only theirs', () => {
    expect(crm.fns.reviewer.kind).toBe('hub/llm');
    expect(hub.fns.chat.kind).toBe('hub/llm');
    expect('kind' in crm.fns.lookup).toBe(false);
  });

  it('builds patterns from refs', () => {
    expect(agents.startingWith(hub.fns.chat)).toBe('hub/chat*');
    expect(agents.of(support)).toBe('support/*');
    expect(agents.all).toBe('*');
  });

  it('writes inject, title and explains on the wire, refs as names and the defaults filled', async () => {
    const manifest = await manifestOf(crm, { version: '1.0.0' });
    const deals = manifest.context.find((decl) => decl.name === 'deals');
    expect(deals?.title).toBe('Deals');
    expect(deals?.inject).toEqual({ into: ['crm/reviewer', 'hub/chat*', 'support/*', '*/review*'], order: 40, requires: ['crm/lookup'], mode: 'tools' });
    expect(manifest.context.find((decl) => decl.name === 'brief')?.inject).toEqual({ into: ['*'], order: 100, requires: [] });
    expect(manifest.context.find((decl) => decl.name === 'plain')?.inject).toBeUndefined();
    expect(manifest.context.some((decl) => 'alwaysFor' in decl)).toBe(false);
    expect(manifest.hooks[0]).toMatchObject({ name: 'stage', explains: 'The deal\'s stage. Mention it only when it matters.' });
    // a pattern is no dependency (`support/*`); an agent's ref in another system is
    expect(manifest.requires).not.toContain('support');
    const other = system('other', { description: 'Other.' }).with({ context: { note: context({ description: 'A note.', content: 'x', inject: { into: [support.fns.triage] } }) } });
    expect((await manifestOf(other, { version: '1.0.0' })).requires).toContain('support');
  });

  it('puts an agent\'s injected setting in its payload', async () => {
    const manifest = await manifestOf(crm, { version: '1.0.0' });
    const payload = (name: string): unknown => z.object({ injected: z.unknown() }).partial().parse(manifest.fns.find((decl) => decl.name === name)?.payload).injected;
    expect(payload('reviewer')).toEqual({ detail: 'full', maxTokens: 1500 });
    expect(payload('small')).toEqual({ detail: 'summary' });
    expect(payload('quiet')).toBe('none');
  });
});

describe('a context folder\'s injections', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) { await rm(dir, { recursive: true, force: true }); } });

  async function folder(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'inject-'));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) { await writeFile(join(dir, name), text); }
    return dir;
  }

  it('takes exact agents and patterns, and refuses an exact name that is no agent', async () => {
    const dir = await folder({
      'good.md': '---\nkey: good\ndescription: Good.\nsummary: Good.\ninject: { into: [\'hub/chat*\', \'crm/reviewer\', \'hub/chat\', \'nobody/*\'], order: 40 }\n---\nText.\n',
      'bad.md': '---\nkey: bad\ndescription: Bad.\nsummary: Bad.\ninject: { into: [\'crm/lookup\', \'crm/reviewr\'] }\n---\nText.\n',
      'twice.md': '---\nkey: twice\ndescription: Twice.\nsummary: Twice.\ninject: { into: [\'hub/**\'] }\n---\nText.\n',
    });
    const checked = await contextFolder(dir, crm);
    expect(checked.context.get('crm/good')?.inject).toEqual({ into: ['hub/chat*', 'crm/reviewer', 'hub/chat', 'nobody/*'], order: 40, requires: [] });
    expect(checked.problems.filter((line) => line.includes('good.md'))).toEqual([]);
    const bad = checked.problems.filter((line) => line.includes('bad.md'));
    expect(bad).toHaveLength(2);
    expect(bad[0]).toContain('inject.into names crm/lookup, which is not an agent');
    expect(bad[1]).toContain('crm/reviewr, which is not an agent');
    expect(checked.problems.some((line) => line.includes('twice.md') && line.includes('write one *'))).toBe(true);
  });

  it('refuses alwaysFor in a header', async () => {
    const dir = await folder({ 'old.md': '---\nkey: old\ndescription: Old.\nsummary: Old.\nalwaysFor: [\'hub/chat\']\n---\nText.\n' });
    const checked = await contextFolder(dir, crm);
    expect(checked.problems.some((line) => line.includes('old.md') && line.includes('alwaysFor'))).toBe(true);
  });
});
