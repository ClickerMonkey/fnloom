/**
 * Installing a system package zip (made by `harness system pack`): the zip goes to the hub's presigned upload with
 * progress, then `installPackage` checks it (format, protocol, file hashes, no path leaving the folder), places it,
 * pairs, configures and starts it. A name already installed adds an instance (a fleet); a data export restores into
 * the new instance.
 */
import type { ContentRef, InstanceRef, Json } from '@harness/core';
import { InstanceName } from '@harness/core';
import { ref } from 'vue';
import type { FileSender } from '../../chat/api.ts';
import { sendFile } from '../../chat/state/uploads.ts';
import { Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type PackagesApi = Pick<AdminApi, 'upload' | 'uploaded' | 'installPackage'>;

/** What an install takes besides the zip. */
export interface PackageOptions {
  /** The instance to install as; blank lets the hub choose (`main`, or the next of a fleet). */
  readonly instance: string;
  readonly config?: Json | undefined;
  /** A data export (`exportSystemData`) to restore into the new instance. */
  readonly data?: File | undefined;
  readonly autoStart: boolean;
}

/** A zip's file name looks like a package (`fs-0.4.0.zip`). */
export function isPackageFile(file: Pick<File, 'name'>): boolean {
  return /\.zip$/i.test(file.name);
}

/** Uploading and installing package zips. */
export class PackagesStore {
  readonly #api: PackagesApi;
  readonly #sender: FileSender;
  readonly install = new Task();
  /** How far the zip's upload is (0 to 1). */
  readonly progress = ref(0);
  #abort: AbortController | undefined;

  constructor(api: PackagesApi, sender: FileSender) {
    this.#api = api;
    this.#sender = sender;
  }

  /** Upload a zip (and its data export) and install it; answers the instance it became. */
  async installZip(zip: File, options: PackageOptions): Promise<Outcome<InstanceRef>> {
    if (!isPackageFile(zip)) { return { ok: false, problem: 'A package is a .zip made by harness system pack.' }; }
    const instance = options.instance.trim();
    if (instance !== '' && !InstanceName.safeParse(instance).success) { return { ok: false, problem: 'An instance name is lowercase letters, digits and dashes, starting with a letter.' }; }
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.progress.value = 0;
    return this.install.run(async () => {
      const ref = await sendFile(this.#api, this.#sender, zip, zip.name, (fraction) => { this.progress.value = fraction; }, signal);
      const data: ContentRef | undefined = options.data === undefined ? undefined : await sendFile(this.#api, this.#sender, options.data, options.data.name, () => undefined, signal);
      return this.#api.installPackage.call({
        zip: ref, autoStart: options.autoStart,
        ...(instance === '' ? {} : { instance: InstanceName.parse(instance) }),
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(data === undefined ? {} : { data }),
      });
    }, "Couldn't install that package.");
  }

  /** Stop an upload on its way. */
  cancel(): void {
    this.#abort?.abort();
  }
}
