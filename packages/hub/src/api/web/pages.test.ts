/**
 * System pages (item 9): the hub lists a system's pages while it is installed and live, with its renderers on and its
 * client build shipped, for the people who may see it (admin-only pages for admins); the nav and routes follow it, so a
 * page leaves when its system is switched off, removed, held for review or not yet live.
 */
import { ActorId, SystemName, SystemPageDecl, type Manifest, type SystemPageInput } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope } from '../../access/index.ts';
import { StoreCatalog } from '../../catalog/catalog.ts';
import { manifestFor, shop, systemRow } from '../../catalog/fixtures.ts';
import { pageItemName, SystemLifecycle, clientItemName } from '../../link/lifecycle.ts';
import { memoryLog, RecordingBus, testStore } from '../../testing.ts';
import { systemPagesFor, type PagesHub } from './pages.ts';

const SHOP = SystemName.parse('shop');
const ADMIN = { id: ActorId.parse('act_admin'), role: 'admin' as const };
const MEMBER = { id: ActorId.parse('act_ada'), role: 'member' as const };
const PAGES: SystemPageInput[] = [
  { segment: 'orders', title: 'Orders', icon: 'inbox', component: 'OrdersPage' },
  { segment: 'order', title: 'Order', nav: 'hidden', component: 'OrderPage' },
  { segment: 'stock', title: 'Stock', access: 'admin', component: 'StockPage' },
];
const BUILD = { entry: 'index.js', hash: 'abc123', files: [{ path: 'index.js', size: 10, hash: 'abc123' }] };

async function world(options: { readonly client?: boolean; readonly hidden?: string } = {}) {
  const store = await testStore();
  const bus = new RecordingBus();
  const { log } = memoryLog();
  const catalog = new StoreCatalog({ store, bus, log, clock: () => 1, describer: { describe: () => Promise.resolve({ problems: [] }) } });
  const base = await manifestFor(shop);
  const manifest: Manifest = { ...base, pages: PAGES.map((page) => SystemPageDecl.parse(page)), ...(options.client === false ? {} : { client: BUILD }) };
  await catalog.importManifest(manifest);
  await store.table('systems').put(systemRow('shop', 'connected', { stage: 'live' }));
  const lifecycle = new SystemLifecycle({ store, catalog, bus, log, clock: () => 1, settings: { HARNESS_REVIEW_SYSTEMS: false } });
  const hidden = options.hidden;
  const hub: PagesHub = {
    store, catalog, link: { lifecycle },
    access: { scope: (actor) => Promise.resolve(hidden === undefined ? openScope(actor) : { ...openScope(actor), seesSystem: (system: string) => system !== hidden }) },
  };
  return { store, hub };
}

const segments = async (hub: PagesHub, viewer: typeof ADMIN | typeof MEMBER = ADMIN): Promise<string[]> => (await systemPagesFor(hub, viewer)).map((page) => page.segment);

describe('systemPagesFor', () => {
  it('lists a live system’s pages with its client build, in the order the contract declares them', async () => {
    const { hub } = await world();
    const pages = await systemPagesFor(hub, ADMIN);
    expect(pages.map((page) => page.segment)).toEqual(['orders', 'order', 'stock']);
    expect(pages[0]).toMatchObject({ system: 'shop', title: 'Orders', icon: 'inbox', nav: 'main', access: 'everyone', component: 'OrdersPage' });
    const url: unknown = expect.stringContaining('/shop/abc123/index.js');
    expect(pages[0]?.client).toEqual({ url, hash: 'abc123' });
  });

  it('leaves admin-only pages out for everyone else', async () => {
    const { hub } = await world();
    expect(await segments(hub, MEMBER)).toEqual(['orders', 'order']);
  });

  it('lists none for a system the person may not see', async () => {
    const { hub } = await world({ hidden: 'shop' });
    expect(await segments(hub)).toEqual([]);
  });

  it('lists none without a client build to draw them', async () => {
    const { hub } = await world({ client: false });
    expect(await segments(hub)).toEqual([]);
  });

  it('keeps them while the system is offline or waits on its config, and drops them once it is removed', async () => {
    const { store, hub } = await world();
    await store.table('systems').put(systemRow('shop', 'disconnected', { stage: 'live' }));
    expect(await segments(hub)).toHaveLength(3);
    await store.table('systems').put(systemRow('shop', 'needs-config', { stage: 'live' }));
    expect(await segments(hub)).toHaveLength(3);
    await store.table('systems').put(systemRow('shop', 'removed', { stage: 'live' }));
    expect(await segments(hub)).toEqual([]);
  });

  it('lists none while the system is installed but not live, and counts a row from before stages as live', async () => {
    const { store, hub } = await world();
    await store.table('systems').put(systemRow('shop', 'connected', { stage: 'installed' }));
    expect(await segments(hub)).toEqual([]);
    await store.table('systems').put(systemRow('shop', 'connected'));
    expect(await segments(hub)).toHaveLength(3);
  });

  it('drops them when an admin turns the system’s renderers off', async () => {
    const { store, hub } = await world();
    await store.table('systems').put(systemRow('shop', 'connected', { stage: 'live', enabled: { functions: true, renderers: false } }));
    expect(await segments(hub)).toEqual([]);
  });

  it('drops a page switched off, and every page when the client build is', async () => {
    const { store, hub } = await world();
    await store.table('itemSwitches').put({ system: SHOP, section: 'components', name: pageItemName(SHOP, 'orders'), by: ADMIN.id, at: 1 });
    expect(await segments(hub)).toEqual(['order', 'stock']);
    await store.table('itemSwitches').put({ system: SHOP, section: 'components', name: clientItemName(SHOP), by: ADMIN.id, at: 1 });
    expect(await segments(hub)).toEqual([]);
  });

  it('holds a page that waits for review', async () => {
    const { store, hub } = await world();
    // what waits is the contract the hub has (a review is made as it arrives)
    const hash = (await hub.catalog.manifest(SHOP))?.hash ?? '';
    await store.table('systemReviews').put({
      system: SHOP, updatedAt: 1,
      pending: { version: '1.1.0', hash, by: 'contract', since: 1, changes: [{ section: 'components', name: pageItemName(SHOP, 'stock'), change: 'added', origin: 'contract' }] },
    });
    expect(await segments(hub)).toEqual(['orders', 'order']);
  });

});
