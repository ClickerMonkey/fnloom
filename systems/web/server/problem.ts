/**
 * Problems a fetch or a search can run into. Server code throws `WebProblem`; the fn layer turns it into a failure of
 * the problem's class with its code, so the LLM sees a message it can act on and the hub knows whether to retry.
 */
import type { ErrorClass } from '@harness/core';

/** Every problem, with the error class it fails a run with. */
export const PROBLEMS = {
  /** Not an http(s) URL. */
  'bad-url': 'caller',
  /** The site's robots.txt disallows the URL (a crawl leaves it out). */
  'robots': 'caller',
  /** A private, loopback or link-local address while `allowPrivate` is off. */
  'private-address': 'caller',
  /** The server answered with a status that isn't success (4xx). */
  'http-status': 'caller',
  /** The server failed (5xx), or asked to come back later (429). */
  'server-busy': 'retry',
  /** Over the byte limit. */
  'too-large': 'caller',
  /** Too many redirects, or a redirect without a usable location. */
  'redirects': 'caller',
  /** It took longer than the timeout. */
  'timeout': 'retry',
  /** The network failed: DNS, a refused connection, a reset. */
  'network': 'retry',
  /** The headless browser couldn't render the page (in `always` mode; `auto` keeps the fetched html). */
  'render-failed': 'retry',
  /** No Tavily key is configured. */
  'no-search-key': 'fatal',
  /** Tavily refused the key or the plan's limits. */
  'search-refused': 'fatal',
  /** Tavily refused the request as given. */
  'search-invalid': 'caller',
  /** Tavily is rate limiting or failing. */
  'search-busy': 'retry',
  /** Tavily answered with something that isn't a search response. */
  'search-garbled': 'retry',
} as const satisfies Record<string, ErrorClass>;

/** A problem's code. */
export type ProblemCode = keyof typeof PROBLEMS;

/** A problem with a fetch or a search. */
export class WebProblem extends Error {
  override readonly name = 'WebProblem';
  readonly code: ProblemCode;
  constructor(code: ProblemCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }

  /** The error class a run fails with for this problem. */
  get errorClass(): ErrorClass {
    return PROBLEMS[this.code];
  }
}

/** The message of anything thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for an abort (a cancelled run's signal), as opposed to a timeout. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** True for a timeout signal's abort (`AbortSignal.timeout`). */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}
