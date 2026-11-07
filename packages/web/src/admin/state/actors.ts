/**
 * The people, groups, agents and systems the hub knows, fetched once for the admin pages that name or pick actors
 * (budgets, priorities, policies, actor settings). `nameOf` turns an id into a name, falling back to the id.
 */
import type { Actor, ActorId, ActorKind } from '@harness/core';
import { computed } from 'vue';
import { Loaded } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import type { NameOf } from '../logic/limits.ts';

/** An actor offered in a picker. */
export interface ActorOption {
  readonly id: ActorId;
  readonly name: string;
  readonly kind: ActorKind;
  readonly detail: string;
}

/** The hub's actors. */
export class ActorsDirectory {
  readonly #api: Pick<AdminApi, 'actors'>;
  readonly list = new Loaded<readonly Actor[]>();
  readonly #byId = computed(() => new Map((this.list.value.value ?? []).map((actor) => [actor.id, actor])));

  constructor(api: Pick<AdminApi, 'actors'>) {
    this.#api = api;
  }

  /** Fetch the actors, unless they are here already (or `again`). */
  async load(again = false): Promise<void> {
    if (!again && (this.list.value.value !== undefined || this.list.loading.value)) { return; }
    await this.list.load(() => this.#api.actors.call({}), "Couldn't load people and groups.");
  }

  /** An actor's name, or its id when unknown. */
  readonly nameOf: NameOf = (id) => this.#byId.value.get(id)?.name ?? id;

  /** The actors of some kinds, as picker options, by name. */
  options(kinds: readonly ActorKind[]): ActorOption[] {
    return (this.list.value.value ?? [])
      .filter((actor) => kinds.includes(actor.kind) && !actor.disabled)
      .map((actor) => ({ id: actor.id, name: actor.name, kind: actor.kind, detail: actor.kind === 'user' ? actor.email : actor.about }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
