/**
 * The hub's side of the system link for what this module answers: the handshake (`hello`, `prove`), the contract
 * (`manifest`, `patch`), resources (`resource`, `resourcesChanged`), embeddings (`embed`) and logs (`log`), plus
 * the `linkSession` guard every endpoint after the handshake runs behind. `linkPlugin` packages them as an
 * `@ayepi/plugin` over `LINK_SPEC` (this module's slice of `hubLinkSpec`; it binds `linkSession` once for every
 * slice); boot installs it on the hub link server, which must be made with `{ peers: PeerLinkService.peers }`.
 *
 * The handshake: `hello` from a known name with its paired key gets a nonce to sign; anything else starts pairing.
 * `prove` checks the signature, makes the socket the system's connection, and welcomes it with its config, why it
 * is starting, an HTTP token, whether to send its manifest, and the link's limits.
 */
import { reject as refuse, spec, type HandlerFor, type ImplFor, type WsConn } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, linkSession, type Hello, type LinkLimits, type LinkSession, type Welcome } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { StoreConfigService } from './config.ts';
import type { PeerLinkService } from './connections.ts';
import type { ResourceRouter, SystemTokens } from './index.ts';
import { fingerprint, isPublicKey, randomToken, verifyNonce } from './keys.ts';
import type { StorePairingService } from './pairing.ts';
import type { SystemStatusKeeper } from './status.ts';

const endpoints = hubLinkSpec.endpoints;

/** The slice of `hubLinkSpec` this module answers: the same endpoint objects, so its types are the spec's. */
export const LINK_SPEC = spec({
  endpoints: {
    hello: endpoints.hello, prove: endpoints.prove, manifest: endpoints.manifest, patch: endpoints.patch,
    resourcesChanged: endpoints.resourcesChanged, resource: endpoints.resource, embed: endpoints.embed, log: endpoints.log,
  },
});
export type LinkSpec = typeof LINK_SPEC;
export type LinkEndpoint = keyof LinkSpec['endpoints'];

/** The handlers for those endpoints. */
export type LinkHandlers = { [K in LinkEndpoint]: HandlerFor<LinkSpec, LinkSpec['endpoints'][K]> };

/** Embeddings for systems that ask the hub (`ctx.embed`): the index's document embedder. */
export interface LinkEmbedding {
  embed(texts: readonly string[], signal?: AbortSignal): Promise<{ vectors: number[][]; cost: number }>;
}

/** What the handshake and its handlers need. */
export interface LinkHandlerOptions {
  readonly store: HubStore;
  readonly log: Logger;
  readonly clock: () => number;
  readonly catalog: Catalog;
  readonly links: PeerLinkService;
  readonly pairing: StorePairingService;
  readonly config: StoreConfigService;
  readonly status: SystemStatusKeeper;
  readonly tokens: SystemTokens;
  readonly resources: ResourceRouter;
  readonly embedding: LinkEmbedding;
  readonly limits: LinkLimits;
}

/** Where a socket came from, as far as its upgrade request says. */
export function addressOf(conn: WsConn): string {
  return conn.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? conn.req.headers.get('x-real-ip') ?? new URL(conn.req.url).host;
}

/** The handshake and the hub link handlers of this module. */
export class LinkHandshake {
  readonly #options: LinkHandlerOptions;
  /** Sockets that said hello with a known key and were sent a nonce. */
  readonly #challenges = new Map<WsConn, { hello: Hello; nonce: string }>();

