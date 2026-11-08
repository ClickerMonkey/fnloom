/**
 * Diagrams in markdown and resources (mermaid), behind one interface so the engine is the app's choice. A renderer
 * turns diagram source into SVG text, which is drawn as an image from a blob URL (scripts in an SVG never run inside
 * an `<img>`), so no diagram can inject markup into the page. Without a renderer the source is shown as code.
 */
import type { InjectionKey } from 'vue';

/** What drawing a diagram came to: its SVG, or why it couldn't be drawn. */
export type DiagramResult = { readonly ok: true; readonly svg: string } | { readonly ok: false; readonly problem: string };

/** Draws diagram source (mermaid) as SVG. */
export interface DiagramRenderer {
  /** The languages it draws (`mermaid`). */
  readonly languages: readonly string[];
  /** Draw `source` in `language`, for the light or dark theme. */
  render(source: string, language: string, dark: boolean): Promise<DiagramResult>;
}

/** Where markdown and the resource viewer find the app's diagram renderer; none provided shows diagrams as code. */
export const DIAGRAMS: InjectionKey<DiagramRenderer | undefined> = Symbol('harness.diagrams');

/** The code fence languages that are diagrams. */
export const DIAGRAM_LANGUAGES: readonly string[] = ['mermaid'];
