/**
 * The fetch the page loader uses: every hop of a redirect chain is checked by the address guard before it is
 * requested, failures become `WebProblem`s with the right class (a 404 is the caller's, a 503 is worth a retry), and
 * the body is cut off at the byte limit as it streams. `@aeye/resources`' `fetchResource` runs over it and does the
 * rest (type detection, charsets, rendering).
 */
import type { FetchFn } from '@aeye/resources';
import { redactUrl } from '../shared/urls.ts';
import type { AddressCheck } from './guard.ts';
import { WebProblem, isAbort, isTimeout } from './problem.ts';

/** How a guarded fetch behaves. */
export interface GuardedFetchOptions {
  /** The fetch underneath (the global one in production). */
  readonly fetch: FetchFn;
  readonly guard: AddressCheck;
  /** The most redirects followed. */
  readonly redirects: number;
  /** The most body bytes read. */
  readonly maxBytes: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Turns what a fetch threw into a `WebProblem` naming `url` (shown as given); aborts of the caller's own signal pass through unchanged. */
export function fetchProblem(error: unknown, url: string): unknown {
  if (error instanceof WebProblem || isAbort(error)) { return error; }
  if (isTimeout(error)) { return new WebProblem('timeout', `${url} took too long to answer.`, { cause: error }); }
  return new WebProblem('network', `Couldn't reach ${url}.`, { cause: error });
}

/** The problem for a response that isn't a success. */
function statusProblem(response: Response, url: string): WebProblem {
  const said = `${url} answered ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}.`;
  return response.status === 429 || response.status >= 500 ? new WebProblem('server-busy', said) : new WebProblem('http-status', said);
}

/** A body that errors with `too-large` once more than `maxBytes` have come through. */
function capped(body: ReadableStream<Uint8Array>, maxBytes: number, url: string): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new WebProblem('too-large', `${url} is over the ${maxBytes}-byte limit.`));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

/** The final response, located at `url` (a response made by hand has no URL of its own) and with its body capped; `shown` names it in problems. */
function finalResponse(response: Response, url: string, shown: string, maxBytes: number): Response {
  const body = response.body === null ? null : capped(response.body, maxBytes, shown);
  const located = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(located, 'url', { value: response.url === '' ? url : response.url });
  return located;
}

/**
 * A `FetchFn` that follows redirects itself, checking each hop, refuses statuses that aren't a success and bodies
 * whose declared or streamed size passes the limit.
 */
export function guardedFetch(options: GuardedFetchOptions): FetchFn {
  return async (input, init) => {
    let url = new URL(input);
    for (let hop = 0; ; hop += 1) {
      // messages reach the LLM and the logs, so a signed or token-bearing URL is named with its credentials redacted
      const shown = redactUrl(url);
      await options.guard.check(url, init.signal ?? undefined);
      init.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await options.fetch(url.href, { ...init, redirect: 'manual' });
      } catch (error) {
        throw fetchProblem(error, shown);
      }
      const location = response.headers.get('location');
      if (REDIRECT_STATUSES.has(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        if (location === null || !URL.canParse(location, url)) { throw new WebProblem('redirects', `${shown} redirected without a usable location.`); }
        if (hop >= options.redirects) { throw new WebProblem('redirects', `${redactUrl(input)} redirected more than ${options.redirects} times.`); }
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw statusProblem(response, shown);
      }
      const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (!Number.isNaN(declared) && declared > options.maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw new WebProblem('too-large', `${shown} is ${declared} bytes, over the ${options.maxBytes}-byte limit.`);
      }
      return finalResponse(response, url.href, shown, options.maxBytes);
    }
  };
}

