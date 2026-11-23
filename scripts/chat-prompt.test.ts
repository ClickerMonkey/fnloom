/**
 * The chat prompt split (docs/plans/injected-context-2026-11-22.md, section 5): the core names no installable system,
 * and what it leaves out is said by injected items. Each system's chat item (`basics`) declares `inject` targeting the
 * chat agents, with a title, a short summary for the small agent and the fns it brings, all its own; the fs hook says
 * what `<fs_git>` means; and between the core, the hub's items and the systems' items every tag a message can carry
 * is explained. Searching by kind is left to the person's asking: no text tells the model to filter by `kinds`. The
 * small chat agent's cap is kept by the planner's fallback, not by capping the sum of every item's summary: the hub's
 * own items fit it alone, each item's summary is short, and many systems' items still fit (docs/plans/schedule-system.md).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hub, isSystemContract, manifestBody, manifestOf } from '@harness/sdk';
import { QualifiedName, qualify, SystemName, type ContextDecl, type ContextRecord, type Manifest } from '@harness/core';

/** A system's manifest before it is hashed: all these tests read. */
type Body = Omit<Manifest, 'hash'>;
import { describe, expect, it } from 'vitest';
import { CHAT_BASE, CHAT_CORE_TAGS } from '../packages/sdk/src/chat-prompt.ts';
import { hubContext } from '../packages/hub/src/boot/hub-context.ts';
import { fitInjected, injectedBlock, type InjectedItem } from '../packages/hub/src/contextor/injected.ts';
import { DEFAULT_CHARS_PER_TOKEN, rawTokens } from '../packages/hub/src/contextor/tokens.ts';

const systems = join(import.meta.dirname, '..', 'systems');

/** Every system folder with a shared contract module. */
const folders = readdirSync(systems, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(systems, entry.name, 'shared', 'index.ts')))
  .map((entry) => entry.name);

/** The systems the chat prompt used to speak for: each now says its own part. */
const SPEAKING = ['input', 'database', 'widgets', 'code', 'api', 'web', 'fs'];

/** Every system's manifest, by name. */
async function manifests(): Promise<Map<string, Body>> {
  const out = new Map<string, Body>();
  for (const folder of folders) {
    const loaded: unknown = await import(pathToFileURL(join(systems, folder, 'shared', 'index.ts')).href);
    const contracts = typeof loaded === 'object' && loaded !== null ? Object.values(loaded).filter(isSystemContract) : [];
    for (const contract of contracts) out.set(contract.name, manifestBody(contract, { version: '0.0.0' }));
  }
  return out;
}

/** A manifest's injected context items. */
function injected(manifest: Body): ContextDecl[] {
  return manifest.context.filter((decl) => decl.inject !== undefined);
}

