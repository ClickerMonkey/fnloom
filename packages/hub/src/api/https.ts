/**
 * HTTPS on the hub's port: the switch, the certificate, and what Settings shows about them. The switch starts as
 * `HARNESS_HTTPS` (on) and an admin's choice in Settings › Hub wins (the hub option `https`); either way it applies
 * to the next connection, with no restart. The certificate is the hub's own (`TlsFolder`: an authority made once,
 * and a certificate for this computer's addresses from it), unless `HARNESS_TLS_CERT` and `HARNESS_TLS_KEY` name
 * files to use instead (a `tailscale cert`, mkcert, a real authority); those are read again when they change.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HTTPS_OPTION, type ActorId, type HttpsSource, type HttpsView } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { TlsSource } from './dual.ts';
import type { Authority, KeyPair, TlsFolder } from './tls.ts';

/** What `HubHttps` is made from. */
export interface HubHttpsOptions {
  readonly store: HubStore;
  /** The hub's own authority and certificate. */
  readonly folder: TlsFolder;
  /** `HARNESS_HTTPS`: on until an admin says otherwise. */
  readonly on: boolean;
  /** `HARNESS_TLS_CERT` / `HARNESS_TLS_KEY`, when both are set. */
  readonly files?: { readonly cert: string; readonly key: string };
  /** `HARNESS_URL`, listed first when it is an https address. */
  readonly hubUrl: string;
  readonly clock: () => number;
  /** A certificate that couldn't be made or read (the old one, if any, stays in use). */
  readonly onError?: (error: unknown) => void;
}

/** The hub's https: the switch, its certificate, and the view Settings shows. */
export class HubHttps implements TlsSource {
  readonly #o: HubHttpsOptions;
  #on: boolean;
  #set: { by: ActorId; at: number } | undefined;
  #port = 0;

  constructor(options: HubHttpsOptions) {
    this.#o = options;
    this.#on = options.on;
  }

  /** This computer's name, as the certificates carry it. */
  get host(): string { return this.#o.folder.host; }

  /** Where the certificate comes from. */
  get source(): HttpsSource { return this.#o.files === undefined ? 'own' : 'files'; }

  /** Read the admin's choice, if any (start-up). */
  async load(): Promise<void> {
    const row = await this.#o.store.table('hubOptions').get(HTTPS_OPTION);
    if (row?.key === HTTPS_OPTION) {
      this.#on = row.value;
      this.#set = { by: row.setBy, at: row.updatedAt };
    }
  }

  /** The port the hub listens on, for the links (set once it listens). */
  listening(port: number): void { this.#port = port; }

  enabled(): boolean { return this.#on; }

  /** The certificate to serve: the given files, or the hub's own (made, or made again, as needed). */
  material(): KeyPair | undefined {
    try {
      const files = this.#o.files;
      if (files !== undefined) { return { cert: readFileSync(files.cert, 'utf8'), key: readFileSync(files.key, 'utf8') }; }
      const made = this.#o.folder.ensure();
      return { key: made.key, cert: made.cert };
    } catch (error) {
      this.#o.onError?.(error);
      return undefined;
    }
  }

  /** The hub's own authority, for a device to install; undefined with given files, or before it is made. */
  authority(): Authority | undefined {
    return this.#o.files === undefined ? this.#o.folder.authority() : undefined;
  }

  /** Switch https on or off (an admin); the next connection follows. Turning it on makes the certificate at once. */
  async set(on: boolean, by: ActorId): Promise<HttpsView> {
    const at = this.#o.clock();
    await this.#o.store.table('hubOptions').put({ key: HTTPS_OPTION, value: on, setBy: by, updatedAt: at });
    this.#on = on;
    this.#set = { by, at };
    if (on) { this.material(); }
    return this.view();
  }

  /** What Settings shows. */
  view(): HttpsView {
    const authority = this.authority();
    return {
      on: this.#on, source: this.source, host: this.#o.folder.host, links: this.#on ? this.#links() : [],
      ...(this.#set === undefined ? {} : { setBy: this.#set.by, updatedAt: this.#set.at }),
      ...(authority === undefined ? {} : { fingerprint: authority.fingerprint, authorityName: authority.name }),
    };
  }

  /** The https address of the hub on each network: `HARNESS_URL` first when it is https, then the certificate's names or this computer's addresses. */
  #links(): string[] {
    const port = this.#port;
    const first = this.#o.hubUrl.startsWith('https://') ? [new URL('/', this.#o.hubUrl).toString()] : [];
    const hosts = this.#o.files === undefined ? this.#o.folder.reachable() : this.#fileHosts();
    const links = hosts.map((host) => `https://${host.includes(':') ? `[${host}]` : host}${port === 443 ? '' : `:${String(port)}`}/`);
    return [...new Set([...first, ...links])];
  }

  /** The names and addresses the given certificate covers (wildcards left out). */
  #fileHosts(): string[] {
    const material = this.material();
    if (material === undefined) { return []; }
    try {
      const san = new X509Certificate(material.cert).subjectAltName ?? '';
      return san.split(',').map((entry) => entry.trim()).flatMap((entry) => {
        if (entry.startsWith('DNS:')) { const name = entry.slice(4); return name.includes('*') ? [] : [name]; }
        if (entry.startsWith('IP Address:')) { return [entry.slice('IP Address:'.length)]; }
        return [];
      });
    } catch {
      return [];
    }
  }
}
