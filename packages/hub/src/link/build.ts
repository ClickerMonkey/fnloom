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
import { StoreCatalog, type CatalogOptions } from '../catalog/catalog.ts';
import type { Catalog, KindDescriber } from '../catalog/index.ts';
import { EmbedBatcher } from '../index/batch.ts';
import { SystemEmbedders, type HubEmbeds } from '../index/embedders.ts';
import { ImageEmbeddingSettings } from '../index/image-setting.ts';
import { OfferedProviders, offeredBy } from '../models/remote.ts';
import type { IndexTuning } from '../index/env.ts';
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
import { LinkHandshake, linkPlugin } from './handlers.ts';
import type { SystemTokens } from './index.ts';
import type { PackagingEnv, ReviewEnv } from './env.ts';
import { SystemGrantGuard } from './grants.ts';
import { SystemLifecycle } from './lifecycle.ts';
import { migrateApiServices } from './migrate-api.ts';
import { migrateLegacyInstances } from './migrate.ts';
import { contentBytes, HubPackages, type PackageContent } from './packages.ts';
import { StoreAutoPairs } from './auto-pair.ts';
import { PairingLimits, StorePairingService } from './pairing.ts';
import { LinkGate } from './gate.ts';
import { clientAddress } from '../api/client-address.ts';
import type { ProcessStarter } from '@harness/sdk/server';
import { NodeInstaller, type Installer } from './process.ts';
import { FleetRouter } from './router.ts';
import { MemorySystemOutput } from './output.ts';
import { PeerResourceRouter } from './resources.ts';
import { InstanceKeeper } from './status.ts';
import { ConfigSecretKeeper, type ConfigVault } from './config-secrets.ts';
import { ProcessSupervisor, grantedNetwork } from './supervisor.ts';
import { StoreSystemAdmin } from './systems.ts';

/** The settings the system side reads, from the env slices. */
export interface SystemsSettings {
  readonly hub: Pick<HubSettings['hubEnv'], 'HARNESS_URL' | 'HARNESS_SYSTEMS_DIR'>;
  readonly link: HubSettings['linkEnv'];
  readonly packaging: PackagingEnv;
  readonly model: Pick<HubSettings['modelEnv'], 'HARNESS_EMBEDDER_DOCUMENT' | 'HARNESS_EMBEDDER_QUERY' | 'HARNESS_EMBED_BATCH'>;
  readonly index: IndexTuning;
  readonly search: Pick<StoreTuning, 'HARNESS_SEARCH_RRF_K' | 'HARNESS_SEARCH_DEPTH'>;
  readonly review: ReviewEnv;
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
  readonly launcher: ProcessStarter;
  /** How systems are fetched (default: npm, git and package zips from `content`). */
  readonly installer?: Installer;
  /** The hub's content store, where uploaded package zips and data exports live (looked up when used). */
  readonly content: () => PackageContent;
  /** The hub's secrets, where config secret fields are sealed (the api module's, looked up when used). */
  readonly secrets: () => ConfigVault;
  /** The typed callers of connected systems, shared with the hub link server (default a new registry). */
  readonly peers?: Peers<SystemLinkSpec>;
  /** Replace the catalog (tests); default the store catalog with kinds described over the link. */
  readonly catalog?: (describer: KindDescriber) => Catalog;
  /** The hub's AI the index embeds through (the execution module's LLM gateway, looked up when used). */
  readonly ai?: () => HubEmbeds | undefined;
  /** Plan item 7: whether a hub model role has a model set, for fns that need one (`CatalogOptions.roleSet`). */
  readonly roleSet?: CatalogOptions['roleSet'];
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
  // every kind is described by its system over the link (the hub's own kinds need no description)
  const describer = new LinkKindDescriber(connections);
  const catalog: Catalog = options.catalog?.(describer) ?? new StoreCatalog({ store, bus, log, clock, describer, ...(options.roleSet === undefined ? {} : { roleSet: options.roleSet }) });
  const instances = new InstanceKeeper({ store, bus, catalog, links: connections });
  const configSecrets = new ConfigSecretKeeper(options.secrets);
  const autoPairs = new StoreAutoPairs({
    store, log, clock, rate: store.ports.rate, limit: settings.packaging.HARNESS_AUTO_PAIR_LIMIT, window: settings.packaging.HARNESS_AUTO_PAIR_WINDOW,
    expiry: settings.packaging.HARNESS_AUTO_PAIR_EXPIRY,
  });
  const lifecycle = new SystemLifecycle({ store, catalog, bus, log, clock, settings: settings.review, resources: () => resources });
  const pairing = new StorePairingService({
    firstStage: () => lifecycle.firstStage, keepChecks: (system, checks) => lifecycle.setChecks(system, checks),
    store, bus, log, clock, instances, autoPairs, timeout: settings.link.HARNESS_PAIRING_TIMEOUT, publicUrl: settings.packaging.HARNESS_PUBLIC_URL,
    grantTtl: settings.link.HARNESS_PAIRING_GRANT_TTL, fn: (name) => catalog.fn(name),
    check: (system, type, value) => catalog.check(system, type, value),
    configType: async (system) => (await catalog.manifest(system))?.config,
    configSecrets: async (system) => (await catalog.manifest(system))?.configSecrets, secrets: configSecrets,
  });
  const config = new StoreConfigService({ log, clock, catalog, bus, links: connections, instances, secrets: configSecrets });
  const resources = new PeerResourceRouter({ links: connections, catalog, bus, log, maxChunk: settings.link.HARNESS_MAX_CHUNK });
  const admin = new StoreSystemAdmin({ store, log, catalog, links: connections, instances, autoPairs, stopTimeout: settings.link.HARNESS_STOP_TIMEOUT });
  const grants = new SystemGrantGuard({ store, catalog, bus, log, clock, admin: () => admin, settings: settings.review });
  const router = new FleetRouter({ links: connections, resources, store, instances });
  const installer = options.installer ?? new NodeInstaller({
    npm: settings.packaging.HARNESS_NPM, maxBytes: settings.packaging.HARNESS_PACKAGE_MAX, zips: { bytes: (hash) => contentBytes(options.content(), hash) },
  });
  const relay = new SystemEventRelay({ bus, links: connections, catalog, log });
  const output = new MemorySystemOutput({ bus, clock });
  const supervisor = new ProcessSupervisor({
    store, log, clock, links: connections, pairing, config, instances, launcher: options.launcher, installer, network: grantedNetwork(grants, bus),
    settings: {
      systemsDir: settings.hub.HARNESS_SYSTEMS_DIR, hubLink: linkUrl(settings.hub.HARNESS_URL), stopTimeout: settings.link.HARNESS_STOP_TIMEOUT,
      backoff: settings.link.HARNESS_RESTART_BACKOFF, perHour: settings.link.HARNESS_RESTARTS_PER_HOUR, maxBackoff: settings.link.HARNESS_RESTART_BACKOFF_MAX,
    },
  });

