/**
 * The browser's logs and API traffic, sent to the hub, which keeps them as one resource file per person (rolled over
 * by size and after a quiet spell; admins and the person can read them). Lines are batched by the caller's own
 * debounce (`clientLogsCaller`: one call per pause, at most one per `LOG_BATCH.maxWait`, the queued lines merged into
 * one batch), so a burst of lines is one request. Only while signed in: the hub files them under the person.
 *
 * What is sent: errors the app didn't catch (Vue's, the window's, rejected promises), the page's `console` lines (`log`,
 * `info`, `warn`, `error`; each still printed), lines the app logs through `log`, and each call's method, path, status
 * and time. Never a body, an answer, a header or a token: traffic lines have no room for them, log lines carry only an
 * error's name, message and stack, and console lines are sanitized (`consoleText`): fields named like secrets, bearer
 * tokens and JWTs are replaced by `[hidden]`.
 */
import type { ClientLogBatch, ClientLogEntry } from '@harness/core';
import type { CallSeen } from '../api/traffic.ts';
import type { CallerOf, Hub } from '../api/client.ts';

/** How lines are batched: sent once they pause for `wait` ms, at least every `maxWait` ms, at most `max` per batch. */
export const LOG_BATCH = { wait: 5_000, maxWait: 30_000, max: 500 } as const;
/** The longest message a line carries (the hub takes up to 4000 characters). */
const MESSAGE_MAX = 4_000;
/** The longest stack a line carries. */
const STACK_MAX = 3_000;
/** The longest any one console argument is written out. */
const ARG_MAX = 1_000;
/** What stands in for a hidden value. */
const HIDDEN = '[hidden]';
/** Field names whose values are never sent. */
const SECRET_FIELD = /token|password|passwd|secret|authorization|cookie|api[-_]?key|private[-_]?key|credential/i;
/** Values that look like credentials inside text: bearer tokens and JWTs. */
const SECRET_TEXT = [/(bearer\s+)[\w.~+/=-]+/gi, /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g] as const;

/** The console methods copied to the hub, with the level each line gets. */
export const CONSOLE_LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error' } as const satisfies Record<string, LogLevel>;
type ConsoleMethod = keyof typeof CONSOLE_LEVELS;

/** Text with bearer tokens and JWTs hidden. */
function hideSecrets(text: string): string {
  return SECRET_TEXT.reduce((out, pattern) => out.replace(pattern, (_match: string, prefix: unknown) => (typeof prefix === 'string' ? `${prefix}${HIDDEN}` : HIDDEN)), text);
}

/** One console argument as text: an error's name and message, a value as JSON with secret fields hidden, cut to size. */
function argText(arg: unknown): string {
  if (typeof arg === 'string') { return hideSecrets(arg).slice(0, ARG_MAX); }
  if (arg instanceof Error) { return hideSecrets(`${arg.name}: ${arg.message}`).slice(0, ARG_MAX); }
  if (arg === undefined || typeof arg === 'function' || typeof arg === 'symbol') { return String(arg); }
  try {
    const json = JSON.stringify(arg, (key, value: unknown) => (key !== '' && SECRET_FIELD.test(key) ? HIDDEN : value));
    return hideSecrets(json).slice(0, ARG_MAX);
  } catch {
    // a cycle, or a value JSON can't hold
    return Object.prototype.toString.call(arg);
  }
}

/** A console call's arguments as one sanitized line. */
export function consoleText(args: readonly unknown[]): string {
  return args.map(argText).join(' ').slice(0, MESSAGE_MAX);
}

/** The caller that sends batches: queued lines merge into one batch (the newest `LOG_BATCH.max`), retried a few times. */
export function clientLogsCaller(hub: Hub): CallerOf<'clientLogs'> {
  return hub.caller('clientLogs', {
    debounce: {
      wait: LOG_BATCH.wait,
      maxWait: LOG_BATCH.maxWait,
      accumulate: (batches) => {
        const last = batches.at(-1);
        return { entries: batches.flatMap((batch) => batch.entries).slice(-LOG_BATCH.max), ...(last?.page === undefined ? {} : { page: last.page }) };
      },
    },
    retry: { attempts: 3 },
  });
}

