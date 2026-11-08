/**
 * Where a link's target opens in the app: a context item's page, a resource in the resource browser (at its section),
 * and a fn's admin page for admins. Types have no page of their own. Kept apart from `context.ts` because the route
 * table reads that file's query schemas.
 */
import type { LinkTarget } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { links } from '../../app/routes.ts';

/** The page a link target opens, if it has one the person may see. */
export function targetRoute(target: LinkTarget, admin: boolean): RouteLocationRaw | undefined {
  switch (target.kind) {
    case 'context': return links.contextItem(target.name);
    case 'fn': return admin ? links.fn(target.name) : undefined;
    case 'resource': return links.resources({ uri: target.uri, ...(target.section === undefined ? {} : { section: target.section }) });
    case 'type': return undefined;
  }
}
