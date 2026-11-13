/**
 * Build 6: the hub link calls that read what people may or may not see, each checked as the person of the run it
 * names (its turn's user), or as the system itself without a run: `resource` (a whole read, or only some sections'
 * text) and `resourceSections`. And `grantPairing`, the one-time token an approved install run asks for. The run a
 * call names must be the asking system's own. The access and resource services are looked up when a call arrives.
 */
import { reject as refuse, spec, type HandlerFor } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, instanceLabel, isSettled, type ActorId, type LinkSession, type ResourceRead, type ResourceUri, type RunId, type SectionKey } from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import type { Asking, ResourceReader } from '../resources/index.ts';
import { PROPOSED_KEY } from '../execution/runs.ts';
import type { HubStore } from '../store/index.ts';
import type { ResourceRouter } from './index.ts';
import type { StorePairingService } from './pairing.ts';

const endpoints = hubLinkSpec.endpoints;

/** The slice of the hub link this module answers. */
export const READS_LINK_SPEC = spec({
  endpoints: { resource: endpoints.resource, resourceSections: endpoints.resourceSections, grantPairing: endpoints.grantPairing },
});
type ReadsSpec = typeof READS_LINK_SPEC;
type ReadsHandlers = { [K in keyof ReadsSpec['endpoints']]: HandlerFor<ReadsSpec, ReadsSpec['endpoints'][K]> };

/** What the reads use, each looked up when a call arrives. */
export interface LinkReadDeps {
  readonly store: () => HubStore;
  readonly access: (actor: ActorId) => Promise<AccessScope>;
  readonly router: () => Pick<ResourceRouter, 'read'>;
  readonly reader: () => Pick<ResourceReader, 'read' | 'outline'>;
  readonly pairing: () => Pick<StorePairingService, 'grant'>;
}

/**
 * Who a link call reads as: the person of the run it names, or the system's own actor without one. The run must be
 * the asking instance's own and still acting: not settled, or settled with an undo still to come (an undo acts for
 * the run it undoes).
 */
export async function askingOf(store: HubStore, link: LinkSession, run: RunId | undefined): Promise<Asking> {
  if (run !== undefined) {
    const row = await store.table('runs').get(run);
    if (row?.system !== link.system || (row.instance !== undefined && row.instance !== link.instance)) throw refuse(403, 'NOT_YOUR_RUN', `run ${run} is not ${instanceLabel(link)}'s`);
    if (isSettled(row.status) && (row.status === 'undone' || row.undo === undefined)) throw refuse(403, 'RUN_SETTLED', `run ${run} has settled`);
    // a run a system proposed for a person (a Claude permit) sits in the system's own turn but acts for that person
    const proposedFor = row.parent === undefined && row.key.startsWith(PROPOSED_KEY);
    const actor = proposedFor ? row.actor : (await store.table('turns').get(row.turn))?.user.id ?? row.actor;
    return { actor, run, ...(row.session === undefined ? {} : { session: row.session }) };
  }
  const actor = (await store.table('systems').get(link.system))?.actor;
  if (actor === undefined) throw refuse(403, 'NO_SYSTEM_ACTOR', `${link.system} has no actor to read as`);
  return { actor };
}

/** `askingOf` with what that actor may see. */
export async function readerOf(deps: Pick<LinkReadDeps, 'store' | 'access'>, link: LinkSession, run: RunId | undefined): Promise<{ asking: Asking; scope: AccessScope }> {
  const asking = await askingOf(deps.store(), link, run);
  return { asking, scope: await deps.access(asking.actor) };
}

/** A resource the reader may not see reads as missing, as it does in the browser. */
function needSeen(scope: AccessScope, uri: ResourceUri): void {
  if (!scope.seesUri(uri)) throw refuse(404, 'RESOURCE_NOT_FOUND', `no resource ${uri}`);
}

/** The handlers. */
export function linkReadHandlers(deps: LinkReadDeps): ReadsHandlers {
  return {
    resource: async ({ data, link, signal }): Promise<ResourceRead> => {
      const { asking, scope } = await readerOf(deps, link, data.run);
      needSeen(scope, data.uri);
      const read = await deps.router().read(data.uri, data.want, signal);
      if (data.sections === undefined) return read;
      // only the named sections' text, in the order asked, each under its heading line
      const texts = await Promise.all(data.sections.map(async (section: SectionKey) => (await deps.reader().read({ uri: data.uri, section }, asking)).text));
      return { ...read, text: { inline: texts.join('\n\n') } };
    },
    resourceSections: async ({ data, link }) => {
      const { asking, scope } = await readerOf(deps, link, data.run);
      needSeen(scope, data.uri);
      return deps.reader().outline(data.uri, asking);
    },
    grantPairing: ({ data, link }) => deps.pairing().grant(data, { system: link.system, instance: link.instance }),
  };
}

/** The reads as an `@ayepi/plugin` on the hub link (the link module binds `linkSession`). */
export function linkReadsPlugin(deps: LinkReadDeps) {
  return plugin({ name: 'link.reads', spec: READS_LINK_SPEC }).handlers(() => linkReadHandlers(deps));
}
