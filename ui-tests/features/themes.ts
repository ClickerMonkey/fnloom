/** Themes (chat-features 1.6): light and dark follow the device, with readable contrast in both. */
import { check, feature, openSession, settle } from '../kit.ts';

export default feature({
  id: 'themes', ref: 'chat-features 1.6', title: 'Light and dark themes',
  async run(ctx) {
    const { page } = ctx;
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await openSession(ctx);
      await settle(page);
      const theme = await page.evaluate(() => `${document.documentElement.dataset['theme'] ?? ''} ${document.documentElement.className}`);
      check(theme.includes(scheme), `the page should be in the ${scheme} theme (got "${theme.trim()}")`);
      // the answer's text against the first opaque background behind it; colours are read through a canvas, which
      // turns any CSS colour (oklch, color-mix, …) into sRGB
      const contrast = await page.$eval('[data-testid="answer-text"]', (el) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const paint = canvas.getContext('2d', { willReadFrequently: true });
        if (paint === null) { return 0; }
        const rgba = (color: string): [number, number, number, number] => {
          paint.clearRect(0, 0, 1, 1);
          paint.fillStyle = color;
          paint.fillRect(0, 0, 1, 1);
          const [r = 0, g = 0, b = 0, a = 0] = paint.getImageData(0, 0, 1, 1).data;
          return [r, g, b, a];
        };
        const lum = ([r, g, b]: readonly number[]): number => {
          const [lr = 0, lg = 0, lb = 0] = [r ?? 0, g ?? 0, b ?? 0].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        };
        let background: readonly number[] = [255, 255, 255];
        for (let at: Element | null = el; at !== null; at = at.parentElement) {
          const color = rgba(getComputedStyle(at).backgroundColor);
          if (color[3] > 200) { background = color; break; }
        }
        const [a, b] = [lum(rgba(getComputedStyle(el).color)), lum(background)];
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      check(contrast >= 4.5, `answer text contrast is ${contrast.toFixed(2)}, below 4.5`);
      await ctx.shot(scheme);
    }
  },
});
