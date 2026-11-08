/**
 * Mermaid diagrams (`DiagramRenderer`): mermaid itself is loaded the first time a diagram is drawn, set to `strict`
 * (no scripts, no clicks, labels as text) and drawn with its light or dark theme to follow the app. Its SVG goes to
 * `UiDiagram`, which shows it as an image from a blob URL, so nothing in a diagram can reach the page.
 */
import type { Mermaid } from 'mermaid';
import type { DiagramRenderer, DiagramResult } from './diagram.ts';

/** The root `<svg …>` tag of an SVG document. */
const SVG_ROOT = /<svg\b[^>]*>/;
/** A `viewBox` attribute's width and height. */
const VIEW_BOX = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/;
/** The root's own `width` and `height` attributes. */
const SIZE_ATTRIBUTES = /\s(?:width|height)="[^"]*"/g;

/**
 * An SVG that sizes itself: mermaid draws `width="100%"`, which an `<img>` (how diagrams are shown) can't resolve, so
 * the root gets the width and height of its `viewBox` (the diagram's own size; CSS still scales it down to fit).
 */
export function sizedSvg(svg: string): string {
  const root = SVG_ROOT.exec(svg)?.[0];
  const box = root === undefined ? undefined : VIEW_BOX.exec(root);
  if (root === undefined || box === null || box === undefined) { return svg; }
  const [, width = '0', height = '0'] = box;
  const sized = root.replace(SIZE_ATTRIBUTES, '').replace(/^<svg/, `<svg width="${width}" height="${height}"`);
  return svg.replace(root, sized);
}

/** Loads mermaid. An interface so tests use a fake. */
export type MermaidLoader = () => Promise<Pick<Mermaid, 'initialize' | 'render'>>;

/** The real loader: the mermaid package, imported when first needed. */
export const BUNDLED_MERMAID: MermaidLoader = async () => (await import('mermaid')).default;

/** Draws mermaid source as SVG, one diagram at a time (mermaid's theme is global). */
export class MermaidRenderer implements DiagramRenderer {
  readonly languages: readonly string[] = ['mermaid'];
  readonly #load: MermaidLoader;
  #mermaid: ReturnType<MermaidLoader> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #count = 0;

  constructor(load: MermaidLoader = BUNDLED_MERMAID) {
    this.#load = load;
  }

  render(source: string, _language: string, dark: boolean): Promise<DiagramResult> {
    const drawn = this.#queue.then(() => this.#draw(source, dark));
    this.#queue = drawn.catch(() => undefined);
    return drawn;
  }

  async #draw(source: string, dark: boolean): Promise<DiagramResult> {
    this.#mermaid ??= this.#load();
    const mermaid = await this.#mermaid;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit' });
    this.#count += 1;
    try {
      const { svg } = await mermaid.render(`harness-diagram-${this.#count}`, source);
      return { ok: true, svg: sizedSvg(svg) };
    } catch (error) {
      return { ok: false, problem: error instanceof Error ? error.message : String(error) };
    }
  }
}
