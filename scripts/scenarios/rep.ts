/**
 * One repetition's clean slate: a fresh data folder (`.harness-test/scenarios/<iteration>/rep-<n>/`, emptied first),
 * a fresh fake home folder for fs, one new SQLite scratch database, and its own stack on the scenarios port with the
 * chat model set to GPT-6 Luna. Every paired system goes live, as an admin does after pairing. With the embedder
 * running, the rep then waits for the hub's index to be embedded (`indexStatus`), so suggestions and search by
 * meaning work from the first case; when it doesn't catch up in time the cases run anyway and the rep says so. People are added here:
 * the kids' member accounts (case 36 needs someone to restrict) and one admin account per case, each with a known
 * password so the case can sign in as it and Phil can open its chats later (`--view`).
 *
 * The web API can add a person but not give them a password (people sign in with SSO, or are the bootstrap admin),
 * so the password is written into the hub's database directly, hashed the way the hub hashes (scrypt), as a test
 * fixture.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from '@ayepi/auth/server';
import type { ActorId, IndexStatus } from '@harness/core';
import BetterSqlite3 from 'better-sqlite3';
import { signIn, type Credentials, type SignedIn } from '../hub-client.ts';
import { lanAddresses, ROOT, startStack, type ComponentName, type Stack } from '../stack.ts';
import { goLiveAll } from '../../e2e/review.ts';
import type { ScenariosSettings } from './env.ts';
import { HOME_TEMPLATE } from './fixtures/make.ts';
import type { DatabaseConfig } from '../../systems/database/shared/shapes.ts';

/** Where every iteration's results go. */
export const SCENARIOS_DIR = join(ROOT, '.harness-test', 'scenarios');
/** Where the fixtures are made. */
export const FIXTURES_DIR = join(SCENARIOS_DIR, 'fixtures');

/** The folder of one repetition of an iteration. */
export function repFolder(iteration: string, rep: number): string {
  return join(SCENARIOS_DIR, iteration, `rep-${rep}`);
}

/** The admin every repetition's hub is set up with. */
export const ADMIN: Credentials = { email: 'scenarios@harness.local', password: 'scenarios-admin-password' };

/** The password every case's person signs in with. */
export const PERSON_PASSWORD = 'scenario-person-password';

/** The scratch database: writable, schema changes allowed, for everyone, as the e2e stack's. */
const SCRATCH: DatabaseConfig = {
  label: 'Household', connection: { kind: 'sqlite-new', path: 'household.db' },
  data: 'read-write', schema: 'allowed', enrich: { on: false }, audience: { visibility: 'public', with: [] },
};

/** Whether the EmbeddingGemma service answers. */
export async function embedderAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Whether something listens on a port of this machine. */
export async function portTaken(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch (error) {
    // refused: nothing listens; anything else (an answer, a timeout) means something is there
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    return !(cause instanceof Error && 'code' in cause && cause.code === 'ECONNREFUSED');
  }
}

/** The addresses other devices open a hub on this machine at: LAN first, then Tailscale (100.x), never localhost. */
export function viewBase(port: number): string {
  const addresses = lanAddresses();
  const lan = addresses.find((a) => a.startsWith('192.168.')) ?? addresses.find((a) => !a.startsWith('100.')) ?? addresses[0] ?? '127.0.0.1';
  return `http://${lan}:${port}`;
}

/** The Tailscale address of this machine's hub, if it has one. */
export function tailscaleBase(port: number): string | undefined {
  const address = lanAddresses().find((a) => a.startsWith('100.'));
  return address === undefined ? undefined : `http://${address}:${port}`;
}

/** A warning or error line of the stack's log, with when it was printed. */
export interface LoggedProblem {
  readonly at: number;
  readonly line: string;
}

/** How the wait for the index went: caught up or not, how long it took, and where it got to. */
export interface IndexWait {
  readonly caughtUp: boolean;
  readonly waitedMs: number;
  readonly items: number;
  readonly pending: number;
  readonly meaning: boolean;
  readonly lastError?: string;
}

