/**
 * The browser's logs and API traffic, sent to the hub, which keeps them as one resource file per person (rolled over
 * by size and after a quiet spell; admins and the person can read them). Lines are batched by the caller's own
 * debounce (`clientLogsCaller`: one call per pause, at most one per `LOG_BATCH.maxWait`, the queued lines merged into
 * one batch), so a burst of lines is one request. Only while signed in: the hub files them under the person.
 *
 * What is sent: errors the app didn't catch (Vue's, the window's, rejected promises), lines the app logs through
 * `log`, and each call's method, path, status and time. Never a body, an answer, a header or a token: traffic lines
 * have no room for them, and log lines carry only an error's name, message and stack.
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

  /** A log line. */
  log(level: LogLevel, message: string, fields: Readonly<Record<string, string>> = {}): void {
    this.#send({ type: 'log', at: this.#clock(), level, message: message.slice(0, MESSAGE_MAX), ...(Object.keys(fields).length === 0 ? {} : { fields: { ...fields } }) });
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

  /** Report the window's uncaught errors and rejected promises; returns the function that stops. */
  watch(win: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const onError = (event: ErrorEvent): void => { this.error(event.error ?? event.message, 'window'); };
    const onRejection = (event: PromiseRejectionEvent): void => { this.error(event.reason, 'promise'); };
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    return () => {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
    };
  }

  #send(entry: ClientLogEntry): void {
    if (!this.#options.signedIn()) { return; }
    const batch: ClientLogBatch = { entries: [entry], page: this.#options.page().slice(0, 300) };
    // a line that can't be sent is dropped: logging must never fail the page, nor log its own failure
    this.#options.send.call(batch).catch(() => undefined);
  }
}
