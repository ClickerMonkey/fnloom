/**
 * The schedule system with the SDK test kit: it connects and sends its manifest, and every fn says it is not built
 * yet (slice 1: the contract with stubs).
 */
import { readFileSync } from 'node:fs';
import { SystemPackageManifest } from '@harness/core';
import { testHub, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { schedule } from '../shared/index.ts';
import { scheduleEnv } from './env.ts';
import { createScheduleImpl, NOT_BUILT } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));

describe('schedule', () => {
  let kit: TestSystem<'schedule', (typeof schedule)['defs']> | undefined;
  afterEach(async () => {
    await kit?.stop();
    kit = undefined;
  });

  it('is named as system.json says', () => {
    expect(schedule.name).toBe(packageManifest.name);
  });

  it('connects with the default limits, sends its manifest, and its fns are not built yet', async () => {
    kit = await testHub(schedule, createScheduleImpl({ settings: scheduleEnv.parse() }), { config: {} });
    expect(kit.hub.manifests).toHaveLength(1);
    const runs = await Promise.all([
      kit.run('list', {}),
      kit.run('history', {}),
      kit.run('remind', { text: 'Send the status note.' }),
      kit.run('resume', { schedule: 'schedule/weekly_orders_summary' }),
    ]);
    expect(runs.map((run) => run.outcome)).toEqual(['list', 'history', 'remind', 'resume'].map((name) => ({
      status: 'failed', error: { class: 'fatal', code: NOT_BUILT, message: `schedule/${name} is not built yet.` },
    })));
  });
});
