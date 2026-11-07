/**
 * The web app's build. In dev it proxies the hub's HTTP API (`/api`), its WebSocket (`/ws`) and files (`/_files`) to
 * the hub, so the browser talks to one origin. Ports come from the environment `scripts/dev.ts` sets.
 */
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const hubPort = Number(process.env['HARNESS_PORT'] ?? 4300);
const webPort = Number(process.env['HARNESS_WEB_PORT'] ?? 4310);
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
      '/ws': { target: hub.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