describe('the chat prompt split', () => {
  it('gives each system the prompt spoke for its own chat item, targeting the chat agents and bringing its own fns', async () => {
    const all = await manifests();
    for (const name of SPEAKING) {
      const manifest = all.get(name);
      expect(manifest, name).toBeDefined();
      if (manifest === undefined) continue;
      const items = injected(manifest);
      expect(items.length, name).toBeGreaterThan(0);
      const own = new Set(manifest.fns.map((decl) => qualify(name, decl.name)));
      for (const item of items) {
        const label = `${name}/${item.name}`;
        expect(item.inject?.into, label).toEqual(['hub/chat*']);
        expect(item.title, label).toBeTruthy();
        expect(item.summary?.length ?? 0, label).toBeGreaterThan(20);
        expect(item.summary?.length ?? 0, label).toBeLessThanOrEqual(220);
        expect(item.fns.length, label).toBeGreaterThan(0);
        for (const fn of item.fns) {
          expect(own.has(fn), `${label} brings ${fn}`).toBe(true);
          expect(item.content ?? '', `${label} names ${fn}`).toContain(fn);
        }
      }
    }
  });

  it('puts every injected item a system declares into the chat agents only by pattern, and nothing of another system', async () => {
    for (const [name, manifest] of await manifests()) {
      for (const item of injected(manifest)) {
        for (const target of item.inject?.into ?? []) expect(target, `${name}/${item.name}`).toMatch(/\*/);
      }
    }
  });

  it('has fs say what <fs_git> means, with its hook', async () => {
    const fs = (await manifests()).get('fs');
    expect(fs?.hooks.find((decl) => decl.name === 'git')?.explains).toContain('`<fs_git>`');
  });

  it('explains every tag a message can carry, between the core, the hub\'s items and the systems\' items', async () => {
    const all = await manifests();
    const hubItems = await hubContext(await manifestOf(hub, { version: '0' }));
    const text = [
      CHAT_BASE,
      ...hubItems.map((item) => item.content ?? ''),
      ...[...all.values()].flatMap((manifest) => [...injected(manifest).map((item) => item.content ?? ''), ...manifest.hooks.map((decl) => decl.explains ?? '')]),
    ].join('\n');
    for (const tag of [...CHAT_CORE_TAGS, 'file name mime size uri read="…"', 'input-answer', 'fs_git']) expect(text, tag).toContain(`\`<${tag}>\``);
  });

  it('leaves the kind filter out of every system\'s text for the model', async () => {
    for (const [name, manifest] of await manifests()) {
      const said = [
        manifest.about ?? '',
        ...manifest.context.flatMap((decl) => [decl.content ?? '', decl.summary ?? '']),
        ...manifest.fns.flatMap((decl) => [decl.description, decl.instructions ?? '']),
      ].join('\n');
      expect(said, name).not.toMatch(/kinds:? \[|with kinds|`kinds/);
    }
  });

  // The small chat agent takes each item at its summary within SMALL_CAP tokens. The systems' items together may pass
  // it (every installed system adds one): the planner then falls back, highest order first, from summary to a
  // <more_ctx> line to out. So what is checked is that the hub's own items fit by themselves, that each item's
  // summary is short, and that the fallback keeps the section in the cap however many systems are installed.

  it('keeps the hub\'s own items\' summaries inside the small agent\'s cap by themselves', async () => {
    const hubItems = await hubContext(await manifestOf(hub, { version: '0' }));
    const fitted = fitInjected(hubItems.map((decl, i) => injectedItem('hub', decl, i)), SMALL_FIT);
    expect(fitted.cut).toEqual([]);
    expect(fitted.tokens).toBeLessThanOrEqual(SMALL_CAP);
  });

  it('gives every chat item a summary of its own, short enough for the small agent', async () => {
    const hubItems = await hubContext(await manifestOf(hub, { version: '0' }));
    const items = [...hubItems.map((decl) => ({ label: `hub/${decl.name}`, decl })), ...[...await manifests()].flatMap(([name, manifest]) => injected(manifest).map((decl) => ({ label: `${name}/${decl.name}`, decl })))];
    for (const { label, decl } of items) {
      expect(decl.summary?.length ?? 0, label).toBeGreaterThan(20);
      expect(decl.summary?.length ?? 0, label).toBeLessThanOrEqual(SUMMARY_MAX);
      // a summary is one or two sentences: a small share of the cap, so one item never crowds out the rest
      expect(SMALL_FIT.estimator.text(injectedBlock(decl.title ?? decl.description, decl.summary ?? '')), label).toBeLessThanOrEqual(SMALL_CAP / 8);
    }
  });

  it('keeps the small agent\'s section in its cap when many systems\' items push past it, the hub\'s items first', async () => {
    const hubItems = (await hubContext(await manifestOf(hub, { version: '0' }))).map((decl, i) => injectedItem('hub', decl, i));
    const systemsItems = [...await manifests()].flatMap(([name, manifest]) => injected(manifest).map((decl, i) => injectedItem(name, decl, i)));
    // thirty more systems, each with a chat item of the longest summary allowed
    const crowd = Array.from({ length: 30 }, (_, i) => injectedItem(`extra${i}`, {
      name: 'basics', description: 'What it does.', title: `Extra ${i}`, summary: `extra${i}/act does a thing. ${'More words. '.repeat(16)}`.slice(0, SUMMARY_MAX),
      imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: [], inject: { into: ['hub/chat*'], order: 100, requires: [] },
    }, i));
    const items = [...hubItems, ...systemsItems, ...crowd].sort((a, b) => a.order - b.order || a.system.localeCompare(b.system) || a.name.localeCompare(b.name));
    const plain = items.reduce((sum, item) => sum + SMALL_FIT.estimator.text(injectedBlock(item.title, item.summary ?? item.full)), 0);
    expect(plain).toBeGreaterThan(SMALL_CAP);
    const fitted = fitInjected(items, SMALL_FIT);
    expect(fitted.tokens).toBeLessThanOrEqual(SMALL_CAP);
    expect(fitted.cut.length).toBeGreaterThan(0);
    // each step starts at the highest order, so the hub's own items (10 to 30) are the last to go: still in the
    // section, at least as a <more_ctx> line the model can load by name
    const placed = new Set(fitted.placed.map((p) => p.item.name));
    for (const item of hubItems) expect(placed.has(item.name), item.name).toBe(true);
    expect(fitted.noFit.map((left) => left.name).every((name) => !name.startsWith('hub/'))).toBe(true);
  });
});

/** The small chat agent's cap on its injected section (hub/chat_small's `injected.maxTokens`). */
const SMALL_CAP = 600;
/** The longest summary a chat item may have, in characters. */
const SUMMARY_MAX = 220;
/** How the small agent's section is fitted: at summary detail, within its cap, at the hub's default characters per token. */
const SMALL_FIT = { detail: 'summary', room: SMALL_CAP, estimator: { text: (text: string) => rawTokens(text.length, DEFAULT_CHARS_PER_TOKEN) }, render: (text: string) => text } as const;

/** A declared chat item as the planner gathers it (its record for the `<more_ctx>` line). */
function injectedItem(system: string, decl: ContextDecl, i: number): InjectedItem {
  const name = QualifiedName.parse(qualify(system, decl.name));
  const record: ContextRecord = { name, system: SystemName.parse(system), stale: false, updatedAt: i, mentions: { context: [], fns: [] }, decl };
  return {
    name, source: { type: 'context' }, system: SystemName.parse(system), via: 'hub/chat*', title: decl.title ?? decl.description, order: decl.inject?.order ?? 100,
    full: decl.content ?? decl.summary ?? decl.description, summary: decl.summary, fns: decl.fns, replaces: decl.inject?.replaces ?? [], record, dynamic: false,
  };
}
