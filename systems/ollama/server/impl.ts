/**
 * The Ollama system's implementation: one instance's server (run as a child process, `serve.ts`, or one someone else
 * runs), its models (`models.ts`), installs (`install.ts`), detection (`detect.ts`) and the provider of the models an
 * admin offers (`provider.ts`). The provider's declared models are the offered ones the server has; they are sent to
 * the hub (`publish`, through `RunningSystem.models`) whenever that set changes: on start, on a config change, once the
 * server answers, and after a pull or a removal.
 */
import { join } from 'node:path';
import type { ProviderModelDecl } from '@harness/core';
import type { Log, SystemImpl, SystemPlace } from '@harness/sdk';
import {
  InstallArgs, ModelArgs, OllamaConfig, taggedModel, type InstalledModel, type OllamaContract, type OllamaStatus, type PullProgress,
} from '../shared/index.ts';
import type { OllamaApiFactory } from './api.ts';
import { detect, type DetectParts } from './detect.ts';
import { readInstall, type Installer, type Machine } from './install.ts';
import { declaredModels, installedModels, offerOf } from './models.ts';
import { OfferedOllamaProvider } from './provider.ts';
import { localUrl, OllamaProcess, type ChildRunner, type LogFields, type ServeLimits, type ServeSpec } from './serve.ts';

/** What the implementation is built from: the tunables and each outside part. */
export interface OllamaDeps {
  readonly installer: Installer;
  readonly runner: ChildRunner;
  readonly api: OllamaApiFactory;
  /** The `fetch` the provider calls the server with. */
  readonly fetch: typeof fetch;
  readonly machine: Machine;
  /** This process's environment (the PATH detection reads, the names passed to the server). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly limits: ServeLimits;
  readonly passEnv: readonly string[];
  /** The most window assumed for a model when nothing sets one. */
  readonly maxContext: number;
  /** Where detection asks for an Ollama already running. */
  readonly defaultUrl: string;
}

/** Sets the provider's models on the hub (`running.models` for the contract's provider). */
export type PublishModels = (models: readonly ProviderModelDecl[]) => Promise<void>;

/** The implementation, and its hand-offs to the process that serves it. */
export interface OllamaServer {
  readonly impl: SystemImpl<OllamaContract['defs']>;
  /** Give it the way to set the provider's models, once `serve` returned; it sends the current ones then. */
  attach(publish: PublishModels): Promise<void>;
  /** Stop the server it runs (the process is going away). */
  close(): Promise<void>;
}

/** The config, parsed (defaults filled in). */
function configOf(raw: unknown): OllamaConfig {
  return OllamaConfig.parse(raw);
}

