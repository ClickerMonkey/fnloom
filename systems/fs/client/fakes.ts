/**
 * A stand-in for the chat's system client, for the renderer tests and the preview page: `run.<fn>` records what it was
 * asked to start and waits until the caller starts or refuses it (or, with `starts`, starts it at once), so every state
 * of "Run again" can be shown and checked. fs declares no actions, so `send` is empty.
 */
import { mintId, type RunId } from '@harness/core';
import type { SystemClient } from '@harness/sdk';
import type { FsContract } from '../shared/index.ts';

/** A run the fake was asked to start. */
export interface StartedRun {
  readonly fn: keyof FsContract['defs']['fns'];
  readonly args: unknown;
}

/** A fake fs system client and the handles to drive it. */
export interface FakeFsSystem {
  readonly system: SystemClient<FsContract['defs']>;
  /** The runs asked for, in order. */
  readonly started: StartedRun[];
  /** Start the latest run asked for; resolves with its id. */
  start(): RunId;
  /** Refuse the latest run asked for, as the hub does when it can't start it. */
  refuse(message: string): void;
}

/** Make a fake fs system client. With `starts`, every run asked for starts at once. */
export function fakeFsSystem(online = true, starts = false): FakeFsSystem {
  const started: StartedRun[] = [];
  let pending: { resolve: (run: RunId) => void; reject: (error: Error) => void } | undefined;
  const ask = (fn: StartedRun['fn']) => (args: unknown): Promise<RunId> => {
    started.push({ fn, args });
    if (starts) { return Promise.resolve(mintId('run')); }
    return new Promise<RunId>((resolve, reject) => { pending = { resolve, reject }; });
  };
  const system: SystemClient<FsContract['defs']> = {
    online,
    send: {},
    run: {
      read: ask('read'), write: ask('write'), edit: ask('edit'), list: ask('list'), glob: ask('glob'), grep: ask('grep'),
      cd: ask('cd'), bash: ask('bash'), remove: ask('remove'), restart: ask('restart'), explore: ask('explore'),
      install_system: ask('install_system'), system_status: ask('system_status'), restart_system: ask('restart_system'), stop_system: ask('stop_system'),
    },
  };
  return {
    system, started,
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
