/**
 * One system on its admin page: its record (status live from the user channel), its fns, its config (saved only when
 * valid for its config type; the hub's problems come back as sentences), turning its functions and renderers on and
 * off (shown at once, put back if the hub refuses), the lifecycle actions, and the installed system's output, live
 * while the page is open.
 */
import type { FnRecord, ImportReport, Json, SystemEnabled, SystemName, SystemView, UserEvent } from '@harness/core';
import { ref, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { Loaded, Task, type TaskResult } from '../../state/loaded.ts';
import type { AdminApi, SystemLogEvents } from '../api.ts';
import type { OutputLine } from '@harness/core';
import type { SystemAction } from '../logic/systems.ts';

type SystemApi = Pick<AdminApi,
  'system' | 'systemFns' | 'systemLogs' | 'configureSystem' | 'enableSystem' | 'startSystem' | 'stopSystem' | 'upgradeSystem' | 'reimport' | 'removeSystem'>;

/** The most output lines kept on the page. */
export const LOG_LINES = 1_000;

/** What saving a config came to. */
export type ConfigResult = { readonly ok: true; readonly version: number } | { readonly ok: false; readonly problems: readonly string[] };

/** What an action came to: the reimport's report, the upgrade's versions, or nothing to say. */
export type ActionOutcome = { readonly kind: 'reimport'; readonly report: ImportReport } | { readonly kind: 'upgrade'; readonly from: string; readonly to: string } | { readonly kind: 'done' };

/** One system's page. */
export class SystemStore {
  readonly #api: SystemApi;
  readonly #events: UserEvents;
  readonly #logEvents: SystemLogEvents;
  #stopEvents: (() => void) | undefined;
  #stopLogs: (() => void) | undefined;

  readonly name = ref<SystemName | undefined>(undefined);
  readonly view = new Loaded<SystemView>();
  readonly fns = new Loaded<readonly FnRecord[]>();
  readonly logs = new Loaded<readonly OutputLine[]>();
  readonly config = new Task();
  readonly enabling = new Task();
  readonly action = new Task();
  /** The action running now. */
  readonly acting = shallowRef<SystemAction | undefined>(undefined);

  constructor(api: SystemApi, events: UserEvents, logEvents: SystemLogEvents) {
    this.#api = api;
    this.#events = events;
    this.#logEvents = logEvents;
  }

  /** Show a system: fetch its record, and follow its status. */
  async open(name: SystemName): Promise<void> {
    if (this.name.value !== name) {
      this.close();
      this.name.value = name;
    }
    this.#stopEvents ??= this.#events((event) => { this.#onEvent(event); });
    await this.view.load(() => this.#api.system.call({ system: name }), "Couldn't load this system.", this.view.value.value?.name === name);
  }

  /** Stop following, and forget what was shown. */
  close(): void {
    this.#stopEvents?.();
    this.#stopEvents = undefined;
    this.unfollowLogs();
    this.name.value = undefined;
    this.view.reset();
    this.fns.reset();
    this.logs.reset();
  }

  async loadFns(): Promise<void> {
    const name = this.name.value;
    if (name === undefined) { return; }
    await this.fns.load(() => this.#api.systemFns.call({ system: name }), "Couldn't load this system's fns.");
  }

  /** Fetch the end of the output and add new lines as they come. */
  async followLogs(): Promise<void> {
    const name = this.name.value;
    if (name === undefined) { return; }
    this.#stopLogs ??= this.#logEvents(name, (line) => {
      const lines = this.logs.value.value ?? [];
      this.logs.set([...lines, line].slice(-LOG_LINES));
    });
    await this.logs.load(() => this.#api.systemLogs.call({ system: name, limit: LOG_LINES }), "Couldn't load this system's output.");
  }

  unfollowLogs(): void {
    this.#stopLogs?.();
    this.#stopLogs = undefined;
  }

  /** Save a config. The hub refuses one that isn't valid for the system's config type, and says why. */
  async configure(config: Json): Promise<ConfigResult> {
    const name = this.name.value;
    if (name === undefined) { return { ok: false, problems: ['No system is open.'] }; }
    const result = await this.config.run(() => this.#api.configureSystem.call({ system: name, config }), "Couldn't save the config.");
    if (!result.ok) { return { ok: false, problems: [result.problem] }; }
    if ('problems' in result.value) { return { ok: false, problems: result.value.problems }; }
    void this.open(name);
    return { ok: true, version: result.value.version };
  }

  /** Turn its functions or renderers on or off: shown at once, put back if the hub refuses. */
  async enable(part: keyof SystemEnabled, on: boolean): Promise<boolean> {
    const name = this.name.value;
    const view = this.view.value.value;
    if (name === undefined || view === undefined) { return false; }
    this.view.set({ ...view, enabled: { ...view.enabled, [part]: on } });
    const result = await this.enabling.run(() => this.#api.enableSystem.call({ system: name, [part]: on }), "Couldn't change that.");
    const now = this.view.value.value;
    if (now === undefined) { return result.ok; }
    this.view.set({ ...now, enabled: result.ok ? result.value.enabled : view.enabled });
    return result.ok;
  }

  /** Start, stop, restart, upgrade (to `version`, or the latest), reimport or remove it. */
  async act(action: SystemAction, version?: string): Promise<TaskResult<ActionOutcome>> {
    const name = this.name.value;
    if (name === undefined) { return { ok: false, problem: 'No system is open.' }; }
    this.acting.value = action;
    const result = await this.action.run(() => this.#perform(name, action, version), `Couldn't ${action} ${name}.`);
    this.acting.value = undefined;
    if (result.ok && action !== 'remove') { void this.open(name); }
    return result;
  }

  async #perform(system: SystemName, action: SystemAction, version: string | undefined): Promise<ActionOutcome> {
    switch (action) {
      case 'start': await this.#api.startSystem.call({ system }); return { kind: 'done' };
      case 'stop': await this.#api.stopSystem.call({ system }); return { kind: 'done' };
      case 'restart':
        await this.#api.stopSystem.call({ system });
        await this.#api.startSystem.call({ system });
        return { kind: 'done' };
      case 'upgrade': {
        const upgraded = await this.#api.upgradeSystem.call({ system, ...(version === undefined || version === '' ? {} : { version }) });
        return { kind: 'upgrade', ...upgraded };
      }
      case 'reimport': return { kind: 'reimport', report: await this.#api.reimport.call({ system }) };
      case 'remove': await this.#api.removeSystem.call({ system }); return { kind: 'done' };
    }
  }

  #onEvent(event: UserEvent): void {
    const view = this.view.value.value;
    if (event.type !== 'system' || view === undefined || event.system !== view.name) { return; }
    this.view.set({ ...view, status: event.status });
  }
}
