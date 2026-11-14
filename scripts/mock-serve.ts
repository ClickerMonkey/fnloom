/**
 * `npm run mock:serve`: the web app on the mock hub, to browse the data the UI tests and screenshots use (chats,
 * widgets, records, systems, runs). The mock hub (`packages/web/e2e/mockHub.ts` and its `mockBuild*` fixtures) and the
 * Vite dev server run on ports of their own, on the LAN, until stopped. Sign in as the mock admin
 * (admin@harness.test / harness-admin-1). Nothing here touches a real hub or its database.
 *
 *   HARNESS_MOCK_SERVE_WEB_PORT=4490 HARNESS_MOCK_SERVE_HUB_PORT=4491 npm run mock:serve
 */
import { env } from '@ayepi/env';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { z } from 'zod';
import { MOCK_ADMIN, serveMockHub } from '../packages/web/e2e/mockHub.ts';

const settings = env({
  HARNESS_MOCK_SERVE_HUB_PORT: z.number().int().default(4491),
  HARNESS_MOCK_SERVE_WEB_PORT: z.number().int().default(4490),
}).parse();
const hubUrl = `http://127.0.0.1:${settings.HARNESS_MOCK_SERVE_HUB_PORT}`;
const web = fileURLToPath(new URL('../packages/web/', import.meta.url));

const hub = serveMockHub(settings.HARNESS_MOCK_SERVE_HUB_PORT, { needsAdmin: false, notifyEvery: 0, logEvery: 0 });
const proxy = Object.fromEntries(['/api', '/_files', '/clients', '/connect/callback', '/manifest.webmanifest'].map((path) => [path, { target: hubUrl, changeOrigin: true }]));
const server = await createServer({
  root: web,
  configFile: false,
  plugins: [(await import('@vitejs/plugin-vue')).default()],
  resolve: { dedupe: ['vue', 'zod'] },
  server: { host: '0.0.0.0', port: settings.HARNESS_MOCK_SERVE_WEB_PORT, strictPort: true, proxy: { ...proxy, '/ws': { target: hubUrl.replace('http', 'ws'), ws: true } } },
});
await server.listen();
console.info('mock.serve', { web: `http://0.0.0.0:${settings.HARNESS_MOCK_SERVE_WEB_PORT}`, admin: MOCK_ADMIN.email });

const stop = (): void => { void Promise.all([server.close(), hub.stop()]).then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
