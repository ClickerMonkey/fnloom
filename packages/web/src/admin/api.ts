/**
 * The admin pages' callers, made once from the one hub client: systems and pairing, providers and models, budgets and
 * priorities, policies, actors and their settings, and the runs, LLM calls and resources browsers. Stores receive
 * only the callers they use (`Pick<AdminApi, …>`), so tests hand them fakes. Admin lists are read fresh (no cache):
 * an admin page should show what is true now. Live system output comes through `SystemLogEvents`.
 */
import type { SystemName } from '@harness/core';
import type { Hub } from '../api/client.ts';
import type { OutputLine } from '@harness/core';

/** Make the admin callers. */
export function adminApi(hub: Hub) {
  return {
    systems: hub.caller('systems', { dedupe: true }),
    system: hub.caller('system', { dedupe: true }),
    pairings: hub.caller('pairings', { dedupe: true }),
    approvePairing: hub.caller('approvePairing'),
    createPairingToken: hub.caller('createPairingToken'),
    configureSystem: hub.caller('configureSystem'),
    enableSystem: hub.caller('enableSystem'),
    removeSystem: hub.caller('removeSystem'),
    installSystem: hub.caller('installSystem'),
    startSystem: hub.caller('startSystem'),
    stopSystem: hub.caller('stopSystem'),
    upgradeSystem: hub.caller('upgradeSystem'),
    reimport: hub.caller('reimport'),
    systemFns: hub.caller('systemFns', { dedupe: true }),
    systemLogs: hub.caller('systemLogs', { dedupe: true }),
    providers: hub.caller('providers', { dedupe: true }),
    configureProvider: hub.caller('configureProvider'),
    models: hub.caller('models', { dedupe: true }),
    modelCategories: hub.caller('modelCategories', { dedupe: true }),
    setModelCategory: hub.caller('setModelCategory'),
    budgets: hub.caller('budgets', { dedupe: true }),
    setBudget: hub.caller('setBudget'),
    priorityRules: hub.caller('priorityRules', { dedupe: true }),
    setPriority: hub.caller('setPriority'),
    resolveLimits: hub.caller('resolveLimits', { lastOnly: true }),
    policies: hub.caller('policies', { dedupe: true }),
    setPolicy: hub.caller('setPolicy'),
    removeRule: hub.caller('removeRule'),
    actors: hub.caller('actors', { dedupe: true }),
    actorSettings: hub.caller('actorSettings', { dedupe: true }),
    setActorSetting: hub.caller('setActorSetting'),
    runs: hub.caller('runs', { lastOnly: true }),
    llmCalls: hub.caller('llmCalls', { lastOnly: true }),
    resources: hub.caller('resources', { lastOnly: true }),
  };
}

/** The admin callers. */
export type AdminApi = ReturnType<typeof adminApi>;

/** Listen to one installed system's new output lines; returns the function that stops listening. */
export type SystemLogEvents = (system: SystemName, listener: (line: OutputLine) => void) => () => void;

/** A system's live output, from the `systemLog` channel. */
export function systemLogEvents(hub: Hub): SystemLogEvents {
  return (system, listener) => hub.on('systemLog', { system }, listener);
}
