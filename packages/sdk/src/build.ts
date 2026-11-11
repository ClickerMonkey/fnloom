/**
 * `@harness/sdk/build`: building a system's client renderers into the bundle the hub serves to the chat.
 *
 * `buildClient({ entry, outDir })` runs a Vite library build of `client/index.ts` (Vue single-file components
 * included) into `outDir/index.js`. `vue` and `@harness/sdk` stay external: every import of them reads the chat's own
 * copies from the shared-modules global (`shareModules` in `@harness/sdk/client`), so renderers share the chat's Vue
 * and the SDK's injection keys. Their CSS is folded into `index.js` (`inlineCss`), so loading the entry styles them. Pass `outDir` as `serve`'s `client` option and the system uploads it on connect.
 */
import vue from '@vitejs/plugin-vue';
import { build, type Plugin } from 'vite';
import { readClientBundle, type ClientBundle } from './server/assets.ts';

export { PREVIEW_INDEX, PreviewIndex } from './testing/shots.ts';

/** The modules a bundle takes from the chat, and the key each lives under in the shared-modules global. */
export const SHARED_IMPORTS = ['vue', '@harness/sdk'] as const;

const VIRTUAL = '\0harness-shared:';

/** The export names of a shared module, read from the copy this build would otherwise bundle. */
async function exportNames(id: (typeof SHARED_IMPORTS)[number]): Promise<string[]> {
  const module: Record<string, unknown> = id === 'vue' ? await import('vue') : await import('./index.ts');
  return Object.keys(module).filter((name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
}

/** A Vite plugin that turns imports of the shared modules into reads of the chat's copies. */
export function sharedModules(): Plugin {
  return {
    name: 'harness-shared-modules',
    enforce: 'pre',
    resolveId(source) {
      return SHARED_IMPORTS.some((id) => id === source) ? `${VIRTUAL}${source}` : null;
    },
    async load(id) {
      if (!id.startsWith(VIRTUAL)) { return null; }
      const source = SHARED_IMPORTS.find((name) => name === id.slice(VIRTUAL.length));
      if (source === undefined) { return null; }
      const names = await exportNames(source);
      return [
        `const shared = globalThis[Symbol.for('harness.shared')];`,
        `const m = shared && shared[${JSON.stringify(source)}];`,
        `if (!m) throw new Error(${JSON.stringify(`The chat has not shared ${source} with system renderers (call shareModules first).`)});`,
        `export const { ${names.join(', ')} } = m;`,
        `export default m.default ?? m;`,
      ].join('\n');
    },
  };
}

/**
 * A Vite plugin that moves the bundle's CSS into its entry chunk, which adds it to the page as a `<style>` when it
 * loads. The chat loads a system's build by its entry alone, so renderers' styles must travel with it.
 */
export function inlineCss(): Plugin {
  return {
    name: 'harness-inline-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const sheets = Object.values(bundle).flatMap((file) => (file.type === 'asset' && file.fileName.endsWith('.css') ? [file] : []));
      const entry = Object.values(bundle).find((file) => file.type === 'chunk' && file.isEntry);
      if (sheets.length === 0 || entry?.type !== 'chunk') { return; }
      const css = sheets.map((sheet) => (typeof sheet.source === 'string' ? sheet.source : new TextDecoder().decode(sheet.source))).join('\n');
      for (const sheet of sheets) { Reflect.deleteProperty(bundle, sheet.fileName); }
      entry.code = `if (typeof document !== 'undefined') { const style = document.createElement('style'); style.dataset['harnessClient'] = ''; style.textContent = ${JSON.stringify(css)}; document.head.append(style); }\n${entry.code}`;
    },
  };
}

/** What `buildClient` takes. */
export interface BuildClientOptions {
  /** The client entry: a module whose default export is `client(contract, renderers)`. */
  entry: string;
  /** Where the bundle goes (emptied first). */
  outDir: string;
  /** Minify the output. Default true. */
  minify?: boolean;
  /** Source maps. Default false. */
  sourcemap?: boolean;
}

/** Build a system's client bundle; returns it as `serve` would upload it. */
export async function buildClient(options: BuildClientOptions): Promise<ClientBundle> {
  await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [sharedModules(), vue(), inlineCss()],
    build: {
      outDir: options.outDir,
      emptyOutDir: true,
      minify: options.minify ?? true,
      sourcemap: options.sourcemap ?? false,
      lib: { entry: options.entry, formats: ['es'], fileName: () => 'index.js', cssFileName: 'index' },
    },
  });
  return readClientBundle(options.outDir);
}
