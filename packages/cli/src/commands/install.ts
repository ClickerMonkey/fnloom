/**
 * `harness system install <zip|dir|npm-spec> [--config <file.json>] [--instance <name>] [--data <export.zip>]`:
 * install a system on a running hub, which pairs it, configures it and starts it beside itself. A zip is uploaded and
 * installed as a package (a fleet package takes `--instance`; `--data` restores a data export into the new
 * instance); a folder is installed in place; the bare name of a premade system this harness carries (`database`,
 * `schedule`: `harness system available` lists them) installs that folder; anything else is an npm package
 * (`name@version`; give a version, `database@latest`, for an npm package named like a premade system). It then waits
 * for the system to connect and says where it got to.
 */
import { basename, resolve } from 'node:path';
import { InstanceName, Json, instanceLabel, type InstallSource, type SystemName, type SystemStatus } from '@harness/core';
import { z } from 'zod';
import { HUB_OPTIONS, command, type CliIo } from '../command.ts';
import type { HubSession } from '../hub.ts';
import { bundledSystem } from './available.ts';

/** The mime type of the zips the CLI uploads. */
const ZIP = 'application/zip';

/** An npm spec split into its package and version (`@x/notes@1.2.0`, `notes`). */
export function npmSpec(spec: string): { package: string; version: string } {
  const at = spec.lastIndexOf('@');
  return at > 0 ? { package: spec.slice(0, at), version: spec.slice(at + 1) || 'latest' } : { package: spec, version: 'latest' };
}

/** Upload a file from disk to the hub. */
async function uploadFile(io: CliIo, hub: HubSession, path: string) {
  return hub.upload(await io.files.read(path), basename(path), ZIP);
}

/** Where an installed system (or one instance of it) is now, as the hub says. */
async function statusOf(hub: HubSession, system: SystemName, instance: InstanceName | undefined): Promise<SystemStatus | undefined> {
  if (instance === undefined) { return (await hub.api.call('system', { system }).catch(() => undefined))?.status; }
  return (await hub.api.call('instances', { system }).catch(() => [])).find((i) => i.instance === instance)?.status;
}

/** Wait until a system (or one instance) is connected or needs config, or `wait` passes; says where it got to. */
export async function waitForSystem(io: CliIo, hub: HubSession, target: { system: SystemName; instance?: InstanceName | undefined }, wait: number): Promise<boolean> {
  const label = target.instance === undefined ? target.system : instanceLabel({ system: target.system, instance: target.instance });
  const deadline = Date.now() + wait;
  for (;;) {
    const status = await statusOf(hub, target.system, target.instance);
    if (status === 'connected') { io.out.line(`${label} is connected`); return true; }
    if (status === 'needs-config') { io.out.line(`${label} is connected and needs config: set it on the hub's system page`); return true; }
    if (Date.now() >= deadline) { io.out.warn(`${label} has not connected yet (${status ?? 'unknown'}); see its output on the hub's system page`); return false; }
    await io.sleep(500);
  }
}

export const installCommand = command({
  path: ['system', 'install'],
  summary: 'Install a package zip, a folder, a premade system by name or an npm package on a hub, which pairs, configures and starts it.',
  usage: '<zip | folder | premade-name | npm-spec> [--config <file.json>] [--instance <name>] [--data <export.zip>] [--no-start] [--wait <ms>]',
  args: z.object({
    positionals: z.tuple([z.string().min(1)]),
    values: z.object({
      ...HUB_OPTIONS,
      config: z.string().optional(),
      instance: InstanceName.optional(),
      data: z.string().optional(),
      'no-start': z.boolean().default(false),
      wait: z.string().regex(/^\d+$/).optional(),
    }),
  }),
  async run({ positionals: [target], values }, io) {
    const given = resolve(io.cwd, target);
    const stat = await io.files.stat(given);
    // a bare name that is no file or folder here, but names a premade system: that system's folder
    const premade = stat === undefined ? await bundledSystem(io, target) : undefined;
    const path = premade ?? given;
    const found = premade === undefined ? stat : await io.files.stat(premade);
    const config = values.config === undefined ? undefined : Json.parse(JSON.parse(await io.files.readText(resolve(io.cwd, values.config))));
    const { instance } = values;
    const autoStart = !values['no-start'];
    const isZip = found?.kind === 'file' && path.toLowerCase().endsWith('.zip');
    if (!isZip && (instance !== undefined || values.data !== undefined)) { io.out.warn('--instance and --data go with a package zip'); return 1; }
    const hub = await io.hub(values);
    try {
      let installed: { system: SystemName; instance?: InstanceName };
      if (isZip) {
        const zip = await uploadFile(io, hub, path);
        const data = values.data === undefined ? undefined : await uploadFile(io, hub, resolve(io.cwd, values.data));
        const ref = await hub.api.call('installPackage', {
          zip, autoStart, ...(instance === undefined ? {} : { instance }), ...(config === undefined ? {} : { config }), ...(data === undefined ? {} : { data }),
        });
        io.out.line(`installed ${ref.system}@${ref.instance}`);
        installed = ref;
      } else {
        const source: InstallSource = found?.kind === 'folder' ? { path } : npmSpec(target);
        installed = { system: (await hub.api.call('installSystem', { source, autoStart, ...(config === undefined ? {} : { config }) })).name };
        io.out.line(`installed ${installed.system}`);
      }
      if (!autoStart) { return 0; }
      const wait = values.wait === undefined ? io.settings.HARNESS_CLI_WAIT : Number(values.wait);
      return await waitForSystem(io, hub, installed, wait) ? 0 : 1;
    } finally {
      hub.close();
    }
  },
});
