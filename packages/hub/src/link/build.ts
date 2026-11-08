/**
 * Wiring the hub's system side: the catalog, the link (connections, pairing, config, status, admin switches,
 * resources, event relay, supervisor, handshake) and the index (embedders, batches, sectioning, indexer, search,
 * suggestions). Boot calls `buildSystems` once with the store, bus, logger and the parsed env slices, installs
 * `plugin` on the hub link server made with `{ peers: connections.peers }`, calls `start()` once the server is up
 * (and `supervisor.startAll()`), and `stop()` on the way down. Tests build the same thing over fakes.
 */
import type { Logger } from '@ayepi/log';
import type { Peers } from '@ayepi/core';
import { QualifiedName, type SystemLinkSpec } from '@harness/core';
import type { HubSettings } from '../boot/env.ts';
import type { EventBus } from '../bus.ts';
import { StoreCatalog } from '../catalog/catalog.ts';
import type { Catalog } from '../catalog/index.ts';
import { EmbedBatcher } from '../index/batch.ts';
import { IndexEmbedding } from '../index/embedding.ts';
import { SystemEmbedders } from '../index/embedders.ts';
import type { IndexTuning } from '../index/env.ts';
import type { ModelCallLog } from '../metrics/index.ts';
import { StoreIndexer } from '../index/indexer.ts';
import { IndexSearch } from '../index/search.ts';
import { Sectioning } from '../index/sectioning.ts';
import { IndexSuggester } from '../index/suggester.ts';
import type { StoreTuning } from '../store/env.ts';
import { HybridSearch } from '../store/hybrid.ts';
import type { HubStore } from '../store/index.ts';
import { StoreConfigService } from './config.ts';
import { PeerLinkService } from './connections.ts';
import { LinkKindDescriber } from './describer.ts';
import { SystemEventRelay } from './events.ts';
import { LinkHandshake, linkPlugin, type LinkEmbedding } from './handlers.ts';
import type { SystemTokens } from './index.ts';
import type { PackagingEnv } from './env.ts';
import { migrateLegacyInstances } from './migrate.ts';
import { contentBytes, HubPackages, type PackageContent } from './packages.ts';
import { StorePairingService } from './pairing.ts';
import { NodeInstaller, type Installer, type ProcessLauncher } from './process.ts';
import { FleetRouter } from './router.ts';
import { MemorySystemOutput } from './output.ts';
import { PeerResourceRouter } from './resources.ts';
import { InstanceKeeper } from './status.ts';
import { ProcessSupervisor } from './supervisor.ts';
import { StoreSystemAdmin } from './systems.ts';

/** The settings the system side reads, from the env slices. */
export interface SystemsSettings {
  readonly hub: Pick<HubSettings['hubEnv'], 'HARNESS_URL' | 'HARNESS_SYSTEMS_DIR'>;
  readonly link: HubSettings['linkEnv'];
  readonly packaging: PackagingEnv;
  readonly model: Pick<HubSettings['modelEnv'], 'HARNESS_EMBEDDER_DOCUMENT' | 'HARNESS_EMBEDDER_QUERY' | 'HARNESS_EMBED_BATCH'>;
  readonly index: IndexTuning;
  readonly search: Pick<StoreTuning, 'HARNESS_SEARCH_RRF_K' | 'HARNESS_SEARCH_DEPTH'>;
}

/** What the system side is built from. */
export interface SystemsOptions {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  readonly settings: SystemsSettings;
  /** Signs the HTTP tokens systems get in their welcome. */
  readonly tokens: SystemTokens;
  readonly launcher: ProcessLauncher;
  /** How systems are fetched (default: npm, git and package zips from `content`). */
  readonly installer?: Installer;
  /** The hub's content store, where uploaded package zips and data exports live (looked up when used). */
  readonly content: () => PackageContent;
  /** The typed callers of connected systems, shared with the hub link server (default a new registry). */
  readonly peers?: Peers<SystemLinkSpec>;
  /** Replace how systems' embed requests are answered (tests); default the index's document embedder. */
  readonly embedding?: LinkEmbedding;
  /** Replace the catalog (tests); default the store catalog with kinds described over the link. */
  readonly catalog?: (describer: LinkKindDescriber) => Catalog;
  /** Where embed calls to system embedders are recorded (the metrics module's log, looked up when used). */
  readonly calls?: () => Pick<ModelCallLog, 'begin'>;
}

