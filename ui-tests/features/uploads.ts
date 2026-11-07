/**
 * Uploads (chat-features 5.9): attach a file in the composer; it uploads with its progress ring, then sits as a ready
 * chip with its size, and can be removed again.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, count, feature, find, newChat, settle, show, tid } from '../kit.ts';

export default feature({
  id: 'uploads', ref: 'chat-features 5.9', title: 'Attach a file in the composer',
  async run(ctx) {
    const { page } = ctx;
    const folder = mkdtempSync(join(tmpdir(), 'harness-ui-upload-'));
    const file = join(folder, 'notes-for-the-agent.txt');
    writeFileSync(file, 'Things the agent should know.\n'.repeat(200));
    try {
      await newChat(ctx);
      await find(page, 'attach');
      const input = await page.$(`${tid('composer')} input[type="file"]`);
      check(input !== null, 'the composer has a file picker behind its attach button');
      await input.uploadFile(file);
      await find(page, 'staged-files');
      await page.waitForSelector(`${tid('staged-files')} [data-status="ready"]`, { timeout: 30_000 });
      const chip = await page.$eval(tid('staged-files'), (el) => el.textContent);
      check(chip.includes('notes-for-the-agent.txt'), 'the chip names the file');
      check(/\d+(\.\d+)?\s*(B|KB)/.test(chip), `the ready chip shows the file's size (saw "${chip.trim()}")`);
      await show(page, tid('composer'));
      await ctx.shot('staged');
      await page.click(`${tid('staged-files')} [aria-label="Remove notes-for-the-agent.txt"]`);
      await settle(page);
      check(await count(page, 'staged-files') === 0, 'removing the only file clears the chips');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
});