  constructor(options: LinkHandlerOptions) {
    this.#options = options;
    options.links.peers.onClose((peer) => void this.#challenges.delete(peer.conn));
    options.links.onChange((change) => {
      if (change.connected) { return; }
      options.status.sync(change.system, { lastSeenAt: options.clock() }).catch((error: unknown) => {
        options.log.error('link.disconnect.sync.failed', { system: change.system, error: messageOf(error) });
      });
    });
  }

  /** The `linkSession` guard: refuses a socket that hasn't finished the handshake, and gives handlers `link`. */
  readonly guard: ImplFor<typeof linkSession> = async (io) => {
    const conn = io.ws?.conn;
    const session = conn === undefined ? undefined : this.#options.links.session(conn);
    if (session === undefined) { throw refuse(401, 'NOT_LINKED', 'say hello and prove your key first'); }
    return io.next({ link: session });
  };

  /** The handlers, to install on the hub link server. */
  handlers(): LinkHandlers {
    const { catalog, resources, embedding, log } = this.#options;
    return {
      hello: ({ data, conn }) => this.#hello(data, conn),
      prove: ({ data, conn }) => this.#prove(data.signature, conn),
      manifest: async ({ data, link }) => {
        if (data.name !== link.system) { throw refuse(403, 'WRONG_SYSTEM', `this link is ${link.system}, not ${data.name}`); }
        const report = await catalog.importManifest(data);
        await this.#contractChanged(link, report.refused.length === 0 ? data.hash : '', { description: data.description, version: data.version });
        if (data.resources) { await resources.refresh(link.system); }
        return report;
      },
      patch: async ({ data, link }) => {
        const report = await catalog.importPatch(link.system, data);
        await this.#contractChanged(link, report.refused.length === 0 ? data.hash : '', {});
        return report;
      },
      resourcesChanged: ({ data, link }) => { resources.changed(link.system, data.changes); },
      resource: ({ data, signal }) => resources.read(data.uri, data.want, signal),
      embed: ({ data, signal }) => embedding.embed(data.texts, signal),
      log: ({ data, link }) => { log.log(data.level, data.key, { system: link.system, instance: link.instance, ...data.fields }); },
    };
  }

  async #hello(hello: Hello, conn: WsConn | undefined): Promise<Awaited<ReturnType<LinkHandlers['hello']>>> {
    const peer = conn === undefined ? undefined : this.#options.links.peer(conn);
    if (conn === undefined || peer === undefined) { throw refuse(400, 'NOT_A_LINK', 'hello must come over the link socket'); }
    if (!isPublicKey(hello.publicKey)) { throw refuse(400, 'BAD_KEY', 'the public key must be Ed25519, SPKI DER in base64'); }
    const record = await this.#options.store.table('systems').get(hello.name);
    if (record !== undefined && record.status !== 'removed' && record.keyFingerprint === fingerprint(hello.publicKey)) {
      const nonce = randomToken();
      this.#challenges.set(conn, { hello, nonce });
      return { kind: 'challenge', nonce };
    }
    return this.#options.pairing.start(hello, { address: addressOf(conn), peer });
  }

  async #prove(signature: string, conn: WsConn | undefined): Promise<Welcome> {
    const { store, links, catalog, status, config, tokens, limits, clock, log } = this.#options;
    const challenge = conn === undefined ? undefined : this.#challenges.get(conn);
    if (conn === undefined || challenge === undefined) { throw refuse(400, 'NO_CHALLENGE', 'say hello first'); }
    this.#challenges.delete(conn);
    const { hello, nonce } = challenge;
    const record = await store.table('systems').get(hello.name);
    if (record === undefined || !verifyNonce(record.publicKey, nonce, signature)) {
      log.warn('link.prove.refused', { system: hello.name });
      throw refuse(401, 'BAD_SIGNATURE', 'the signature does not match the paired key');
    }
    const first = record.lastSeenAt === undefined;
    const upgradedFrom = !first && record.version !== hello.version ? record.version : undefined;
    const manifest = await catalog.manifest(hello.name);
    const sendManifest = manifest === undefined || record.manifestHash !== hello.manifestHash;
    const session: LinkSession = { system: hello.name, instance: hello.instance };
    links.establish(conn, session);
    await status.sync(hello.name, { version: hello.version, lastSeenAt: clock(), address: addressOf(conn) });
    const current = sendManifest ? await config.current(hello.name) : await config.applyPending(hello.name, record.actor);
    return {
      ...(current === undefined ? {} : { config: current }),
      start: { first, ...(upgradedFrom === undefined ? {} : { upgradedFrom }) },
      token: tokens.issue(session),
      sendManifest,
      limits,
    };
  }

  /** After a contract import: keep the hash it matched (blank when something was refused, so it is sent again). */
  async #contractChanged(link: LinkSession, manifestHash: string, change: { description?: string; version?: string }): Promise<void> {
    const { status, config, store } = this.#options;
    await status.sync(link.system, { manifestHash, ...change });
    const record = await store.table('systems').get(link.system);
    if (record !== undefined) { await config.applyPending(link.system, record.actor); }
  }
}

/** The link module as an `@ayepi/plugin`: its slice of the hub link, the `linkSession` guard and the handlers. */
export function linkPlugin(handshake: LinkHandshake) {
  return plugin({ name: 'link', spec: LINK_SPEC, state: () => handshake })
    .middleware(linkSession, () => handshake.guard)
    .handlers(() => handshake.handlers());
}
