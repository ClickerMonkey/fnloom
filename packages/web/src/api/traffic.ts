/**
 * The app's API traffic, as the browser's logs send it to the hub: every call a caller makes (its endpoint's method
 * and path, the status it came back with and how long it took), never its body, its answer or its headers. Seen
 * through ayepi's caller lifecycle hooks (`onStart` / `onSuccess` / `onError` / `onSettled`), which `withTraffic`
 * adds to every caller the app makes, beside the caller's own hooks.
 */
import { ApiError } from '@ayepi/core';
import type { Endpoint, Hub } from './client.ts';
import { manifest } from './manifest.gen.ts';

/** One call as the traffic log keeps it. */
export interface CallSeen {
  readonly at: number;
  readonly method: string;
  /** The endpoint's path (`/fns/facts`), never with the call's values. */
  readonly endpoint: string;
  /**
   * The status it came back with: 200 for an answer, the hub's status for a refusal, 0 when it never got one (the
   * network failed, or a newer call or the page cancelled it).
   */
  readonly status: number;
  readonly duration: number;
}

/** The status a failed call came back with. */
function failedStatus(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

/** Where an endpoint is: its HTTP method and path, as the generated manifest names them. */
function placeOf(name: Endpoint): { readonly method: string; readonly endpoint: string } {
  const entry = manifest.endpoints[name];
  return { method: entry.method, endpoint: entry.path };
}

/**
 * The client with every caller it makes reporting its calls to `seen`. A call is matched from start to end by its
 * data object, the one ayepi hands each hook of the same call; calls without data aren't timed.
 */
export function withTraffic(hub: Hub, seen: (call: CallSeen) => void, clock: () => number = Date.now): Hub {
  const caller: Hub['caller'] = (name, options) => {
    const place = placeOf(name);
    const started = new WeakMap<object, { at: number; status: number }>();
    const mark = (data: unknown, status: number): void => {
      const open = typeof data === 'object' && data !== null ? started.get(data) : undefined;
      if (open !== undefined) { open.status = status; }
    };
    return hub.caller(name, {
      ...options,
      onStart: (data) => {
        if (typeof data === 'object' && data !== null) { started.set(data, { at: clock(), status: 0 }); }
        options?.onStart?.(data);
      },
      onSuccess: (result, data) => { mark(data, 200); options?.onSuccess?.(result, data); },
      onError: (error, data) => { mark(data, failedStatus(error)); options?.onError?.(error, data); },
      onSettled: (data) => {
        const key = typeof data === 'object' && data !== null ? data : undefined;
        const open = key === undefined ? undefined : started.get(key);
        if (key !== undefined && open !== undefined) {
          started.delete(key);
          seen({ at: open.at, ...place, status: open.status, duration: Math.max(0, Math.round(clock() - open.at)) });
        }
        options?.onSettled?.(data);
      },
    });
  };
  return { ...hub, caller };
}
