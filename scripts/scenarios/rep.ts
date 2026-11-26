/**
 * One repetition's clean slate: a fresh data folder (`.harness-test/scenarios/<iteration>/rep-<n>/`, or
 * `<iteration>/<variant>/rep-<n>/` when a run has several variants; emptied first), a fresh fake home folder for fs
 * (outside any git repository: `homeFolder`), one new SQLite scratch database, and its own stack on the scenarios port with the
 * chat model and the image model (the `describe` role, for `hub/image_read`) set to GPT-6 Luna. Every paired system goes live, as an admin does after pairing. With the embedder
 * running, the rep then waits for the hub's index to be embedded (`indexStatus`), so suggestions and search by
 * meaning work from the first case; when it doesn't catch up in time the cases run anyway and the rep says so. People are added here:
 * the kids' member accounts (case 36 needs someone to restrict) and one admin account per case, each with a known
 * password so the case can sign in as it and Phil can open its chats later (`--view`). A case step sent as another
 * person of the household signs in as them (`member`): Emma is the kids' account given a password then, Sara a member
 * made for the case. The schedule system runs only when a case of the rep needs it (`StartOptions.needs`). Then the rep's variant is
 * applied (`variants.ts`), and the household as it is then is what every case finds: `restore` puts it back between
 * cases (`household.ts`), and a case's person that can't sign in is turned back on, or made again under a new address. Every hub call the rep makes is patient with a busy hub (`busy.ts`), and every client it
 * signs in is closed when it stops, so the runner exits once its last rep is done.
 *
 * The web API can add a person but not give them a password (people sign in with SSO, or are the bootstrap admin),
 * so the password is written into the hub's database directly, hashed the way the hub hashes (scrypt), as a test
 * fixture.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hashPassword } from '@ayepi/auth/server';
import type { ActorId, IndexStatus } from '@harness/core';
import { HouseholdKeeper, type HouseholdAdmin, type Restored } from './household.ts';
import BetterSqlite3 from 'better-sqlite3';
import { signIn, type Credentials, type SignedIn } from '../hub-client.ts';
import { lanAddresses, ROOT, startStack, type ComponentName, type Stack } from '../stack.ts';
import { goLiveAll } from '../../e2e/review.ts';
import { busyPolicy, noShedding, patient, patientClient, type Shedding } from './busy.ts';
import type { ScenariosSettings } from './env.ts';
import { applyVariant, type VariantName, type VariantRecord } from './variants.ts';
import { HOME_TEMPLATE } from './fixtures/make.ts';
import { MEMBERS, type Member, type OptionalSystem } from './cases.ts';
import type { DatabaseConfig } from '../../systems/database/shared/shapes.ts';

/** Where every iteration's results go. */
export const SCENARIOS_DIR = join(ROOT, '.harness-test', 'scenarios');
/** Where the fixtures are made. */
export const FIXTURES_DIR = join(SCENARIOS_DIR, 'fixtures');

/** The folder of one repetition of an iteration (of one of its variants, when the run had several). */
export function repFolder(iteration: string, rep: number, variant?: string): string {
  return variant === undefined ? join(SCENARIOS_DIR, iteration, `rep-${rep}`) : join(SCENARIOS_DIR, iteration, variant, `rep-${rep}`);
}

/** Where the fake home folders go: `HARNESS_SCENARIOS_HOME_ROOT`, else `<os temp>/harness-scenarios`. */
export function homeRoot(settings: Pick<ScenariosSettings, 'HARNESS_SCENARIOS_HOME_ROOT'>): string {
  return resolve(settings.HARNESS_SCENARIOS_HOME_ROOT ?? join(tmpdir(), 'harness-scenarios'));
}

