/**
 * The production modules put together: the hub starts with every real module (an in-memory database, a scripted
 * model), serves its own contract, and stops cleanly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hub as hubContract } from '@harness/sdk';
import { mintId, SystemName } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingPush, testSettings } from '../api/testing/rig.ts';
import { memoryLog } from '../testing.ts';
import { ScriptedProvider, TEST_MODEL } from '../execution/testing.ts';
import type { RunningHub } from './index.ts';
import { hubModules } from './modules.ts';
import { startHub } from './start.ts';

const dir = mkdtempSync(join(tmpdir(), 'harness-modules-'));
let running: RunningHub;

beforeAll(async () => {
  const base = testSettings();
  running = await startHub({
    port: 0, log: memoryLog().log, pushSender: recordingPush(), signals: false,
    keyMaker: { secret: () => 'k'.repeat(48), vapid: () => ({ publicKey: 'pub', privateKey: 'priv' }) },
    settings: {
      ...base,
      hubEnv: { ...base.hubEnv, HARNESS_DB_FILE: ':memory:', HARNESS_KEYS_FILE: join(dir, 'keys.json'), HARNESS_FILES_DIR: join(dir, 'files'), HARNESS_SYSTEMS_DIR: join(dir, 'systems') },
      logEnv: { ...base.logEnv, HARNESS_LOG_FILES: false },
    },
    modules: hubModules({ llm: () => ({ providers: { scripted: new ScriptedProvider() }, models: [TEST_MODEL] }) }),
  });
});

afterAll(async () => {
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('the hub with its real modules', () => {
  it('imports its own contract, so its chat agent and fns resolve like any system’s', async () => {
    const { catalog } = running.services;
    expect((await catalog.fn(hubContract.fns.chat.name))?.decl.kind).toBe('hub/llm');
    const names = (await catalog.fns({ system: SystemName.parse('hub') })).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(Object.values(hubContract.fns).map((f) => f.name)));
  });

  it('offers the models of the providers it was given', async () => {
    expect((await running.services.execution.llm.models()).map((m) => m.id)).toContain(TEST_MODEL.id);
  });

  it('starts a session answered by its chat agent, with the systems and suggestions wired', async () => {
    const owner = mintId('actor');
    await running.services.store.table('actors').insert({ id: owner, kind: 'user', name: 'Ada', about: '', email: 'ada@example.com', role: 'admin', createdAt: 1, disabled: false });
    const session = await running.services.chat.sessions.create({ owner });
    expect(session.agent).toBe('hub/chat');
    await expect(running.services.index.suggest.suggest({ session: session.id, text: 'hello', limit: 3 })).resolves.toEqual(expect.any(Array));
    expect(running.services.link.connections.connected()).toEqual([]);
  });
});
