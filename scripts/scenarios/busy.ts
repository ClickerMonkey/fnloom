/**
 * The hub sheds load: past a sustained event-loop stall it answers every request with HTTP 503 `OVERLOADED` ("the hub
 * is busy; try again shortly", `retry-after: 1`) before running any handler, so the call can be made again safely,
 * whatever it does. Iteration 1's rep 3 lost cases 34 to 40 to it. Every call the runner makes to a rep's hub goes
 * through `patient`: a shed call is tried again with a doubling wait (never under the hub's retry-after), bounded by
 * `HARNESS_SCENARIOS_BUSY_*`, and only fails once that runs out. Each shedding is counted (`Shedding`), logged, and
 * saved in `rep.json` and the report: the hub shedding is a finding, not noise.
 */
import type { SignedIn } from '../hub-client.ts';
import type { ScenariosSettings } from './env.ts';
import { z } from 'zod';

/** What the hub said when it shed calls during a rep, as `rep.json` keeps it. */
export const Shedding = z.object({
  /** Calls that were shed at least once. */
  calls: z.number().int().default(0),
  /** Shed answers in all (one call can be shed several times). */
  sheds: z.number().int().default(0),
  /** Calls that were still shed when the tries ran out (each failed its case, or a step of the rep). */
  gaveUp: z.number().int().default(0),
  /** Time spent waiting on a busy hub, summed over calls (ms). */
  waitedMs: z.number().default(0),
  /** The first and last shed answer. */
  first: z.string().optional(),
  last: z.string().optional(),
  /** Shed answers by endpoint. */
  byCall: z.record(z.string(), z.number().int()).default({}),
});
export type Shedding = z.infer<typeof Shedding>;

/** An empty tally. */
export function noShedding(): Shedding {
  return { calls: 0, sheds: 0, gaveUp: 0, waitedMs: 0, byCall: {} };
}

/** How patient to be with a busy hub. */
export interface BusyPolicy {
  readonly tries: number;
  readonly wait: number;
  readonly waitMax: number;
  readonly total: number;
}

export function busyPolicy(settings: Pick<ScenariosSettings, 'HARNESS_SCENARIOS_BUSY_TRIES' | 'HARNESS_SCENARIOS_BUSY_WAIT' | 'HARNESS_SCENARIOS_BUSY_WAIT_MAX' | 'HARNESS_SCENARIOS_BUSY_TOTAL'>): BusyPolicy {
  return { tries: settings.HARNESS_SCENARIOS_BUSY_TRIES, wait: settings.HARNESS_SCENARIOS_BUSY_WAIT, waitMax: settings.HARNESS_SCENARIOS_BUSY_WAIT_MAX, total: settings.HARNESS_SCENARIOS_BUSY_TOTAL };
}

/** The hub's retry-after when it sheds (its `start.ts` sends `retry-after: 1`), used when the error doesn't carry one. */
const HUB_RETRY_AFTER_MS = 1_000;

/**
 * Whether an error is the hub shedding load, and the wait it asked for (ms). ayepi's `ApiError` carries the status and
 * the parsed envelope but no headers, so the retry-after is read from the envelope when it has one, else the hub's.
 */
export function shedOf(error: unknown): { retryAfterMs: number } | undefined {
  if (!(error instanceof Error)) { return undefined; }
  const status = 'status' in error ? error.status : undefined;
  const code = 'code' in error ? error.code : undefined;
  const busy = status === 503 || code === 'OVERLOADED' || /\bHTTP 503\b|the hub is busy/.test(error.message);
  if (!busy) { return undefined; }
  const data: unknown = 'data' in error ? error.data : undefined;
  const after = typeof data === 'object' && data !== null && 'retryAfter' in data ? Number(data.retryAfter) : Number.NaN;
  return { retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1_000 : HUB_RETRY_AFTER_MS };
}

/** Where a shedding is told: the rep's tally, its log, and (for a case's own client) the case's count. */
export interface ShedSink {
  readonly tally: Shedding;
  readonly log: (line: string) => void;
  /** Called with each shed answer, for a per-case count. */
  readonly onShed?: () => void;
}

/** Run `call`, trying again while the hub sheds it, within `policy`; past that, the last 503 is thrown. */
export async function patient<T>(what: string, call: () => Promise<T>, policy: BusyPolicy, sink: ShedSink): Promise<T> {
  const started = Date.now();
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await call();
      if (attempt > 1) {
        sink.tally.waitedMs += waited;
        sink.log(`the hub took ${what} after shedding it ${attempt - 1} time(s) (${Math.round(waited / 1000)}s waiting)`);
      }
      return value;
    } catch (error) {
      const shed = shedOf(error);
      if (shed === undefined) { if (attempt > 1) { sink.tally.waitedMs += waited; } throw error; }
      const now = new Date().toISOString();
      const tally = sink.tally;
      tally.sheds++;
      if (attempt === 1) { tally.calls++; }
      tally.byCall[what] = (tally.byCall[what] ?? 0) + 1;
      tally.first ??= now;
      tally.last = now;
      sink.onShed?.();
      const backoff = Math.min(policy.wait * 2 ** (attempt - 1), policy.waitMax);
      const delay = Math.max(shed.retryAfterMs, backoff) + Math.floor(Math.random() * 250);
      if (attempt >= policy.tries || Date.now() - started + delay > policy.total) {
        tally.gaveUp++;
        tally.waitedMs += waited;
        sink.log(`the hub is busy: gave up on ${what} after ${attempt} shed answer(s) and ${Math.round(waited / 1000)}s`);
        throw error;
      }
      if (attempt === 1) { sink.log(`the hub is busy (HTTP 503): ${what} is shed; trying again with backoff`); }
      await new Promise((done) => setTimeout(done, delay));
      waited += delay;
    }
  }
}

/**
 * A signed-in client whose every `hub.call` is `patient`. The socket, events (`hub.on`) and `close` are the original
 * client's. Safe for any endpoint: a shed request never reached its handler.
 */
export function patientClient(client: SignedIn, policy: BusyPolicy, sink: ShedSink): SignedIn {
  const original = client.hub;
  const call = ((name: string, ...rest: unknown[]) => patient(name, () => (original.call as (n: string, ...r: unknown[]) => Promise<unknown>)(name, ...rest), policy, sink)) as typeof original.call;
  const hub = new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'call') { return call; }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    hub, socket: client.socket,
    get tokens() { return client.tokens; },
    close: () => { client.close(); },
  };
}
