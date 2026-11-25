/**
 * The hub's and every system's real manifest loaded into a hub catalog, for tests that check what a model is sent for
 * every fn there is (`tool-schemas.test.ts`, `examples-encoded.test.ts`).
 */
import { manifestOf, hub, type AnyContract } from '@harness/sdk';
import type { Manifest } from '@harness/core';
import { StoreCatalog } from '../packages/hub/src/catalog/catalog.ts';
import type { KindDescriber } from '../packages/hub/src/catalog/index.ts';
import { withHubGroups } from '../packages/hub/src/boot/hub-groups.ts';
import { RecordingBus, memoryLog, testStore } from '../packages/hub/src/testing.ts';
import { api } from '../systems/api/shared/index.ts';
import { claude } from '../systems/claude/shared/index.ts';
import { code } from '../systems/code/shared/index.ts';
import { database } from '../systems/database/shared/index.ts';
import { embedderSystem } from '../systems/embedder/shared/index.ts';
import { fs } from '../systems/fs/shared/index.ts';
import { googleCalendar } from '../systems/google-calendar/shared/index.ts';
import { input } from '../systems/input/shared/index.ts';
import { mcp } from '../systems/mcp/shared/index.ts';
import { schedule } from '../systems/schedule/shared/index.ts';
import { web } from '../systems/web/shared/index.ts';
import { widgets } from '../systems/widgets/shared/index.ts';

/** Every system's shared contract. */
export const SYSTEMS: readonly AnyContract[] = [api, claude, code, database, embedderSystem, fs, googleCalendar, input, mcp, schedule, web, widgets];

/** What a kind's fn needs to be described: here, nothing (those fns are checked where their kind's system runs). */
export const NOT_IN_THIS_TEST = 'not in this test';

/**
 * A catalog holding the hub's and every system's manifest, the manifests, and what each import refused (a kind's fn,
 * `hub/chat`, needs its kind's system to describe it: refused with `NOT_IN_THIS_TEST`).
 */
export async function catalogOfEverything(): Promise<{ catalog: StoreCatalog; manifests: Manifest[]; refused: Array<{ system: string; problems: readonly string[] }> }> {
  const describer: KindDescriber = { describe: () => Promise.resolve({ problems: [NOT_IN_THIS_TEST] }) };
  const catalog = new StoreCatalog({ store: await testStore(), bus: new RecordingBus(), log: memoryLog().log, clock: () => 1_000, describer });
  const manifests = [withHubGroups(await manifestOf(hub, { version: '1.0.0' })), ...await Promise.all(SYSTEMS.map((contract) => manifestOf(contract, { version: '1.0.0', resources: false })))];
  const refused: Array<{ system: string; problems: readonly string[] }> = [];
  for (const manifest of manifests) {
    const report = await catalog.importManifest(manifest);
    for (const refusal of report.refused) refused.push({ system: manifest.name, problems: refusal.problems });
  }
  return { catalog, manifests, refused };
}
