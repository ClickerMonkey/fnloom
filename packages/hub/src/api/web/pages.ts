/**
 * System pages (item 9): the pages a person may open, from the contracts of the systems that are installed and live.
 * A page is listed while its system is (connected, offline for a moment, or waiting on its config: the page itself says
 * so), has gone live, has its renderers on, ships a client build, and neither the build nor the page is switched off or
 * waiting for review. Removed and paired-but-not-live systems list none, so their pages leave the nav and a stale link
 * shows "not installed". Admin-only pages are left out for everyone else.
 */
import { SystemStatus, type Manifest, type SystemPageView, type SystemName, type SystemRecord } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { clientItemName, pageItemName } from '../../link/lifecycle.ts';
import { allRows } from '../../store/rows.ts';
import type { Viewer } from './access.ts';
import { clientUrl } from './chat.ts';

/** What the pages read uses. */
export interface PagesHub {
  readonly store: Pick<HubServices['store'], 'table'>;
  readonly catalog: Pick<HubServices['catalog'], 'manifest'>;
  readonly access: Pick<HubServices['access'], 'scope'>;
  readonly link: { readonly lifecycle: Pick<HubServices['link']['lifecycle'], 'off'> };
}

/** The statuses of an installed system: everything but pairing and removed. */
const INSTALLED = SystemStatus.options.filter((status) => status !== 'pairing' && status !== 'removed');

/** The installed systems that went live (rows from before build 7 have no stage and are live), read in the database. */
async function liveSystems(hub: Pick<PagesHub, 'store'>): Promise<SystemRecord[]> {
  const table = hub.store.table('systems');
  const status = { in: INSTALLED };
  const [live, unstaged] = await Promise.all([
    allRows(table, { where: { status, stage: 'live' } }),
    allRows(table, { where: { status, stage: { exists: false } } }),
  ]);
  return [...live, ...unstaged];
}

/** A system's pages a viewer may open, with where its client build is; none without a build. */
function pagesOf(system: SystemName, manifest: Manifest | undefined, off: ReadonlySet<string>, viewer: Viewer): SystemPageView[] {
  const build = manifest?.client;
  if (build === undefined || off.has(clientItemName(system))) { return []; }
  const client = { url: clientUrl(system, build.hash, build.entry), hash: build.hash };
  return (manifest?.pages ?? [])
    .filter((page) => !off.has(pageItemName(system, page.segment)) && (page.access === 'everyone' || viewer.role === 'admin'))
    .map((page) => ({ ...page, system, client }));
}

/** The pages a person may open, by system then in the order each contract declares them. */
export async function systemPagesFor(hub: PagesHub, viewer: Viewer): Promise<SystemPageView[]> {
  const [systems, scope, off] = await Promise.all([liveSystems(hub), hub.access.scope(viewer.id), hub.link.lifecycle.off('components')]);
  const shown = systems.filter((record) => record.enabled.renderers && scope.seesSystem(record.name)).sort((a, b) => a.name.localeCompare(b.name));
  const manifests = await Promise.all(shown.map(async (record) => ({ system: record.name, manifest: await hub.catalog.manifest(record.name) })));
  return manifests.flatMap(({ system, manifest }) => pagesOf(system, manifest, off, viewer));
}
