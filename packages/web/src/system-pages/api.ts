/** The system pages caller (item 9), made once from the one hub client: the pages of live systems the person may open. */
import type { Hub } from '../api/client.ts';

/** Make the system pages callers. */
export function systemPagesApi(hub: Hub) {
  return {
    systemPages: hub.caller('systemPages', { dedupe: true }),
  };
}

/** The system pages callers. */
export type SystemPagesApi = ReturnType<typeof systemPagesApi>;
