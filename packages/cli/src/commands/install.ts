/**
 * `harness system install <zip|dir|npm-spec> [--config <file.json>] [--instance <name>] [--data <export.zip>]`:
 * install a system on a running hub, which pairs it, configures it and starts it beside itself. A zip is uploaded and
 * installed as a package (a fleet package takes `--instance`; `--data` restores a data export into the new
 * instance); a folder is installed in place; the bare name of a premade system this harness carries (`database`,
 * `schedule`: `harness system available` lists them) installs that system: its folder, or in the published package
 * its package zip for the heavy ones (the hub then installs the npm packages it left out into the system's own
 * folder). A premade system installed by name goes live, and brings the systems `premade.ts` says go with it
 * (database brings widgets). Anything else is an npm package (`name@version`; give a version, `database@latest`, for
 * an npm package named like a premade system). It then waits for the system to connect and says where it got to.
 */
import { basename, resolve } from 'node:path';
import { InstanceName, Json, SystemName, instanceLabel, type InstallSource, type SystemStatus } from '@harness/core';
import { z } from 'zod';
import { HUB_OPTIONS, command, type CliIo } from '../command.ts';
import type { HubSession } from '../hub.ts';
import { bundledSystem } from './available.ts';
import { goLiveWhenPaired, liveApi } from '../live.ts';
import { CLI_NAME } from '../local.ts';
import { PREMADE } from '../premade.ts';

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

/** Whether the hub has a system installed (any status but removed). */
async function isInstalled(hub: HubSession, system: string): Promise<boolean> {
  const status = await hub.api.call('system', { system: SystemName.parse(system) }).then((view) => view.status, () => undefined);
  return status !== undefined && status !== 'removed';
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

/** One install: where from, and what goes with it. */
interface Install {
  /** A zip, a folder or an npm spec, resolved. */
  readonly path: string;
  readonly kind: 'zip' | 'folder' | 'npm';
  readonly config?: Json | undefined;
  readonly instance?: InstanceName | undefined;
  readonly data?: string | undefined;
  readonly autoStart: boolean;
}

/** Install one system on the hub; says what it installed. */
async function installOne(io: CliIo, hub: HubSession, install: Install, spec: string): Promise<{ system: SystemName; instance?: InstanceName }> {
  const { config, instance, autoStart } = install;
  if (install.kind === 'zip') {
    const zip = await uploadFile(io, hub, install.path);
    const data = install.data === undefined ? undefined : await uploadFile(io, hub, resolve(io.cwd, install.data));
    const ref = await hub.api.call('installPackage', {
      zip, autoStart, ...(instance === undefined ? {} : { instance }), ...(config === undefined ? {} : { config }), ...(data === undefined ? {} : { data }),
    });
    io.out.line(`installed ${ref.system}@${ref.instance}`);
    return ref;
  }
  const source: InstallSource = install.kind === 'folder' ? { path: install.path } : npmSpec(spec);
  const installed = { system: (await hub.api.call('installSystem', { source, autoStart, ...(config === undefined ? {} : { config }) })).name };
  io.out.line(`installed ${installed.system}`);
  return installed;
}

/** Wait for a premade system to connect, then put it live; false when it didn't get there. */
async function connectAndGoLive(io: CliIo, hub: HubSession, installed: { system: SystemName; instance?: InstanceName | undefined }, wait: number): Promise<boolean> {
  if (!await waitForSystem(io, hub, installed, wait)) { return false; }
  // a premade system the admin just asked for by name goes live as they would put it (nothing switched off)
  // (it can say it is connected a moment before its contract reaches the hub, so this waits for that too)
  const unpaired = await goLiveWhenPaired(liveApi(hub.api), [installed.system], wait);
  if (unpaired.length > 0) { io.out.warn(`${installed.system} has not sent its contract yet, so it is not live: put it live under Admin > Systems once it does`); return false; }
  io.out.line(`${installed.system} is live`);
  return true;
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
    // a bare name that is no file or folder here, but names a premade system: that system's folder or package zip
    const premade = stat === undefined ? await bundledSystem(io, target) : undefined;
    const path = premade ?? given;
    const found = premade === undefined ? stat : await io.files.stat(premade);
    const config = values.config === undefined ? undefined : Json.parse(JSON.parse(await io.files.readText(resolve(io.cwd, values.config))));
    const { instance } = values;
    const autoStart = !values['no-start'];
    const isZip = found?.kind === 'file' && path.toLowerCase().endsWith('.zip');
    // a premade package zip is the system itself, so --instance and --data go with it as with any package zip
    if (!isZip && (instance !== undefined || values.data !== undefined)) { io.out.warn('--instance and --data go with a package zip'); return 1; }
    const kind = isZip ? 'zip' : found?.kind === 'folder' ? 'folder' : 'npm';
    const hub = await io.hub(values);
    try {
      const wait = values.wait === undefined ? io.settings.HARNESS_CLI_WAIT : Number(values.wait);
      const about = premade === undefined ? undefined : PREMADE[target];
      // what goes along with a premade system, when the hub doesn't have it yet (database brings widgets)
      const along: string[] = [];
      for (const name of about?.with ?? []) {
        if (!await isInstalled(hub, name)) { along.push(name); }
      }
      const installed = await installOne(io, hub, { path, kind, config, instance, data: values.data, autoStart }, target);
      const companions: Array<{ system: SystemName }> = [];
      for (const name of along) {
        const where = await bundledSystem(io, name);
        if (where === undefined) { io.out.warn(`${name} goes with ${target}, but this harness doesn't carry it`); continue; }
        companions.push(await installOne(io, hub, { path: where, kind: where.toLowerCase().endsWith('.zip') ? 'zip' : 'folder', autoStart }, name));
      }
      if (about?.note !== undefined && (about.with ?? []).length === 0) {
        // a system that is most use beside another (widgets beside database) says so when that one isn't here
        const needs = Object.entries(PREMADE).filter(([, other]) => other.with?.includes(target) === true).map(([name]) => name);
        const missing = [];
        for (const name of needs) { if (!await isInstalled(hub, name)) { missing.push(name); } }
        if (missing.length > 0) { io.out.line(about.note.replaceAll('harness system', `${CLI_NAME} system`)); }
      }
      if (!autoStart) { return 0; }
      if (premade === undefined) { return await waitForSystem(io, hub, installed, wait) ? 0 : 1; }
      let ok = await connectAndGoLive(io, hub, installed, wait);
      for (const companion of companions) { ok = await connectAndGoLive(io, hub, companion, wait) && ok; }
      return ok ? 0 : 1;
    } finally {
      hub.close();
    }
  },
});
