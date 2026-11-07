/**
 * Wiring the hub's system side: the catalog, the link (connections, pairing, config, status, admin switches,
 * resources, event relay, supervisor, handshake) and the index (embedders, batches, sectioning, indexer, search,
 * suggestions). Boot calls `buildSystems` once with the store, bus, logger and the parsed env slices, installs
 * `plugin` on the hub link server made with `{ peers: connections.peers }`, calls `start()` once the server is up
 * (and `supervisor.startAll()`), and `stop()` on the way down. Tests build the same thing over fakes.
 */
import type { Logger } from '@ayepi/log';
import { QualifiedName } from '@harness/core';
import type { HubSettings } from '../boot/env.ts';
import type { EventBus } from '../bus.ts';
import { StoreCatalog } from '../catalog/catalog.ts';
import type { Catalog } from '../catalog/index.ts';
import { EmbedBatcher } from '../index/batch.ts';
import { IndexEmbedding } from '../index/embedding.ts';
import { SystemEmbedders } from '../index/embedders.ts';
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
import { LinkHandshake, linkPlugin, type LinkEmbedding } from './handlers.ts';
import type { SystemTokens } from './index.ts';
import { StorePairingService } from './pairing.ts';
import type { Installer, ProcessLauncher } from './process.ts';
import { PeerResourceRouter } from './resources.ts';
import { SystemStatusKeeper } from './status.ts';
import { ProcessSupervisor } from './supervisor.ts';
import { StoreSystemAdmin } from './systems.ts';

/** The settings the system side reads, from the env slices. */
export interface SystemsSettings {
  readonly hub: Pick<HubSettings['hubEnv'], 'HARNESS_URL' | 'HARNESS_SYSTEMS_DIR'>;
  readonly link: HubSettings['linkEnv'];
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
  readonly installer: Installer;
  /** Replace how systems' embed requests are answered (tests); default the index's document embedder. */
  readonly embedding?: LinkEmbedding;
  /** Replace the catalog (tests); default the store catalog with kinds described over the link. */
  readonly catalog?: (describer: LinkKindDescriber) => Catalog;
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

  const connections = new PeerLinkService({ log, clock });
  const describer = new LinkKindDescriber(connections);
  const catalog = options.catalog?.(describer) ?? new StoreCatalog({ store, bus, log, clock, describer });
  const status = new SystemStatusKeeper({ store, bus, catalog, links: connections });
  const pairing = new StorePairingService({ store, bus, log, clock, url: settings.hub.HARNESS_URL, timeout: settings.link.HARNESS_PAIRING_TIMEOUT });
  const config = new StoreConfigService({ store, log, clock, catalog, links: connections, status });
  const resources = new PeerResourceRouter({ links: connections, catalog, bus, log, maxChunk: settings.link.HARNESS_MAX_CHUNK });
  const admin = new StoreSystemAdmin({ store, log, catalog, links: connections, status, stopTimeout: settings.link.HARNESS_STOP_TIMEOUT });
  const relay = new SystemEventRelay({ bus, links: connections, catalog, log });
  const supervisor = new ProcessSupervisor({
    store, log, clock, links: connections, pairing, config, status, launcher: options.launcher, installer: options.installer,
    settings: {
      systemsDir: settings.hub.HARNESS_SYSTEMS_DIR, hubLink: linkUrl(settings.hub.HARNESS_URL), stopTimeout: settings.link.HARNESS_STOP_TIMEOUT,
      backoff: settings.link.HARNESS_RESTART_BACKOFF, perHour: settings.link.HARNESS_RESTARTS_PER_HOUR,
    },
  });

  const embedders = new SystemEmbedders({ catalog, links: connections, bus, log, document, query, batch: settings.model.HARNESS_EMBED_BATCH });
  const batcher = new EmbedBatcher({ embedders, size: settings.model.HARNESS_EMBED_BATCH, wait: settings.index.HARNESS_EMBED_WAIT, poll: settings.index.HARNESS_EMBED_POLL });
  const sectioning = new Sectioning({ store, catalog, router: resources });
  const indexer = new StoreIndexer({ store, bus, log, clock, catalog, embedders, batcher, router: resources, sectioning, document, maxText: settings.index.HARNESS_INDEX_MAX_TEXT });
  const hybrid = new HybridSearch({ vectors: store.vectors, text: store.text }, settings.search);
  const search = new IndexSearch({ store, hybrid, embedders, batcher, log, document, overfetch: settings.index.HARNESS_SEARCH_OVERFETCH });
  const suggest = new IndexSuggester({ store, catalog, search });

  const handshake = new LinkHandshake({
    store, log, clock, catalog, links: connections, pairing, config, status, tokens, resources,
    embedding: options.embedding ?? new IndexEmbedding({ embedders, batcher, catalog }),
    limits: { maxFrame: settings.link.HARNESS_MAX_FRAME, maxChunk: settings.link.HARNESS_MAX_CHUNK, heartbeat: settings.link.HARNESS_HEARTBEAT },
  });

  let stopIndexer: (() => void) | undefined;
  return {
    catalog, connections, pairing, config, status, resources, admin, relay, supervisor, handshake,
    index: { embedders, indexer, search, suggest, sectioning, batcher },
    /** The link plugin to install on the hub link server. */
    plugin: linkPlugin(handshake),
    /** Start following the bus (indexing) and the embedders. */
    start(): void {
      stopIndexer ??= indexer.start();
      void embedders.refresh();
    },
    /** Stop installed systems, ask the rest to stop, and stop the index's work. */
    async stop(): Promise<void> {
      await supervisor.stopAll('shutdown');
      await connections.stopAll('shutdown', settings.link.HARNESS_STOP_TIMEOUT);
      stopIndexer?.();
      relay.stop();
      await batcher.stop();
    },
  };
}

/** The built system side. */
export type HubSystems = ReturnType<typeof buildSystems>;
