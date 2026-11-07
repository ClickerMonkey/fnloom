/**
 * The settings slice (admins only): model providers (keys stored encrypted as secrets), model categories, budgets,
 * priority rules, policies, actor settings (checked against the setting's declared gin type), users and groups. The
 * writes are the admin operations (`api/admin-ops.ts`), which the hub's admin fns run too.
 */
import { plugin } from '@ayepi/plugin';
import { settingsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { modelsOf, providerRecords, type AdminOperations } from '../admin-ops.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The settings plugin. Requires the systems plugin, which binds `adminOnly`. */
export function settingsPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations) {
  return plugin({ name: 'web.settings', spec: settingsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof settingsSlice> => ({
      configureProvider: ({ data, user }) => ops.configure_provider(data, user.id),
      providers: async () => {
        const [records, models] = await Promise.all([providerRecords(hub), hub.execution.llm.models()]);
        return records.map((p) => ({ id: p.id, provider: p.config.provider, models: modelsOf(models, p.config.provider) }));
      },
      setModelCategory: ({ data, user }) => ops.set_model_category(data, user.id),
      setBudget: ({ data, user }) => ops.set_budget(data, user.id),
      setPriority: ({ data, user }) => ops.set_priority(data, user.id),
      setPolicy: ({ data, user }) => ops.set_policy(data, user.id),
      setActorSetting: ({ data, user }) => ops.set_actor_setting(data, user.id),
      addUser: ({ data, user }) => ops.add_user(data, user.id),
      addGroup: ({ data, user }) => ops.add_group(data, user.id),
    }));
}
