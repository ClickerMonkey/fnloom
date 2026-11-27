/**
 * `harness start`: the harness from an installed package (or a checkout), for people who aren't developing it. It is
 * `runStack` (the same supervisor as `npm run dev` and `npm run live`), with settings for a person's machine:
 *
 * - **Data** in `--data`, else `HARNESS_DATA`, else `~/.harness`.
 * - **Port** `--port`, else `HARNESS_PORT`, else 4300; bound to every address so a phone on the same network reaches it
 *   (http and https on the one port; see "Installing the app, and HTTPS" in docs/harness.md).
 * - **The admin account:** `HARNESS_ADMIN_EMAIL` and `HARNESS_ADMIN_PASSWORD` when set (the environment or `.env` in
 *   the folder it starts in); else the one this command made before, kept in `<data>/admin.json` (readable by its
 *   owner only); else, on the first start, it makes one (`admin@harness.local` and a random password), saves it there
 *   and prints it. The hub makes that account on its first start, as it does from `.env` in the repository.
 * - **Systems:** the lightweight premade systems `PREMADE` (packages/cli/src/premade.ts) marks to start: fs (serving
 *   `--root`, else `HARNESS_DEV_ROOT`, else the folder it starts in), input, code, schedule and api always;
 *   google-calendar when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; embedder when `HARNESS_EMBEDDER_URL`
 *   names an EmbeddingGemma service. `--systems` (or `HARNESS_DEV_ONLY`) gives the list instead. Every other premade
 *   system is installed on demand (`harness system install <name>`), and the heavy ones (database, web, claude) bring
 *   their own dependencies when they are: the published package carries only their package zips, so a heavy one
 *   listed in `--systems` is left out here with a word on how to install it.
 *
 * Values in `.env` in the starting folder reach the hub and the systems as if they were in the environment.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadEnv } from '@ayepi/env/load';
import {
  ADMIN_FILE, BUNDLED_SYSTEMS_DIR, CLI_NAME, PREMADE, connectHub, dataFolder, goLiveWhenPaired, liveApi, readAdminFile, startComponents, systemOfComponent,
  type AdminFile, type StartOptions,
} from '@harness/cli';
import { SystemName } from '@harness/core';
import { runStack, stackSettings } from './run-stack.ts';

/** The account `harness start` makes on a first start with none given. */
export const DEFAULT_ADMIN_EMAIL = 'admin@harness.local';

/** Fill `process.env` from `.env` in the folder, without replacing what is set, so the hub and systems see it too. */
function loadDotEnv(cwd: string): void {
  for (const [name, value] of Object.entries(loadEnv({ files: [join(cwd, '.env')] }))) {
    if (process.env[name] === undefined && typeof value === 'string') { process.env[name] = value; }
  }
}

