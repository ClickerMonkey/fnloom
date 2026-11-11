/**
 * Component previews: a system's Vue components (fn renderers, visuals, inputs, editors, config) drawn in isolation in
 * named states, so a model or a person can review them.
 *
 * - `renderHtml(component, props)` draws one state to HTML in-process (Vue's server renderer): fast, for asserting
 *   what a state shows.
 * - `preview({ name, module, states })` draws every state at phone and desktop sizes in light and dark: it bundles the
 *   component with Vite (its own styles included), opens each state in headless Chrome with the app's look (the web
 *   app's tokens), and saves a screenshot per state, viewport and theme into the preview folder, with `gallery.html`
 *   beside them. Shooting is on with `HARNESS_PREVIEWS` (`harness test --previews`); otherwise the component is only
 *   bundled (so a broken import or template still fails), and the preview tests stay fast.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject, PreviewShot, PreviewViewport } from '@harness/core';
import { createSSRApp, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { contentHash } from '../server/content.ts';
import { kitEnv, viewportSize } from './env.ts';
import { PREVIEW_INDEX, PREVIEW_THEMES, PreviewIndex, type PreviewTheme } from './shots.ts';


/** Draw a component with props to HTML, in-process. */
export function renderHtml(component: Component, props: JsonObject = {}): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

/** What to preview: one component, from its module, in named states. */
export interface PreviewOptions {
  /** The component's name as the client registers it (a renderer's type, a visual's entry, an input, an editor). */
  readonly name: string;
  /** The module that exports it: a `.vue` file or a module, as a path or `new URL('./X.vue', import.meta.url)`. */
  readonly module: string | URL;
  /** Its export (default `default`). */
  readonly export?: string;
  /** Props by state name: the kit's `empty`, `loading`, `error`, `typical`, `long`, or names of its own. Plain JSON. */
  readonly states: Readonly<Record<string, JsonObject>>;
  /** Default both. */
  readonly viewports?: readonly PreviewViewport[];
  /** Default both. */
  readonly themes?: readonly PreviewTheme[];
  /** Force shooting on or off (default `HARNESS_PREVIEWS`). */
  readonly shoot?: boolean;
}

/** One preview shot, with where its image was saved. */
export interface SavedShot extends PreviewShot {
  readonly file: string;
}


/**
 * Preview a component in its states. Without shooting, it bundles the component once to prove it builds and returns
 * no shots; with shooting, every state, viewport and theme is saved and returned.
 */
export async function preview(options: PreviewOptions): Promise<SavedShot[]> {
  const settings = kitEnv.parse();
  const shoot = options.shoot ?? settings.HARNESS_PREVIEWS;
  const bundle = await bundleComponent(options);
  if (!shoot) { return []; }
  const out = resolve(settings.HARNESS_PREVIEW_DIR);
  await mkdir(out, { recursive: true });
  const theme = await themeCss(settings.HARNESS_PREVIEW_THEME);
  const sizes: Record<PreviewViewport, { width: number; height: number }> = {
    phone: viewportSize(settings.HARNESS_PREVIEW_PHONE),
    desktop: viewportSize(settings.HARNESS_PREVIEW_DESKTOP),
  };
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: true });
  const shots: SavedShot[] = [];
  try {
    for (const [state, props] of Object.entries(options.states)) {
      for (const viewport of options.viewports ?? ['phone', 'desktop'] as const) {
        for (const mode of options.themes ?? PREVIEW_THEMES) {
          const page = await browser.newPage();
          try {
            await page.setViewport(sizes[viewport]);
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
            await page.setContent(pageHtml({ theme, css: bundle.css, script: bundle.script, props, mode }), { waitUntil: 'load' });
            await page.waitForFunction('globalThis.__previewReady === true', { timeout: 10_000 });
            const image = await page.screenshot({ type: 'png', fullPage: true });
            const hash = contentHash(image);
            const file = join(out, `${hash}.png`);
            await writeFile(file, image);
            shots.push({ component: options.name, state, viewport, theme: mode, image: { hash, size: image.byteLength, mime: 'image/png' }, file });
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  await recordShots(out, shots);
  return shots;
}

/** A component bundled for the browser: the mount script and its styles. */
interface Bundle {
  readonly script: string;
  readonly css: string;
}

/** The id of the generated entry that mounts the component. */
const ENTRY = 'virtual:harness-preview';

/** Bundle the component and Vue into one module that mounts it with `globalThis.__previewProps`. */
async function bundleComponent(options: PreviewOptions): Promise<Bundle> {
  const path = typeof options.module === 'string' ? resolve(options.module) : fileURLToPath(options.module);
  const name = options.export ?? 'default';
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const entry = [
    `import { createApp } from 'vue';`,
    `import { ${name === 'default' ? 'default as Preview' : `${name} as Preview`} } from ${JSON.stringify(path.replaceAll('\\', '/'))};`,
    `createApp(Preview, globalThis.__previewProps ?? {}).mount('#app');`,
    `globalThis.__previewReady = true;`,
  ].join('\n');
  const output = await build({
    configFile: false,
    logLevel: 'warn',
    root: dirname(path),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [vue(), {
      name: 'harness-preview',
      resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : undefined),
      load: (id) => (id === `\0${ENTRY}` ? entry : undefined),
    }],
    build: { write: false, minify: false, cssCodeSplit: false, modulePreload: false, rolldownOptions: { input: ENTRY, output: { codeSplitting: false } } },
  });
  const outputs = Array.isArray(output) ? output : 'output' in output ? [output] : [];
  let script = '';
  let css = '';
  for (const item of outputs.flatMap((o) => o.output)) {
    if (item.type === 'chunk') { script += item.code; } else if (item.fileName.endsWith('.css')) { css += typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source); }
  }
  if (script === '') { throw new Error(`Bundling ${options.name} (${path}) gave no script.`); }
  return { script, css };
}

/** The app's look: the given CSS files, or the web app's tokens and base styles when it is installed. */
async function themeCss(files: string | undefined): Promise<string> {
  const paths = files === undefined ? webThemeFiles() : files.split(',').map((f) => f.trim()).filter((f) => f !== '');
  const texts = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  return texts.join('\n');
}

/** The web app's tokens and base styles, or none when `@harness/web` isn't installed beside the SDK. */
function webThemeFiles(): string[] {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('@harness/web/package.json'));
    return ['tokens.css', 'base.css'].map((file) => join(root, 'src', 'ui', 'styles', file));
  } catch {
    return [];
  }
}

