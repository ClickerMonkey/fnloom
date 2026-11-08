/**
 * Package zips and data exports, over the supervisor and the hub's content store. A zip is uploaded to the content
 * store first (the web `upload`, or the CLI), then installed by its ref: checked, placed, paired, configured,
 * optionally given the data of an export, and started. The same instance again with a newer version upgrades every
 * installed instance of the system; anything else already installed is refused. An export zips an installed
 * instance's data folder with `export.json` (and its config only when asked, since the hub can't tell secret fields).
 */
import { ApiError, reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { EXPORT_NOT_READY, MAIN_INSTANCE, PACKAGE_FORMAT, instanceLabel, packageFileName, type ActorId, type ContentRef, type InstanceName, type InstanceRef, type Json } from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { InstanceKeeper } from './status.ts';
import type { LinkService, Packages } from './index.ts';
import { PackageError, readExport, readPackage, readTree, sealExport, unzip, writeTree, zip, ZipError, type DataExport, type ZipEntry } from './package/index.ts';
import type { ZipSource } from './process.ts';
import type { ProcessSupervisor } from './supervisor.ts';
import type { StoreSystemAdmin } from './systems.ts';

/** The content store calls packages use. */
export type PackageContent = Pick<ContentStore, 'put' | 'open'>;

/** What packages need. Content is looked up when used, so the link module can be made before the api module. */
export interface PackagesOptions {
  readonly content: () => PackageContent;
  readonly supervisor: ProcessSupervisor;
  readonly admin: StoreSystemAdmin;
  readonly instances: InstanceKeeper;
  readonly links: LinkService;
  /** How long a connected instance gets to quiesce before its data is copied. */
  readonly exportTimeout: number;
  readonly log: Logger;
  readonly clock: () => number;
  /** The most bytes a zip may unpack to. */
  readonly maxBytes: number;
}

/** The mime type of package zips and data exports. */
export const ZIP_MIME = 'application/zip';

/** Whether version `a` is newer than `b` (semver order, pre-releases before their release). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => {
    const [core = '', pre] = v.split('+')[0]?.split('-', 2) ?? [];
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) { return d > 0; }
  }
  if (x.pre === undefined || y.pre === undefined) { return x.pre === undefined && y.pre !== undefined; }
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

/** The bytes under a content hash, read whole. */
export async function contentBytes(content: Pick<ContentStore, 'open'>, hash: string): Promise<Uint8Array> {
  const opened = await content.open(hash);
  if (opened === undefined) { throw refuse(404, 'CONTENT_NOT_FOUND', `no content ${hash}`); }
  const chunks: Uint8Array[] = [];
  for await (const chunk of opened.stream) { chunks.push(chunk); }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The installs, upgrades, exports and removals of package zips. */
export class HubPackages implements Packages {
  readonly #options: PackagesOptions;

  constructor(options: PackagesOptions) {
    this.#options = options;
  }

  /** Where the installer reads zips from: this hub's content store. */
  get zips(): ZipSource {
    return { bytes: (hash) => contentBytes(this.#options.content(), hash) };
  }

  async installZip(input: { zip: ContentRef; instance?: InstanceName; config?: Json; data?: ContentRef; autoStart?: boolean; by: ActorId }): Promise<InstanceRef> {
    const { supervisor, instances, log } = this.#options;
    const { manifest } = this.#checked(await this.#bytes(input.zip.hash), (entries) => readPackage(entries));
    const ref: InstanceRef = { system: manifest.name, instance: input.instance ?? MAIN_INSTANCE };
    const source = { zip: input.zip.hash, file: packageFileName(manifest.name, manifest.version) };
    // an uninstalled instance has no `installed` entry, so this is an instance the hub runs now
    const installed = (await instances.get(ref))?.installed;
    if (installed !== undefined) {
      if (!newer(manifest.version, installed.version)) {
        throw refuse(409, 'ALREADY_INSTALLED', `${instanceLabel(ref)} already runs ${installed.version}; a zip installs over it only with a newer version`);
      }
      if (input.data !== undefined || input.config !== undefined) {
        throw refuse(409, 'UPGRADE_KEEPS_DATA', `${instanceLabel(ref)} is installed: an upgrade keeps its data and config, so a data export or config goes only with a new instance`);
      }
      await supervisor.upgradeTo(ref.system, source);
      return ref;
    }
    const restore = input.data === undefined ? undefined : this.#checked(await this.#bytes(input.data.hash), (entries) => readExport(entries));
    if (restore !== undefined && restore.info.system !== manifest.name) {
      throw refuse(422, 'WRONG_EXPORT', `the data export is of ${restore.info.system}, not ${manifest.name}`);
    }
    const config = input.config ?? restore?.config;
    const autoStart = input.autoStart ?? true;
    await supervisor.install({ source, instance: ref.instance, by: input.by, autoStart: autoStart && restore === undefined, ...(config === undefined ? {} : { config }) });
    if (restore !== undefined) {
      await writeTree(restore.data, supervisor.dirsOf(ref).data);
      log.info('packages.data.restored', { system: ref.system, instance: ref.instance, files: restore.data.length, from: restore.info.exportedAt });
      if (autoStart) { await supervisor.start(ref.system, ref.instance); }
    }
    log.info('packages.installed', { system: ref.system, instance: ref.instance, version: manifest.version, by: input.by });
    return ref;
  }

  async exportData(input: { ref: InstanceRef; withSecrets: boolean; by: ActorId }): Promise<ContentRef> {
    const { instances, content, clock, log } = this.#options;
    const record = await instances.get(input.ref);
    if (record === undefined) { throw refuse(404, 'NO_INSTANCE', `no instance ${instanceLabel(input.ref)}`); }
    if (record.dirs === undefined) { throw refuse(409, 'NOT_INSTALLED', `${instanceLabel(input.ref)} runs elsewhere; only instances the hub runs have a data folder it can export`); }
    const folder = await this.#quiesced(input.ref, record.dirs.data);
    const data = await readTree(folder).catch((): ZipEntry[] => []);
    // the config goes only when asked for; an instance with no config yet has none to carry
    const config = input.withSecrets ? record.config?.value : undefined;
    const exported: DataExport = {
      info: {
        format: PACKAGE_FORMAT, system: record.system, instance: record.instance, version: record.version, exportedAt: clock(), exportedBy: input.by,
        withSecrets: config !== undefined,
      },
      ...(config === undefined ? {} : { config }),
      data,
    };
    const ref = await content().put(zip(sealExport(exported)), ZIP_MIME);
    log.info('packages.exported', { system: record.system, instance: record.instance, files: data.length, withSecrets: exported.info.withSecrets, by: input.by });
    return ref;
  }

  async removeInstance(ref: InstanceRef, by: ActorId): Promise<void> {
    const record = await this.#options.instances.get(ref);
    if (record === undefined) { throw refuse(404, 'NO_INSTANCE', `no instance ${instanceLabel(ref)}`); }
    if (record.installed !== undefined) { await this.#options.supervisor.uninstall(ref.system, ref.instance); }
    await this.#options.admin.removeInstance(ref, by);
  }

  /**
   * Ask a connected instance to get its data folder into a state worth copying (`exporting`) and say where it is; an
   * instance that is away, or doesn't answer in time, is copied as it lies. One that answers that it could not get
   * its data ready (`EXPORT_NOT_READY`) is not copied: a copy made meanwhile might not be whole.
   */
  async #quiesced(ref: InstanceRef, folder: string): Promise<string> {
    const { links, exportTimeout, log } = this.#options;
    const connection = links.connection(ref.system, ref.instance);
    if (connection === undefined) { return folder; }
    try {
      const { data } = await connection.peer.call('export', { timeout: exportTimeout }, { signal: AbortSignal.timeout(exportTimeout) });
      return data;
    } catch (error) {
      if (error instanceof ApiError && error.code === EXPORT_NOT_READY) {
        log.warn('packages.export.refused', { system: ref.system, instance: ref.instance, error: error.message });
        throw refuse(409, EXPORT_NOT_READY, error.message);
      }
      log.warn('packages.export.quiesce.failed', { system: ref.system, instance: ref.instance, error: messageOf(error) });
      return folder;
    }
  }

  /** Read stored bytes. */
  #bytes(hash: string): Promise<Uint8Array> {
    return contentBytes(this.#options.content(), hash);
  }

  /** Unzip and check, turning format problems into a 422 that lists them. */
  #checked<T>(bytes: Uint8Array, read: (entries: ReturnType<typeof unzip>) => T): T {
    try {
      return read(unzip(bytes, this.#options.maxBytes));
    } catch (error) {
      if (error instanceof PackageError) { throw refuse(422, 'BAD_PACKAGE', error.message); }
      if (error instanceof ZipError) { throw refuse(422, 'BAD_ZIP', error.message); }
      throw error;
    }
  }
}
