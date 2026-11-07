/**
 * `startHub`: the hub process from settings to a listening port, and back down. The order, as `@ayepi/updown`
 * components (each stops after everything that depends on it):
 *
 *   log → store → plugins (web API and link plugins installed) → work (modules' queues)
 *       → http (the port) → links (system connections) → installed (systems the hub runs)
 *
 * Stopping drains in reverse: installed systems are asked to stop, connections are told the hub is shutting down,
 * the port stops taking requests, queues stop, plugins are uninstalled, the store closes, and the log flushes last.
 */
import { join } from 'node:path';
import { verifyJwt } from '@ayepi/auth/server';
import { peers, server, spec, type AnySpec, type Server } from '@ayepi/core';
import { fsFiles } from '@ayepi/files/fs';
import { mountFiles } from '@ayepi/files/server';
import type { Logger } from '@ayepi/log';
import { createPluginHost } from '@ayepi/plugin';
import { updown, type Component } from '@ayepi/updown';
import { mintId, systemLinkSpec, type ActorId, type SystemActor, SystemName } from '@harness/core';
import { ACCESS_TOKEN } from '../api/auth.ts';
import { FILES_PATH, HttpFront } from '../api/http.ts';
import { generateVapidKeys, WebPushSender, type PushSender } from '../api/push.ts';
import { ClientBuildRoute, WebAppRoute } from '../api/serve.ts';
import { NamedContentFiles } from '../api/files.ts';
import { first, PAGE } from '../api/paging.ts';
import { webPlugins } from '../api/web/index.ts';
import { MemoryEventBus } from '../bus/memory.ts';
import { JwtSystemTokens } from '../link/tokens.ts';
import type { HubStore } from '../store/index.ts';
import { parseHubSettings, type HubSettings } from './env.ts';
import { HUB_INFO, HUB_PACKAGE_DIR } from './info.ts';
import { loadKeys, randomSecret, type KeyMaker } from './keys.ts';
import { makeLogger } from './log.ts';
import { apiServices, assemble, type BaseServices } from './services.ts';
import { COMPONENTS, type ModuleBuild, type RunningHub, type StageHooks, type StartOptions } from './index.ts';

/** The signals that stop the hub (`SIGBREAK` is Ctrl+Break on Windows). */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

/** What `startHub` can be given beyond `StartOptions`, for tests. */
export interface StartSeams {
  readonly keyMaker?: KeyMaker;
  readonly pushSender?: PushSender;
}

/** The hub's own actor, made on first start. */
export async function ensureHubActor(store: HubStore, clock: () => number): Promise<ActorId> {
  const hub = SystemName.parse('hub');
  const found = await first((cursor) => store.table('actors').find({ where: { kind: 'system' }, limit: PAGE, cursor }), (actor) => actor.kind === 'system' && actor.system === hub);
  if (found !== undefined) { return found.id; }
  const actor: SystemActor = { id: mintId('actor'), kind: 'system', system: hub, name: HUB_INFO.name, about: 'The hub itself.', createdAt: clock(), disabled: false };
  await store.table('actors').insert(actor);
  return actor.id;
}

/** The web build folder: the setting, or `packages/web/dist` beside the hub package. */
export function webDist(settings: HubSettings): string {
  return settings.httpEnv.HARNESS_WEB_DIST === '' ? join(HUB_PACKAGE_DIR, '..', 'web', 'dist') : settings.httpEnv.HARNESS_WEB_DIST;
}

/** An empty ayepi server that plugins are installed into. */
function emptyServer(options: Parameters<typeof server>[2]): Server<AnySpec> {
  return server(spec({ endpoints: {} }), [], options);
}