/** One line of the index's progress. */
function progressLine(status: IndexStatus): string {
  const state = status.embedding ? 'embedding' : status.retrying ? 'waiting to retry' : 'idle';
  return `${status.items - status.pending}/${status.items} embedded, ${status.pending} waiting, ${state}${status.meaning ? '' : ', no embedder set up yet'}${status.lastError === undefined ? '' : ` (last failure: ${status.lastError.message.slice(0, 160)})`}`;
}

/** Wait until every index item has its vector (and search by meaning is on), logging progress; gives up after `timeout`. */
export async function waitForIndex(admin: SignedIn, settings: Pick<ScenariosSettings, 'HARNESS_SCENARIOS_INDEX_TIMEOUT' | 'HARNESS_SCENARIOS_INDEX_POLL'>, log: (line: string) => void): Promise<IndexWait> {
  const started = Date.now();
  let last = '';
  for (;;) {
    const status = await admin.hub.call('indexStatus', {});
    const waitedMs = Date.now() - started;
    const done = status.meaning && status.pending === 0;
    const line = progressLine(status);
    if (line !== last || done) { log(`index: ${line} after ${Math.round(waitedMs / 1000)}s`); last = line; }
    if (done || waitedMs >= settings.HARNESS_SCENARIOS_INDEX_TIMEOUT) {
      return { caughtUp: done, waitedMs, items: status.items, pending: status.pending, meaning: status.meaning, ...(status.lastError === undefined ? {} : { lastError: status.lastError.message }) };
    }
    await new Promise((resolve) => { setTimeout(resolve, settings.HARNESS_SCENARIOS_INDEX_POLL); });
  }
}

/** A running repetition. */
export interface Rep {
  readonly folder: string;
  readonly stack: Stack;
  readonly admin: SignedIn;
  /** What it runs, for the report. */
  readonly systems: readonly ComponentName[];
  readonly skipped: readonly string[];
  /** How the wait for the index went (absent: no embedder ran, so there was nothing to wait for). */
  readonly index: IndexWait | undefined;
  /** The stack's warnings and errors so far. */
  readonly problems: readonly LoggedProblem[];
  /** Add a person for a case (an admin: the household's owner) and sign in as them. */
  person(caseId: number): Promise<{ client: SignedIn; credentials: Credentials }>;
  stop(): Promise<void>;
}

/** The hub's log lines worth keeping: warnings and errors (`[time] warn …`, `[time] error …`), and anything on stderr. */
const PROBLEM = /^\[[^\]]+\] (warn|error|fatal) /;

