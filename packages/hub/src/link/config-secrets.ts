/**
 * Secret fields in instance config (build 5). A system names its config's secret fields by dot path
 * (`Manifest.configSecrets`): text, or a record of text sealed whole as JSON text (build 9). When a config is saved
 * each such value is sealed into the hub's secrets table and the stored config holds `{ $secret: id }` in its place; only the system, in its welcome and `configure`, gets the plain
 * value. The web app sees `SECRET_KEPT` in a set secret field and sends it back to keep the stored secret. A changed
 * value replaces its secret; a value taken away removes it.
 */
import {
  isJsonObject, Json, SealedConfigSecret, SECRET_KEPT, type ActorId, type ConfigPath, type InstanceRef, type JsonObject, type SecretId,
} from '@harness/core';
import type { SecretVault } from '../api/index.ts';

/** The vault calls sealing uses. */
export type ConfigVault = Pick<SecretVault, 'store' | 'reveal' | 'remove'>;

/** The sealed secret a config value holds, if it is one. */
function sealedOf(value: Json | undefined): SealedConfigSecret | undefined {
  const parsed = SealedConfigSecret.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A sealed secret as the stored config holds it. */
function storedOf(sealed: SealedConfigSecret): JsonObject {
  return sealed.json === true ? { $secret: sealed.$secret, json: true } : { $secret: sealed.$secret };
}

/** The text a secret value is sealed as: text as it is, a record (or any other object or list) as JSON text. */
function secretText(value: Json | undefined): string | undefined {
  if (typeof value === 'string') { return value; }
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : undefined;
}

/** A sealed secret's value from its text: JSON text read back for one sealed whole (missing when unreadable). */
function secretValue(sealed: SealedConfigSecret, text: string | undefined): Json | undefined {
  if (text === undefined || sealed.json !== true) { return text; }
  try {
    const parsed = Json.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
async function mapSealed(value: Json, map: (sealed: SealedConfigSecret) => Promise<Json>): Promise<Json> {
  const sealed = sealedOf(value);
  if (sealed !== undefined) { return map(sealed); }
  if (Array.isArray(value)) { return Promise.all(value.map((item) => mapSealed(item, map))); }
  if (!isJsonObject(value)) { return value; }
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) { out[key] = await mapSealed(item, map); }
  return out;
}

/**
 * The dot paths (`a.b`, `list.0`) of every `{ $secret }` reference in a value a caller gave. Only the keeper writes
 * sealed references into a config, each for its own instance and path, so one a caller wrote is refused: revealing it
 * would hand that secret (another system's, a provider's key) to whatever system the config is sent to. A caller keeps
 * a stored secret with `SECRET_KEPT` instead.
 */
export function secretRefsIn(value: Json | undefined, at = ''): string[] {
  if (sealedOf(value) !== undefined) { return [at === '' ? '(the whole value)' : at]; }
  const entries: Array<[string, Json]> = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : isJsonObject(value) ? Object.entries(value) : [];
  return entries.flatMap(([key, item]) => secretRefsIn(item, at === '' ? key : `${at}.${key}`));
}

/** Why a value holding `{ $secret }` references is refused (`secretRefsIn`), or undefined when it holds none. */
export function secretRefsRefusal(value: Json | undefined, what = 'the config'): string | undefined {
  const refs = secretRefsIn(value);
  return refs.length === 0 ? undefined
    : `${what} names a stored secret at ${refs.join(', ')}: give the value itself, or ${JSON.stringify(SECRET_KEPT)} to keep the one already stored`;
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
   * Secrets no longer used are removed once the caller has stored `sealed` (`release`). `name` names each new secret
   * (a run's sealed args name their run, so only that run unseals them).
   */
  async seal(
    ref: InstanceRef, value: Json, before: Json | undefined, paths: readonly ConfigPath[], by: ActorId, name?: (path: ConfigPath) => string,
  ): Promise<{ plain: Json; sealed: Json; release: () => Promise<void> }> {
    // a caller's own `{ $secret }` reference is never stored, so it can never be revealed (callers refuse it first)
    const refused = secretRefsRefusal(value);
    if (refused !== undefined) { throw new Error(refused); }
    if (paths.length === 0 || !isJsonObject(value)) { return { plain: value, sealed: value, release: () => this.#removeAll(before, value) }; }
    const vault = this.#vault();
    let plain: JsonObject = value;
    let sealed: JsonObject = value;
    const dropped: SecretId[] = [];
    for (const path of paths) {
      const old = sealedOf(valueAt(before, path));
      const given = valueAt(value, path);
      if (given === SECRET_KEPT) {
        const kept = old === undefined ? undefined : secretValue(old, await vault.reveal(old.$secret));
        plain = withValueAt(plain, path, kept);
        sealed = withValueAt(sealed, path, old === undefined || kept === undefined ? undefined : storedOf(old));
        continue;
      }
      const text = secretText(given);
      if (text === undefined) {
        if (old !== undefined) { dropped.push(old.$secret); }
        continue;
      }
      const json = typeof given !== 'string';
      if (old !== undefined && (old.json === true) === json && await vault.reveal(old.$secret) === text) {
        sealed = withValueAt(sealed, path, storedOf(old));
        continue;
      }
      const id = await vault.store({ name: name?.(path) ?? `config ${ref.system}@${ref.instance} ${path}`, owner: by, value: text });
      sealed = withValueAt(sealed, path, storedOf({ $secret: id, ...(json ? { json: true } : {}) }));
      if (old !== undefined) { dropped.push(old.$secret); }
    }
    return { plain, sealed, release: async () => { for (const id of dropped) { await vault.remove(id); } } };
  }

  /** A stored config with each sealed secret revealed (a secret that is gone reads as missing). */
  async unseal(value: Json): Promise<Json> {
    const vault = this.#vault();
    return mapSealed(value, async (sealed) => secretValue(sealed, await vault.reveal(sealed.$secret)) ?? '');
  }

  /** Remove the secrets of `before` that `after` no longer holds (a config type with no secret fields any more). */
  async #removeAll(before: Json | undefined, after: Json): Promise<void> {
    if (before === undefined) { return; }
    const kept = new Set<SecretId>();
    await mapSealed(after, (sealed) => { kept.add(sealed.$secret); return Promise.resolve(null); });
    const vault = this.#vault();
    await mapSealed(before, async (sealed) => { if (!kept.has(sealed.$secret)) { await vault.remove(sealed.$secret); } return null; });
  }
}
