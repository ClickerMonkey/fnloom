/**
 * The Ollama system end to end over the SDK's real link to an in-memory hub (`FakeHub`), with everything outside
 * faked: the release, download and unpack, the child process, and the Ollama server's HTTP API. Nothing is installed,
 * started or pulled for real. It installs into the instance's data folder, starts and stops the server, pulls with
 * progress and removes, offers exactly the offered models the server has as the provider named after the instance,
 * and its admin fns wait for an admin's approval with a card that says what they do.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceName, mintId, QualifiedName, SystemPackageManifest, type Json, type OutcomeWire } from '@harness/core';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub, TEST_USER } from '@harness/sdk/server/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { Detected, InstallResult, ModelList, OllamaConfig, OllamaStatus, ollama, PullResult, RemoveResult } from '../shared/index.ts';
import { HttpOllamaApi } from './api.ts';
import { chatShow, embedShow, FakeDownloader, FakeExtractor, FakeOllama, fakeFetch, FakeReleases, FakeRunner, sha256 } from './fakes.ts';
import { createOllamaImpl, type OllamaServer } from './impl.ts';
import { Installer, isFile, type Machine } from './install.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));
const LINUX: Machine = { platform: 'linux', arch: 'x64' };
const MANAGED = 'http://127.0.0.1:11435';
const fnName = (local: string) => QualifiedName.parse(`ollama/${local}`);

/** A done outcome's result, read with its schema. */
function resultOf<S extends z.ZodType>(schema: S, outcome: OutcomeWire): z.infer<S> {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return schema.parse(outcome.result);
}

