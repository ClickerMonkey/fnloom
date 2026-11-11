/**
 * Reaching a hub from the CLI: its web API signed in as an admin, with uploads and downloads of content. It signs in
 * with `--token` (or `HARNESS_TOKEN`), else with the admin account from the environment or `.env`
 * (`HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD`), as `npm run dev` does.
 */
import { env } from '@ayepi/env';
import { loadEnv } from '@ayepi/env/load';
import { client } from '@ayepi/core/client';
import { hubWebSpec, type ContentRef, type HubWebSpec } from '@harness/core';
import { join } from 'node:path';
import { z } from 'zod';
import { signIn, type HubClient } from './hub-client.ts';

/** Where the CLI finds a hub and how it signs in. */
export const cliEnv = env({
  /** The hub's address (`http://192.168.50.112:4300`). */
  HARNESS_URL: z.string().default('http://127.0.0.1:4300'),
  /** An admin access token; without one the CLI signs in with the admin account below. */
  HARNESS_TOKEN: z.string().optional(),
  HARNESS_ADMIN_EMAIL: z.string().optional(),
  HARNESS_ADMIN_PASSWORD: z.string().optional(),
  /** How long `install` waits for a system to connect, in ms. */
  HARNESS_CLI_WAIT: z.number().int().min(0).default(30_000),
  /** How long reading a system's contract (in a sandboxed child process) may take, in ms. */
  HARNESS_CLI_PROBE_TIMEOUT: z.number().int().min(1_000).default(60_000),
});

/** The parsed CLI settings. */
export type CliEnv = ReturnType<typeof cliEnv.parse>;

/** The CLI settings from `.env` in `cwd` and the environment (the environment wins). */
export function cliSettings(cwd: string, environment: Readonly<Record<string, string | undefined>>): CliEnv {
  cliEnv.set({ ...loadEnv({ files: [join(cwd, '.env')] }), ...environment });
  return cliEnv.parse();
}

/** A signed-in hub. */
export interface HubSession {
  /** The web API. */
  readonly api: HubClient;
  /** Store bytes in the hub's content store; returns their ref. */
  upload(bytes: Uint8Array, name: string, mime: string): Promise<ContentRef>;
  /** Fetch a presigned download. */
  download(url: string): Promise<Uint8Array>;
  close(): void;
}

/** How to reach the hub: from options, else settings. */
export interface HubTarget {
  readonly url: string;
  readonly token?: string | undefined;
  readonly admin?: { readonly email: string; readonly password: string } | undefined;
}

/** The hub target settings and options name. */
export function hubTarget(settings: CliEnv, options: { hub?: string | undefined; token?: string | undefined }): HubTarget {
  const token = options.token ?? settings.HARNESS_TOKEN;
  const admin = settings.HARNESS_ADMIN_EMAIL !== undefined && settings.HARNESS_ADMIN_PASSWORD !== undefined
    ? { email: settings.HARNESS_ADMIN_EMAIL, password: settings.HARNESS_ADMIN_PASSWORD } : undefined;
  return { url: (options.hub ?? settings.HARNESS_URL).replace(/\/$/, ''), token, admin };
}

/** Sign in to a hub over HTTP (`fetch` injectable). */
export async function connectHub(target: HubTarget, fetcher: typeof fetch = fetch): Promise<HubSession> {
  const signed = target.token === undefined ? await adminClient(target) : tokenClient(target, target.token, fetcher);
  const absolute = (url: string) => new URL(url, `${target.url}/`).toString();
  return {
    api: signed.api,
    upload: async (bytes, name, mime) => {
      const { url, upload } = await signed.api.call('upload', { name, mime, size: bytes.length });
      const put = await fetcher(absolute(url), { method: 'PUT', body: new Blob([new Uint8Array(bytes)], { type: mime }), headers: { 'content-type': mime } });
      if (!put.ok) { throw new Error(`the hub refused the upload of ${name}: HTTP ${put.status}`); }
      return signed.api.call('uploaded', { upload });
    },
    download: async (url) => {
      const got = await fetcher(absolute(url));
      if (!got.ok) { throw new Error(`the hub refused the download: HTTP ${got.status}`); }
      return new Uint8Array(await got.arrayBuffer());
    },
    close: signed.close,
  };
}

/** Signed in as the admin account. */
async function adminClient(target: HubTarget): Promise<{ api: HubClient; close: () => void }> {
  if (target.admin === undefined) {
    throw new Error('say how to sign in: --token (or HARNESS_TOKEN), or HARNESS_ADMIN_EMAIL and HARNESS_ADMIN_PASSWORD in the environment or .env');
  }
  const signed = await signIn(target.url, target.admin);
  return { api: signed.hub, close: () => { signed.close(); } };
}

/** Calls carrying a token over HTTP. */
function tokenClient(target: HubTarget, token: string, fetcher: typeof fetch): { api: HubClient; close: () => void } {
  const api = client<HubWebSpec>({ baseUrl: `${target.url}/api`, manifest: hubWebSpec, headers: () => ({ authorization: `Bearer ${token}` }), fetchImpl: (request) => fetcher(request) });
  return { api, close: () => undefined };
}
