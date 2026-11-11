/**
 * The record of a preview folder's shots, shared by the kit that writes it (`preview`) and `harness test`, which reads
 * it into its report. Kept apart from the kit's entry so build tools can read it without loading vitest or Vue.
 */
import { PreviewShot } from '@harness/core';
import { z } from 'zod';

/** The themes previews are shot in, from the shot contract. */
export const PREVIEW_THEMES = PreviewShot.shape.theme.options;
export type PreviewTheme = PreviewShot['theme'];

/** The record of every shot in a preview folder (`shots.json`), which `harness test` reads into its report. */
export const PreviewIndex = z.object({ shots: z.array(PreviewShot) });
export type PreviewIndex = z.infer<typeof PreviewIndex>;

/** The file of the shots index in a preview folder. */
export const PREVIEW_INDEX = 'shots.json';
