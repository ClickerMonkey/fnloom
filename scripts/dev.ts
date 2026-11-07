/**
 * `npm run dev`: the hub, the web app (Vite), and the fs and embedder systems, each bound to the LAN, with their
 * output prefixed and coloured. Ctrl+C stops them all. Settings come from the `devEnv` slice:
 *
 *   HARNESS_PORT      hub port (default 4300)       HARNESS_WEB_PORT  web port (default 4310)
 *   HARNESS_DATA      data folder (default .harness) HARNESS_DEV_ONLY  comma list to run only some: hub,web,fs,embedder
 *
 * A component whose entry file doesn't exist yet is reported and skipped, so this works while lanes build.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import { z } from 'zod';

const devEnv = env({
  HARNESS_PORT: z.number().int().default(4300),
  HARNESS_WEB_PORT: z.number().int().default(4310),
  HARNESS_DATA: z.string().default('.harness'),
  HARNESS_DEV_ONLY: z.string().default('hub,web,fs,embedder'),
  HARNESS_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760'),
});
const settings = devEnv.parse();
const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const link = `ws://127.0.0.1:${settings.HARNESS_PORT}/link`;

interface Component {
  readonly name: string;
  readonly colour: number;
  readonly entry: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const shared = { HARNESS_PORT: String(settings.HARNESS_PORT), HARNESS_WEB_PORT: String(settings.HARNESS_WEB_PORT), HARNESS_DATA: settings.HARNESS_DATA };

const components: readonly Component[] = [
  { name: 'hub', colour: 35, entry: `${root}packages/hub/src/main.ts`, args: [tsx, 'watch', `${root}packages/hub/src/main.ts`], cwd: root, env: { HARNESS_HOST: '0.0.0.0' } },
  { name: 'web', colour: 36, entry: vite, args: [vite], cwd: `${root}packages/web`, env: {} },
  { name: 'fs', colour: 33, entry: `${root}systems/fs/server/main.ts`, args: [tsx, 'watch', `${root}systems/fs/server/main.ts`], cwd: root, env: { HARNESS_HUB: link, HARNESS_SYSTEM_STATE: `${settings.HARNESS_DATA}/dev-systems/fs` } },
  {
    name: 'embedder', colour: 32, entry: `${root}systems/embedder/server/main.ts`, args: [tsx, 'watch', `${root}systems/embedder/server/main.ts`], cwd: root,
    env: { HARNESS_HUB: link, HARNESS_SYSTEM_STATE: `${settings.HARNESS_DATA}/dev-systems/embedder`, HARNESS_EMBEDDER_URL: settings.HARNESS_EMBEDDER_URL },
  },
];

const only = new Set(settings.HARNESS_DEV_ONLY.split(',').map((s) => s.trim()));
const children = new Map<string, ChildProcess>();

function prefix(component: Component, text: string): string {
  return text.split(/\r?\n/).filter((line) => line !== '').map((line) => `\u001b[${component.colour}m${component.name.padEnd(9)}\u001b[0m ${line}`).join('\n');
}

for (const component of components) {
  if (!only.has(component.name)) { continue; }
  if (!existsSync(component.entry)) {
    console.warn('dev.component.missing', { component: component.name, entry: component.entry });
    continue;
  }
  const child = spawn(process.execPath, [...component.args], { cwd: component.cwd, env: { ...process.env, ...shared, ...component.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk: Buffer) => { process.stdout.write(`${prefix(component, chunk.toString())}\n`); });
  child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(`${prefix(component, chunk.toString())}\n`); });
  child.on('exit', (code) => { children.delete(component.name); console.info('dev.component.exited', { component: component.name, code }); });
  children.set(component.name, child);
}

const lan = Object.values(networkInterfaces()).flat().find((n) => n?.family === 'IPv4' && !n.internal)?.address ?? 'localhost';
console.info('dev.ready', { web: `http://${lan}:${settings.HARNESS_WEB_PORT}`, hub: `http://${lan}:${settings.HARNESS_PORT}`, data: settings.HARNESS_DATA });

function stop(): void {
  for (const child of children.values()) { child.kill(); }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
