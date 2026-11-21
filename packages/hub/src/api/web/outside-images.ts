/**
 * Images from outside the hub in markdown (M4): the admin's setting, kept as the hub option `outsideImages`
 * (`core/urls.ts`). Everyone signed in reads it (their chat holds such images behind a click unless it says `always`);
 * admins set it. Nothing stored means the secure default, `ask`.
 */
import { plugin } from '@ayepi/plugin';
import { OUTSIDE_IMAGES_DEFAULT, OUTSIDE_IMAGES_OPTION, outsideImagesSlice, type ActorId, type OutsideImages, type OutsideImagesView } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { HubStore } from '../../store/index.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The setting in use: the stored choice, else the default. */
export async function readOutsideImages(store: HubStore): Promise<OutsideImagesView> {
  const row = await store.table('hubOptions').get(OUTSIDE_IMAGES_OPTION);
  return row?.key === OUTSIDE_IMAGES_OPTION ? { value: row.value, setBy: row.setBy, updatedAt: row.updatedAt } : { value: OUTSIDE_IMAGES_DEFAULT };
}

/** Store the admin's choice. */
export async function setOutsideImages(store: HubStore, value: OutsideImages, by: ActorId, now: number): Promise<OutsideImagesView> {
  await store.table('hubOptions').put({ key: OUTSIDE_IMAGES_OPTION, value, setBy: by, updatedAt: now });
  return readOutsideImages(store);
}

/** The outside-images plugin. Requires the systems plugin, which binds `adminOnly`. */
export function outsideImagesPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.outsideImages', spec: outsideImagesSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof outsideImagesSlice> => ({
      outsideImages: () => readOutsideImages(hub.store),
      setOutsideImages: ({ data, user }) => setOutsideImages(hub.store, data.value, user.id, hub.clock()),
    }));
}
