/**
 * The admin pages' callers, made once from the one hub client: systems and pairing, providers and models, budgets and
 * priorities, policies, actors and their settings, the runs, LLM calls and resources browsers, model roles and limits,
 * every model call, fn metrics, hub MCPs, and pairing pages, a fleet's instances, packages and data exports. Stores receive
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
    /** One fn or context item of a system on or off by itself. */
    switchItem: hub.caller('switchItem'),
    /** Any other item of a system (a type, root, kind, command, component, ...) on or off by itself. */
    switchPart: hub.caller('switchPart'),
    // build 7: review and go live, test calls while installed, and the refusals the hub logged
    systemReview: hub.caller('systemReview', { dedupe: true }),
    goLive: hub.caller('goLive'),
    approveReview: hub.caller('approveReview'),
    rejectReview: hub.caller('rejectReview'),
    testCall: hub.caller('testCall'),
    refusals: hub.caller('refusals', { lastOnly: true }),
    removeSystem: hub.caller('removeSystem'),
    installSystem: hub.caller('installSystem'),
    startSystem: hub.caller('startSystem'),
    stopSystem: hub.caller('stopSystem'),
    restartSystem: hub.caller('restartSystem'),
    upgradeSystem: hub.caller('upgradeSystem'),
    reimport: hub.caller('reimport'),
    systemFns: hub.caller('systemFns', { dedupe: true }),
    systemLogs: hub.caller('systemLogs', { dedupe: true }),
    /** What a system added beyond its fns, context and types (kinds, commands, providers, components, examples, …). */
    systemParts: hub.caller('systemParts', { dedupe: true }),
    /** A system's resource roots (its main instance's, live). */
    exploreRoots: hub.caller('exploreRoots', { dedupe: true }),
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
    /** Every fn of every system with its stats (the fns catalogue). */
    fns: hub.caller('fns', { lastOnly: true }),
    llmCalls: hub.caller('llmCalls', { lastOnly: true }),
    /** Any list by the query standard (a fleet instance's types). */
    query: hub.caller('query'),
    resources: hub.caller('resources', { lastOnly: true }),
    // model roles and limits
    modelRoles: hub.caller('modelRoles', { dedupe: true }),
    setModelRole: hub.caller('setModelRole'),
    clearModelRole: hub.caller('clearModelRole'),
    modelLimits: hub.caller('modelLimits', { dedupe: true }),
    setModelLimits: hub.caller('setModelLimits'),
    // every model call, and fn metrics
    modelCalls: hub.caller('modelCalls', { lastOnly: true }),
    modelCall: hub.caller('modelCall', { dedupe: true }),
    fnMetrics: hub.caller('fnMetrics', { dedupe: true }),
    fnMetricsDays: hub.caller('fnMetricsDays', { dedupe: true }),
    // hub MCPs
    mcps: hub.caller('mcps', { dedupe: true }),
    mcp: hub.caller('mcp', { dedupe: true }),
    createMcp: hub.caller('createMcp'),
    updateMcp: hub.caller('updateMcp'),
    rotateMcpSecret: hub.caller('rotateMcpSecret'),
    deleteMcp: hub.caller('deleteMcp'),
    /** The live preview of draft rules: only the latest draft's answer counts. */
    previewMcp: hub.caller('previewMcp', { lastOnly: true }),
    mcpSessions: hub.caller('mcpSessions', { dedupe: true }),
    // pairing pages, fleets, packages and data
    pairing: hub.caller('pairing', { dedupe: true }),
    instances: hub.caller('instances', { dedupe: true }),
    installPackage: hub.caller('installPackage'),
    removeInstance: hub.caller('removeInstance'),
    exportSystemData: hub.caller('exportSystemData'),
    // auto pair: the secrets that let instances re-pair, and revoking one
    autoPairs: hub.caller('autoPairs', { dedupe: true }),
    revokeAutoPair: hub.caller('revokeAutoPair'),
    // the decision model for suggestions
    suggestDecision: hub.caller('suggestDecision', { dedupe: true }),
    setSuggestDecision: hub.caller('setSuggestDecision'),
    previewSuggestions: hub.caller('previewSuggestions', { lastOnly: true }),
    // the model a chat in auto mode asks about calls that write or delete
    autoClassifier: hub.caller('autoClassifier', { dedupe: true }),
    setAutoClassifier: hub.caller('setAutoClassifier'),
    upload: hub.caller('upload'),
    uploaded: hub.caller('uploaded'),
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
