/**
 * Mermaid diagrams (`DiagramRenderer`): mermaid itself is loaded the first time a diagram is drawn, set to `strict`
 * (no scripts, no clicks, labels as text) and drawn in the app's own look: its font and its surface, border, text and
 * accent colours, light or dark, read from the design tokens when it draws (mermaid's own light or dark theme where
 * they can't be read). Its SVG goes to `UiDiagram`, which shows it as an image from a blob URL, so nothing in a
 * diagram can reach the page; an image can't use the page's styles, so the look is written into the SVG.
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

/** The app's look as a diagram draws it: a font stack and colours mermaid can read (hex). */
export interface DiagramLook {
  readonly font: string;
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
}

/** Reads the app's look; undefined where it can't (no document, or no canvas to turn colours into hex). */
export type LookReader = () => DiagramLook | undefined;

/** A CSS colour token as hex, by painting it (a canvas reads every CSS colour, oklch and light-dark included). */
function hexOf(paint: CanvasRenderingContext2D, probe: HTMLElement, token: string): string | undefined {
  probe.style.color = `var(${token})`;
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = getComputedStyle(probe).color;
  paint.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = paint.getImageData(0, 0, 1, 1).data;
  return a === 0 ? undefined : `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** The tokens a diagram is drawn with, in `DiagramLook`'s order. */
const LOOK_TOKENS = ['--bg', '--surface-2', '--border-strong', '--text', '--text-dim', '--accent'] as const;

/** The app's look from its design tokens on the page. */
export const PAGE_LOOK: LookReader = () => {
  if (typeof document === 'undefined') { return undefined; }
  const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (paint === null) { return undefined; }
  const probe = document.createElement('span');
  document.body.append(probe);
  try {
    const [background, surface, border, text, muted, accent] = LOOK_TOKENS.map((token) => hexOf(paint, probe, token));
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
    if (background === undefined || surface === undefined || border === undefined || text === undefined || muted === undefined || accent === undefined || font === '') { return undefined; }
    return { font, background, surface, border, text, muted, accent };
  } finally {
    probe.remove();
  }
};

/** Mermaid's settings for a look: its `base` theme with the app's font and colours. */
export function themeOf(look: DiagramLook, dark: boolean): { readonly theme: 'base'; readonly fontFamily: string; readonly themeVariables: Readonly<Record<string, string | boolean>> } {
  return {
    theme: 'base',
    fontFamily: look.font,
    themeVariables: {
      darkMode: dark, fontFamily: look.font, fontSize: '14px', background: look.background,
      primaryColor: look.surface, primaryBorderColor: look.border, primaryTextColor: look.text,
      secondaryColor: look.surface, secondaryBorderColor: look.border, secondaryTextColor: look.text,
      tertiaryColor: look.background, tertiaryBorderColor: look.border, tertiaryTextColor: look.text,
      mainBkg: look.surface, nodeBorder: look.border, nodeTextColor: look.text, lineColor: look.muted, textColor: look.text,
      clusterBkg: look.background, clusterBorder: look.border, edgeLabelBackground: look.background, titleColor: look.text,
      noteBkgColor: look.surface, noteBorderColor: look.accent, noteTextColor: look.text, actorBorder: look.border, actorBkg: look.surface,
    },
  };
}

/** Loads mermaid. An interface so tests use a fake. */
export type MermaidLoader = () => Promise<Pick<Mermaid, 'initialize' | 'render'>>;

/** The real loader: the mermaid package, imported when first needed. */
export const BUNDLED_MERMAID: MermaidLoader = async () => (await import('mermaid')).default;

/** Draws mermaid source as SVG, one diagram at a time (mermaid's theme is global). */
export class MermaidRenderer implements DiagramRenderer {
  readonly languages: readonly string[] = ['mermaid'];
  readonly #load: MermaidLoader;
  readonly #look: LookReader;
  #mermaid: ReturnType<MermaidLoader> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #count = 0;

  constructor(load: MermaidLoader = BUNDLED_MERMAID, look: LookReader = PAGE_LOOK) {
    this.#load = load;
    this.#look = look;
  }

  render(source: string, _language: string, dark: boolean): Promise<DiagramResult> {
    const drawn = this.#queue.then(() => this.#draw(source, dark));
    this.#queue = drawn.catch(() => undefined);
    return drawn;
  }

  async #draw(source: string, dark: boolean): Promise<DiagramResult> {
    this.#mermaid ??= this.#load();
    const mermaid = await this.#mermaid;
    const look = this.#look();
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...(look === undefined ? { theme: dark ? 'dark' : 'default' } : themeOf(look, dark)) });
    this.#count += 1;
    try {
      const { svg } = await mermaid.render(`harness-diagram-${this.#count}`, source);
      return { ok: true, value: sizedSvg(svg) };
    } catch (error) {
      return { ok: false, problem: error instanceof Error ? error.message : String(error) };
    }
  }
}
