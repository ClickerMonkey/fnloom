/**
 * A chart as an image (look-export): PNG from an off-screen canvas instance, SVG from a server-side-rendered SVG
 * instance, both drawn from the same option and theme as the chart shown, without animation, at its size.
 */
import { init } from 'echarts/core';
import type { ChartOption, ChartTheme } from './echarts-setup.ts';
import type { ImageKind } from './size.ts';

/** What an image is drawn from. */
export interface ImageSource {
  readonly option: ChartOption;
  readonly theme: ChartTheme;
  readonly width: number;
  readonly height: number;
  /** The ground a PNG is filled with (a transparent chart reads badly in an image viewer). */
  readonly background: string;
}

/** The chart as a data URL of the kind asked for. */
export function chartImage(source: ImageSource, kind: ImageKind): string {
  const size = { width: Math.max(1, Math.round(source.width)), height: Math.max(1, Math.round(source.height)) };
  const option = { ...source.option, animation: false };
  if (kind === 'svg') {
    const chart = init(null, source.theme, { renderer: 'svg', ssr: true, ...size });
    try {
      chart.setOption({ ...option, backgroundColor: source.background });
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(chart.renderToSVGString())}`;
    } finally { chart.dispose(); }
  }
  const chart = init(document.createElement('div'), source.theme, { renderer: 'canvas', ...size });
  try {
    chart.setOption(option);
    return chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: source.background });
  } finally { chart.dispose(); }
}

/** Save a data URL as a file. */
export function saveUrl(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}

/** Save bytes (an export, a CSV) as a file. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  saveUrl(url, name);
  URL.revokeObjectURL(url);
}
