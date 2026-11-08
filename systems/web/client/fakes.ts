/**
 * A stand-in for the chat's system client, for the renderer tests: `run.<fn>` records what it was asked to start and
 * waits until the test starts or refuses it, so every state of "Read" can be shown and checked. The web system
 * declares no actions, so `send` is empty.
 */
import { mintId, type RunId } from '@harness/core';
import type { SystemClient } from '@harness/sdk';
import type { WebContract } from '../shared/index.ts';

/** A run the fake was asked to start. */
export interface StartedRun {
  readonly fn: keyof WebContract['defs']['fns'];
  readonly args: unknown;
}

/** A fake web system client and the handles to drive it. */
export interface FakeWebSystem {
  readonly system: SystemClient<WebContract['defs']>;
  readonly started: StartedRun[];
  /** Start the latest run asked for; returns its id. */
  start(): RunId;
  /** Refuse the latest run asked for. */
  refuse(message: string): void;
}

/** Make a fake web system client. */
export function fakeWebSystem(online = true): FakeWebSystem {
  const started: StartedRun[] = [];
  let pending: { resolve: (run: RunId) => void; reject: (error: Error) => void } | undefined;
  const ask = (fn: StartedRun['fn']) => (args: unknown): Promise<RunId> => {
    started.push({ fn, args });
    return new Promise<RunId>((resolve, reject) => { pending = { resolve, reject }; });
  };
  return {
    system: { online, send: {}, run: { search: ask('search'), read: ask('read'), fetch_raw: ask('fetch_raw') } },
    started,
    start: () => {
      const run = mintId('run');
      pending?.resolve(run);
      pending = undefined;
      return run;
    },
    refuse: (message) => {
      pending?.reject(new Error(message));
      pending = undefined;
    },
  };
}