/** Start the hub and the default systems; resolves with an exit code once they are up (or failed). */
export async function startHarness(options: StartOptions): Promise<number> {
  const { cwd, out } = options;
  loadDotEnv(cwd);
  const environment = process.env;
  const data = dataFolder(cwd, options.data, environment);
  mkdirSync(data, { recursive: true });
  const port = options.port ?? environment['HARNESS_PORT'] ?? '4300';
  const local = `http://127.0.0.1:${port}`;

  // the admin account: given, made before, or made now
  let made = false;
  let email = environment['HARNESS_ADMIN_EMAIL'];
  let password = environment['HARNESS_ADMIN_PASSWORD'];
  if (email === undefined || password === undefined) {
    const saved = readAdminFile(data);
    if (saved !== undefined) {
      ({ email, password } = saved);
    } else if (existsSync(join(data, 'hub.sqlite'))) {
      out.warn(`The hub in ${data} already has its admin account, and this command doesn't know its sign-in. Set HARNESS_ADMIN_EMAIL and HARNESS_ADMIN_PASSWORD (in the environment or .env here) to it.`);
      return 1;
    } else {
      email = DEFAULT_ADMIN_EMAIL;
      password = randomBytes(15).toString('base64url');
      made = true;
    }
  }
  const adminFile = join(data, ADMIN_FILE);
  if (made || existsSync(adminFile)) {
    writeFileSync(adminFile, `${JSON.stringify({ url: local, email, password } satisfies AdminFile, null, 2)}\n`, { mode: 0o600 });
    chmodSync(adminFile, 0o600);
  }

  const asked = (options.systems ?? environment['HARNESS_DEV_ONLY'] ?? startComponents(environment).join(','))
    .split(',').map((name) => name.trim()).filter((name) => name !== '');
  // a heavy premade system's folder is not in the published package (its package zip is): it runs once installed
  const notHere = asked.filter((name) => PREMADE[systemOfComponent(name)] !== undefined && !existsSync(join(BUNDLED_SYSTEMS_DIR, systemOfComponent(name), 'system.json')));
  for (const name of notHere) {
    out.warn(`${systemOfComponent(name)} is not started by ${CLI_NAME} start here: ${CLI_NAME} system install ${systemOfComponent(name)} installs it, and it starts with the hub after that`);
  }
  const systems = asked.filter((name) => !notHere.includes(name)).join(',');
  Object.assign(process.env, {
    HARNESS_PORT: port, HARNESS_DATA: data, HARNESS_ADMIN_EMAIL: email, HARNESS_ADMIN_PASSWORD: password, HARNESS_DEV_ONLY: systems,
    HARNESS_DEV_ROOT: resolve(cwd, options.root ?? environment['HARNESS_DEV_ROOT'] ?? '.'),
  });

  out.line(`Starting the harness on port ${port} (data in ${data}) ...`);
  const stack = await runStack({ name: 'start', watch: false }, stackSettings());
  // the premade systems it started go live as the admin would put them (they wait for review otherwise)
  const started = systems.split(',').filter((name) => name !== '' && !['hub', 'web'].includes(name))
    // the stack leaves these out without their keys (run-stack.ts)
    .filter((name) => name !== 'web-system' || process.env['TAVILY_API_KEY'] !== undefined)
    .filter((name) => name !== 'calendar' || (process.env['GOOGLE_CLIENT_ID'] !== undefined && process.env['GOOGLE_CLIENT_SECRET'] !== undefined))
    .filter((name) => name !== 'ollama' || process.env['HARNESS_DEV_OLLAMA'] !== undefined)
    .map((name) => SystemName.parse(systemOfComponent(name)));
  const hub = await connectHub({ url: local, admin: { email, password } });
  try {
    const unpaired = await goLiveWhenPaired(liveApi(hub.api), started, 60_000);
    if (unpaired.length > 0) { out.warn(`Not paired yet, so not live: ${unpaired.join(', ')} (Admin > Systems once they connect)`); }
  } finally {
    hub.close();
  }
  const https = (url: string): string => url.replace(/^http:/, 'https:');
  out.line('');
  out.line('The harness is running.');
  out.line(`  Open:      ${local}`);
  for (const url of stack.lanUrls) { out.line(`  Or:        ${url}   (a phone on this network: ${https(url)}, see Settings > App)`); }
  out.line(`  Sign in:   ${email}`);
  out.line(made ? `  Password:  ${password}   (saved in ${adminFile})` : existsSync(adminFile) ? `  Password:  in ${adminFile}` : '  Password:  HARNESS_ADMIN_PASSWORD');
  out.line(`  fs serves: ${process.env['HARNESS_DEV_ROOT']}`);
  out.line('');
  out.line('Add a model provider under Models > Providers (or set OPENROUTER_API_KEY before the first start).');
  out.line(`Systems running: ${started.join(', ') || 'none'}.`);
  out.line(`More: ${CLI_NAME} system available lists them all; ${CLI_NAME} system install <name> adds one (database, with widgets, for`);
  out.line('  your own tables and charts; web for search and page reading; claude for Claude Code sessions). Ctrl+C stops everything.');
  return 0;
}
