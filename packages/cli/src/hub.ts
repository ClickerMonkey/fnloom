/**
 * Reaching a hub from the CLI: its web API signed in as an admin, with uploads and downloads of content. It signs in
 * with `HARNESS_TOKEN` (or `--token -`, read from stdin; `--token <token>` works but other programs can see it), else
 * with the admin account from the environment or `.env` (`HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD`), as
 * `npm run dev` does. A hub address from the folder's `.env` is only signed in to with that same file's sign-in, so a
 * folder can't send the sign-in from the environment to a hub of its choosing.
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
  /** A hub MCP's secret, for `harness mcp`. */
  HARNESS_MCP_SECRET: z.string().optional(),
  /** How long `install` waits for a system to connect, in ms. */
  HARNESS_CLI_WAIT: z.number().int().min(0).default(30_000),
  /** How long reading a system's contract (in a sandboxed child process) may take, in ms. */
  HARNESS_CLI_PROBE_TIMEOUT: z.number().int().min(1_000).default(60_000),
});

/** The parsed CLI settings. */
export type CliEnv = ReturnType<typeof cliEnv.parse>;

/** A setting's name. */
export type CliSetting = keyof CliEnv;

/** The CLI settings, and which of them came from `.env` in the folder it runs in rather than the environment. */
export type CliSettings = CliEnv & { readonly fromFile: ReadonlySet<CliSetting> };

/** The CLI settings from `.env` in `cwd` and the environment (the environment wins). */
export function cliSettings(cwd: string, environment: Readonly<Record<string, string | undefined>>): CliSettings {
  const file = loadEnv({ files: [join(cwd, '.env')] });
  cliEnv.set({ ...file, ...environment });
  const settings = cliEnv.parse();
  const isSetting = (name: string): name is CliSetting => name in settings;
  const fromFile = new Set(Object.keys(settings).filter(isSetting).filter((name) => file[name] !== undefined && environment[name] === undefined));
  return { ...settings, fromFile };
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

/** Why a hub address from the folder's `.env` isn't signed in to with a sign-in from elsewhere. */
export const ENV_FILE_URL_REFUSED = 'The hub address comes from .env in this folder, but the sign-in does not. '
  + 'Pass --hub <url> or set HARNESS_URL, or put the sign-in in the same .env.';

/**
 * The hub target settings and options name. A secret signed in with instead (`harness mcp`'s) says where it came
 * from. Refused when the address is from the folder's `.env` and the sign-in used isn't.
 */
export function hubTarget(settings: CliSettings, options: { hub?: string | undefined; token?: string | undefined }, secret?: { readonly fromFile: boolean }): HubTarget {
  const token = options.token ?? settings.HARNESS_TOKEN;
  const admin = settings.HARNESS_ADMIN_EMAIL !== undefined && settings.HARNESS_ADMIN_PASSWORD !== undefined
    ? { email: settings.HARNESS_ADMIN_EMAIL, password: settings.HARNESS_ADMIN_PASSWORD } : undefined;
  if (options.hub === undefined && settings.fromFile.has('HARNESS_URL') && !signInFromFile(settings, options, token, admin, secret)) {
    throw new Error(ENV_FILE_URL_REFUSED);
  }
  return { url: (options.hub ?? settings.HARNESS_URL).replace(/\/$/, ''), token, admin };
}

/** Whether the sign-in a hub target uses came from the folder's `.env` (none at all counts: nothing is sent). */
function signInFromFile(settings: CliSettings, options: { token?: string | undefined }, token: string | undefined, admin: HubTarget['admin'], secret: { readonly fromFile: boolean } | undefined): boolean {
  const { fromFile } = settings;
  if (secret !== undefined) return secret.fromFile;
  if (options.token !== undefined) return false;
  if (token !== undefined) return fromFile.has('HARNESS_TOKEN');
  return admin === undefined || (fromFile.has('HARNESS_ADMIN_EMAIL') && fromFile.has('HARNESS_ADMIN_PASSWORD'));
}

/** A secret option: its flag, the setting that gives it instead, and whether `-` reads it from stdin. */
export interface SecretFlag {
  readonly flag: string;
  readonly env: CliSetting;
  readonly stdin: boolean;
}

/**
 * A secret option as given: `-` reads it from the first line of stdin (where the command allows); a value on the
 * command line is used, with a warning (other programs on this machine can see it) naming the ways to give it instead.
 */
export async function secretOption(given: string | undefined, io: { stdin(): AsyncIterable<string>; readonly out: { warn(text: string): void } }, secret: SecretFlag): Promise<string | undefined> {
  const { flag, env, stdin } = secret;
  if (given === undefined) return undefined;
  if (given === '-' && !stdin) throw new Error(`${flag} - can't read from stdin here: set ${env}.`);
  if (given !== '-') {
    io.out.warn(`${flag} on the command line can be seen by other programs on this machine. Set ${env} instead${stdin ? `, or pass ${flag} - and give it on stdin` : ''}.`);
    return given;
  }
  for await (const line of io.stdin()) {
    const value = line.trim();
    if (value !== '') return value;
  }
  throw new Error(`${flag} - reads it from stdin, but stdin was empty.`);
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
    throw new Error('Say how to sign in: set HARNESS_TOKEN (or pass --token - and give it on stdin), or HARNESS_ADMIN_EMAIL and HARNESS_ADMIN_PASSWORD in the environment or .env.');
  }
  const signed = await signIn(target.url, target.admin);
  return { api: signed.hub, close: () => { signed.close(); } };
}

/** Calls carrying a token over HTTP. */
function tokenClient(target: HubTarget, token: string, fetcher: typeof fetch): { api: HubClient; close: () => void } {
  const api = client<HubWebSpec>({ baseUrl: `${target.url}/api`, manifest: hubWebSpec, headers: () => ({ authorization: `Bearer ${token}` }), fetchImpl: (request) => fetcher(request) });
  return { api, close: () => undefined };
}
