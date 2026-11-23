/**
 * The schedule system with the SDK test kit: it connects with the default limits and sends its manifest, and a fresh
 * person has no schedules and no history yet.
 */
import { readFileSync } from 'node:fs';
import { SystemPackageManifest } from '@harness/core';
import { testHub, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { schedule } from '../shared/index.ts';
import { scheduleEnv } from './env.ts';
import { createScheduleImpl } from './impl.ts';

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

  it('connects with the default limits, sends its manifest, and a fresh person has no schedules or runs', async () => {
    kit = await testHub(schedule, createScheduleImpl({ settings: scheduleEnv.parse() }), { config: {} });
    expect(kit.hub.manifests).toHaveLength(1);
    expect((await kit.call('list', {})).result).toEqual({ items: [] });
    expect((await kit.call('history', {})).result).toEqual({ items: [] });
  });
});