/** The link URL systems connect to, from the hub's public URL. */
export function linkUrl(hubUrl: string): string {
  const url = new URL('/link', hubUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Build the catalog, link and index services, wired to each other. */
export function buildSystems(options: SystemsOptions) {
  const { store, bus, log, clock, settings, tokens } = options;
  const document = QualifiedName.parse(settings.model.HARNESS_EMBEDDER_DOCUMENT);
  const query = QualifiedName.parse(settings.model.HARNESS_EMBEDDER_QUERY);

  const connections = new PeerLinkService({ log, clock, ...(options.peers === undefined ? {} : { peers: options.peers }) });
  const describer = new LinkKindDescriber(connections);
  const catalog = options.catalog?.(describer) ?? new StoreCatalog({ store, bus, log, clock, describer });
  const instances = new InstanceKeeper({ store, bus, catalog, links: connections });
  const pairing = new StorePairingService({
    store, bus, log, clock, instances, timeout: settings.link.HARNESS_PAIRING_TIMEOUT, publicUrl: settings.packaging.HARNESS_PUBLIC_URL,
    check: (system, type, value) => catalog.check(system, type, value),
    configType: async (system) => (await catalog.manifest(system))?.config,
  });
  const config = new StoreConfigService({ log, clock, catalog, bus, links: connections, instances });
  const resources = new PeerResourceRouter({ links: connections, catalog, bus, log, maxChunk: settings.link.HARNESS_MAX_CHUNK });
  const admin = new StoreSystemAdmin({ store, log, catalog, links: connections, instances, stopTimeout: settings.link.HARNESS_STOP_TIMEOUT });
  const router = new FleetRouter({ links: connections, resources, store, instances });
  const installer = options.installer ?? new NodeInstaller({
    npm: settings.packaging.HARNESS_NPM, maxBytes: settings.packaging.HARNESS_PACKAGE_MAX, zips: { bytes: (hash) => contentBytes(options.content(), hash) },
  });
  const relay = new SystemEventRelay({ bus, links: connections, catalog, log });
  const output = new MemorySystemOutput({ bus, clock });
  const supervisor = new ProcessSupervisor({
    store, log, clock, links: connections, pairing, config, instances, launcher: options.launcher, installer,
    settings: {
      systemsDir: settings.hub.HARNESS_SYSTEMS_DIR, hubLink: linkUrl(settings.hub.HARNESS_URL), stopTimeout: settings.link.HARNESS_STOP_TIMEOUT,
      backoff: settings.link.HARNESS_RESTART_BACKOFF, perHour: settings.link.HARNESS_RESTARTS_PER_HOUR,
    },
  });

  const embedders = new SystemEmbedders({
    catalog, links: connections, bus, log, clock, document, query, batch: settings.model.HARNESS_EMBED_BATCH, ...(options.calls === undefined ? {} : { calls: options.calls }),
  });
  const batcher = new EmbedBatcher({
    embedders, log, size: settings.model.HARNESS_EMBED_BATCH, wait: settings.index.HARNESS_EMBED_WAIT, poll: settings.index.HARNESS_EMBED_POLL,
    concurrency: { interactive: settings.index.HARNESS_EMBED_INTERACTIVE, background: settings.index.HARNESS_EMBED_BACKGROUND },
  });
  const sectioning = new Sectioning({ store, catalog, router: resources });
  const indexer = new StoreIndexer({ store, bus, log, clock, catalog, embedders, batcher, router: resources, sectioning, document, maxText: settings.index.HARNESS_INDEX_MAX_TEXT, maxCrawl: settings.index.HARNESS_INDEX_CRAWL_MAX,
    // a chunk fills every background batch running at once
    chunk: settings.model.HARNESS_EMBED_BATCH * settings.index.HARNESS_EMBED_BACKGROUND,
    retry: { first: settings.index.HARNESS_INDEX_RETRY, most: settings.index.HARNESS_INDEX_RETRY_MOST },
  });
  const hybrid = new HybridSearch({ vectors: store.vectors, text: store.text }, settings.search);
  const search = new IndexSearch({ store, hybrid, embedders, batcher, log, document, overfetch: settings.index.HARNESS_SEARCH_OVERFETCH, embedWait: settings.index.HARNESS_SEARCH_EMBED_WAIT });
  const suggest = new IndexSuggester({ store, catalog, search });

  const packages = new HubPackages({
    content: options.content, supervisor, admin, instances, links: connections, exportTimeout: settings.link.HARNESS_STOP_TIMEOUT, log, clock,
    maxBytes: settings.packaging.HARNESS_PACKAGE_MAX,
  });

  const handshake = new LinkHandshake({
    log, clock, catalog, links: connections, pairing, config, instances, tokens, resources, output,
    embedding: options.embedding ?? new IndexEmbedding({ embedders, batcher, catalog }),
    limits: { maxFrame: settings.link.HARNESS_MAX_FRAME, maxChunk: settings.link.HARNESS_MAX_CHUNK, heartbeat: settings.link.HARNESS_HEARTBEAT },
  });

  let stopIndexer: (() => void) | undefined;
  let stopOutput: (() => void) | undefined;
  return {
    catalog, connections, pairing, config, instances, resources, admin, relay, supervisor, packages, router, handshake, output,
    index: { embedders, indexer, search, suggest, sectioning, batcher },
    /** The link plugin to install on the hub link server. */
    plugin: linkPlugin(handshake, { log, clock }),
    /** Move build 1's single-instance system rows onto instances (before systems connect). */
    migrate(): Promise<number> {
      return migrateLegacyInstances(store, log);
    },
    /** Start following the bus (indexing) and the embedders. */
    start(): void {
      stopIndexer ??= indexer.start();
      stopOutput ??= output.start();
      void embedders.refresh();
    },
    /** Stop installed systems, ask the rest to stop, and stop the index's work. */
    async stop(): Promise<void> {
      await supervisor.stopAll('shutdown');
      await connections.stopAll('shutdown', settings.link.HARNESS_STOP_TIMEOUT);
      stopIndexer?.();
      stopOutput?.();
      relay.stop();
      await batcher.stop();
    },
  };
}

/** The built system side. */
export type HubSystems = ReturnType<typeof buildSystems>;
