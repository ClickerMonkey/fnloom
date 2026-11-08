/**
 * The models slice (admins): which model and provider each role uses (the default chat model, transcription,
 * dictation, speech, describing images, reading text in them), through `hub.models.roles`. Writes run the admin
 * operations, the same ones the hub's admin fns run in chat.
 */
import { plugin } from '@ayepi/plugin';
import { modelsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { AdminOperations } from '../admin-ops.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The models plugin. Requires the systems plugin, which binds `adminOnly`. */
export function modelsPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations) {
  return plugin({ name: 'web.models', spec: modelsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof modelsSlice> => ({
      modelRoles: () => hub.models.roles.list(),
      setModelRole: ({ data, user }) => ops.set_model_role(data, user.id),
      clearModelRole: ({ data, user }) => ops.clear_model_role(data, user.id),
    }));
}
