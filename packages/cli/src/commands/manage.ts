/**
 * The commands over a hub's installed systems: `list`, `start`, `stop`, `upgrade` and `uninstall`, each a thin call to
 * the hub's admin endpoints.
 */
import { InstanceName, SystemName, type InstanceView, type SystemView } from '@harness/core';
import { z } from 'zod';
import { HUB_OPTIONS, command, type CliIo, type HubOptions } from '../command.ts';
import type { HubSession } from '../hub.ts';

/** Run with a hub, closing it afterwards. */
async function withHub(io: CliIo, options: HubOptions, use: (hub: HubSession) => Promise<number>): Promise<number> {
  const hub = await io.hub(options);
  try {
    return await use(hub);
  } finally {
    hub.close();
  }
}

/** One instance as a list line: `laptop connected 0.2.0 (installed, running)`. */
export function instanceLine(instance: InstanceView): string {
  const process = instance.installed === undefined ? '' : ` (installed, ${instance.installed.status})`;
  return `  ${instance.instance.padEnd(12)} ${instance.status.padEnd(13)} ${instance.version}${process}`;
}

/** One system as list lines: the system, then its instances. */
export function systemLines(system: SystemView): string[] {
  const connected = system.instances.filter((i) => i.status === 'connected').length;
  return [`${system.name.padEnd(14)} ${system.status.padEnd(13)} ${system.version} · ${system.instances.length} instances, ${connected} connected`, ...system.instances.map(instanceLine)];
}

const SYSTEM_ARGS = z.object({ positionals: z.tuple([SystemName]), values: z.object(HUB_OPTIONS) });

export const listCommand = command({
  path: ['system', 'list'],
  summary: 'List the hub’s systems and their instances.',
  usage: '',
  args: z.object({ positionals: z.tuple([]), values: z.object(HUB_OPTIONS) }),
  run: ({ values }, io) => withHub(io, values, async (hub) => {
    const systems = await hub.api.call('systems', {});
    if (systems.length === 0) { io.out.line('no systems yet'); }
    for (const system of systems) { for (const line of systemLines(system)) { io.out.line(line); } }
    return 0;
  }),
});

export const startCommand = command({
  path: ['system', 'start'],
  summary: 'Start an installed system.',
  usage: '<system>',
  args: SYSTEM_ARGS,
  run: ({ positionals: [system], values }, io) => withHub(io, values, async (hub) => {
    await hub.api.call('startSystem', { system });
    io.out.line(`started ${system}`);
    return 0;
  }),
});

export const stopCommand = command({
  path: ['system', 'stop'],
  summary: 'Stop an installed system.',
  usage: '<system>',
  args: SYSTEM_ARGS,
  run: ({ positionals: [system], values }, io) => withHub(io, values, async (hub) => {
    await hub.api.call('stopSystem', { system });
    io.out.line(`stopped ${system}`);
    return 0;
  }),
});

export const upgradeCommand = command({
  path: ['system', 'upgrade'],
  summary: 'Upgrade an installed system from its npm or git source (a zip upgrades by installing a newer zip).',
  usage: '<system> [--version <version>]',
  args: z.object({ positionals: z.tuple([SystemName]), values: z.object({ ...HUB_OPTIONS, version: z.string().optional() }) }),
  run: ({ positionals: [system], values }, io) => withHub(io, values, async (hub) => {
    const { from, to } = await hub.api.call('upgradeSystem', { system, ...(values.version === undefined ? {} : { version: values.version }) });
    io.out.line(`upgraded ${system} from ${from} to ${to}`);
    return 0;
  }),
});

export const uninstallCommand = command({
  path: ['system', 'uninstall'],
  summary: 'Stop and remove an installed system’s instances (one with --instance); their data folders stay.',
  usage: '<system> [--instance <name>]',
  args: z.object({ positionals: z.tuple([SystemName]), values: z.object({ ...HUB_OPTIONS, instance: InstanceName.optional() }) }),
  run: ({ positionals: [system], values }, io) => withHub(io, values, async (hub) => {
    const all = await hub.api.call('instances', { system });
    const targets = all.filter((i) => i.status !== 'removed' && (values.instance === undefined || i.instance === values.instance));
    if (targets.length === 0) { io.out.warn(`${system} has no instance${values.instance === undefined ? '' : ` ${values.instance}`} to remove`); return 1; }
    for (const target of targets) {
      await hub.api.call('removeInstance', { system, instance: target.instance });
      io.out.line(`removed ${system}@${target.instance}`);
    }
    return 0;
  }),
});
