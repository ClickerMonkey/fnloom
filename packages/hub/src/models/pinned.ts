/** A model setting (`RoleModel`) as an LLM gateway call takes it: the model choice, and the provider kind it is pinned to. */
import type { ModelChoice, RoleModel } from '@harness/core';
import type { HubStore } from '../store/index.ts';

/** The model and pinned provider of a setting; nothing for no setting (the gateway's own choice). */
export async function pinnedModel(store: HubStore, setting: RoleModel | undefined): Promise<{ model?: ModelChoice; provider?: string }> {
  if (setting === undefined) return {};
  const pinned = setting.provider === undefined ? undefined : (await store.table('providers').get(setting.provider))?.config.provider;
  return { model: setting.model, ...(pinned === undefined ? {} : { provider: pinned }) };
}