/** The hooks every module gave for one lifecycle component, run in module order (and reverse to stop). */
function moduleHooks(builds: ReadonlyArray<ModuleBuild<unknown>>, stage: 'work' | 'links' | 'installed'): Required<StageHooks> {
  const hooks = builds.flatMap((build) => (build.hooks?.[stage] === undefined ? [] : [build.hooks[stage]]));
  return {
    up: async () => { for (const hook of hooks) { await hook.up?.(); } },
    pre: async () => { for (const hook of [...hooks].reverse()) { await hook.pre?.(); } },
    post: async () => { for (const hook of [...hooks].reverse()) { await hook.post?.(); } },
  };
}

/** When an access token expires (ms since the epoch), or undefined when it isn't one of the hub's. */
export function accessTokenExpiry(token: string, secret: string): number | undefined {
  try {
    const { exp } = verifyJwt(token, { secret, ...ACCESS_TOKEN });
    return exp === undefined ? undefined : exp * 1000;
  } catch {
    return undefined;
  }
}

/** Start a hub. */
export async function startHub(options: StartOptions & StartSeams): Promise<RunningHub> {
  const settings = options.settings ?? parseHubSettings();
  const clock = options.clock ?? Date.now;
  const log: Logger = options.log ?? makeLogger(settings, clock);
  const restoreConsole = options.log === undefined ? log.interceptConsole() : () => undefined;
  const bus = new MemoryEventBus((event, error) => { log.error('bus.listener.failed', { event }, error); });

  const store = await options.modules.store({
    // vector tables are sized by the embedder's declaration once the index knows it (`vectors.ensure`)
    file: settings.hubEnv.HARNESS_DB_FILE, now: clock, log,
    tuning: settings.storeEnv,
  });
  /** Once the lifecycle starts, stopping it closes the store and the log. */
  let lifecycleOwns = false;
  try {
    await store.migrate();
    const keys = await loadKeys(settings, options.keyMaker ?? { secret: randomSecret, vapid: generateVapidKeys });
    const hubActor = await ensureHubActor(store, clock);

    const web = emptyServer({ docs: settings.httpEnv.HARNESS_DOCS ? { info: { title: HUB_INFO.name, version: HUB_INFO.version } } : false, shed: {
      thresholdMs: settings.httpEnv.HARNESS_SHED_THRESHOLD, sustainedMs: settings.httpEnv.HARNESS_SHED_SUSTAINED, recoverMs: settings.httpEnv.HARNESS_SHED_RECOVER,
      response: () => Response.json({ error: { code: 'OVERLOADED', message: 'the hub is busy; try again shortly' } }, { status: 503, headers: { 'retry-after': '1' } }),
    } });
    const systems = peers(systemLinkSpec);
    const link = emptyServer({ peers: systems });
    const files = new NamedContentFiles(fsFiles({ dir: settings.hubEnv.HARNESS_FILES_DIR, onError: (error, op, key) => { log.warn('files.failed', { op, key }, error); } }));
    const mounted = mountFiles(web, files, { secret: keys.filesSecret, basePath: FILES_PATH, expiresIn: Math.round(settings.httpEnv.HARNESS_PRESIGN_TTL / 1000), now: clock });

    const base: BaseServices = { settings, log, clock, bus, store };
    const api = apiServices(base, { keys, files, presign: mounted.presign, pushSender: options.pushSender ?? new WebPushSender({ ...keys.vapid, subject: settings.pushEnv.HARNESS_VAPID_SUBJECT }) });
    const { hub, builds } = assemble(base, api, options.modules, {
      peers: systems, hubActor, systemTokens: new JwtSystemTokens({ secret: keys.jwtSecret, ttl: settings.authEnv.HARNESS_ACCESS_TTL }),
    });
    const modules = builds();

    const { HARNESS_ADMIN_EMAIL: email, HARNESS_ADMIN_PASSWORD: password } = settings.authEnv;
    if (email !== undefined && password !== undefined && await api.auth.bootstrap({ email, password })) {
      log.info('auth.admin.bootstrapped', { email });
    }

    const lc = updown({
      signals: options.signals === true ? SIGNALS : false, exit: options.signals === true, timeout: settings.httpEnv.HARNESS_SHUTDOWN_TIMEOUT,
      onError: (error, phase, component) => { log.error('lifecycle.failed', { phase, component }, error); },
    });
    const front = new HttpFront({
      web, link, health: { live: () => lc.isLive(), ready: () => lc.isReady() }, heartbeat: settings.httpEnv.HARNESS_WS_HEARTBEAT,
      tokenMargin: settings.httpEnv.HARNESS_WS_TOKEN_MARGIN, clock, log,
      files: [new ClientBuildRoute({ catalog: hub.catalog, content: api.content }), new WebAppRoute(webDist(settings))],
      tokenExpiry: (token) => accessTokenExpiry(token, keys.jwtSecret),
    });
    const onError = (error: unknown, phase: string, plugin: string): void => { log.warn('plugin.teardown.failed', { phase, plugin }, error); };
    const webHost = createPluginHost(web, { onError });
    const linkHost = createPluginHost(link, { onError });
    let port = options.port ?? settings.hubEnv.HARNESS_PORT;
    let sweeper: NodeJS.Timeout | undefined;
    const work = moduleHooks(modules, 'work');
    const links = moduleHooks(modules, 'links');
    const installed = moduleHooks(modules, 'installed');

    const components: readonly Component[] = [
      { name: COMPONENTS.log, post: async () => { restoreConsole(); if (options.log === undefined) { await log.close(); } } },
      { name: COMPONENTS.store, deps: [COMPONENTS.log], post: () => store.close() },
      {
        name: COMPONENTS.plugins, deps: [COMPONENTS.store],
        up: async () => {
          for (const plugin of webPlugins(hub, { secret: keys.jwtSecret })) { await webHost.install(plugin); }
          for (const plugin of modules.flatMap((m) => m.linkPlugins ?? [])) { await linkHost.install(plugin); }
        },
        post: async () => {
          await linkHost.shutdown();
          await webHost.shutdown();
        },
      },
      { name: COMPONENTS.work, deps: [COMPONENTS.plugins], ...work },
      {
        name: COMPONENTS.http, deps: [COMPONENTS.work],
        up: async () => {
          port = await front.listen(port, settings.hubEnv.HARNESS_HOST);
          sweeper = setInterval(() => {
            api.content.sweep().then((removed) => { if (removed > 0) { log.info('content.uploads.swept', { removed }); } }, (error: unknown) => {
              log.warn('content.uploads.sweep.failed', {}, error);
            });
          }, settings.httpEnv.HARNESS_PRESIGN_TTL);
          sweeper.unref();
          log.info('hub.listening', { port, host: settings.hubEnv.HARNESS_HOST, version: HUB_INFO.version });
        },
        pre: () => {
          clearInterval(sweeper);
          front.stopAccepting();
        },
        post: () => front.close(),
      },
      {
        name: COMPONENTS.links, deps: [COMPONENTS.http], up: links.up, post: links.post,
        pre: async () => {
          await hub.link.connections.stopAll('shutdown', settings.linkEnv.HARNESS_STOP_TIMEOUT);
          await links.pre();
        },
      },
      {
        name: COMPONENTS.installed, deps: [COMPONENTS.links], post: installed.post,
        up: async () => { await hub.link.supervisor.startAll(); await installed.up(); },
        pre: async () => { await installed.pre(); await hub.link.supervisor.stopAll('shutdown'); },
      },
    ];
    for (const component of components) { lc.register(component); }
    lifecycleOwns = true;
    try {
      await lc.up();
    } catch (error) {
      await lc.down();
      throw error;
    }
    const running: RunningHub = {
      services: hub,
      get port() { return port; },
      get url() { return `http://127.0.0.1:${port}`; },
      stop: async () => {
        log.info('hub.stopping', {});
        await lc.down();
      },
    };
    return running;
  } catch (error) {
    if (!lifecycleOwns) {
      await store.close().catch(() => undefined);
      restoreConsole();
      if (options.log === undefined) { await log.close().catch(() => undefined); }
    }
    throw error;
  }
}

