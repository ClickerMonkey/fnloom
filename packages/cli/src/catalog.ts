/**
 * The hub's catalog as `@harness/build` asks it (`CatalogLookup`): which of the names a context folder links to exist,
 * by exact name over the web API (`fns` and `contexts` filtered `name in [...]`), never by listing the whole catalog.
 */
import type { CatalogLookup, KnownToBuild } from '@harness/build';
import type { HubSession } from './hub.ts';

/** The most names one filter carries; more are asked in further calls. */
const NAMES_PER_CALL = 100;

/** Names in groups of `NAMES_PER_CALL`. */
function groups(names: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let start = 0; start < names.length; start += NAMES_PER_CALL) { out.push(names.slice(start, start + NAMES_PER_CALL)); }
  return out;
}

/** A `CatalogLookup` over a signed-in hub session (an admin's, as the `fns` list needs). */
export function hubCatalog(session: Pick<HubSession, 'api'>): CatalogLookup {
  return {
    async existing(names: KnownToBuild): Promise<KnownToBuild> {
      const fns: string[] = [];
      for (const group of groups(names.fns)) {
        const page = await session.api.call('fns', { filters: [{ field: 'name', op: 'in', values: group }], limit: group.length });
        fns.push(...page.items.map((fn) => fn.name));
      }
      const context: string[] = [];
      for (const group of groups(names.context)) {
        const page = await session.api.call('contexts', { query: { filters: [{ field: 'name', op: 'in', values: group }], limit: group.length } });
        context.push(...page.items.map((item) => item.name));
      }
      return { fns, context };
    },
  };
}