  // the index embeds with the embedding models of the providers systems offer, by the same rule as the hub AI's providers
  const offered = new OfferedProviders({ link: connections, catalog, bus, log, offered: offeredBy(lifecycle) });
  // where images are embedded: the admin's setting, which the embedders read at each refresh
  const images: ImageEmbeddingSettings = new ImageEmbeddingSettings({ store, clock, document, embedders: () => embedders });
  const embedders: SystemEmbedders = new SystemEmbedders({
    offered, connections, bus, log, document, query, batch: settings.model.HARNESS_EMBED_BATCH, ai: () => options.ai?.(),
    imageSetting: () => images.value(),
  });
  const batcher = new EmbedBatcher({
    embedders, log, size: settings.model.HARNESS_EMBED_BATCH, wait: settings.index.HARNESS_EMBED_WAIT, poll: settings.index.HARNESS_EMBED_POLL,
    concurrency: { interactive: settings.index.HARNESS_EMBED_INTERACTIVE, background: settings.index.HARNESS_EMBED_BACKGROUND },
  });
  const sectioning = new Sectioning({ store, catalog, router: resources });
  const indexer = new StoreIndexer({ store, bus, log, clock, catalog, embedders, batcher, router: resources, sectioning, document, maxText: settings.index.HARNESS_INDEX_MAX_TEXT, maxCrawl: settings.index.HARNESS_INDEX_CRAWL_MAX,
    chunk: settings.index.HARNESS_INDEX_EMBED_BATCH,
    retry: { first: settings.index.HARNESS_INDEX_RETRY, most: settings.index.HARNESS_INDEX_RETRY_MOST }, maxPicture: settings.index.HARNESS_INDEX_IMAGE_MAX,
  });
  const hybrid = new HybridSearch({ vectors: store.vectors, text: store.text }, settings.search);
  const search = new IndexSearch({ store, hybrid, embedders, batcher, log, document, overfetch: settings.index.HARNESS_SEARCH_OVERFETCH, embedWait: settings.index.HARNESS_SEARCH_EMBED_WAIT });
  const suggest = new IndexSuggester({ store, catalog, search });

  const packages = new HubPackages({
    content: options.content, supervisor, admin, instances, links: connections, config, exportTimeout: settings.link.HARNESS_STOP_TIMEOUT, log, clock,
    maxBytes: settings.packaging.HARNESS_PACKAGE_MAX,
  });

  // where a socket comes from, by the admin's proxy setting, for the pairing limits and the socket caps
  const address = (req: Request): Promise<string> => clientAddress(req, store);
  const pairingLimits = new PairingLimits({
    perAddress: settings.link.HARNESS_PAIRING_LIMIT, total: settings.link.HARNESS_PAIRING_LIMIT_TOTAL, window: settings.link.HARNESS_PAIRING_WINDOW, clock, log, rate: store.ports.rate,
  });
  const gate = new LinkGate({
    log, peers: connections.peers, address, perAddress: settings.link.HARNESS_LINK_UNLINKED_PER_ADDRESS, total: settings.link.HARNESS_LINK_UNLINKED_MAX,
    helloTimeout: settings.link.HARNESS_LINK_HELLO_TIMEOUT, linkTimeout: settings.link.HARNESS_PAIRING_TIMEOUT,
  });
  const handshake = new LinkHandshake({
    log, clock, catalog, links: connections, pairing, autoPairs, config, instances, tokens, resources, output, lifecycle, grants, bus, address, pairingLimits, gate,
    limits: { maxFrame: settings.link.HARNESS_MAX_FRAME, maxChunk: settings.link.HARNESS_MAX_CHUNK, heartbeat: settings.link.HARNESS_HEARTBEAT },
  });

  let stopIndexer: (() => void) | undefined;
  let stopOutput: (() => void) | undefined;
  return {
    catalog, connections, pairing, autoPairs, config, instances, resources, admin, relay, supervisor, packages, router, handshake, output, lifecycle, grants, gate,
    index: { embedders, indexer, search, suggest, sectioning, batcher, images },
    /** The link plugin to install on the hub link server. */
    plugin: linkPlugin(handshake, { log, clock }),
    /**
     * Move build 1's single-instance system rows onto instances, then the per-service api instances onto service
     * records of the one api instance (before systems connect).
     */
    async migrate(): Promise<number> {
      const instances = await migrateLegacyInstances(store, log);
      const api = await migrateApiServices({ store, vault: options.secrets, log, clock });
      return instances + api.services + api.removed;
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