/** Boot a repetition on a clean slate. */
export async function startRep(settings: ScenariosSettings, iteration: string, rep: number, log: (line: string) => void): Promise<Rep> {
  const folder = repFolder(iteration, rep);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const home = join(folder, 'home');
  cpSync(join(FIXTURES_DIR, HOME_TEMPLATE), home, { recursive: true, preserveTimestamps: true });

  const skipped: string[] = [];
  const embedder = await embedderAnswers(settings.HARNESS_SCENARIOS_EMBEDDER);
  if (!embedder) { skipped.push(`embedder: the EmbeddingGemma service at ${settings.HARNESS_SCENARIOS_EMBEDDER} doesn't answer`); }
  if (settings.TAVILY_API_KEY === undefined) { skipped.push('web-system: no TAVILY_API_KEY'); }
  const google = settings.GOOGLE_CLIENT_ID === undefined || settings.GOOGLE_CLIENT_SECRET === undefined ? undefined : { clientId: settings.GOOGLE_CLIENT_ID, clientSecret: settings.GOOGLE_CLIENT_SECRET };
  if (google === undefined) { skipped.push('calendar: no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (cases 24 and 25 test the not-connected path)'); }
  skipped.push('mcp: each MCP instance is one outside MCP server a person adds; the household has none');
  skipped.push('claude: Claude Code sessions on this machine are not part of a household\'s harness');

  const systems: ComponentName[] = [
    'hub', 'fs', 'database', 'input', 'widgets', 'code', 'api',
    ...(embedder ? ['embedder' as const] : []), ...(settings.TAVILY_API_KEY === undefined ? [] : ['web-system' as const]), ...(google === undefined ? [] : ['calendar' as const]),
  ];
  const problems: LoggedProblem[] = [];
  const stackLog = join(folder, 'stack.log');
  const stack = await startStack({
    port: settings.HARNESS_SCENARIOS_PORT, data: folder, admin: ADMIN, build: false, watch: false, timeout: settings.HARNESS_SCENARIOS_START_TIMEOUT,
    only: new Set(systems),
    systems: {
      fs: { roots: [{ name: 'home', path: home, writable: true, index: 'all' }], self: join(ROOT, 'systems', 'fs') },
      embedder: { url: settings.HARNESS_SCENARIOS_EMBEDDER },
      ...(google === undefined ? {} : { calendar: { ...google, hubUrl: `http://127.0.0.1:${settings.HARNESS_SCENARIOS_PORT}` } }),
      databases: { main: SCRATCH },
    },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: settings.HARNESS_SCENARIOS_MODEL },
    output: (component, line, stream) => {
      appendFileSync(stackLog, `${component.padEnd(9)} ${line}\n`);
      if (stream === 'err' || PROBLEM.test(line)) { problems.push({ at: Date.now(), line: `${component}: ${line}`.slice(0, 600) }); }
    },
  });
  log(`rep ${rep}: stack up at ${stack.url} (${systems.join(', ')})`);
  const admin = await signIn(stack.url, ADMIN);
  await goLiveAll(admin);
  // the kids' own logins, members with no password (nobody signs in as them; case 36 restricts them)
  for (const kid of [{ name: 'Emma Parker', email: 'emma@example.com' }, { name: 'Leo Parker', email: 'leo@example.com' }]) {
    await admin.hub.call('addUser', { ...kid, role: 'member' });
  }
  const index = systems.includes('embedder') ? await waitForIndex(admin, settings, (line) => { log(`rep ${rep}: ${line}`); }) : undefined;
  if (index !== undefined && !index.caughtUp) { log(`rep ${rep}: the index did not catch up in ${Math.round(index.waitedMs / 1000)}s (${index.pending} of ${index.items} waiting); playing anyway`); }

  const database = join(folder, 'hub.sqlite');
  const setPassword = async (user: ActorId, password: string): Promise<void> => {
    const secretHash = await hashPassword(password);
    const db = new BetterSqlite3(database);
    try {
      db.pragma('busy_timeout = 10000');
      db.prepare('insert into credentials ("_key", "user", "kind", "secretHash", "createdAt") values (?, ?, ?, ?, ?)').run(`${user}\u0000password`, user, 'password', secretHash, Date.now());
    } finally {
      db.close();
    }
  };

  return {
    folder, stack, admin, systems, skipped, index, problems,
    async person(caseId) {
      const credentials = { email: `case-${String(caseId).padStart(2, '0')}@parker.family`, password: PERSON_PASSWORD };
      const { id } = await admin.hub.call('addUser', { email: credentials.email, name: 'Alex Parker', role: 'admin' });
      await setPassword(id, credentials.password);
      return { client: await signIn(stack.url, credentials), credentials };
    },
    async stop() {
      admin.close();
      await stack.stop();
    },
  };
}

/** Boot a saved repetition's hub alone (systems offline), served to the network on the view port, to read its chats. */
export async function viewRep(settings: ScenariosSettings, iteration: string, rep: number): Promise<Stack> {
  const folder = repFolder(iteration, rep);
  if (!existsSync(join(folder, 'hub.sqlite'))) { throw new Error(`there is no saved run at ${folder}`); }
  return startStack({
    port: settings.HARNESS_SCENARIOS_VIEW_PORT, data: folder, admin: ADMIN, build: !existsSync(join(ROOT, 'packages', 'web', 'dist', 'index.html')), watch: false,
    timeout: settings.HARNESS_SCENARIOS_START_TIMEOUT, only: new Set(['web', 'hub']),
    systems: { fs: { roots: [], self: join(ROOT, 'systems', 'fs') }, embedder: { url: settings.HARNESS_SCENARIOS_EMBEDDER } },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: settings.HARNESS_SCENARIOS_MODEL },
    output: (component, line) => { appendFileSync(join(folder, 'view.log'), `${component.padEnd(9)} ${line}\n`); },
  });
}
