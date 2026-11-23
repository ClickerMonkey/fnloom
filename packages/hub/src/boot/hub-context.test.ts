/**
 * The hub's own context files (packages/hub/context/): the hub's features, each injected into the chat agents in the
 * hub's 10 to 30 range with a title, a summary for the small agent and the fns it brings, and checked at boot.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hub, HUB_CONTEXT_KEYS, manifestOf } from '@harness/sdk';
import { ContextFolderError } from '@harness/sdk/server';
import { describe, expect, it } from 'vitest';
import { hubContext, withHubContext } from './hub-context.ts';

/** The hub's features as section 5 of plan injected-context-2026-11-22 lists them, with the fns each brings. */
const FEATURES: Record<string, { title: string; fns: string[]; requires?: string[]; mode?: 'tools' }> = {
  finding_fns: { title: 'Finding and adding fns', fns: ['hub/fns_search', 'hub/fns_load', 'hub/fns_drop', 'hub/ctx_search', 'hub/ctx_load', 'hub/ctx_drop'], mode: 'tools' },
  memory: { title: 'Memory', fns: ['hub/remember'], requires: ['hub/ctx_search', 'hub/forget', 'hub/memory_update'] },
  earlier_chats: { title: 'Earlier chats', fns: ['hub/sessions_list', 'hub/session_messages'] },
  asking: { title: 'Asking mid-task', fns: ['hub/ask_user'] },
  attached_files: { title: 'Attached files', fns: ['hub/resource_read', 'hub/resource_send'] },
  // only while a model that can see images is set up (hub/image_read needs the describe role)
  images: { title: 'Unseen images', fns: ['hub/image_read'] },
  resources: { title: 'Resources', fns: ['hub/search_resources', 'hub/resource_read'], requires: ['hub/resource_outline', 'hub/resource_send'] },
  saved_fns: { title: 'Saved fns', fns: [], requires: ['hub/fns_search', 'hub/fns_get'] },
  examples: { title: 'Examples', fns: ['hub/fns_examples'] },
  background_runs: { title: 'Background runs', fns: ['hub/run_status', 'hub/run_wait'] },
  undo: { title: 'Undo', fns: [], requires: ['hub/turn_undo'] },
  limits: { title: 'What this app can\'t do', fns: [] },
  later: { title: 'Nothing runs later', fns: [] },
};

describe('the hub\'s context files', () => {
  it('are the hub\'s features, each injected into the chat agents with its title, summary, order and fns', async () => {
    const items = await hubContext(await manifestOf(hub, { version: '0' }));
    expect(items.map((item) => item.name).sort()).toEqual(Object.keys(FEATURES).sort());
    for (const item of items) {
      const want = FEATURES[item.name];
      expect(want, item.name).toBeDefined();
      expect(item.title).toBe(want?.title);
      expect(item.fns).toEqual(want?.fns);
      expect(item.inject?.into).toEqual(['hub/chat*']);
      expect(item.inject?.requires ?? []).toEqual(want?.requires ?? []);
      expect(item.inject?.order).toBeGreaterThanOrEqual(10);
      expect(item.inject?.order).toBeLessThanOrEqual(30);
      // one text for both modes, except how tools mode adds fns (static mode's guide says its own)
      expect(item.inject?.mode).toBe(want?.mode);
      // the small agent takes each at its summary: short, and naming what the item brings
      expect(item.summary?.length ?? 0, item.name).toBeLessThanOrEqual(200);
      for (const fn of want?.fns ?? []) {
        const said = `${item.summary ?? ''} ${item.content ?? ''}`;
        expect(said, `${item.name} ${fn}`).toContain(fn);
      }
    }
  });

  it('keep the whole set of summaries inside the small agent\'s 600-token cap', async () => {
    const items = await hubContext(await manifestOf(hub, { version: '0' }));
    const words = items.reduce((sum, item) => sum + `## ${item.title ?? ''}\n\n${item.summary ?? ''}`.split(/\s+/).length, 0);
    // about 4/3 tokens a word: the hub's share leaves room for the systems' items
    expect(words * 4 / 3).toBeLessThan(400);
  });

  it('are the keys the SDK gives refs to (hub.context.later), so a system can name one', async () => {
    const items = await hubContext(await manifestOf(hub, { version: '0' }));
    expect(items.map((item) => item.name).sort()).toEqual([...HUB_CONTEXT_KEYS].sort());
    expect(hub.context.later).toMatchObject({ ref: 'context', name: 'hub/later' });
    expect(`${hub.context.limits}`).toBe('context:hub/limits');
  });

  it('split what the app can\'t do: `limits` (accounts, setup) and `later` (nothing later by itself, no messages later), naming no system', async () => {
    const items = await hubContext(await manifestOf(hub, { version: '0' }));
    const text = (name: string): string => {
      const item = items.find((found) => found.name === name);
      return `${item?.description ?? ''}\n${item?.summary ?? ''}\n${item?.content ?? ''}`;
    };
    const limits = text('limits');
    const later = text('later');
    expect(limits).toContain('You can\'t connect accounts or set up services');
    expect(limits).toContain('Never invent links');
    expect(limits).not.toMatch(/later|remind|every week/i);
    expect(later).toContain('Nothing runs later by itself.');
    expect(later).toContain('No messages to anyone later.');
    expect(later).toContain('"remind me"');
    expect(later).not.toMatch(/accounts|set up services/i);
    // general purpose: neither names a system that might say otherwise
    for (const said of [limits, later]) expect(said).not.toMatch(/\bschedul/i);
  });

  it('own the blocks the core leaves to them: <file> is the Attached files item\'s', async () => {
    const items = await hubContext(await manifestOf(hub, { version: '0' }));
    expect(items.find((item) => item.name === 'attached_files')?.content).toContain('`<file name mime size uri read="…">`');
  });

  it('join the hub\'s manifest at boot', async () => {
    const manifest = await withHubContext(await manifestOf(hub, { version: '0' }));
    expect(manifest.context.some((decl) => decl.name === 'memory' && decl.inject !== undefined)).toBe(true);
  });

  it('fail the start when a file names a fn the hub doesn\'t have', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-context-'));
    try {
      await writeFile(join(dir, 'bad.md'), '---\nkey: bad\ndescription: Bad.\nsummary: Bad.\nfns: [hub/nope]\ninject: { into: [\'hub/chat*\'] }\n---\nText.\n');
      await expect(hubContext(await manifestOf(hub, { version: '0' }), dir)).rejects.toBeInstanceOf(ContextFolderError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
