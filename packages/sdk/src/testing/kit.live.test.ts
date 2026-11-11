/**
 * Live: the kit's real model (a free OpenRouter model, skipped without a key) answering through `ctx.ai()`, and a
 * component preview shot in headless Chrome at both sizes and themes, into a gallery. Run with `npm run test:live`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { PREVIEW_INDEX, PreviewIndex, callFn, preview, realModel } from './index.ts';

const greeter = system('greeter', { description: 'Greets.' }).with({
  fns: { greet: fn({ description: 'A one-line greeting from the model.', args: g.obj({ name: g.text() }), returns: g.text() }) },
});

describe('the kit, live', () => {
  realModel.it('runs a fn whose ctx.ai() is a real free model', async (model) => {
    const { result, hubCalls } = await callFn(greeter, {
      fns: {
        greet: {
          async run(args, ctx) {
            const reply = await (await ctx.ai()).chat.get({ messages: [{ role: 'user', content: `Say hello to ${args.name} in five words or fewer.` }] });
            return ctx.done(reply.content);
          },
        },
      },
    }, 'greet', { name: 'Ann' }, { model });
    expect(result.length).toBeGreaterThan(0);
    expect(hubCalls.forwards).toHaveLength(1);
    expect(model.answeredBy).toHaveLength(1);
  });

  it('shoots a component in each state, size and theme, and writes the gallery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'previews-'));
    const before = process.env['HARNESS_PREVIEW_DIR'];
    process.env['HARNESS_PREVIEW_DIR'] = dir;
    try {
      const shots = await preview({ name: 'NoteCard', module: new URL('./fixtures/NoteCard.vue', import.meta.url), states: { empty: {}, long: { title: 'Shop', lines: Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`) } }, shoot: true });
      expect(shots).toHaveLength(8);
      const [phone, desktop] = [shots.find((s) => s.state === 'long' && s.viewport === 'phone'), shots.find((s) => s.state === 'long' && s.viewport === 'desktop')];
      // a long list makes the phone page taller than its screen, so the full-page shot is bigger than the desktop one
      expect(phone?.image.size).toBeGreaterThan(0);
      expect(desktop?.image.hash).not.toBe(phone?.image.hash);
      expect(new Set(shots.map((s) => s.image.hash)).size).toBe(8);
      const index = PreviewIndex.parse(JSON.parse(await readFile(join(dir, PREVIEW_INDEX), 'utf8')));
      expect(index.shots).toHaveLength(8);
      expect(await readFile(join(dir, 'gallery.html'), 'utf8')).toContain('NoteCard · long');
    } finally {
      if (before === undefined) { delete process.env['HARNESS_PREVIEW_DIR']; } else { process.env['HARNESS_PREVIEW_DIR'] = before; }
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
