/**
 * Secrets in the args of the admin fns (build 9). A model that adds an instance, configures or installs a system,
 * approves a pairing with a config, or gives a provider its key passes secret values (API tokens, client secrets,
 * environment and header values) as the fn's args. A run's args are stored on its row and may wait for an approval,
 * so they are sealed before the row is written, the same way an instance's config is (`ConfigSecretKeeper`): each
 * secret value is kept in the hub's secrets table, named for its run, and the args hold `{ $secret }` in its place.
 * The run's executor gets the plain values, and the secrets are removed once the run settles.
 *
 * Which values are secret is decided here only (`SECRET_ARGS`): a system's declared secret fields
 * (`Manifest.configSecrets`, or what a pairing system said of itself), or the whole config when the system isn't known
 * yet (an install), and a provider's keys. `SECRET_KEPT` (keep the stored secret) is left as it is.
 */
import {
  isJsonObject, MAIN_INSTANCE, PairingId, SealedConfigSecret, SECRET_KEPT, SystemName, type ActorId, type ConfigPath, type InstanceRef, type Json,
  type InvalidInput, type JsonObject, type QualifiedName, type Run, type RunId, type SecretId,
} from '@harness/core';
import { ConfigSecretKeeper, secretRefsIn, secretRefsRefusal, valueAt } from '../link/config-secrets.ts';
import type { RunArgSecrets } from '../execution/runs.ts';
import type { HubServices } from './index.ts';

/** What the secret paths of a fn's args are worked out from. */
type SecretLookup = Pick<HubServices, 'catalog' | 'store'>;

/** The dot paths in a fn's args that hold secret values. */
type SecretPaths = (args: JsonObject, hub: SecretLookup) => Promise<readonly ConfigPath[]>;

/** The arg that holds a system's config. */
const CONFIG = 'config';

/** The secret fields of a system's config, under the `config` arg; the whole config when they aren't known. */
function underConfig(declared: readonly ConfigPath[] | undefined): readonly ConfigPath[] {
  return declared === undefined ? [CONFIG] : declared.map((path) => `${CONFIG}.${path}`);
}

/** The config secret fields of the system an arg names, when its contract is known (none declared: none). */
async function declaredBy(system: Json | undefined, hub: SecretLookup): Promise<readonly ConfigPath[] | undefined> {
  const name = SystemName.safeParse(system);
  if (!name.success) { return undefined; }
  const manifest = await hub.catalog.manifest(name.data);
  return manifest === undefined ? undefined : manifest.configSecrets ?? [];
}

/** A system named by the args: its declared secret fields, else the whole config. */
const systemConfig: SecretPaths = async (args, hub) => underConfig(await declaredBy(args['system'], hub));

/** A system not installed yet: its contract is unknown, so the whole config. */
const wholeConfig: SecretPaths = () => Promise.resolve([CONFIG]);

/** A pairing: its system's declared secret fields, else what it said of itself while waiting, else the whole config. */
const pairingConfig: SecretPaths = async (args, hub) => {
  const id = PairingId.safeParse(args['pairing']);
  const request = id.success ? await hub.store.table('pairings').get(id.data) : undefined;
  if (request === undefined) { return [CONFIG]; }
  return underConfig(await declaredBy(request.name, hub) ?? request.configSecrets);
};

/** A provider's keys (`ProviderInput`), wherever its kind keeps them. */
const providerKeys: SecretPaths = () => Promise.resolve(['apiKey', 'auth.apiKey', 'auth.secretAccessKey', 'auth.sessionToken']);

/** The fns whose args carry secrets, and where. */
export const SECRET_ARGS: ReadonlyMap<QualifiedName, SecretPaths> = new Map<QualifiedName, SecretPaths>([
  ['hub/configure_system', systemConfig],
  ['hub/add_instance', systemConfig],
  ['hub/install_system', wholeConfig],
  ['hub/install_package', wholeConfig],
  ['hub/approve_pairing', pairingConfig],
  ['hub/configure_provider', providerKeys],
]);

