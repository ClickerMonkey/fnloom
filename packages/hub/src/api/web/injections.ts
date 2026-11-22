/**
 * The injections slice (admins): what is injected into each agent and an admin's per-agent switch and order. Each
 * endpoint runs the one operation its hub fn runs (`hub/ctx_injections_list`, `hub/ctx_injection_set`), so the web
 * and the chat can never do different things.
 */
import { plugin } from '@ayepi/plugin';
import { injectionsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { AdminOperations } from '../admin-ops.ts';
import { adminReadOperations } from '../person-ops.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The injections plugin. Requires the systems plugin, which binds `adminOnly`. */
export function injectionsPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations) {
  const adminReads = adminReadOperations(hub);
  return plugin({ name: 'web.injections', spec: injectionsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof injectionsSlice> => ({
      injections: ({ data, user }) => adminReads.ctx_injections_list(data, user),
      setInjection: ({ data, user }) => ops.ctx_injection_set(data, user.id),
    }));
}