/** One state's page: the look, the component's styles, its props and the mount script. */
function pageHtml(parts: { theme: string; css: string; script: string; props: JsonObject; mode: PreviewTheme }): string {
  // `<` escaped so a prop's text can't close the script
  const props = JSON.stringify(parts.props).replaceAll('<', '\\u003c');
  return [
    `<!doctype html><html data-theme="${parts.mode}"><head><meta charset="utf-8">`,
    `<style>${parts.theme}</style><style>${parts.css}</style>`,
    `<style>html, body, #app { height: auto; } body { padding: 16px; }</style>`,
    `</head><body><div id="app"></div>`,
    `<script>globalThis.__previewProps = ${props};</script>`,
    `<script type="module">${parts.script.replaceAll('</script', '<\\/script')}</script>`,
    `</body></html>`,
  ].join('');
}

/** Merge shots into the folder's index (a newer shot of the same component, state, viewport and theme replaces the older) and write the gallery. */
async function recordShots(out: string, shots: readonly SavedShot[]): Promise<void> {
  const indexFile = join(out, PREVIEW_INDEX);
  const before = await readFile(indexFile, 'utf8').then((text) => PreviewIndex.parse(JSON.parse(text)).shots, () => []);
  const key = (shot: PreviewShot): string => `${shot.component}\n${shot.state}\n${shot.viewport}\n${shot.theme}`;
  const merged = new Map(before.map((shot) => [key(shot), shot]));
  for (const shot of shots) { merged.set(key(shot), { component: shot.component, state: shot.state, viewport: shot.viewport, theme: shot.theme, image: shot.image }); }
  const all = [...merged.values()].sort((a, b) => key(a).localeCompare(key(b)));
  await writeFile(indexFile, `${JSON.stringify({ shots: all } satisfies PreviewIndex, null, 2)}\n`);
  await writeFile(join(out, 'gallery.html'), galleryHtml(all));
}

/** A page of every shot, grouped by component and state. */
export function galleryHtml(shots: readonly PreviewShot[]): string {
  const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const groups = new Map<string, PreviewShot[]>();
  for (const shot of shots) { groups.set(`${shot.component} · ${shot.state}`, [...(groups.get(`${shot.component} · ${shot.state}`) ?? []), shot]); }
  const sections = [...groups].map(([title, group]) => [
    `<section><h2>${escape(title)}</h2><div class="row">`,
    ...group.map((shot) => `<figure><img src="${shot.image.hash}.png" alt="${escape(`${title}, ${shot.viewport}, ${shot.theme}`)}"><figcaption>${shot.viewport} · ${shot.theme}</figcaption></figure>`),
    `</div></section>`,
  ].join(''));
  return [
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Component previews</title>`,
    `<style>body{font:14px system-ui,sans-serif;margin:16px;color-scheme:light dark}h2{font-size:15px;margin:24px 0 8px}`,
    `.row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}figure{margin:0;max-width:100%}`,
    `img{max-width:min(100%,640px);border:1px solid #8884;border-radius:6px}figcaption{color:#888;font-size:12px}</style></head><body>`,
    `<h1>Component previews</h1>`,
    ...sections,
    `</body></html>`,
  ].join('');
}
