/**
 * The build 2 modules as the production hub wires them (`hubModules`): MCPs served at `/mcp/<slug>` over real HTTP,
 * the contextor's preview over the real catalog and index, model roles over the real model list, and hub resources
 * through the real forms and context services. Each reaches the other modules only through its factory's lazy
 * accessors, which these tests exercise.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient, McpHttpClientTransport } from '@ayepi/mcp';
import { ActorId, McpSlug, mintId, SystemName, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingPush, testSettings } from '../api/testing/rig.ts';
import { memoryLog } from '../testing.ts';
import { SCRIPTED_AS, ScriptedProvider, TEST_MODEL } from '../execution/testing.ts';
import type { RunningHub } from './index.ts';
import { hubModules } from './modules.ts';
import { startHub } from './start.ts';

const dir = mkdtempSync(join(tmpdir(), 'harness-wiring-'));
let running: RunningHub;
const ADA = ActorId.parse(mintId('actor'));
let session: SessionId;

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
    modules: hubModules({ llm: () => ({ providers: { [SCRIPTED_AS]: new ScriptedProvider() }, models: [TEST_MODEL] }) }),
  });
  await running.services.store.table('actors').insert({ id: ADA, kind: 'user', name: 'Ada', about: '', email: 'ada@example.com', role: 'admin', createdAt: 1, disabled: false });
  session = (await running.services.chat.sessions.create({ owner: ADA })).id;
});

afterAll(async () => {
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A client of an MCP at its route, once the endpoints have mounted it (they remount as MCPs change). */
async function connected(slug: string, secret: string): Promise<McpClient> {
  for (let tries = 0; ; tries += 1) {
    try {
      const transport = new McpHttpClientTransport(`${running.url}/mcp/${slug}`, { headers: { authorization: `Bearer ${secret}` } });
      return await McpClient.connect(transport, { clientInfo: { name: 'test', version: '1' } });
    } catch (error) {
      if (tries >= 50) { throw error; }
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  }
}

describe('the wired mcp module', () => {
  it('serves an MCP made in its registry at its route, scoped by its rules', async () => {
    const { registry, endpoints, scopes } = running.services.mcp;
    const { mcp, secret } = await registry.create({
      slug: McpSlug.parse('wired'), name: 'Wired', instructions: 'Read runs.', toolMode: 'each', user: ADA, grantees: [SystemName.parse('claude')], origins: [], enabled: true,
      rules: { include: { systems: [SystemName.parse('hub')] }, exclude: {} },
    }, ADA);
    const scope = await scopes.scope(mcp.id);
    expect(scope.fns.size).toBeGreaterThan(0);
    expect((await scopes.preview({ include: { systems: [SystemName.parse('hub')] }, exclude: {} })).fns.length).toBeGreaterThan(0);
    const client = await connected('wired', secret);
    try {
      expect(client.server.instructions).toContain('Read runs.');
      const tools = await client.listTools();
      expect(tools.length).toBe(scope.fns.size);
      // admin fns are never exposed through an MCP
      expect(tools.map((t) => t.name)).not.toContain('hub_create_mcp');
      await expect(client.listResources()).resolves.toEqual(expect.any(Array));
      await expect(client.listResourceTemplates()).resolves.toEqual(expect.any(Array));
      await expect(client.listPrompts()).resolves.toEqual(expect.any(Array));
      expect(await endpoints.sessions(mcp.id)).toHaveLength(1);
      expect((await registry.get(mcp.id))?.sessions).toBe(1);
    } finally {
      await client.close();
    }
    const { token } = await running.services.mcp.tokens.mint({ mcp: mcp.id, label: 'one', ttl: 60_000, system: SystemName.parse('claude') });
    await expect(running.services.mcp.tokens.verify(token)).resolves.toMatchObject({ mcp: mcp.id });
    expect(await registry.remove(mcp.id, ADA)).toBe(true);
  });
});

describe('the wired contextor module', () => {
  it('previews a session’s prompt over the real catalog, index and model list', async () => {
    const report = await running.services.contextor.planner.preview(session, 'what runs failed today?', ADA);
    expect(report.contextor).toBe('plain');
    const limits = await running.services.contextor.limits.resolve(TEST_MODEL.id);
    expect(limits.limits.contextWindow).toBeGreaterThan(0);
  });
});

describe('the wired models module', () => {
  it('lists the roles over the hub’s model list, and sets and clears one', async () => {
    const { roles } = running.services.models;
    const listed = await roles.list();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.map((r) => r.role)).toContain('chat');
    await roles.set({ role: 'chat', model: { model: TEST_MODEL.id } }, ADA);
    expect(await roles.get('chat')).toMatchObject({ from: 'setting', choice: { model: { model: TEST_MODEL.id } } });
    await expect(roles.resolve('chat')).resolves.toMatchObject({ model: TEST_MODEL.id });
    expect((await roles.clear('chat', ADA)).from).not.toBe('setting');
  });
});

describe('the wired resources module', () => {
  it('imports content as a hub resource, reads its forms, and makes context from it', async () => {
    const { library, forms, reader, context } = running.services.resources;
    const content = await running.services.api.content.put(new TextEncoder().encode('# Notes\n\nFirst part.\n\n## More\n\nSecond part.\n'), 'text/markdown');
    const record = await library.import({ content, name: 'notes.md', path: 'wiring' }, { actor: ADA });
    expect(record.uri).toMatch(/^hub:\/\/resources\//);
    expect((await forms.forms(record.uri, { actor: ADA })).record.uri).toBe(record.uri);
    expect((await reader.outline(record.uri, { actor: ADA })).length).toBeGreaterThan(0);
    const made = await context.fromResource({ uri: record.uri, copy: 'snapshot' }, { actor: ADA });
    expect(made.created.length).toBeGreaterThan(0);
    expect((await library.browse({}, { actor: ADA })).items.map((r) => r.uri)).toContain(record.uri);
  });
});