/** Build the Ollama implementation. */
export function createOllamaImpl(deps: OllamaDeps): OllamaServer {
  let log: Log | undefined;
  const say = (event: string, fields: LogFields): void => { log?.info(event, fields); };
  const server = new OllamaProcess({
    runner: deps.runner, env: deps.env, passEnv: deps.passEnv, limits: deps.limits, clock: deps.clock, sleep: deps.sleep, log: say,
    answers: async (url) => (await versionAt(url)) !== undefined,
  });
  let config: OllamaConfig | undefined;
  let publisher: PublishModels | undefined;
  /** The models the server had when last read, kept while it doesn't answer. */
  let known: InstalledModel[] | undefined;
  /** The declared models last sent, as JSON. */
  let sent: string | undefined;
  const pulls = new Map<string, PullProgress>();

  async function versionAt(url: string): Promise<string | undefined> {
    return deps.api(url).version().catch(() => undefined);
  }

  const urlOf = (c: OllamaConfig): string => (c.server.mode === 'url' ? c.server.url.replace(/\/+$/, '') : localUrl(c.server.host, c.server.port));
  const modelsDirOf = (c: OllamaConfig, dataDir: string): string => (c.server.mode === 'binary' && c.server.modelsDir !== undefined ? c.server.modelsDir : join(dataDir, 'models'));

  /** The program this config runs, if there is one. */
  async function binaryOf(c: OllamaConfig, at: SystemPlace): Promise<string | undefined> {
    if (c.server.mode === 'managed') { return (await readInstall(at.dataDir))?.binary; }
    if (c.server.mode === 'binary') {
      if (c.server.path !== undefined) { return await deps.isFile(c.server.path) ? c.server.path : undefined; }
      const found = await detect(detectParts(), undefined, []);
      return found.binaries[0]?.path;
    }
    return undefined;
  }

  /** What `ollama serve` runs as for this config, or why it can't run. */
  async function specOf(c: OllamaConfig, at: SystemPlace): Promise<ServeSpec | string> {
    if (c.server.mode === 'url') { return `This instance uses the Ollama at ${c.server.url}, which runs on its own: it never starts or stops it.`; }
    const binary = await binaryOf(c, at);
    if (binary === undefined) {
      return c.server.mode === 'managed' ? 'Ollama is not installed on this instance yet: install it with ollama/install first.'
        : c.server.path === undefined ? 'No Ollama program was found on this machine: install Ollama, or set the config\'s `path`.' : `There is no program at ${c.server.path}.`;
    }
    return {
      binary, host: c.server.host, port: c.server.port, modelsDir: modelsDirOf(c, at.dataDir), cwd: at.dataDir,
      contextLength: c.server.contextLength, keepAlive: c.server.keepAlive,
    };
  }

  const detectParts = (): DetectParts => ({ platform: deps.machine.platform, env: deps.env, isFile: deps.isFile, version: versionAt });

  /** The installed models, read now (and kept), or the last known when the server doesn't answer. */
  async function readModels(c: OllamaConfig): Promise<InstalledModel[]> {
    const models = await installedModels({ api: deps.api(urlOf(c)), offered: c.offered, contextLength: c.server.mode === 'url' ? undefined : c.server.contextLength, maxContext: deps.maxContext });
    known = models;
    return models;
  }

  /** Send the provider's models when the offered ∩ installed set changed. */
  async function publish(): Promise<void> {
    const c = config;
    if (c === undefined || publisher === undefined) { return; }
    try { await readModels(c); } catch { /* the server doesn't answer: the last known models stand */ }
    const declared = declaredModels(known ?? [], c.offered);
    const next = JSON.stringify(declared);
    if (next === sent) { return; }
    await publisher(declared);
    sent = next;
    say('ollama.offered', { models: declared.map((m) => m.id) });
  }
  const publishQuietly = (): void => { void publish().catch((error: unknown) => { log?.warn('ollama.offer-failed', { error: error instanceof Error ? error.message : String(error) }); }); };
  server.onState((state) => { if (state === 'running') { publishQuietly(); } });

  /** Follow a config: run the server it describes (when it starts on its own) and offer its models. */
  async function follow(raw: unknown, at: SystemPlace, ctxLog: Log): Promise<void> {
    log = ctxLog;
    const next = configOf(raw);
    config = next;
    const spec = await specOf(next, at);
    if (typeof spec === 'string') {
      if (next.server.mode === 'url') { await server.stop(); }
    } else if (server.runs(spec)) {
      // already running as configured
    } else if ((next.server.mode !== 'url' && next.server.autoStart) || server.status().state === 'running') {
      await server.start(spec).catch((error: unknown) => { ctxLog.warn('ollama.start-failed', { error: error instanceof Error ? error.message : String(error) }); });
    } else {
      await server.stop();
    }
    await publish();
  }

  /** The status of this instance's server now. */
  async function statusOf(c: OllamaConfig, at: SystemPlace): Promise<OllamaStatus> {
    const url = urlOf(c);
    const [version, installed] = await Promise.all([versionAt(url), readInstall(at.dataDir)]);
    const run = server.status();
    const binary = c.server.mode === 'url' ? undefined : await binaryOf(c, at);
    const offered = declaredModels(known ?? [], c.offered).map((m) => m.id);
    return {
      instance: at.instance, mode: c.server.mode, state: c.server.mode === 'url' ? 'external' : run.state, url,
      ...(version === undefined ? {} : { version }), answering: version !== undefined,
      ...(run.pid === undefined ? {} : { pid: run.pid }), ...(run.since === undefined ? {} : { since: run.since }),
      restartsLastHour: run.restartsLastHour, ...(run.lastExit === undefined ? {} : { lastExit: { ...run.lastExit } }),
      ...(run.problem === undefined ? {} : { problem: run.problem }),
      ...(installed === undefined ? {} : { installed }), ...(binary === undefined ? {} : { binary }),
      ...(c.server.mode === 'url' ? {} : { modelsDir: modelsDirOf(c, at.dataDir) }),
      pulls: [...pulls.values()], offered, output: [...run.output],
    };
  }

  /** The release an install would use: the args', else the config's. */
  const versionFor = (args: InstallArgs, c: OllamaConfig): string => args.version ?? (c.server.mode === 'managed' ? c.server.version : 'latest');
  const managedOnly = (c: OllamaConfig): string | undefined => (c.server.mode === 'managed' ? undefined
    : `This instance's config uses ${c.server.mode === 'url' ? `the Ollama at ${c.server.url}` : 'an Ollama program already on this machine'}; install is for the \`managed\` mode.`);
  const sizeOf = (bytes: number | undefined): string => (bytes === undefined || bytes === 0 ? 'size unknown' : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

  const impl: SystemImpl<OllamaContract['defs']> = {
    providers: {
      server: (ctx) => {
        const c = configOf(ctx.config);
        return new OfferedOllamaProvider({
          baseURL: urlOf(c), offered: c.offered, maxContextWindow: deps.maxContext, fetch: deps.fetch,
          ...(c.server.mode !== 'url' && c.server.contextLength !== undefined ? { contextWindow: c.server.contextLength } : {}),
          ...(c.server.mode !== 'url' && c.server.keepAlive !== undefined ? { keepAlive: c.server.keepAlive } : {}),
        });
      },
    },
    fns: {
      status: {
        async run(_args, ctx) { return ctx.done(await statusOf(configOf(ctx.config), ctx)); },
      },
      detect: {
        async run(_args, ctx) {
          const c = configOf(ctx.config);
          return ctx.done(await detect(detectParts(), (await readInstall(ctx.dataDir))?.binary, [deps.defaultUrl, urlOf(c)]));
        },
      },
      install: {
        async run(raw, ctx) {
          const c = configOf(ctx.config);
          const args = InstallArgs.parse(raw);
          const wrong = managedOnly(c);
          if (wrong !== undefined) { return ctx.invalid(wrong); }
          const running = server.status().state === 'running';
          const outcome = await deps.installer.install({
            version: versionFor(args, c), force: args.force, dataDir: ctx.dataDir, cacheDir: ctx.cacheDir, prune: !running,
            progress: (fraction, message) => { ctx.progress.set(fraction, message); }, signal: ctx.signal,
          });
          ctx.log.info('ollama.installed', { version: outcome.install.version, asset: outcome.install.asset, checked: outcome.checked, already: outcome.already });
          return ctx.done({ version: outcome.install.version, binary: outcome.install.binary, asset: outcome.install.asset, checked: outcome.checked, already: outcome.already });
        },
        async preview(raw, ctx) {
          const c = configOf(ctx.config);
          const wrong = managedOnly(c);
          if (wrong !== undefined) { return { refused: wrong }; }
          const plan = await deps.installer.plan(versionFor(InstallArgs.parse(raw), c), ctx.dataDir, ctx.signal);
          const check = plan.checksum === 'none' ? 'The release publishes no sha-256 for it, so the download can\'t be checked.' : 'The download is checked against the sha-256 the release publishes before anything is unpacked.';
          return {
            preview: {
              title: plan.installed ? `Ollama ${plan.version} is installed already` : `Install Ollama ${plan.version} on ${ctx.instance}`,
              parts: [{ type: 'text', text: `Downloads \`${plan.asset.name}\` (${sizeOf(plan.asset.size)}) from Ollama's GitHub releases and unpacks it into \`${plan.into}\`, inside this instance's data folder; nothing is installed system-wide and nothing runs until it is started. ${check}` }],
              irreversible: false,
            },
          };
        },
      },
      start: {
        async run(_args, ctx) {
          const c = configOf(ctx.config);
          const spec = await specOf(c, ctx);
          if (typeof spec === 'string') { return ctx.invalid(spec); }
          try {
            await server.start(spec);
          } catch (error) {
            return ctx.fail('caller', error instanceof Error ? error.message : String(error), { code: 'NOT_STARTED' });
          }
          return ctx.done(await statusOf(c, ctx));
        },
        async preview(_raw, ctx) {
          const c = configOf(ctx.config);
          const spec = await specOf(c, ctx);
          if (typeof spec === 'string') { return { refused: spec }; }
          return {
            preview: {
              title: `Start Ollama on ${ctx.instance}`,
              parts: [{ type: 'text', text: `Runs \`${spec.binary} serve\` listening on ${spec.host}:${String(spec.port)}, with its models in \`${spec.modelsDir}\`. It is restarted if it crashes, until it is stopped.` }],
              irreversible: false,
            },
          };
        },
      },
      stop: {
        async run(_args, ctx) {
          const c = configOf(ctx.config);
          if (c.server.mode === 'url') { return ctx.invalid(`This instance uses the Ollama at ${c.server.url}, which runs on its own: it never starts or stops it.`); }
          await server.stop();
          return ctx.done(await statusOf(c, ctx));
        },
        preview(_raw, ctx) {
          const c = configOf(ctx.config);
          if (c.server.mode === 'url') { return Promise.resolve({ refused: `This instance uses the Ollama at ${c.server.url}, which runs on its own.` }); }
          return Promise.resolve({
            preview: { title: `Stop Ollama on ${ctx.instance}`, parts: [{ type: 'text', text: 'Chats using its models get no answers until it is started again.' }], irreversible: false },
          });
        },
      },
      models: {
        async run(_args, ctx) {
          const c = configOf(ctx.config);
          try {
            return ctx.done({ models: await readModels(c) });
          } catch {
            return ctx.fail('retry', `The Ollama at ${urlOf(c)} doesn't answer; see ollama/status.`, { code: 'NOT_ANSWERING' });
          }
        },
      },
      pull: {
        async run(raw, ctx) {
          const c = configOf(ctx.config);
          const model = taggedModel(ModelArgs.parse(raw).model);
          if (pulls.has(model)) { return ctx.invalid([{ path: 'model', message: `${model} is being pulled already; see ollama/status.` }]); }
          const layers = new Map<string, { total: number; completed: number }>();
          const started = deps.clock();
          pulls.set(model, { model, status: 'starting', completed: 0, total: 0, fraction: 0, startedAt: started });
          try {
            await deps.api(urlOf(c)).pull(model, (line) => {
              if (line.digest !== undefined && line.total !== undefined) { layers.set(line.digest, { total: line.total, completed: line.completed ?? 0 }); }
              let total = 0;
              let completed = 0;
              for (const layer of layers.values()) { total += layer.total; completed += Math.min(layer.completed, layer.total); }
              const fraction = total === 0 ? 0 : completed / total;
              pulls.set(model, { model, status: line.status, completed, total, fraction, startedAt: started });
              ctx.progress.set(line.status === 'success' ? 1 : Math.min(0.99, fraction), line.status);
            }, ctx.signal);
          } catch (error) {
            if (ctx.signal.aborted) { return ctx.cancelled(); }
            const message = error instanceof Error ? error.message : String(error);
            return /file does not exist|not found|manifest unknown/i.test(message)
              ? ctx.invalid([{ path: 'model', message: `Ollama has no model ${model}: ${message}` }])
              : ctx.fail('retry', message, { code: 'PULL_FAILED' });
          } finally {
            pulls.delete(model);
          }
          await publish().catch((error: unknown) => { ctx.log.warn('ollama.offer-failed', { error: error instanceof Error ? error.message : String(error) }); });
          const size = known?.find((m) => m.name === model)?.size;
          return ctx.done({ model, ...(size === undefined ? {} : { size }), offered: offerOf(c.offered, model) !== undefined });
        },
        preview(raw, ctx) {
          const c = configOf(ctx.config);
          const model = taggedModel(ModelArgs.parse(raw).model);
          return Promise.resolve({
            preview: {
              title: `Pull ${model} on ${ctx.instance}`,
              parts: [{ type: 'text', text: `Downloads ${model} from Ollama's registry to the Ollama at ${urlOf(c)}${c.server.mode === 'url' ? '' : `, into \`${modelsDirOf(c, ctx.dataDir)}\``}. Models are often several gigabytes. ${offerOf(c.offered, model) === undefined ? 'It is not offered to the chat until an admin offers it.' : 'It is offered to the chat once it is in.'}` }],
              irreversible: false,
            },
          });
        },
      },
      remove: {
        async run(raw, ctx) {
          const c = configOf(ctx.config);
          const model = taggedModel(ModelArgs.parse(raw).model);
          let removed: boolean;
          try {
            removed = await deps.api(urlOf(c)).remove(model);
          } catch (error) {
            return ctx.fail('retry', error instanceof Error ? error.message : String(error), { code: 'REMOVE_FAILED' });
          }
          if (!removed) { return ctx.invalid([{ path: 'model', message: `The Ollama at ${urlOf(c)} has no model ${model}.` }]); }
          await publish().catch((error: unknown) => { ctx.log.warn('ollama.offer-failed', { error: error instanceof Error ? error.message : String(error) }); });
          return ctx.done({ model, removed });
        },
        async preview(raw, ctx) {
          const c = configOf(ctx.config);
          const model = taggedModel(ModelArgs.parse(raw).model);
          const size = (known ?? await readModels(c).catch(() => [])).find((m) => m.name === model)?.size;
          return {
            preview: {
              title: `Remove ${model} from ${ctx.instance}`,
              parts: [{ type: 'text', text: `Deletes ${model}${size === undefined ? '' : ` (${sizeOf(size)})`} from the Ollama at ${urlOf(c)}. ${offerOf(c.offered, model) === undefined ? '' : 'It leaves the chat\'s model picker at once. '}Pull it again to get it back.` }],
              irreversible: false,
            },
          };
        },
      },
    },
    lifecycle: {
      started: (ctx) => follow(ctx.config, ctx, ctx.log),
      configured: (ctx) => follow(ctx.config, ctx, ctx.log),
      stopping: async () => { await server.stop(); },
    },
  };

  return {
    impl,
    async attach(publish_: PublishModels) {
      publisher = publish_;
      await publish();
    },
    async close() {
      await server.stop();
    },
  };
}
