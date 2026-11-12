/**
 * Choosing and running a sectioner for a resource. A user's section rule beats any system default; among rules,
 * and among defaults, the most specific match wins. Defaults are the serving system's own sectioners, then the
 * hub's (whose `hub/whole` matches everything). Matching sees the form a resource is read in (its primary form), so
 * a web page read as markdown gets `hub/headings` and a spreadsheet read as tables gets `hub/tables`. The hub's
 * sectioners run here over that form's text; a system's run on that system.
 */
import type { FormKind, QualifiedName, ResourceStat, ResourceUri, Section, SystemName } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../store/rows.ts';
import type { ResourceRouter } from '../link/index.ts';
import type { HubStore } from '../store/index.ts';
import { hubSectioners, matchScore, type SectionInput, type Sectioner } from './sectioners.ts';

/** The best-scoring candidate, or undefined when none fits. */
function best<T>(candidates: readonly T[], score: (candidate: T) => number | undefined): T | undefined {
  let found: { candidate: T; score: number } | undefined;
  for (const candidate of candidates) {
    const s = score(candidate);
    if (s !== undefined && (found === undefined || s > found.score)) { found = { candidate, score: s }; }
  }
  return found?.candidate;
}

/** Picks sectioners and cuts resources with them. */
export class Sectioning {
  readonly #store: HubStore;
  readonly #catalog: Catalog;
  readonly #router: ResourceRouter;
  readonly #hub: ReadonlyMap<string, Sectioner>;

  constructor(options: { store: HubStore; catalog: Catalog; router: ResourceRouter; hub?: readonly Sectioner[] }) {
    this.#store = options.store;
    this.#catalog = options.catalog;
    this.#router = options.router;
    this.#hub = new Map((options.hub ?? hubSectioners()).map((s) => [s.name, s]));
  }

  /** The sectioner for a resource served by `system`, read in `form` (its raw text when absent). */
  async choose(stat: ResourceStat, system: SystemName, form?: FormKind): Promise<QualifiedName> {
    const rule = best(await allRows(this.#store.table('sectionRules')), (r) => matchScore(r.match, stat, form));
    if (rule !== undefined) { return rule.sectioner; }
    // a sectioner an admin switched off is passed over for the hub's
    const off = new Set((await allRows(this.#store.table('itemSwitches'), { where: { system, section: 'sectioners' } })).map((row) => row.name));
    const own = best((await this.#catalog.entries('sectioners', { system })).filter((e) => !off.has(e.name)), (e) => matchScore(e.decl.match, stat, form));
    if (own !== undefined) { return own.name; }
    const hub = best([...this.#hub.values()], (s) => matchScore(s.match, stat, form));
    if (hub === undefined) { throw new Error('the hub has no sectioner that matches everything'); }
    return hub.name;
  }

  /** Cut a resource's text with a sectioner: the hub's here (over the form given), a system's over its link. */
  cut(sectioner: QualifiedName, uri: ResourceUri, input: SectionInput): Promise<Section[]> {
    const local = this.#hub.get(sectioner);
    return local === undefined ? this.#router.sections(sectioner, uri, input.stat.version) : Promise.resolve(local.sections(input));
  }
}
