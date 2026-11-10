/**
 * The chat's results host: the query visuals that fit a result, the app's own and those systems contribute from their
 * client bundles (named by the hub's `contributions`, labelled from them), and the visual the person picked for each
 * result, kept per message while the app is open (not in the URL).
 */
import { humanize, type ContributionView, type QualifiedName, type ResultTable } from '@harness/core';
import type { VisualSource } from '@harness/sdk';
import { markRaw, shallowRef } from 'vue';
import { OWN_VISUALS, type ResultsHost } from '../../components/results/builtin.ts';
import { fittingVisuals, isIconName, type FittingVisual, type Visual } from '../../components/results/visuals.ts';
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
  readonly #contributions = shallowRef<ReadonlyMap<QualifiedName, readonly ContributionView[]>>(new Map());
  readonly #choices = shallowRef<ReadonlyMap<string, string>>(new Map());
  readonly #asked = new Map<QualifiedName, Promise<void>>();

  /**
   * The SDK's `VISUALS` source, for a system's own result view (an attachment renderer): every loaded contribution
   * that fits, the registry's bundles loading on the first ask.
   */
  readonly source: VisualSource = {
    visuals: (registry, table) => {
      void this.prepare(registry);
      return this.#deps.renderers.contributedVisuals(registry, table);
    },
  };

  constructor(deps: VisualHostDeps) {
    this.#deps = deps;
  }

  visuals(registry: QualifiedName, table: ResultTable): readonly FittingVisual[] {
    const views = this.#contributions.value.get(registry) ?? [];
    const contributed = this.#deps.renderers.contributedVisuals(registry, table).map((entry): Visual => {
      const view = views.find((v) => v.system === entry.system && v.name === entry.name);
      const icon = view?.icon;
      return {
        name: entry.name, label: view?.label ?? humanize(entry.name), icon: isIconName(icon) ? icon : 'layers', system: entry.system,
        match: () => entry.fit, component: markRaw(entry.component), props: entry.props,
      };
    });
    return fittingVisuals(OWN_VISUALS, contributed, table);
  }

  /** Ask once per registry which systems contribute to it, then make sure their bundles are loading. */
  prepare(registry: QualifiedName): Promise<void> {
    const asked = this.#asked.get(registry);
    if (asked !== undefined) { return asked; }
    const made = (async () => {
      try {
        const views = await this.#deps.api.contributions.call({ registry });
        this.#contributions.value = new Map([...this.#contributions.value, [registry, views]]);
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

  choice(key: string): string | undefined {
    return this.#choices.value.get(key);
  }

  choose(key: string, visual: string): void {
    this.#choices.value = new Map([...this.#choices.value, [key, visual]]);
  }
}
