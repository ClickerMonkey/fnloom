/**
 * The template system with the SDK test kit (`@harness/sdk/testing`): `testHub` serves it to a fake hub in memory
 * (the real link, handshake and wire checks; every `ctx.*` call recorded). Keep these passing as the system grows, and
 * add a test of each sort beside them as it gets fns (the guide's Testing section has the details):
 *
 * - a fn call: `const { result, progress, hubCalls } = await kit.call('<fn>', args)`, typed by the contract;
 * - a mocked model: `testHub(template, impl, { model: mockModel(['a reply', toolCall('<tool>', args)]) })`;
 * - a real model: `realModel.it('…', async () => { … })`, skipped without `OPENROUTER_API_KEY`;
 * - a component preview: `await preview({ name, module, states })`, shot at phone and desktop, light and dark;
 * - a kind: `await kit.kindProps('<kind>', payload)`; a context folder: `await contextFolder(dir, template)`.
 */
import { readFileSync } from 'node:fs';
import { SystemPackageManifest } from '@harness/core';
import { testHub, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { template } from '../shared/index.ts';
import { templateEnv } from './env.ts';
import { createImpl } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));

describe('template', () => {
  let kit: TestSystem<'template', (typeof template)['defs']> | undefined;
  afterEach(async () => {
    await kit?.stop();
    kit = undefined;
  });

  it('is named as system.json says', () => {
    expect(template.name).toBe(packageManifest.name);
  });

  it('connects, says hello and sends its manifest', async () => {
    // TODO: once the contract declares config, give a valid value here
    kit = await testHub(template, createImpl({ settings: templateEnv.parse() }), { config: {} });
    expect(kit.hub.hellos.map((hello) => hello.name)).toEqual([packageManifest.name]);
    expect(kit.hub.manifests).toHaveLength(1);
  });
});
