/**
 * The one test that starts a real Claude Code session (it spends the machine's Claude login, so it is opt-in: set
 * `HARNESS_CLAUDE_LIVE=1` and run `npm run test:live`). A one-line prompt in a fresh temporary folder, never in a
 * repository: the session opens with the id the harness minted, answers, ends its turn with a cost, and its transcript
 * reads back from Claude's store.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSdkDriver } from './agent-sdk.ts';
import type { DriverEvent } from './driver.ts';

const enabled = process.env['HARNESS_CLAUDE_LIVE'] === '1';

describe.skipIf(!enabled)('Claude Code through the Agent SDK (live)', () => {
  it('answers a one-line prompt and keeps the transcript', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'harness-claude-'));
    const driver = new AgentSdkDriver({ dialogKinds: [], textMax: 2_000 });
    const session = randomUUID();
    const events: DriverEvent[] = [];
    try {
      const ended = new Promise<Extract<DriverEvent, { type: 'result' }>>((resolve) => {
        const live = driver.open({ session, resume: false, folder, model: 'haiku', permissionMode: 'default' }, {
          event: (event) => {
            events.push(event);
            if (event.type === 'result') { live.close(); resolve(event); }
          },
          permit: () => Promise.resolve({ allow: false, reason: 'No tools in this test.' }),
          question: () => Promise.resolve({ declined: 'No questions in this test.' }),
        });
        live.send('Reply with the single word: ok');
      });
      const result = await ended;
      expect(result.ok).toBe(true);
      expect(result.text.toLowerCase()).toContain('ok');
      expect(result.costUsd).toBeGreaterThan(0);
      const page = await driver.transcript({ session, folder, offset: 0, limit: 20 });
      expect(page.items.some((item) => item.type === 'user' && item.text.includes('single word'))).toBe(true);
      expect(page.items.some((item) => item.type === 'assistant')).toBe(true);
    } finally {
      // on Windows the ended process may hold the folder a moment longer
      await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }, 120_000);
});
