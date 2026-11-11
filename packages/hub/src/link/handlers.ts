/**
 * The hub's side of the system link for what this module answers: the handshake (`hello`, `prove`, `pairingInfo`),
 * the contract (`manifest`, `patch`), resource changes (`resourcesChanged`), the fleet and logs (`log`) (reads checked
 * as a person are `reads.ts`), plus the `linkSession` guard every endpoint after the handshake runs behind. `linkPlugin` packages them as
 * an `@ayepi/plugin` over `LINK_SPEC` (this module's slice of `hubLinkSpec`; it binds `linkSession` once for every
 * slice); boot installs it on the hub link server, which must be made with `{ peers: PeerLinkService.peers }`.
 *
 * The handshake: `hello` whose key matches a paired instance of the system gets a nonce to sign; anything else starts
 * pairing, unless it brings an auto-pair secret (`link/auto-pair.ts`): a good one gets a nonce to sign with the hello's
 * new key, and proving it re-keys the instance and rotates the secret. `prove` checks the signature, makes the socket that instance's connection, and welcomes it with the name
 * it is known as, its config, why it is starting, an HTTP token, whether to send its manifest, and the link's limits.
 */
import { reject as refuse, spec, type HandlerFor, type ImplFor, type WsConn } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { telemetry } from '@ayepi/otel/server';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, linkSession, linkTel, type AutoPairGrant, type Hello, type InstanceRef, type LinkLimits, type LinkSession, type Welcome } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { StoreConfigService } from './config.ts';
import type { PeerLinkService } from './connections.ts';
import type { ResourceRouter, SystemTokens } from './index.ts';
import { isPublicKey, randomToken, verifyNonce } from './keys.ts';
import type { SystemOutput } from './output.ts';
import { autoPairRefused, type AutoPairMatch, type AutoPairService } from './auto-pair.ts';
import type { StorePairingService } from './pairing.ts';
import type { InstanceKeeper } from './status.ts';
import { maskSecrets } from './config-secrets.ts';

const endpoints = hubLinkSpec.endpoints;

/** The slice of `hubLinkSpec` this module answers: the same endpoint objects, so its types are the spec's. */
export const LINK_SPEC = spec({
  endpoints: {
    hello: endpoints.hello, prove: endpoints.prove, pairingInfo: endpoints.pairingInfo, manifest: endpoints.manifest, patch: endpoints.patch,
    resourcesChanged: endpoints.resourcesChanged, log: endpoints.log,
    fleet: endpoints.fleet,
  },
});
export type LinkSpec = typeof LINK_SPEC;
export type LinkEndpoint = keyof LinkSpec['endpoints'];

/** The handlers for those endpoints. */
export type LinkHandlers = { [K in LinkEndpoint]: HandlerFor<LinkSpec, LinkSpec['endpoints'][K]> };

/** What the handshake and its handlers need. */
export interface LinkHandlerOptions {
  readonly log: Logger;
  readonly clock: () => number;
  readonly catalog: Catalog;
  readonly links: PeerLinkService;
  readonly pairing: StorePairingService;
  readonly autoPairs: AutoPairService;
  readonly config: StoreConfigService;
  readonly instances: InstanceKeeper;
  readonly tokens: SystemTokens;
  readonly resources: ResourceRouter;
  readonly limits: LinkLimits;
  /** Where each system's lines go for the admin page. */
  readonly output: SystemOutput;
}

/** Where a socket came from, as far as its upgrade request says. */
export function addressOf(conn: WsConn): string {
  return conn.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? conn.req.headers.get('x-real-ip') ?? new URL(conn.req.url).host;
}

/**
 * The web origin a socket reached the hub at: the `Host` it dialed, with `http` for `ws` and `https` for `wss` (or
 * what a proxy says it was), so a pairing link opens from wherever the system could reach the hub.
 */
export function originOf(conn: WsConn): string {
  const url = new URL(conn.req.url);
  const host = conn.req.headers.get('x-forwarded-host') ?? conn.req.headers.get('host') ?? url.host;
  const forwarded = conn.req.headers.get('x-forwarded-proto');
  const secure = forwarded === null ? url.protocol === 'wss:' || url.protocol === 'https:' : forwarded === 'https' || forwarded === 'wss';
  return `${secure ? 'https' : 'http'}://${host}`;
}

