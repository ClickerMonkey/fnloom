/**
 * The shapes of fs's hosting fns: installing a system folder from the chat (`install_system`), and seeing, restarting
 * and stopping the systems this fs instance hosts (`system_status`, `restart_system`, `stop_system`). A hosted system
 * runs on fs's machine, from a bundle an admin approved, supervised by fs.
 */
import { g, type Infer } from '@harness/sdk';

/** Where a hosted system is in its life. */
export const HOSTED_STATES = ['starting', 'connected', 'needs-config', 'crashed', 'stopped', 'disabled'] as const;
export const HostedState = g.enum(HOSTED_STATES);

/** `install_system`'s args. */
export const InstallArgs = g.obj({
  path: g.field(g.text({ minLength: 1 }), { docs: 'The system folder (the one with system.json): absolute, or relative to a root (`systems/random`).' }),
  instance: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'Which copy of the system this is; `main` when empty.' }),
  replace: g.field(g.optional(g.bool()), { docs: 'Replace a system of this name that runs somewhere else (the card says what it replaces).' }),
});

/** What `install_system` started. */
export const InstallResult = g.obj({
  system: g.text(),
  instance: g.text(),
  version: g.text(),
  status: g.field(g.enum(['connected', 'needs-config']), { docs: '`needs-config`: it runs but waits for its config, set on its page or asked for in the chat.' }),
  fns: g.field(g.list(g.text()), { docs: 'Its fns, by qualified name: load them with hub/load_fns to call them.' }),
  folder: g.field(g.text(), { docs: 'The source folder it was built from.' }),
});

/** One hosted system as `system_status` reports it. */
export const HostedStatus = g.obj({
  system: g.text(),
  instance: g.text(),
  version: g.text(),
  state: HostedState,
  pid: g.optional(g.num({ whole: true })),
  restartsLastHour: g.num({ min: 0, whole: true }),
  folder: g.text(),
  bundleHash: g.text(),
  output: g.field(g.text(), { docs: 'The end of what it printed, to read a crash.' }),
});

/** `system_status`'s args. */
export const StatusArgs = g.obj({ system: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'One system; every hosted one when empty.' }) });

/** `restart_system`'s args. */
export const RestartArgs = g.obj({
  system: g.text({ minLength: 1 }),
  instance: g.field(g.optional(g.text({ minLength: 1 })), { docs: '`main` when empty.' }),
  reason: g.text({ minLength: 1, maxLength: 200 }),
});

/** `stop_system`'s args. */
export const StopArgs = g.obj({
  system: g.text({ minLength: 1 }),
  instance: g.field(g.optional(g.text({ minLength: 1 })), { docs: '`main` when empty.' }),
  remove: g.field(g.optional(g.bool()), { docs: 'Also delete its hosted folders (its data too); the person is asked first.' }),
});

/** What `stop_system` did. */
export const StopResult = g.obj({ stopped: g.bool(), removed: g.bool() });

/** The result values, typed. */
export type InstallResultValue = Infer<typeof InstallResult>;
export type HostedStatusValue = Infer<typeof HostedStatus>;
export type HostedStateValue = Infer<typeof HostedState>;
