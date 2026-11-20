/**
 * The web app's build. In dev it proxies the hub's HTTP API (`/api`), its WebSocket (`/ws`), files (`/_files`) and systems' client bundles (`/clients`) to
 * the hub, so the browser talks to one origin. Ports come from `webEnv` (`HARNESS_PORT`, `HARNESS_WEB_PORT`). The
 * build has two entries: the app (`index.html`) and its service worker (`sw/sw.ts`, written to `/sw.js`).
 */
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { webEnv } from './env.ts';

const { HARNESS_PORT: hubPort, HARNESS_WEB_PORT: webPort } = webEnv.parse();
const hub = `http://127.0.0.1:${hubPort}`;

export default defineConfig({
  plugins: [vue()],
  resolve: { dedupe: ['vue', 'zod'] },
  server: {
    host: '0.0.0.0',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: hub, changeOrigin: true },
      '/_files': { target: hub, changeOrigin: true },
      // systems' client bundles (renderers, visuals), which the hub serves
      '/clients': { target: hub, changeOrigin: true },
      // the redirect back from a provider's sign-in (a calendar): the hub answers it, then sends the person to /connect/<system>
      '/connect/callback': { target: hub, changeOrigin: true },
      // SSO: a provider button's start, and the redirect back from the provider; the hub answers both. `xfwd` tells the
      // hub the host the browser used (X-Forwarded-Host), so a start here bounces to HARNESS_URL, where the provider comes back
      '/auth/sso': { target: hub, changeOrigin: true, xfwd: true },
      // the install manifest, which carries the hub's display name
      '/manifest.webmanifest': { target: hub, changeOrigin: true },
      '/ws': { target: hub.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist', emptyOutDir: true, sourcemap: true,
    // the service worker is its own entry, at the root so its scope is the whole app
    rolldownOptions: {
      input: { index: fileURLToPath(new URL('index.html', import.meta.url)), sw: fileURLToPath(new URL('sw/sw.ts', import.meta.url)) },
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});
