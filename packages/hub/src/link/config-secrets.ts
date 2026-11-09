/**
 * Secret fields in instance config (build 5). A system names its config's secret text fields by dot path
 * (`Manifest.configSecrets`). When a config is saved each such value is sealed into the hub's secrets table and the
 * stored config holds `{ $secret: id }` in its place; only the system, in its welcome and `configure`, gets the plain
 * value. The web app sees `SECRET_KEPT` in a set secret field and sends it back to keep the stored secret. A changed
 * value replaces its secret; a value taken away removes it.
 */
import {
  isJsonObject, SealedConfigSecret, SECRET_KEPT, type ActorId, type ConfigPath, type InstanceRef, type Json, type JsonObject, type SecretId,
} from '@harness/core';
import type { SecretVault } from '../api/index.ts';

/** The vault calls sealing uses. */
export type ConfigVault = Pick<SecretVault, 'store' | 'reveal' | 'remove'>;

/** The sealed secret a config value holds, if it is one. */
function sealedOf(value: Json | undefined): SecretId | undefined {
  const parsed = SealedConfigSecret.safeParse(value);
  return parsed.success ? parsed.data.$secret : undefined;
}

/** The value at a dot path of a JSON value, if there is one. */
export function valueAt(value: Json | undefined, path: ConfigPath): Json | undefined {
  let node: Json | undefined = value;
  for (const key of path.split('.')) {
    if (!isJsonObject(node)) { return undefined; }
    node = node[key];
  }
  return node;
}

/** A copy of an object with the value at a dot path replaced (made where missing), or removed when `next` is undefined. */
export function withValueAt(value: JsonObject, path: ConfigPath, next: Json | undefined): JsonObject {
  const [key, ...rest] = path.split('.');
  if (key === undefined) { return value; }
  if (rest.length === 0) {
    const { [key]: _old, ...others } = value;
    return next === undefined ? others : { ...others, [key]: next };
  }
  const child = value[key];
  if (!isJsonObject(child) && next === undefined) { return value; }
  return { ...value, [key]: withValueAt(isJsonObject(child) ? child : {}, rest.join('.'), next) };
}

/** Every sealed secret anywhere in a value, mapped (depth first). */
async function mapSealed(value: Json, map: (id: SecretId) => Promise<Json>): Promise<Json> {
  const id = sealedOf(value);
  if (id !== undefined) { return map(id); }
  if (Array.isArray(value)) { return Promise.all(value.map((item) => mapSealed(item, map))); }
  if (!isJsonObject(value)) { return value; }
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) { out[key] = await mapSealed(item, map); }
  return out;
}

/** A config as the web app sees it: each sealed secret as `SECRET_KEPT`. */
export function maskSecrets(value: Json): Json {
  if (sealedOf(value) !== undefined) { return SECRET_KEPT; }
  if (Array.isArray(value)) { return value.map(maskSecrets); }
  if (!isJsonObject(value)) { return value; }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSecrets(item)]));
}

/** Seals and reveals the secret fields of instance configs. */
export class ConfigSecretKeeper {
  readonly #vault: () => ConfigVault;

  /** `vault` is looked up when used (the api module's, built after the link module). */
  constructor(vault: () => ConfigVault) {
    this.#vault = vault;
  }

  /**
   * A config about to be saved over `before` (the stored value, sealed): `plain` with `SECRET_KEPT` put back to the
   * stored secret's value (to check and to send the system), and `sealed` with each secret path sealed (to store).
   * Secrets no longer used are removed once the caller has stored `sealed` (`release`).
   */
  async seal(ref: InstanceRef, value: Json, before: Json | undefined, paths: readonly ConfigPath[], by: ActorId): Promise<{ plain: Json; sealed: Json; release: () => Promise<void> }> {
    if (paths.length === 0 || !isJsonObject(value)) { return { plain: value, sealed: value, release: () => this.#removeAll(before, value) }; }
    const vault = this.#vault();
    let plain: JsonObject = value;
    let sealed: JsonObject = value;
    const dropped: SecretId[] = [];
    for (const path of paths) {
      const old = sealedOf(valueAt(before, path));
      const given = valueAt(value, path);
      if (given === SECRET_KEPT) {
        const kept = old === undefined ? undefined : await vault.reveal(old);
        plain = withValueAt(plain, path, kept);
        sealed = withValueAt(sealed, path, old === undefined || kept === undefined ? undefined : { $secret: old });
        continue;
      }
      if (typeof given !== 'string') {
        if (old !== undefined) { dropped.push(old); }
        continue;
      }
      if (old !== undefined && await vault.reveal(old) === given) {
        sealed = withValueAt(sealed, path, { $secret: old });
        continue;
      }
      const id = await vault.store({ name: `config ${ref.system}@${ref.instance} ${path}`, owner: by, value: given });
      sealed = withValueAt(sealed, path, { $secret: id });
      if (old !== undefined) { dropped.push(old); }
    }
    return { plain, sealed, release: async () => { for (const id of dropped) { await vault.remove(id); } } };
  }

  /** A stored config with each sealed secret revealed (a secret that is gone reads as missing). */
  async unseal(value: Json): Promise<Json> {
    const vault = this.#vault();
    return mapSealed(value, async (id) => (await vault.reveal(id)) ?? '');
  }

  /** Remove the secrets of `before` that `after` no longer holds (a config type with no secret fields any more). */
  async #removeAll(before: Json | undefined, after: Json): Promise<void> {
    if (before === undefined) { return; }
    const kept = new Set<SecretId>();
    await mapSealed(after, (id) => { kept.add(id); return Promise.resolve(null); });
    const vault = this.#vault();
    await mapSealed(before, async (id) => { if (!kept.has(id)) { await vault.remove(id); } return null; });
  }
}