/** The name prefix of the secrets sealed for a run: only that run's executor reveals them. */
function prefixOf(run: RunId): string {
  return `run ${run} `;
}

/** Whether a value at a secret path is one to seal: text (but not `SECRET_KEPT`) or a record. */
function sealable(value: Json | undefined): boolean {
  if (typeof value === 'string') { return value !== SECRET_KEPT; }
  return value !== null && typeof value === 'object';
}

/** The hub's own instance, which the run secrets are sealed for (they are named for the run). */
const HUB_REF: InstanceRef = { system: SystemName.parse('hub'), instance: MAIN_INSTANCE };

/** Seals the secrets in the args of the fns that carry them (`SECRET_ARGS`). */
export class AdminArgSecrets implements RunArgSecrets {
  readonly #hub: Pick<HubServices, 'catalog' | 'store' | 'api'>;
  readonly #keeper: ConfigSecretKeeper;

  /** `hub`'s services are read when used (the api module's vault is built after execution). */
  constructor(hub: Pick<HubServices, 'catalog' | 'store' | 'api'>) {
    this.#hub = hub;
    this.#keeper = new ConfigSecretKeeper(() => hub.api.secrets);
  }

  async seal(input: { readonly run: RunId; readonly fn: QualifiedName; readonly args: Json; readonly owner: ActorId }): Promise<{ args: Json; invalid?: InvalidInput }> {
    const paths = SECRET_ARGS.get(input.fn);
    if (paths === undefined || !isJsonObject(input.args)) { return { args: input.args }; }
    const { args } = input;
    // a `{ $secret }` reference the caller wrote is refused, never revealed: only the hub seals secrets into args
    const refs = secretRefsIn(args);
    if (refs.length > 0) {
      const message = secretRefsRefusal(args, 'the args') ?? '';
      return { args, invalid: { source: 'validation', problems: refs.map((path) => ({ path, message })) } };
    }
    const secret = (await paths(args, this.#hub)).filter((path) => sealable(valueAt(args, path)));
    if (secret.length === 0) { return { args }; }
    const prefix = prefixOf(input.run);
    const { sealed } = await this.#keeper.seal(HUB_REF, args, undefined, secret, input.owner, (path) => `${prefix}${path}`);
    return { args: sealed };
  }

  async unseal(run: Pick<Run, 'id' | 'fn' | 'args'>): Promise<Json> {
    if (!SECRET_ARGS.has(run.fn)) { return run.args; }
    return this.#mapOwned(run, run.args, (_sealed, value) => this.#keeper.unseal(value));
  }

  async release(run: Pick<Run, 'id' | 'fn' | 'args'>): Promise<void> {
    if (!SECRET_ARGS.has(run.fn)) { return; }
    const owned: SecretId[] = [];
    await this.#mapOwned(run, run.args, (sealed) => { owned.push(sealed.$secret); return Promise.resolve(null); });
    for (const id of owned) { await this.#hub.api.secrets.remove(id); }
  }

  /**
   * Every sealed value in the args that was sealed for this run, mapped; any other (`{ $secret }` the caller wrote
   * itself, naming some other secret) is left as it is, so a run can't reveal a secret that isn't its own.
   */
  async #mapOwned(run: Pick<Run, 'id'>, value: Json, map: (sealed: SealedConfigSecret, value: Json) => Promise<Json>): Promise<Json> {
    const sealed = SealedConfigSecret.safeParse(value);
    if (sealed.success) {
      const row = await this.#hub.store.table('secrets').get(sealed.data.$secret);
      return row?.name.startsWith(prefixOf(run.id)) === true ? map(sealed.data, value) : value;
    }
    if (Array.isArray(value)) { return Promise.all(value.map((item) => this.#mapOwned(run, item, map))); }
    if (!isJsonObject(value)) { return value; }
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) { out[key] = await this.#mapOwned(run, item, map); }
    return out;
  }
}
