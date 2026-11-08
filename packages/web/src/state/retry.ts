/**
 * Trying again until it works: the catch-up a view does after a reconnect (events sent while offline are lost, so it
 * must fetch) is retried with growing waits until it succeeds or the view stops caring. The waits and the sleep are
 * injected, so tests run it without real time.
 */

/** How to wait between tries. */
export interface RetryPolicy {
  /** The waits between tries, in ms; the last one repeats. */
  readonly delays: readonly number[];
  /** Wait `ms`. */
  sleep(ms: number): Promise<void>;
}

/** Half a second, then doubling to 15 seconds, then every 15 seconds. */
export const RETRY: RetryPolicy = {
  delays: [500, 1_000, 2_000, 4_000, 8_000, 15_000],
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

/**
 * Run `work` until it resolves, waiting between tries as `policy` says, while `wanted()` holds. Answers whether it
 * succeeded (false when it stopped being wanted first). `failed` hears each failure.
 */
export async function retryUntil(work: () => Promise<void>, policy: RetryPolicy, wanted: () => boolean, failed: (error: unknown) => void = () => undefined): Promise<boolean> {
  for (let attempt = 0; wanted(); attempt++) {
    try {
      await work();
      return true;
    } catch (error) {
      failed(error);
      if (!wanted()) { return false; }
      await policy.sleep(policy.delays[Math.min(attempt, policy.delays.length - 1)] ?? 1_000);
    }
  }
  return false;
}
