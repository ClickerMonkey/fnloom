/**
 * The chat's results host: the query visuals that can draw a result, the app's own and those systems contribute from their
 * client bundles (the hub's `contributions` say which bundles to load; each visual's label and icon come from its
 * contract), and the visual the person picked for each
 * result, kept per message while the app is open (not in the URL).
 */
import type { QualifiedName, ResultFacts, ResultTable } from '@harness/core';
import type { VisualSource } from '@harness/sdk';
import { markRaw, shallowRef } from 'vue';
import { OWN_VISUALS, type ResultsHost } from '../../components/results/builtin.ts';
import { isIconName, rankedVisuals, type RankedVisual, type Visual, type VisualChoice } from '../../components/results/visuals.ts';
import type { ChatApi } from '../api.ts';
import type { RendererHub } from './renderers.ts';

/** What the host is built from. */
export interface VisualHostDeps {
  readonly api: Pick<ChatApi, 'contributions'>;
  readonly renderers: Pick<RendererHub, 'contributedVisuals'>;
  /** Load the systems' client bundles, unless they are loaded. */
  readonly prepare: () => Promise<void>;
}

/** The chat's query visuals and the choices made between them. */
export class VisualHost implements ResultsHost {
  readonly #deps: VisualHostDeps;
  readonly #choices = shallowRef<ReadonlyMap<string, VisualChoice>>(new Map());
  readonly #asked = new Map<QualifiedName, Promise<void>>();

  /**
   * The SDK's `VISUALS` source, for a system's own result view (an attachment renderer): every loaded contribution
   * that fits, the registry's bundles loading on the first ask.
   */
  readonly source: VisualSource = {
    visuals: (registry, table, facts) => {
      void this.prepare(registry);
      return this.#deps.renderers.contributedVisuals(registry, table, facts);
    },
  };

  constructor(deps: VisualHostDeps) {
    this.#deps = deps;
  }

  /** The app's own visuals and every loaded contribution its veto keeps, ranked together (product's order). */
  visuals(registry: QualifiedName, table: ResultTable, facts: ResultFacts): readonly RankedVisual[] {
    const contributed = this.#deps.renderers.contributedVisuals(registry, table, facts).map((entry): Visual => ({
      name: entry.name, label: entry.label, icon: isIconName(entry.icon) ? entry.icon : 'layers', system: entry.system,
      shape: entry.shape, component: markRaw(entry.component), props: { system: entry.client },
    }));
    return rankedVisuals(OWN_VISUALS, contributed, table, facts);
  }

  /** Ask once per registry which systems contribute to it, then make sure their bundles are loading. */
  prepare(registry: QualifiedName): Promise<void> {
    const asked = this.#asked.get(registry);
    if (asked !== undefined) { return asked; }
    const made = (async () => {
      try {
        const views = await this.#deps.api.contributions.call({ registry });
        if (views.length > 0) { await this.#deps.prepare(); }
      } catch (error) {
        // the app's own visuals still draw it; ask again next time
        this.#asked.delete(registry);
        console.error('chat.visuals.contributions-failed', { registry, error });
      }
    })();
    this.#asked.set(registry, made);
    return made;
  }

  choice(key: string): VisualChoice | undefined {
    return this.#choices.value.get(key);
  }

  choose(key: string, choice: VisualChoice): void {
    this.#choices.value = new Map([...this.#choices.value, [key, choice]]);
  }
}
