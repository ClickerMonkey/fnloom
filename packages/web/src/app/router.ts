/**
 * The router: the route table over browser history, with a guard that sends signed-out visitors to sign-in and brings
 * them back to where they were, keeps the signed-in away from the sign-in page, and keeps the admin area for admins.
 */
import { createRouter, type Router, type RouterHistory } from 'vue-router';
import type { SessionStore } from '../state/session.ts';
import { links, ROUTES, routes, safeNext } from './routes.ts';

/** Make the app's router. */
export function createAppRouter(session: Pick<SessionStore, 'signedIn' | 'user'>, history: RouterHistory): Router {
  const router = createRouter({ history, routes, scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 } });
  router.beforeEach((to) => {
    const signedIn = session.signedIn.value;
    if (to.name === ROUTES.signIn && signedIn) { return safeNext(to.query['next']) ?? links.chat(); }
    if (to.meta.public === true) { return true; }
    if (!signedIn) { return links.signIn(to.fullPath); }
    // the admin area is for admins; anyone else lands in the chat
    return to.meta.admin === true && session.user.value?.role !== 'admin' ? links.chat() : true;
  });
  return router;
}
