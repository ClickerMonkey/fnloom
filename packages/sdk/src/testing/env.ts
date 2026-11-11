/**
 * The test kit's tunables. The real model's key and ids are the live tests' slice (`liveEnv`: `OPENROUTER_API_KEY`,
 * `HARNESS_LIVE_MODEL`, `HARNESS_LIVE_FALLBACKS`); this slice holds the previews'.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** `<width>x<height>` in CSS pixels. */
const Size = z.string().regex(/^\d+x\d+$/);

export const kitEnv = env({
  /** Shoot component previews (`preview()`); off, it only bundles each component. `harness test --previews` sets it. */
  HARNESS_PREVIEWS: z.boolean().default(false),
  /** Where previews and their gallery are written. */
  HARNESS_PREVIEW_DIR: z.string().default('.harness-test/previews'),
  /** The phone viewport. */
  HARNESS_PREVIEW_PHONE: Size.default('390x844'),
  /** The desktop viewport. */
  HARNESS_PREVIEW_DESKTOP: Size.default('1280x800'),
  /** The CSS files of the app's look (its tokens and base), comma separated; default the web app's own. */
  HARNESS_PREVIEW_THEME: z.string().optional(),
});

/** A viewport size from its `<width>x<height>` text. */
export function viewportSize(text: string): { width: number; height: number } {
  const [width = 0, height = 0] = text.split('x').map(Number);
  return { width, height };
}
