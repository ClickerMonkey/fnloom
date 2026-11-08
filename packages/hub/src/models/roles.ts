/**
 * Model roles in the hub store (`ModelRoles`, table `modelRoles`): which model, and optionally which configured
 * provider, does each job the hub picks a model for itself. A role without a stored choice falls back to its env
 * default (`HARNESS_DEFAULT_MODEL` for chat; `HARNESS_TRANSCRIBE_MODEL` for transcription and a model-engine dictation)
 * or is off. A choice resolves against the models configured providers offer, and a model that can't do the role's
 * job (a chat model asked to hear audio) is reported as a problem, not used.
 */
import type { ModelCapability } from '@aeye/ai';
import type { Logger } from '@ayepi/log';
import {
  MODEL_ROLES, namesModel, ROLE_CAPABILITY, type ActorId, type ChatCapabilities, type ModelChoice, type ModelInfo, type ModelRole, type ModelRoleView, type ProviderId, type ResolvedRole, type RoleChoice, type RoleModel, type RoleResolution,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { HubStore } from '../store/index.ts';
import type { ModelRoles } from './index.ts';

/** The capability a role's model must have, by role: core's words, which must be capabilities aeye knows (a rename there fails to compile here). */
const ROLE_ABILITIES: Record<ModelRole, ModelCapability> = ROLE_CAPABILITY;

/** The env defaults roles fall back to. */
export interface RoleDefaults {
  readonly HARNESS_DEFAULT_MODEL: string;
  readonly HARNESS_TRANSCRIBE_MODEL: string;
}

/** What the roles use. */
export interface ModelRolesDeps {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly log: Logger;
  readonly defaults: RoleDefaults;
  /** The models configured providers offer now. */
  readonly models: () => Promise<readonly ModelInfo[]>;
}

/** A role's env default, or undefined when the role has none (it is off). */
export function defaultChoice(role: ModelRole, defaults: RoleDefaults): RoleChoice | undefined {
  const transcribe = defaults.HARNESS_TRANSCRIBE_MODEL;
  switch (role) {
    case 'chat': return defaults.HARNESS_DEFAULT_MODEL === '' ? undefined : { role, model: { model: defaults.HARNESS_DEFAULT_MODEL } };
    case 'transcribe': return transcribe === '' ? undefined : { role, model: { model: transcribe } };
    case 'dictate': return transcribe === '' ? undefined : { role, engine: { engine: 'model', model: { model: transcribe } } };
    case 'speak': case 'describe': case 'ocr': return undefined;
  }
}

/** The model a role's choice names, or undefined for dictation in the browser (no model call). */
export function roleModel(choice: RoleChoice): RoleModel | undefined {
  if (choice.role !== 'dictate') return { model: choice.model, ...(choice.provider === undefined ? {} : { provider: choice.provider }) };
  return choice.engine.engine === 'browser' ? undefined : { model: choice.engine.model, ...(choice.engine.provider === undefined ? {} : { provider: choice.engine.provider }) };
}

/**
 * Resolve a model choice for a role against the offered models: an id as it is, a category as its first model, and
 * automatic selection as the cheapest offered model with the role's capability. A pinned provider must offer it.
 */
export function resolveChoice(
  role: ModelRole, wanted: RoleModel, offered: readonly ModelInfo[], kindOf: (provider: ProviderId) => string | undefined, categories: ReadonlyMap<string, readonly string[]>,
): RoleResolution {
  const capability = ROLE_ABILITIES[role];
  const pinned = wanted.provider === undefined ? undefined : kindOf(wanted.provider);
  if (wanted.provider !== undefined && pinned === undefined) return { problem: `There is no provider ${wanted.provider}.` };
  const candidates = offered.filter((model) => pinned === undefined || model.provider === pinned);
  const id = idOf(wanted.model, categories);
  if (id === undefined) {
    const able = candidates.filter((model) => model.capabilities.includes(capability))
      .sort((a, b) => (a.pricing?.input ?? 0) - (b.pricing?.input ?? 0));
    const best = able[0];
    return best === undefined ? { problem: `No configured provider offers a model that can do ${capability}.` } : { model: best.id, provider: best.provider };
  }
  const found = candidates.find((model) => namesModel(id, model));
  if (found === undefined) {
    return pinned === undefined ? { problem: `No configured provider offers ${id}.` } : { model: id, provider: pinned };
  }
  if (!found.capabilities.includes(capability)) return { problem: `${found.id} can't do ${capability}, which ${role} needs.` };
  return { model: found.id, provider: found.provider };
}

/** A choice's model id: itself, a category's first model; undefined for automatic selection (or an empty category). */
function idOf(choice: ModelChoice, categories: ReadonlyMap<string, readonly string[]>): string | undefined {
  if ('model' in choice) return choice.model;
  if ('category' in choice) return categories.get(choice.category)?.[0];
  return undefined;
}

/** Model roles on the hub store. */
export class StoreModelRoles implements ModelRoles {
  readonly #deps: ModelRolesDeps;

  constructor(deps: ModelRolesDeps) {
    this.#deps = deps;
  }

  async list(): Promise<ModelRoleView[]> {
    return Promise.all(MODEL_ROLES.map((role) => this.get(role)));
  }

  async get(role: ModelRole): Promise<ModelRoleView> {
    const stored = await this.#deps.store.table('modelRoles').get(role);
    const fallback = defaultChoice(role, this.#deps.defaults);
    const choice = stored?.choice ?? fallback;
    const from = stored !== undefined ? 'setting' : fallback === undefined ? 'none' : 'env';
    if (choice === undefined) return { role, from };
    const wanted = roleModel(choice);
    if (wanted === undefined) return { role, choice, from };
    return { role, choice, from, resolved: await this.#resolve(role, wanted) };
  }

  async set(choice: RoleChoice, by: ActorId): Promise<ModelRoleView> {
    await this.#deps.store.table('modelRoles').put({ choice, setBy: by, updatedAt: this.#deps.clock() });
    this.#deps.log.info('model.role.set', { role: choice.role, by });
    this.#deps.bus.publish('capabilities.changed', {});
    return this.get(choice.role);
  }

  async clear(role: ModelRole, by: ActorId): Promise<ModelRoleView> {
    const removed = await this.#deps.store.table('modelRoles').remove(role);
    if (removed) {
      this.#deps.log.info('model.role.cleared', { role, by });
      this.#deps.bus.publish('capabilities.changed', {});
    }
    return this.get(role);
  }

  async resolve(role: ModelRole): Promise<ResolvedRole | undefined> {
    const view = await this.get(role);
    return view.resolved !== undefined && 'model' in view.resolved ? view.resolved : undefined;
  }

  /** A model choice against what configured providers offer now. */
  async #resolve(role: ModelRole, wanted: RoleModel): Promise<RoleResolution> {
    const { store } = this.#deps;
    const [offered, providers, categories] = await Promise.all([
      this.#deps.models(),
      store.table('providers').find({ limit: 100 }),
      'category' in wanted.model ? store.table('modelCategories').find({ where: { name: wanted.model.category }, limit: 1 }) : Promise.resolve({ items: [] }),
    ]);
    const kinds = new Map(providers.items.map((p) => [p.id, p.config.provider]));
    return resolveChoice(role, wanted, offered, (id) => kinds.get(id), new Map(categories.items.map((c) => [c.name, c.models])));
  }
}

/** How the composer hears voice input, from the dictation role: undefined while it can't be heard at all. */
export function dictationOf(view: ModelRoleView): ChatCapabilities['dictation'] {
  if (view.choice?.role !== 'dictate') return undefined;
  const language = view.choice.language === undefined ? {} : { language: view.choice.language };
  if (view.choice.engine.engine === 'browser') return { engine: 'browser', ...language };
  return view.resolved !== undefined && 'model' in view.resolved ? { engine: 'model', ...language } : undefined;
}