describe('the ollama system', () => {
  let state: string;
  let running: RunningSystem<'ollama'> | undefined;
  let server: OllamaServer | undefined;
  beforeEach(async () => { state = await mkdtemp(join(tmpdir(), 'ollama-system-')); });
  afterEach(async () => {
    await server?.close();
    await running?.stop();
    running = undefined;
    server = undefined;
    await rm(state, { recursive: true, force: true });
  });

  /** The system served to a fake hub as instance `desk`, with a fake release and a fake managed server that answers while its child runs. */
  async function start(config: Json) {
    const managed = new FakeOllama(MANAGED);
    managed.up = false;
    const servers = new Map([[MANAGED, managed]]);
    const runner = new FakeRunner();
    runner.started = (child) => {
      managed.up = true;
      void child.exited.then(() => { managed.up = false; });
    };
    const releases = new FakeReleases().add({ version: '0.12.3', assets: [{ name: 'ollama-linux-amd64.tgz', url: 'https://dl/linux.tgz', size: 7, sha256: sha256('archive') }] });
    const downloader = new FakeDownloader();
    downloader.files.set('https://dl/linux.tgz', 'archive');
    const fetcher = fakeFetch(servers);
    server = createOllamaImpl({
      installer: new Installer({ releases, downloader, extractor: new FakeExtractor(), machine: LINUX, clock: () => 7 }),
      runner,
      api: (url) => servers.get(url) ?? new HttpOllamaApi(url, fetcher, 1_000),
      fetch: fetcher, machine: LINUX, env: { PATH: '' }, isFile, clock: Date.now,
      sleep: (ms, signal) => new Promise((done, failed) => { const t = setTimeout(done, Math.min(ms, 5)); signal?.addEventListener('abort', () => { clearTimeout(t); failed(new Error('aborted')); }); }),
      limits: { startTimeout: 2_000, healthEvery: 5, stopGrace: 100, restartDelay: 5, restartMax: 20, restartsPerHour: 5, outputLines: 10 },
      passEnv: [], maxContext: 4_096, defaultUrl: 'http://127.0.0.1:11434',
    });
    const hub = new FakeHub({ config, instance: InstanceName.parse('desk') });
    running = await serve(ollama, server.impl, { hub: 'ws://hub.test/link', state, version: '0.1.0' }, hub.host());
    await running.ready();
    const system = running;
    await server.attach(async (models) => { await system.models(ollama.providers.server, models); });
    const run = (local: string, args: Json = {}) => hub.run(fnName(local), args);
    const status = async () => resultOf(OllamaStatus, await run('status'));
    const offered = () => hub.patches.filter((p) => p.lists?.providers !== undefined).at(-1)?.lists?.providers?.[0]?.models.map((m) => m.id);
    return { hub, managed, runner, run, status, offered, releases };
  }

  it('is named as system.json says, many instances, and its changes wait for an admin', async () => {
    expect(ollama.name).toBe(packageManifest.name);
    expect(packageManifest.instances).toBe('many');
    const { hub } = await start({});
    const manifest = hub.manifests.at(-1);
    // the provider is the instance's, with no models until an admin offers one the server has
    expect(manifest?.providers?.map(({ description: _d, ...rest }) => rest)).toEqual([{ name: 'desk', models: [], runtime: true, instance: 'desk' }]);
    const fns = new Map(manifest?.fns.map((f) => [f.name, f]));
    for (const name of ['install', 'start', 'stop', 'pull', 'remove']) {
      expect(fns.get(name)?.approval, name).toMatchObject({ approver: 'admins', remember: false });
      expect(fns.get(name)?.tags, name).toContain('admin');
    }
    for (const name of ['status', 'detect', 'models']) {
      expect(fns.get(name)?.approval, name).toBeUndefined();
      expect(fns.get(name)?.tags, name).toEqual(['admin', 'read']);
    }
    expect(manifest?.pages?.map((page) => [page.segment, page.access, page.component])).toEqual([['servers', 'admin', 'ServersPage']]);
  });

  it('checks its config: where Ollama runs, and the offered models', () => {
    expect(OllamaConfig.parse({})).toEqual({ server: { mode: 'managed', version: 'latest', port: 11_435, host: '127.0.0.1', autoStart: true }, offered: [] });
    expect(OllamaConfig.parse({ server: { mode: 'url', url: 'http://gpu-box:11434' } }).server).toEqual({ mode: 'url', url: 'http://gpu-box:11434' });
    expect(OllamaConfig.parse({ server: { mode: 'managed', version: 'v0.12.3' } }).server).toMatchObject({ version: '0.12.3' });
    expect(OllamaConfig.safeParse({ server: { mode: 'url', url: 'http://gpu-box:11434/v1' } }).success).toBe(false);
    expect(OllamaConfig.safeParse({ server: { mode: 'managed', port: 80 } }).success).toBe(false);
    expect(OllamaConfig.safeParse({ server: { mode: 'managed', version: 'newest' } }).success).toBe(false);
    expect(OllamaConfig.safeParse({ offered: [{ model: 'qwen3' }, { model: 'qwen3:latest' }] }).success).toBe(false);
    expect(OllamaConfig.safeParse({ offered: [{ model: '../etc' }] }).success).toBe(false);
    expect(OllamaConfig.safeParse({ offered: [{ model: 'hf.co/org/repo:Q4_K_M', contextWindow: 8_192 }] }).success).toBe(true);
  });

  it('installs into its data folder, starts the server there, and stops it', async () => {
    const { run, status, runner, hub } = await start({ server: { mode: 'managed' } });
    // nothing installed: it can't start, and says how to fix that
    expect(await status()).toMatchObject({ instance: 'desk', mode: 'managed', state: 'stopped', answering: false, url: MANAGED, pulls: [], offered: [] });
    const notInstalled = await run('start');
    expect(notInstalled.status).toBe('invalid-input');
    expect(JSON.stringify(notInstalled)).toContain('install it with ollama/install first');

    const installed = resultOf(InstallResult, await run('install'));
    expect(installed).toMatchObject({ version: '0.12.3', checked: 'sha256', already: false });
    expect(installed.binary).toBe(join(state, 'data', 'ollama', '0.12.3', 'bin', 'ollama'));
    expect(hub.progress.map((p) => 'fraction' in p.progress ? p.progress.fraction : undefined).at(-1)).toBe(1);

    const started = resultOf(OllamaStatus, await run('start'));
    expect(started).toMatchObject({ state: 'running', answering: true, version: '0.12.3', installed: { version: '0.12.3' }, modelsDir: join(state, 'data', 'models') });
    expect(runner.children[0]?.command).toBe(installed.binary);
    expect(runner.children[0]?.options.env).toMatchObject({ OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: join(state, 'data', 'models') });

    expect(resultOf(OllamaStatus, await run('stop'))).toMatchObject({ state: 'stopped', answering: false });
    expect(runner.children[0]?.kills).toEqual([false]);
  });

  it('starts an installed server on its own when the config says so', async () => {
    const first = await start({ server: { mode: 'managed', autoStart: false } });
    await first.run('install');
    expect((await first.status()).state).toBe('stopped');
    await first.hub.configure({ server: { mode: 'managed', autoStart: true } });
    await expect.poll(async () => (await first.status()).state).toBe('running');
    expect(first.runner.children).toHaveLength(1);
  });

  it('pulls with progress, offers exactly the offered models it has, and drops one it removes', async () => {
    const { run, managed, hub, offered } = await start({ server: { mode: 'managed' }, offered: [{ model: 'qwen3:8b', contextWindow: 8_192 }, { model: 'nomic-embed-text' }] });
    await run('install');
    await run('start');
    managed.models.set('llama3.2:1b', { size: 1, show: chatShow(131_072) });
    managed.registry.set('qwen3:8b', {
      lines: [{ status: 'pulling manifest' }, { status: 'pulling a1', digest: 'a1', total: 100, completed: 25 }, { status: 'pulling a1', digest: 'a1', total: 100, completed: 100 }, { status: 'verifying sha256 digest' }],
      model: { size: 5_000, show: chatShow(40_960, 16_384) },
    });
    hub.progress.length = 0;
    expect(resultOf(PullResult, await run('pull', { model: 'qwen3:8b' }))).toEqual({ model: 'qwen3:8b', size: 5_000, offered: true });
    const fractions = hub.progress.flatMap((p) => ('fraction' in p.progress ? [p.progress.fraction] : []));
    expect(fractions).toContain(0.25);
    expect(fractions.at(-1)).toBe(1);
    // offered ∩ installed: llama3.2 is installed but not offered, nomic-embed-text offered but not installed
    expect(offered()).toEqual(['qwen3:8b']);
    const live = await hub.peer().call('providerModels', { provider: 'desk' });
    expect(live).toEqual({ listed: true, models: [{ id: 'qwen3:8b', contextWindow: 8_192 }] });

    managed.registry.set('nomic-embed-text:latest', { lines: [], model: { size: 9, show: embedShow(768) } });
    await run('pull', { model: 'nomic-embed-text' });
    expect(offered()).toEqual(['qwen3:8b', 'nomic-embed-text:latest']);
    expect(hub.patches.at(-1)?.lists?.providers?.[0]?.models[1]).toMatchObject({ capabilities: ['embedding'], dimensions: 768 });

    const models = resultOf(ModelList, await run('models')).models;
    expect(models.map((m) => [m.name, m.offered])).toEqual([['llama3.2:1b', false], ['qwen3:8b', true], ['nomic-embed-text:latest', true]]);

    expect(resultOf(RemoveResult, await run('remove', { model: 'qwen3:8b' }))).toEqual({ model: 'qwen3:8b', removed: true });
    expect(offered()).toEqual(['nomic-embed-text:latest']);
    expect(await run('remove', { model: 'qwen3:8b' })).toMatchObject({ status: 'invalid-input' });
    expect(await run('pull', { model: 'nope:1b' })).toMatchObject({ status: 'invalid-input', invalid: { problems: [{ path: 'model' }] } });

    // an admin offers the installed llama: the provider follows the config
    await hub.configure({ server: { mode: 'managed' }, offered: [{ model: 'nomic-embed-text' }, { model: 'llama3.2:1b', label: 'Llama' }] });
    await expect.poll(() => offered()).toEqual(['llama3.2:1b', 'nomic-embed-text:latest']);
  });

  it('shows the approval card what each change would do, and refuses what the config rules out', async () => {
    const { hub, run } = await start({ server: { mode: 'managed' }, offered: [{ model: 'qwen3:8b' }] });
    /** The card's title and words, or why it was refused. */
    const card = async (fn: string, args: Json = {}): Promise<string> => {
      const answer = await hub.preview({ run: mintId('run'), fn, args, user: TEST_USER });
      return 'refused' in answer ? `refused: ${answer.refused}` : [answer.preview.title, ...answer.preview.parts.map((part) => (part.type === 'text' ? part.text : ''))].join(' | ');
    };
    const install = await card('install');
    expect(install).toMatch(/^Install Ollama 0\.12\.3 on desk \| /);
    expect(install).toContain('ollama-linux-amd64.tgz');
    expect(install).toContain('checked against the sha-256');
    expect(await card('start')).toMatch(/^refused: .*not installed/);
    await run('install');
    expect(await card('start')).toMatch(/^Start Ollama on desk \| .*127\.0\.0\.1:11435/);
    expect(await card('pull', { model: 'qwen3:8b' })).toMatch(/^Pull qwen3:8b on desk \| .*offered to the chat once it is in/);
    expect(await card('remove', { model: 'qwen3' })).toMatch(/^Remove qwen3:latest from desk/);
    expect(await card('stop')).toMatch(/^Stop Ollama on desk/);

    await hub.configure({ server: { mode: 'url', url: 'http://gpu-box:11434' } });
    await expect.poll(async () => resultOf(OllamaStatus, await run('status')).mode).toBe('url');
    expect(await card('install')).toMatch(/^refused: .*install is for the `managed` mode/);
    expect(await card('stop')).toMatch(/^refused: .*runs on its own/);
    expect(await run('start')).toMatchObject({ status: 'invalid-input' });
    expect(await run('install')).toMatchObject({ status: 'invalid-input' });
    expect(resultOf(OllamaStatus, await run('status'))).toMatchObject({ state: 'external', answering: false, url: 'http://gpu-box:11434' });
  });

  it('finds the managed install and servers that answer, without running anything', async () => {
    const { run, runner } = await start({ server: { mode: 'managed', autoStart: false } });
    await run('install');
    const found = resultOf(Detected, await run('detect'));
    expect(found.binaries[0]).toMatchObject({ source: 'managed' });
    expect(found.servers).toEqual([]);
    expect(runner.children).toEqual([]);
  });
});
