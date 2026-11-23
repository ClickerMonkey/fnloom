/**
 * The Ollama system's process: the real server API, GitHub releases, download, `tar` and child processes, served to
 * the hub with its admin page. Once `serve` returns, the implementation gets `running.models` to offer its provider's models with, and
 * the Ollama it runs is stopped when this process stops.
 */
import { join } from 'node:path';
import { loggedHost, rendererFolder, serve } from '@harness/sdk/server';
import { ollama } from '../shared/index.ts';
import { HttpOllamaApi } from './api.ts';
import { ollamaEnv } from './env.ts';
import { createOllamaImpl } from './impl.ts';
import { FetchDownloader, GitHubReleases, Installer, isFile, TarExtractor } from './install.ts';
import { NodeChildRunner } from './serve.ts';

const settings = ollamaEnv.parse();
const { host, log } = loggedHost(ollama.name);
const machine = { platform: process.platform, arch: process.arch };
const fetcher: typeof fetch = (input, init) => fetch(input, init);
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((done, failed) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); failed(new Error('aborted')); }, { once: true });
});

const server = createOllamaImpl({
  installer: new Installer({
    releases: new GitHubReleases(settings.OLLAMA_SYSTEM_RELEASES, fetcher),
    downloader: new FetchDownloader(fetcher, settings.OLLAMA_SYSTEM_DOWNLOAD_IDLE),
    extractor: new TarExtractor(machine.platform, process.env),
    machine,
    clock: Date.now,
  }),
  runner: new NodeChildRunner(),
  api: (url) => new HttpOllamaApi(url, fetcher, settings.OLLAMA_SYSTEM_TIMEOUT),
  fetch: fetcher,
  machine,
  env: process.env,
  isFile,
  clock: Date.now,
  sleep,
  limits: {
    startTimeout: settings.OLLAMA_SYSTEM_START_TIMEOUT, healthEvery: settings.OLLAMA_SYSTEM_HEALTH_EVERY, stopGrace: settings.OLLAMA_SYSTEM_STOP_GRACE,
    restartDelay: settings.OLLAMA_SYSTEM_RESTART_DELAY, restartMax: settings.OLLAMA_SYSTEM_RESTART_MAX, restartsPerHour: settings.OLLAMA_SYSTEM_RESTARTS_PER_HOUR,
    outputLines: settings.OLLAMA_SYSTEM_OUTPUT_LINES,
  },
  passEnv: settings.OLLAMA_SYSTEM_PASS_ENV.split(',').map((name) => name.trim()).filter((name) => name !== ''),
  maxContext: settings.OLLAMA_SYSTEM_MAX_CTX,
  defaultUrl: settings.OLLAMA_SYSTEM_DEFAULT_URL,
});

// the admin page, built into the state folder
const clientFolder = await rendererFolder({ main: import.meta.url, outDir: join(settings.HARNESS_SYSTEM_STATE, 'client') });

log.info('ollama.serving', { hub: settings.HARNESS_HUB, instance: settings.HARNESS_INSTANCE });
const running = await serve(ollama, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('ollama.status', { status }); });
await server.attach(async (models) => { await running.models(ollama.providers.server, models); });

const stop = () => {
  server.close().then(() => running.stop()).finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
