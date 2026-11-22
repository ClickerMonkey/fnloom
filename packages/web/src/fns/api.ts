/**
 * The callers of a fn's view, made once from the one hub client: finding the fn (its description, kind and
 * signature) by a search in the hub's database, its facts (mode, types read and written, cost, run times) and pages
 * of its examples. Open to every signed-in person, for the fns they may see. Stores receive only the callers they use.
 */
import type { Hub } from '../api/client.ts';

/** Make the fn view's callers. */
export function fnsApi(hub: Hub) {
  return {
    searchFns: hub.caller('searchFns', { cache: { ttl: 30_000 }, dedupe: true }),
    fnFacts: hub.caller('fnFacts', { dedupe: true }),
    fnExamples: hub.caller('fnExamples', { dedupe: true }),
    fnsOfModelNames: hub.caller('fnsOfModelNames', { dedupe: true }),
  };
}

/** The fn view's callers. */
export type FnsApi = ReturnType<typeof fnsApi>;