/** A log line's level. */
export type LogLevel = Extract<ClientLogEntry, { type: 'log' }>['level'];

/** What the shipper needs from the page. */
export interface ClientLogOptions {
  readonly send: Pick<CallerOf<'clientLogs'>, 'call'>;
  /** Whether someone is signed in now: lines are only sent then. */
  readonly signedIn: () => boolean;
  /** The page's path now (no query or hash, which may hold values). */
  readonly page: () => string;
  readonly clock?: () => number;
}

/** An error's name, message and stack, cut to size; anything else as text. */
function errorOf(error: unknown): { readonly message: string; readonly fields: Record<string, string> } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`.slice(0, MESSAGE_MAX), fields: error.stack === undefined ? {} : { stack: error.stack.slice(0, STACK_MAX) } };
  }
  return { message: String(error).slice(0, MESSAGE_MAX), fields: {} };
}

/** Sends the browser's log lines and traffic to the hub. */
export class ClientLogs {
  readonly #options: ClientLogOptions;
  readonly #clock: () => number;

  constructor(options: ClientLogOptions) {
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
  }

  /** A log line; bearer tokens and JWTs in its message and fields are hidden, as on console lines. */
  log(level: LogLevel, message: string, fields: Readonly<Record<string, string>> = {}): void {
    const shown = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, SECRET_FIELD.test(name) ? HIDDEN : hideSecrets(value)]));
    this.#send({ type: 'log', at: this.#clock(), level, message: hideSecrets(message).slice(0, MESSAGE_MAX), ...(Object.keys(shown).length === 0 ? {} : { fields: shown }) });
  }

  /** An error the app didn't catch, with where it surfaced (`vue`, `window`, `promise`). */
  error(error: unknown, source: string): void {
    const { message, fields } = errorOf(error);
    this.log('error', message, { source, ...fields });
  }

  /** A call the app made. */
  traffic(call: CallSeen): void {
    this.#send({ type: 'traffic', at: call.at, method: call.method.slice(0, 16), endpoint: call.endpoint.slice(0, 300), status: call.status, duration: call.duration });
  }

  /**
   * Report the window's uncaught errors and rejected promises, and copy the console's lines (each still printed);
   * returns the function that stops and puts the console back.
   */
  watch(win: Pick<Window, 'addEventListener' | 'removeEventListener'>, target: Console = console): () => void {
    const onError = (event: ErrorEvent): void => { this.error(event.error ?? event.message, 'window'); };
    const onRejection = (event: PromiseRejectionEvent): void => { this.error(event.reason, 'promise'); };
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    const restore = this.#captureConsole(target);
    return () => {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
      restore();
    };
  }

  /** Wrap the console's methods so each line is also sent; returns the function that puts the originals back. */
  #captureConsole(target: Console): () => void {
    const methods = Object.keys(CONSOLE_LEVELS).filter((name): name is ConsoleMethod => name in CONSOLE_LEVELS);
    // each method's own property as it was, put back as it was when capture stops
    const saved = methods.map((method) => [method, Object.getOwnPropertyDescriptor(target, method)] as const);
    let inside = false;
    for (const method of methods) {
      const original = target[method].bind(target);
      target[method] = (...args: unknown[]): void => {
        original(...args);
        // a line logged while sending one is not sent again
        if (inside) { return; }
        inside = true;
        try { this.log(CONSOLE_LEVELS[method], consoleText(args), { source: 'console' }); } finally { inside = false; }
      };
    }
    return () => {
      for (const [method, descriptor] of saved) {
        if (descriptor === undefined) { Reflect.deleteProperty(target, method); } else { Object.defineProperty(target, method, descriptor); }
      }
    };
  }


  #send(entry: ClientLogEntry): void {
    if (!this.#options.signedIn()) { return; }
    const batch: ClientLogBatch = { entries: [entry], page: this.#options.page().slice(0, 300) };
    // a line that can't be sent is dropped: logging must never fail the page, nor log its own failure
    this.#options.send.call(batch).catch(() => undefined);
  }
}