/** The git work tree a folder is in, or undefined when it is in none (git answers no, or isn't there to ask). */
export function gitTopLevel(folder: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A rep's fake home folder, `<home root>/<iteration>[/<variant>]/rep-<n>[/restart-<k>]/home`, made fresh from the
 * template and kept after the rep. Never inside a git repository: the fs system's git hook would report that
 * repository's branch and changed files to the household (iteration 1 showed the harness repo's in a person's chat),
 * so a root inside one is refused.
 */
export function homeFolder(settings: Pick<ScenariosSettings, 'HARNESS_SCENARIOS_HOME_ROOT'>, iteration: string, rep: number, variant: string | undefined, stack: string | undefined): string {
  const root = homeRoot(settings);
  mkdirSync(root, { recursive: true });
  const above = gitTopLevel(root);
  if (above !== undefined) { throw new Error(`the scenarios' home root ${root} is inside the git repository ${above}; set HARNESS_SCENARIOS_HOME_ROOT to a folder outside any repository`); }
  const home = join(root, iteration, ...(variant === undefined ? [] : [variant]), `rep-${rep}`, ...(stack === undefined ? [] : [stack]), 'home');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(dirname(home), { recursive: true });
  cpSync(join(FIXTURES_DIR, HOME_TEMPLATE), home, { recursive: true, preserveTimestamps: true });
  const inside = gitTopLevel(home);
  if (inside !== undefined) { throw new Error(`the fake home ${home} is inside the git repository ${inside}; refusing to run`); }
  return home;
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
  /** The fake home folder the fs system serves as `home`. */
  readonly home: string;
  /** The household variant applied after go-live. */
  readonly variant: VariantRecord;
  /** What the hub shed during the rep (every client's calls). */
  readonly shedding: Shedding;
  /** Run a call to the hub that isn't a client call (a presigned upload), patient with a busy hub as client calls are. */
  patient<T>(what: string, call: () => Promise<T>): Promise<T>;
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
  person(caseId: number): Promise<{ client: SignedIn; credentials: Credentials; shed: () => number }>;
  /** Sign in as another person of the household for a case's step (`Step.as`): Emma's kid account, or a Sara made for the case. */
  member(caseId: number, who: Member, onShed?: () => void): Promise<{ client: SignedIn; credentials: Credentials }>;
  /**
   * Put the household back as the rep set it up (`household.ts`): its accounts on with their roles, the sign-in policy,
   * no rules added since. The members of the cases still `playing` are left to them.
   */
  restore(playing: ReadonlySet<number>): Promise<Restored>;
  stop(): Promise<void>;
}

/** The hub's log lines worth keeping: warnings and errors (`[time] warn …`, `[time] error …`), and anything on stderr. */
const PROBLEM = /^\[[^\]]+\] (warn|error|fatal) /;

/** Where a rep goes and how its household is set up. */
export interface StartOptions {
  /** A restart after a crash: its folder's name inside the rep's (`restart-1`). */
  readonly stack?: string;
  /** The variant to apply (default `off`). */
  readonly variant?: VariantName;
  /** Whether the rep lives in its variant's folder (`<iteration>/<variant>/rep-<n>/`: the run has several variants). */
  readonly variantFolder?: boolean;
  /** Systems to run beyond the usual ones, because a case of the rep needs them (`Case.needs`). */
  readonly needs?: readonly OptionalSystem[];
}

/** The kids' member accounts every rep makes (no password until a case signs in as one). */
const KIDS = [{ key: 'emma', name: 'Emma Parker', email: 'emma@example.com' }, { key: 'leo', name: 'Leo Parker', email: 'leo@example.com' }] as const;

