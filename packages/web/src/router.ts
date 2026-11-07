/**
 * Every page is a URL, so a refresh returns to the same place: the chat and its session, the admin pages and the
 * system being looked at. Signed-out visitors go to sign-in and come back to where they were.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { signedIn } from './state/session.ts';

/** The route names, so links can't point at a page that doesn't exist. */
export const ROUTES = {
  signIn: 'sign-in',
  chat: 'chat',
  session: 'session',
  systems: 'systems',
  system: 'system',
  settings: 'settings',
  notFound: 'not-found',
} as const;

const routes: RouteRecordRaw[] = [
  { path: '/sign-in', name: ROUTES.signIn, component: () => import('./pages/SignInPage.vue'), meta: { public: true } },
  { path: '/', redirect: { name: ROUTES.chat } },
  { path: '/chat', name: ROUTES.chat, component: () => import('./pages/ChatPage.vue') },
  { path: '/chat/:session', name: ROUTES.session, component: () => import('./pages/ChatPage.vue'), props: true },
  { path: '/admin/systems', name: ROUTES.systems, component: () => import('./pages/SystemsPage.vue') },
  { path: '/admin/systems/:name', name: ROUTES.system, component: () => import('./pages/SystemsPage.vue'), props: true },
  { path: '/settings', name: ROUTES.settings, component: () => import('./pages/SettingsPage.vue') },
  { path: '/:rest(.*)*', name: ROUTES.notFound, component: () => import('./pages/NotFoundPage.vue'), meta: { public: true } },
];

export const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to) => {
  if (to.meta['public'] === true || signedIn.value) { return true; }
  return { name: ROUTES.signIn, query: { next: to.fullPath } };
});
