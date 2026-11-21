/** Callers for the outside-images setting: everyone signed in reads it, admins set it. */
import type { Hub } from './client.ts';

/** Make the outside-images callers. */
export function outsideImagesApi(hub: Hub) {
  return {
    outsideImages: hub.caller('outsideImages', { dedupe: true }),
    setOutsideImages: hub.caller('setOutsideImages'),
  };
}

/** The outside-images callers. */
export type OutsideImagesApi = ReturnType<typeof outsideImagesApi>;
