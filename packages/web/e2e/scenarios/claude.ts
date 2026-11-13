/**
 * Build 9's Claude fleet, which only rendering can check: the fleet list with a waiting session, the new-session
 * dialog, a session's page with its waiting cards (a tool to approve, a question with a form), tasks and workflows,
 * transcript and message box, and a subagent's transcript.
 */
import type { Scenario } from '../harness.ts';
import { CLAUDE_WAITING } from '../mockBuild9.ts';
import { check, closeDialog, settle, signedIn, tracked } from './steps.ts';

export const claude: Scenario = {
  name: 'claude',
  description: 'The Claude fleet: sessions, a new session, a session with its cards, tasks, transcript and composer.',
  async run(ctx) {
    const { page } = ctx;
    const sessionPath = `/claude/${CLAUDE_WAITING.instance}/${CLAUDE_WAITING.session}`;
    await tracked(ctx, async (shot) => {
      await signedIn(ctx, '/claude');
      await page.waitForSelector('[data-testid="claude-sessions"] [data-waiting="2"]');
      await settle(page);
      await shot('claude-fleet');

      await page.click('[data-testid="claude-new"]');
      await page.waitForSelector('[data-testid="claude-new-form"]');
      check(new URL(page.url()).searchParams.get('new') === '1', 'the new-session dialog should be in the URL');
      await settle(page);
      await shot('claude-new');
      await closeDialog(page);

      await signedIn(ctx, sessionPath);
      await page.waitForSelector('[data-testid="claude-waiting"] [data-testid="approval-ask"]');
      await page.waitForSelector('[data-testid="claude-transcript"] [data-testid="transcript-tool"]');
      const cards = await page.$$eval('[data-testid="claude-waiting"] [data-testid="approval-card"]', (els) => els.length);
      check(cards === 2, `the session should show its two waiting cards, not ${cards}`);
      await settle(page);
      await shot('claude-session');

      await signedIn(ctx, `${sessionPath}?task=ag1`);
      await page.waitForSelector('[data-testid="claude-task-banner"]');
      check(await page.$('[data-testid="claude-composer"]') === null, 'a subagent\'s transcript has no message box');
      await settle(page);
      await shot('claude-subagent');
    });
  },
};