/** The rep's admin client as the household keeper calls it. */
function householdAdmin(admin: SignedIn): HouseholdAdmin {
  return {
    async people() {
      const all = [];
      let cursor: string | undefined;
      do {
        const page = await admin.hub.call('people', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
        all.push(...page.items);
        cursor = page.cursor;
      } while (cursor !== undefined);
      return all;
    },
    async rules() {
      const [policies, budgets, priorities, categories] = await Promise.all([
        admin.hub.call('policies', {}), admin.hub.call('budgets', {}), admin.hub.call('priorityRules', {}), admin.hub.call('modelCategories', {}),
      ]);
      return { policies, budgets, priorities, categories };
    },
    signInPolicy: async () => (await admin.hub.call('signInSettings', {})).policy,
    updateUser: async (change) => { await admin.hub.call('updateUser', change); },
    removeRule: async (rule) => { await admin.hub.call('removeRule', rule); },
    setSignInPolicy: async (policy) => { await admin.hub.call('setSignInPolicy', policy); },
  };
}

/** Boot a repetition on a clean slate. */
export async function startRep(settings: ScenariosSettings, iteration: string, rep: number, log: (line: string) => void, options: StartOptions = {}): Promise<Rep> {
  // a restart after a crash gets a folder of its own inside the rep's, so the crashed hub's database stays readable
  const placed = options.variantFolder === true ? options.variant ?? 'off' : undefined;
  const base = repFolder(iteration, rep, placed);
  const folder = options.stack === undefined ? base : join(base, options.stack);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const home = homeFolder(settings, iteration, rep, placed, options.stack);

  const skipped: string[] = [];
  const embedder = await embedderAnswers(settings.HARNESS_SCENARIOS_EMBEDDER);
  if (!embedder) { skipped.push(`embedder: the EmbeddingGemma service at ${settings.HARNESS_SCENARIOS_EMBEDDER} doesn't answer`); }
  if (settings.TAVILY_API_KEY === undefined) { skipped.push('web-system: no TAVILY_API_KEY'); }
  const google = settings.GOOGLE_CLIENT_ID === undefined || settings.GOOGLE_CLIENT_SECRET === undefined ? undefined : { clientId: settings.GOOGLE_CLIENT_ID, clientSecret: settings.GOOGLE_CLIENT_SECRET };
  if (google === undefined) { skipped.push('calendar: no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (cases 24 and 25 test the not-connected path)'); }
  skipped.push('mcp: each MCP instance is one outside MCP server a person adds; the household has none');
  skipped.push('claude: Claude Code sessions on this machine are not part of a household\'s harness');

  const schedule = options.needs?.includes('schedule') === true;
  if (!schedule) { skipped.push('schedule: runs only for cases that need reminders or timed runs (the second set, 59-62)'); }
  const systems: ComponentName[] = [
    'hub', 'fs', 'database', 'input', 'widgets', 'code', 'api',
    ...(embedder ? ['embedder' as const] : []), ...(schedule ? ['schedule' as const] : []), ...(settings.TAVILY_API_KEY === undefined ? [] : ['web-system' as const]), ...(google === undefined ? [] : ['calendar' as const]),
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
  log(`rep ${rep}: stack up at ${stack.url} (${systems.join(', ')}); home ${home}`);
  const shedding = noShedding();
  const policy = busyPolicy(settings);
  const sink = { tally: shedding, log: (line: string) => { log(`rep ${rep}: ${line}`); } };
  /** Every client signed in on this stack, closed when it stops (an open one keeps renewing, and the process alive). */
  const clients = new Set<SignedIn>();
  const signInPatient = async (credentials: Credentials, onShed?: () => void): Promise<SignedIn> => {
    const caseSink = onShed === undefined ? sink : { ...sink, onShed };
    const client = patientClient(await patient('signIn', () => signIn(stack.url, credentials), policy, caseSink), policy, caseSink);
    clients.add(client);
    return { hub: client.hub, socket: client.socket, get tokens() { return client.tokens; }, close: () => { clients.delete(client); client.close(); } };
  };
  const closeAll = (): void => {
    for (const client of [...clients]) {
      clients.delete(client);
      try { client.close(); } catch { /* already closed */ }
    }
  };
  let admin: SignedIn;
  let variant: VariantRecord;
  let index: IndexWait | undefined;
  const kidIds = new Map<string, ActorId>();
  let keeper: HouseholdKeeper;
  try {
    admin = await signInPatient(ADMIN);
    await goLiveAll(admin);
    // a model that can see images, as an admin sets one under Models: a chat model that can't see asks it with hub/image_read
    const image = await admin.hub.call('setModelRole', { role: 'describe', model: { model: settings.HARNESS_SCENARIOS_IMAGE_MODEL } });
    if (image.resolved === undefined || !('model' in image.resolved)) {
      throw new Error(`the image model ${settings.HARNESS_SCENARIOS_IMAGE_MODEL} can't be the describe role: ${image.resolved === undefined ? 'it resolves to nothing' : image.resolved.problem}`);
    }
    log(`rep ${rep}: image model (describe role) ${image.resolved.model}`);
    // the kids' own logins, members with no password (nobody signs in as them; case 36 restricts them)
    for (const kid of KIDS) {
      const { id } = await admin.hub.call('addUser', { name: kid.name, email: kid.email, role: 'member' });
      kidIds.set(kid.key, id);
    }
    index = systems.includes('embedder') ? await waitForIndex(admin, settings, (line) => { log(`rep ${rep}: ${line}`); }) : undefined;
    if (index !== undefined && !index.caughtUp) { log(`rep ${rep}: the index did not catch up in ${Math.round(index.waitedMs / 1000)}s (${index.pending} of ${index.items} waiting); playing anyway`); }
    // after the index, so the `on` variant's suggestions preview has candidates to decide on
    variant = await applyVariant(admin, options.variant ?? 'off', settings.HARNESS_SCENARIOS_DECISION_MODEL, (line) => { log(`rep ${rep}: ${line}`); });
    // the household as it is now is what every case finds: put back after each case (`household.ts`)
    keeper = new HouseholdKeeper(householdAdmin(admin));
    for (const kid of KIDS) {
      const id = kidIds.get(kid.key);
      if (id !== undefined) { keeper.keep({ id, email: kid.email, role: 'member' }); }
    }
    await keeper.snapshot();
  } catch (error) {
    // a rep that fails to set up stops its stack, so the port is free and nothing keeps the process alive
    closeAll();
    await stack.stop().catch(() => undefined);
    throw error;
  }

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

  /** A kid's password, set once, the first time a case signs in as them. */
  const kidPasswords = new Map<string, Promise<void>>();

  return {
    folder, home, variant, shedding, stack,
    patient: (what, call) => patient(what, call, policy, sink), admin, systems, skipped, index, problems,
    async person(caseId) {
      const base = `case-${String(caseId).padStart(2, '0')}`;
      let shed = 0;
      const onShed = (): void => { shed++; };
      /** A new admin account for the case under an address, kept between cases. */
      const make = async (email: string): Promise<{ id: ActorId; credentials: Credentials }> => {
        const credentials = { email, password: PERSON_PASSWORD };
        const { id } = await admin.hub.call('addUser', { email, name: 'Alex Parker', role: 'admin' });
        await setPassword(id, PERSON_PASSWORD);
        keeper.keep({ id, email, role: 'admin', owner: caseId, person: true });
        return { id, credentials };
      };
      let made = await make(`${base}@parker.family`);
      try {
        return { client: await signInPatient(made.credentials, onShed), credentials: made.credentials, shed: () => shed };
      } catch (first) {
        // another case's agent may have turned it off or changed it: put it back and try again
        await admin.hub.call('updateUser', { user: made.id, disabled: false, role: 'admin' }).catch(() => undefined);
        try {
          return { client: await signInPatient(made.credentials, onShed), credentials: made.credentials, shed: () => shed };
        } catch {
          // still not: a new account for the case rather than a failed case
          log(`rep ${rep}: case ${caseId}'s person couldn't sign in (${first instanceof Error ? first.message : String(first)}); made again`);
          keeper.forget(made.id);
          made = await make(`${base}-again-${Date.now().toString(36)}@parker.family`);
          return { client: await signInPatient(made.credentials, onShed), credentials: made.credentials, shed: () => shed };
        }
      }
    },
    async member(caseId, who, onShed) {
      const kid = KIDS.find((k) => k.key === who);
      let credentials: Credentials;
      if (kid !== undefined) {
        const id = kidIds.get(kid.key);
        if (id === undefined) { throw new Error(`the rep has no account for ${kid.name}`); }
        let ready = kidPasswords.get(kid.key);
        if (ready === undefined) { ready = setPassword(id, PERSON_PASSWORD); kidPasswords.set(kid.key, ready); }
        await ready;
        credentials = { email: kid.email, password: PERSON_PASSWORD };
      } else {
        credentials = { email: `case-${String(caseId).padStart(2, '0')}-${who}@parker.family`, password: PERSON_PASSWORD };
        const { id } = await admin.hub.call('addUser', { email: credentials.email, name: MEMBERS[who].name, role: 'member' });
        await setPassword(id, credentials.password);
        keeper.keep({ id, email: credentials.email, role: 'member', owner: caseId });
      }
      return { client: await signInPatient(credentials, onShed), credentials };
    },
    async restore(playing) {
      const restored = await keeper.restore(playing);
      // a kid's login that is gone is made again (a new account: its password is set when a case next signs in as it)
      for (const kid of KIDS.filter((k) => restored.missing.includes(k.email))) {
        const old = kidIds.get(kid.key);
        if (old !== undefined) { keeper.forget(old); }
        try {
          const { id } = await admin.hub.call('addUser', { name: kid.name, email: kid.email, role: 'member' });
          kidIds.set(kid.key, id);
          kidPasswords.delete(kid.key);
          keeper.keep({ id, email: kid.email, role: 'member' });
        } catch (error) {
          log(`rep ${rep}: ${kid.name}'s login is gone and couldn't be made again: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return restored;
    },
    async stop() {
      closeAll();
      await stack.stop();
    },
  };
}

/** Boot a saved repetition's hub alone (systems offline), served to the network on the view port, to read its chats. */
export async function viewRep(settings: ScenariosSettings, iteration: string, rep: number, variant?: string): Promise<Stack> {
  const folder = repFolder(iteration, rep, variant);
  if (!existsSync(join(folder, 'hub.sqlite'))) { throw new Error(`there is no saved run at ${folder}`); }
  return startStack({
    port: settings.HARNESS_SCENARIOS_VIEW_PORT, data: folder, admin: ADMIN, build: !existsSync(join(ROOT, 'packages', 'web', 'dist', 'index.html')), watch: false,
    timeout: settings.HARNESS_SCENARIOS_START_TIMEOUT, only: new Set(['web', 'hub']),
    systems: { fs: { roots: [], self: join(ROOT, 'systems', 'fs') }, embedder: { url: settings.HARNESS_SCENARIOS_EMBEDDER } },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: settings.HARNESS_SCENARIOS_MODEL },
    output: (component, line) => { appendFileSync(join(folder, 'view.log'), `${component.padEnd(9)} ${line}\n`); },
  });
}
