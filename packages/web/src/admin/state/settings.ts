/**
 * Actor settings: the typed settings systems declare (grouped by system), the values set on actors, and setting a
 * value (checked against the setting's gin type by the form, and again by the hub).
 */
import type { ActorId, ActorSetting, Json, QualifiedName, SystemName } from '@harness/core';
import { computed } from 'vue';
import { Loaded, Task } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import type { SettingView } from '@harness/core';

type SettingsApi = Pick<AdminApi, 'actorSettings' | 'setActorSetting'>;

/** A declared setting with its values. */
export interface SettingEntry {
  readonly view: SettingView;
  readonly values: readonly ActorSetting[];
}

/** One system's settings. */
export interface SettingGroup {
  readonly system: SystemName;
  readonly settings: readonly SettingEntry[];
}

/** The actor settings page's state. */
export class ActorSettingsStore {
  readonly #api: SettingsApi;
  readonly data = new Loaded<{ readonly declared: readonly SettingView[]; readonly values: readonly ActorSetting[] }>();
  readonly save = new Task();
  /** The settings by system, systems and settings by name. */
  readonly groups = computed<readonly SettingGroup[]>(() => {
    const data = this.data.value.value;
    if (data === undefined) { return []; }
    const bySystem = new Map<SystemName, SettingEntry[]>();
    for (const view of [...data.declared].sort((a, b) => a.setting.localeCompare(b.setting))) {
      const entry = { view, values: data.values.filter((v) => v.setting === view.setting) };
      bySystem.set(view.system, [...(bySystem.get(view.system) ?? []), entry]);
    }
    return [...bySystem].sort(([a], [b]) => a.localeCompare(b)).map(([system, settings]) => ({ system, settings }));
  });

  constructor(api: SettingsApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await this.data.load(() => this.#api.actorSettings.call({}), "Couldn't load actor settings.", quiet);
  }

  /** Set a setting's value on an actor; the list shows it once the hub accepts it. */
  async set(setting: QualifiedName, actor: ActorId, value: Json, setBy: ActorId, now: number): Promise<boolean> {
    const result = await this.save.run(() => this.#api.setActorSetting.call({ setting, actor, value }), "Couldn't save the setting.");
    const data = this.data.value.value;
    if (!result.ok || !result.value.ok || data === undefined) { return result.ok && result.value.ok; }
    const updated: ActorSetting = { setting, actor, value, setBy, updatedAt: now };
    this.data.set({ ...data, values: [...data.values.filter((v) => v.setting !== setting || v.actor !== actor), updated] });
    return true;
  }
}
