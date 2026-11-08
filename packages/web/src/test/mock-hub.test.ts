// @vitest-environment node
/**
 * The mock hub itself: its request log says what it really answered (a refused sign-in is a 401, not a 500), and its
 * build 2 endpoints answer from their in-memory state.
 */
import { createLogger } from '@ayepi/log';
import { ChatCapabilities, McpScopePreview, Tokens } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_ADMIN, serveMockHub } from '../../e2e/mockHub.ts';

/** A port of the web lane's own (4480–4499). */
const PORT = 4482;
const BASE = `http://127.0.0.1:${PORT}/api`;
const lines: { readonly level: string; readonly path: unknown; readonly status: unknown }[] = [];
let hub: { stop: () => Promise<void> } | undefined;

beforeAll(() => {
  const logger = createLogger({ level: 'debug', transports: [{ name: 'memory', write: (record) => { lines.push({ level: record.level, path: record['path'], status: record['status'] }); } }] });
  hub = serveMockHub(PORT, { needsAdmin: false, notifyEvery: 0, logEvery: 0, logger });
});
afterAll(async () => { await hub?.stop(); });

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) };
  for (let tries = 0; ; tries++) {
    try {
      return await fetch(`${BASE}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (error) {
      if (tries > 40) { throw error; }
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
}

describe('the mock hub', () => {
  it('logs a refused sign-in as 401 and an accepted one as 200', async () => {
    expect((await post('signIn', { email: MOCK_ADMIN.email, password: 'not-the-password' })).status).toBe(401);
    expect((await post('signIn', { email: MOCK_ADMIN.email, password: MOCK_ADMIN.password })).status).toBe(200);
    const signIns = lines.filter((line) => line.path === '/signIn' && line.status !== undefined);
    expect(signIns.map((line) => line.status)).toEqual([401, 200]);
    expect(signIns.every((line) => line.level !== 'error')).toBe(true);
  });

  it('answers build 2 endpoints from its state: roles drive dictation, MCPs are made and previewed', async () => {
    const signedIn = await post('signIn', { email: MOCK_ADMIN.email, password: MOCK_ADMIN.password });
    const { access } = Tokens.parse(await signedIn.json());
    const set = await post('setModelRole', { role: 'dictate', engine: { engine: 'model', model: { model: 'openai/whisper-1' } } }, access);
    expect(set.status).toBe(200);
    const caps = ChatCapabilities.parse(await (await post('capabilities', {}, access)).json());
    expect(caps.voiceInput).toBe(true);
    expect(caps.dictation?.engine).toBe('model');
    const preview = McpScopePreview.parse(await (await post('previewMcp', { rules: { include: { systems: ['fs'] }, exclude: { fns: [{ fn: 'fs/shell' }] } } }, access)).json());
    expect(preview.fns).toContain('fs/read_file');
    expect(preview.fns).not.toContain('fs/shell');
  });
});