/** The handshake and the hub link handlers of this module. */
export class LinkHandshake {
  readonly #options: LinkHandlerOptions;
  /** Sockets that said hello with a known key (or a good auto-pair secret) and were sent a nonce. */
  readonly #challenges = new Map<WsConn, { hello: Hello; ref: InstanceRef; nonce: string; autoPair?: AutoPairMatch }>();

  constructor(options: LinkHandlerOptions) {
    this.#options = options;
    options.links.peers.onClose((peer) => void this.#challenges.delete(peer.conn));
    options.links.onChange((change) => {
      if (change.connected) { return; }
      options.instances.sync(change, { lastSeenAt: options.clock() }).catch((error: unknown) => {
        options.log.error('link.disconnect.sync.failed', { system: change.system, instance: change.instance, error: messageOf(error) });
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
    const { catalog, resources, log, pairing, links } = this.#options;
    return {
      hello: ({ data, conn }) => this.#hello(data, conn),
      prove: ({ data, conn }) => this.#prove(data.signature, conn),
      pairingInfo: async ({ data, conn }) => {
        const peer = conn === undefined ? undefined : links.peer(conn);
        if (peer === undefined) { throw refuse(400, 'NOT_A_LINK', 'pairing info must come over the link socket'); }
        await pairing.info(data, peer);
      },
      manifest: async ({ data, link }) => {
        if (data.name !== link.system) { throw refuse(403, 'WRONG_SYSTEM', `this link is ${link.system}, not ${data.name}`); }
        const report = await catalog.importManifest(data, link.instance);
        await this.#contractChanged(link, report.refused.length === 0 ? data.hash : '', { description: data.description, version: data.version });
        if (data.resources) { await resources.refresh(link.system, link.instance); }
        return report;
      },
      patch: async ({ data, link }) => {
        const report = await catalog.importPatch(link.system, data, link.instance);
        await this.#contractChanged(link, report.refused.length === 0 ? data.hash : '', {});
        // its resource roots changed: ask for them again
        if (data.roots === true) { await resources.refresh(link.system, link.instance); }
        return report;
      },
      resourcesChanged: ({ data, link }) => { resources.changed(link, data.changes); },
      fleet: async ({ link }) => {
        const [rows, types] = await Promise.all([this.#options.instances.of(link.system), catalog.typesOf(link.system)]);
        return rows.filter((row) => row.status !== 'removed').map((row) => ({
          instance: row.instance, description: row.description, online: this.#options.links.connection(link.system, row.instance) !== undefined,
          config: row.config === undefined ? null : maskSecrets(row.config.value),
          types: types.filter((type) => type.instance === row.instance).map((type) => ({ name: type.name, description: type.description })),
        }));
      },
      log: ({ data, link }) => {
        log.log(data.level, data.key, { system: link.system, instance: link.instance, ...data.fields });
        this.#options.output.logged(link.system, data);
      },
    };
  }

  async #hello(hello: Hello, conn: WsConn | undefined): Promise<Awaited<ReturnType<LinkHandlers['hello']>>> {
    const peer = conn === undefined ? undefined : this.#options.links.peer(conn);
    if (conn === undefined || peer === undefined) { throw refuse(400, 'NOT_A_LINK', 'hello must come over the link socket'); }
    if (!isPublicKey(hello.publicKey)) { throw refuse(400, 'BAD_KEY', 'the public key must be Ed25519, SPKI DER in base64'); }
    const known = await this.#options.pairing.known(hello);
    if (known !== undefined) { return this.#challenge(conn, { hello, ref: known.instance }); }
    if (hello.autoPair !== undefined) {
      const match = await this.#options.autoPairs.check(hello.autoPair, hello.name, addressOf(conn));
      const existing = await this.#options.instances.get(match.secret);
      // an instance an admin removed stays removed: its secret is refused like any other that can't be used
      if (existing?.status === 'removed') { throw autoPairRefused(); }
      return this.#challenge(conn, { hello, ref: { system: match.secret.system, instance: match.secret.instance }, autoPair: match });
    }
    return this.#options.pairing.start(hello, { address: addressOf(conn), origin: originOf(conn), peer });
  }

  /** Send a socket a nonce to sign, remembering what it proves. */
  #challenge(conn: WsConn, challenge: { hello: Hello; ref: InstanceRef; autoPair?: AutoPairMatch }): { kind: 'challenge'; nonce: string } {
    const nonce = randomToken();
    this.#challenges.set(conn, { ...challenge, nonce });
    return { kind: 'challenge', nonce };
  }

  async #prove(signature: string, conn: WsConn | undefined): Promise<Welcome> {
    const { links, catalog, instances, config, tokens, limits, clock, log, autoPairs, pairing } = this.#options;
    const challenge = conn === undefined ? undefined : this.#challenges.get(conn);
    if (conn === undefined || challenge === undefined) { throw refuse(400, 'NO_CHALLENGE', 'say hello first'); }
    this.#challenges.delete(conn);
    const { hello, nonce, ref } = challenge;
    // with an auto-pair secret the hello's own key signs, and becomes the instance's key; else the paired key must
    const signer = challenge.autoPair === undefined ? (await instances.get(ref))?.publicKey : hello.publicKey;
    if (signer === undefined || !verifyNonce(signer, nonce, signature)) {
      log.warn('link.prove.refused', { system: hello.name, instance: ref.instance });
      throw refuse(401, 'BAD_SIGNATURE', 'the signature does not match the paired key');
    }
    let autoPair: AutoPairGrant | undefined;
    if (challenge.autoPair === undefined) {
      autoPair = await autoPairs.deliver(ref, hello.autoPair);
    } else {
      // rotate first: should re-keying fail, the secret it brought stays good as the previous one
      autoPair = await autoPairs.rotate(challenge.autoPair);
      await pairing.autoPaired(ref, hello, addressOf(conn), challenge.autoPair.secret.createdBy);
    }
    const record = await instances.get(ref);
    if (record === undefined) { throw refuse(401, 'BAD_SIGNATURE', 'the signature does not match the paired key'); }
    const first = record.lastSeenAt === undefined;
    const upgradedFrom = !first && record.version !== hello.version ? record.version : undefined;
    const manifest = await catalog.manifest(hello.name);
    const sendManifest = manifest === undefined || record.manifestHash !== hello.manifestHash;
    const session: LinkSession = { ...ref, boot: hello.boot };
    links.establish(conn, session);
    await instances.sync(ref, { version: hello.version, lastSeenAt: clock(), address: addressOf(conn) });
    const system = await instances.syncSystem(ref.system);
    const current = sendManifest ? await config.current(ref.system, ref.instance) : await config.applyPending(ref, system.actor);
    return {
      instance: ref.instance,
      ...(current === undefined ? {} : { config: current }),
      start: { first, ...(upgradedFrom === undefined ? {} : { upgradedFrom }) },
      token: tokens.issue(session),
      sendManifest,
      limits,
      ...(autoPair === undefined ? {} : { autoPair }),
    };
  }

  /**
   * After a contract import: keep the hash the instance's contract matched (blank when something was refused, so it
   * is sent again), the system's description and newest version, and apply a config waiting for the contract.
   */
  async #contractChanged(link: LinkSession, manifestHash: string, change: { description?: string; version?: string }): Promise<void> {
    const { instances, config } = this.#options;
    await instances.sync(link, { manifestHash, ...(change.version === undefined ? {} : { version: change.version }) });
    const system = await instances.syncSystem(link.system, { manifestHash, ...change });
    await config.applyPending(link, system.actor);
  }
}

/**
 * The link module as an `@ayepi/plugin`: its slice of the hub link, request telemetry (`linkTel`, bound once for every
 * slice; progress and forwarded log lines stay quiet), the `linkSession` guard and the handlers.
 */
export function linkPlugin(handshake: LinkHandshake, options: Pick<LinkHandlerOptions, 'log' | 'clock'>) {
  const { log, clock } = options;
  return plugin({ name: 'link', spec: LINK_SPEC, state: () => handshake })
    .middleware(telemetry.server(linkTel, {
      logger: log, logWith: (add, inner) => log.logWith(add, inner), now: clock,
      response: { status: true, duration: true, error: true },
      overrides: { progress: { request: false, response: false }, log: { request: false, response: false } },
    }))
    .middleware(linkSession, () => handshake.guard)
    .handlers(() => handshake.handlers());
}
