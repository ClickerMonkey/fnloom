/**
 * The chat prompt split (docs/plans/injected-context-2026-11-22.md, section 5): the core names no installable system,
 * and what it leaves out is said by injected items. Each system's chat item (`basics`) declares `inject` targeting the
 * chat agents, with a title, a short summary for the small agent and the fns it brings, all its own; the fs hook says
 * what `<fs_git>` means; and between the core, the hub's items and the systems' items every tag a message can carry
 * is explained. Searching by kind is left to the person's asking: no text tells the model to filter by `kinds`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hub, isSystemContract, manifestBody, manifestOf, type AnyContract } from '@harness/sdk';
import { qualify, type ContextDecl, type Manifest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { CHAT_BASE, CHAT_CORE_TAGS } from '../packages/sdk/src/chat-prompt.ts';
import { hubContext } from '../packages/hub/src/boot/hub-context.ts';

const systems = join(import.meta.dirname, '..', 'systems');

/** Every system folder with a shared contract module. */
const folders = readdirSync(systems, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(systems, entry.name, 'shared', 'index.ts')))
  .map((entry) => entry.name);

/** The systems the chat prompt used to speak for: each now says its own part. */
const SPEAKING = ['input', 'database', 'widgets', 'code', 'api', 'web', 'fs'];

/** Every system's manifest, by name. */
async function manifests(): Promise<Map<string, Manifest>> {
  const out = new Map<string, Manifest>();
  for (const folder of folders) {
    const loaded: unknown = await import(pathToFileURL(join(systems, folder, 'shared', 'index.ts')).href);
    const contracts = typeof loaded === 'object' && loaded !== null ? Object.values(loaded).filter(isSystemContract) : [];
    for (const contract of contracts as AnyContract[]) out.set(contract.name, manifestBody(contract, { version: '0.0.0' }) as Manifest);
  }
  return out;
}

/** A manifest's injected context items. */
function injected(manifest: Manifest): ContextDecl[] {
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

  it('keeps every chat item\'s summary inside the small agent\'s 600-token cap together', async () => {
    const all = await manifests();
    const hubItems = await hubContext(await manifestOf(hub, { version: '0' }));
    const items = [...hubItems, ...[...all.values()].flatMap(injected)];
    const words = items.reduce((sum, item) => sum + `## ${item.title ?? ''}\n\n${item.summary ?? ''}`.split(/\s+/).length, 0);
    // about 4/3 tokens a word
    expect(Math.round(words * 4 / 3)).toBeLessThanOrEqual(600);
  });
});
