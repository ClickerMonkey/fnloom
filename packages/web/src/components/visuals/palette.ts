/**
 * The chart palette: the `--chart-1` … `--chart-8` tokens and the text, grid and surface colours of the theme shown,
 * resolved to colours ECharts can read (it parses hex and rgb, not `oklch()` or `light-dark()`). Read once per theme
 * change by `usePalette`; every chart is drawn from the value it gets, never from the DOM, so a test passes a fixed one.
 */
import { CHART_PALETTE_SIZE } from '@harness/core';
import type { VisualPalette } from '@harness/sdk';
import { onBeforeUnmount, onMounted, shallowRef, type Ref } from 'vue';
import { isDark } from '../../ui/index.ts';

/**
 * The colours a chart is drawn with, for the theme shown: the sdk's `VisualPalette` (what a system's own chart gets:
 * `--chart-1` … `--chart-8` as `series`, text, muted text, grid lines, the ground) and what the built-in families add.
 */
export interface ChartPalette extends VisualPalette {
  /** A rise and a fall (candles). */
  readonly up: string;
  readonly down: string;
  readonly font: string;
}

/** The light theme's colours, for a page with no tokens (a test, a detached export). */
export const LIGHT_PALETTE: ChartPalette = {
  series: ['#4b5fd0', '#d06a2c', '#1d8a62', '#c2408e', '#2283a8', '#9a8414', '#7a46b5', '#c8414a'],
  text: '#1d1f24', muted: '#5b5f69', grid: '#e2e3e7', surface: '#ffffff', up: '#25875a', down: '#c8414a',
  font: 'system-ui, sans-serif', dark: false,
};

const SERIES_TOKENS = Array.from({ length: CHART_PALETTE_SIZE }, (_, i) => `--chart-${String(i + 1)}`);

/** One OKLCH colour as sRGB hex (the CSS Color 4 conversion, clamped into gamut), keeping any alpha. */
export function oklchToHex(lightness: number, chroma: number, hue: number, alpha = 1): string {
  const rad = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(rad); const b = chroma * Math.sin(rad);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channel = (x: number): string => {
    const c = Math.min(1, Math.max(0, x));
    const gamma = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(gamma * 255).toString(16).padStart(2, '0');
  };
  const hex = `#${linear.map(channel).join('')}`;
  return alpha >= 1 ? hex : `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/i;

/** A computed CSS colour as ECharts reads it: `oklch()` converted to hex, anything else as it is; empty stays empty. */
export function chartColor(css: string): string {
  const value = css.trim();
  const match = OKLCH.exec(value);
  if (match === null) { return value; }
  const [, l = '0', lPercent, c = '0', h = '0', alpha, alphaPercent] = match;
  const lightness = Number(l) / (lPercent === '%' ? 100 : 1);
  const opacity = alpha === undefined ? 1 : Number(alpha) / (alphaPercent === '%' ? 100 : 1);
  return oklchToHex(lightness, Number(c), Number(h), opacity);
}

/**
 * The palette of the theme shown: each token resolved through a hidden probe's `color` (custom properties hold
 * `light-dark()` unresolved), falling back on the light palette for any token the page lacks.
 */
export function readPalette(doc: Document = document): ChartPalette {
  const view = doc.defaultView;
  if (view === null) { return LIGHT_PALETTE; }
  const probe = doc.createElement('span');
  probe.style.display = 'none';
  doc.body.append(probe);
  const read = (token: string, fallback: string): string => {
    probe.style.color = '';
    probe.style.color = `var(${token})`;
    const value = chartColor(view.getComputedStyle(probe).color);
    return value === '' || value.includes('var(') ? fallback : value;
  };
  try {
    return {
      series: SERIES_TOKENS.map((token, i) => read(token, LIGHT_PALETTE.series[i] ?? LIGHT_PALETTE.text)),
      text: read('--text', LIGHT_PALETTE.text), muted: read('--text-dim', LIGHT_PALETTE.muted), grid: read('--border', LIGHT_PALETTE.grid),
      surface: read('--surface', LIGHT_PALETTE.surface), up: read('--ok', LIGHT_PALETTE.up), down: read('--danger', LIGHT_PALETTE.down),
      font: view.getComputedStyle(doc.body).fontFamily || LIGHT_PALETTE.font, dark: isDark(doc),
    };
  } finally {
    probe.remove();
  }
}

/** The palette of the theme shown, read again when the app's theme or the device's preference changes. */
export function usePalette(): Readonly<Ref<ChartPalette>> {
  const palette = shallowRef<ChartPalette>(LIGHT_PALETTE);
  let observer: MutationObserver | undefined;
  let media: MediaQueryList | undefined;
  const update = (): void => { palette.value = readPalette(); };
  onMounted(() => {
    update();
    observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
  });
  onBeforeUnmount(() => { observer?.disconnect(); media?.removeEventListener('change', update); });
  return palette;
}
