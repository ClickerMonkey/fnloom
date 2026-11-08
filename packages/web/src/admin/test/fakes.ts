/**
 * Test doubles for the admin pages: records parsed through the hub's own schemas (so ids are the real branded types
 * and a schema change breaks the fixtures), fake admin callers answering from in-memory lists, live channels a test
 * pushes into, and the admin store built on them. The mock hub's admin data is made from the same builders.
 */
import {
  Actor, ActorSetting, FnRecord, ImportReport, ModelCategory, PairingRequest, Policy, PriorityRule, ResourceRecord, SystemView,
  type LlmInteraction, type SystemName, type UserEvent,
} from '@harness/core';
import { g, wireType } from '@harness/sdk';
import { fakeCaller } from '../../test/fakes.ts';
import { fakeSender, llmCall, run, T0 } from '../../chat/test/fakes.ts';
import type { McpProbe, ProbeResult } from '../probe.ts';
import type { SystemLogEvents } from '../api.ts';
import { BudgetView, LlmSummary, OutputLine, ModelInfo, SettingView } from '@harness/core';
import { AdminStore } from '../state/admin.ts';
import { fakeBuild2Api } from './build2.ts';

export { T0 };

type Loose<T> = Partial<Record<keyof T, unknown>>;

/** The fs system's config type: the folders it may use. */
export const FS_CONFIG = wireType(g.obj({
  roots: g.field(g.list(g.obj({ path: g.text({ minLength: 1 }), name: g.text({ minLength: 1 }), writable: g.bool() }), { minLength: 1 }), { docs: 'The folders it may use.' }),
}));

/** A setting's type: which tables a group may read. */
export const ROW_RULES = wireType(g.obj({ tables: g.list(g.text({ minLength: 1 })), readOnly: g.bool() }));

/** A system as the admin pages get it. */
export function systemView(overrides: Loose<SystemView> = {}): SystemView {
  return SystemView.parse({
    name: 'fs', description: 'Files, folders and a shell on this computer.', status: 'connected', enabled: { functions: true, renderers: true },
    config: { value: { roots: [{ path: '/work', name: 'work', writable: true }] }, version: 2, setBy: 'act_ada', setAt: T0 - 3_600_000 },
    keyFingerprint: 'SHA256:9f2c41a0b7', version: '0.4.0', manifestHash: 'a1b2c3d4', pairedAt: T0 - 86_400_000, pairedBy: 'act_ada', lastSeenAt: T0 - 5_000,
    address: '127.0.0.1', actor: 'act_fs', fns: 12, needsConfig: false, configType: FS_CONFIG, instances: [], ...overrides,
  });
}

/** An installed system's record part. */
export function installed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'fs', instance: 'main', source: { package: '@harness/system-fs', version: '0.4.0' }, dir: 'systems/fs', command: { run: 'node', args: ['server.js'], env: {} },
    version: '0.4.0', goodVersion: '0.4.0', autoStart: true, restart: { policy: 'on-failure', backoff: 1_000, maxPerHour: 5 }, status: 'running', pid: 4242,
    installedBy: 'act_ada', installedAt: T0 - 86_400_000, ...overrides,
  };
}

let nextPairing = 1;
/** A pairing request. */
export function pairing(overrides: Loose<PairingRequest> = {}): PairingRequest {
  const n = nextPairing++;
  return PairingRequest.parse({
    id: `par_${n}`, name: 'notes', keyFingerprint: 'SHA256:77aa01', publicKey: 'pk', version: '0.3.1', address: '192.168.50.20', method: 'code', code: '483912',
    status: 'pending', createdAt: T0 - 60_000, expiresAt: T0 + 9 * 60_000, ...overrides,
  });
}

/** A fn's record. */
export function fnRecord(overrides: Loose<FnRecord> = {}): FnRecord {
  return FnRecord.parse({
    name: 'fs/read_file', system: 'fs', version: 'v1', origin: 'contract', available: true, paused: false, disabled: false, updatedAt: T0,
    stats: { outcomes: { done: 137, 'invalid-input': 0, failed: 3, cancelled: 0 }, averageCost: 0, averageTime: 42, tokens: 0, lastRunAt: T0 - 30_000 },
    decl: {
      name: 'read_file', description: 'Read a file', kind: 'native', args: { name: 'obj', props: { path: { type: { name: 'text' } } } }, returns: { name: 'text' },
      deps: [], handlers: {}, progress: { type: 'none' }, operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {},
      visibility: 'both', tags: ['read'],
    },
    ...overrides,
  });
}

/** An output line. */
export function logLine(text: string, overrides: Loose<OutputLine> = {}): OutputLine {
  return OutputLine.parse({ at: T0, stream: 'stdout', text, ...overrides });
}

/** A person, group or other actor. */
export function actor(overrides: Record<string, unknown> = {}): Actor {
  return Actor.parse({ id: 'act_ada', kind: 'user', name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin', about: '', createdAt: T0, disabled: false, ...overrides });
}

/** A budget with its spend. */
export function budget(overrides: Loose<BudgetView> = {}): BudgetView {
  return BudgetView.parse({ id: 'bgt_1', target: { scope: 'hub' }, period: { window: 86_400_000 }, maxCost: 5, onLimit: 'refuse', setBy: 'act_ada', spent: 1.25, ...overrides });
}

/** A priority rule. */
export function priorityRule(overrides: Loose<PriorityRule> = {}): PriorityRule {
  return PriorityRule.parse({ id: 'pri_1', target: { scope: 'hub' }, default: 'normal', setBy: 'act_ada', ...overrides });
}

/** A policy. */
export function policy(overrides: Loose<Policy> = {}): Policy {
  return Policy.parse({
    id: 'pol_1', description: 'Writing files asks first', subject: { everyone: true }, target: { fn: 'fs/*', tags: ['write'] },
    decision: { effect: 'ask', approver: { by: 'turn-user' } }, priority: 10, createdBy: 'act_ada', createdAt: T0, ...overrides,
  });
}

/** A model a provider offers. */
export function model(overrides: Loose<ModelInfo> = {}): ModelInfo {
  return ModelInfo.parse({ id: 'openai/gpt-oss-20b:free', provider: 'openrouter', name: 'GPT OSS 20B (free)', contextWindow: 131_072, pricing: { input: 0, output: 0 }, capabilities: ['chat', 'tools'], ...overrides });
}

/** A model category. */
export function category(overrides: Loose<ModelCategory> = {}): ModelCategory {
  return ModelCategory.parse({ id: 'mct_1', name: 'fast', description: 'Quick answers', models: ['openai/gpt-oss-20b:free'], ...overrides });
}

/** A declared actor setting. */
export function settingView(overrides: Loose<SettingView> = {}): SettingView {
  return SettingView.parse({
    setting: 'db/rows', system: 'db',
    decl: { name: 'rows', description: 'Which tables a group may read', type: ROW_RULES, appliesTo: ['group', 'user'], merge: 'most-restrictive', editableBy: ['self', 'fns'] },
    ...overrides,
  });
}

/** A setting's value on an actor. */
export function settingValue(overrides: Loose<ActorSetting> = {}): ActorSetting {
  return ActorSetting.parse({ setting: 'db/rows', actor: 'act_eng', value: { tables: ['orders'], readOnly: true }, setBy: 'act_ada', updatedAt: T0, ...overrides });
}

/** A resource the hub knows. */
export function resourceRecord(overrides: Loose<ResourceRecord> = {}): ResourceRecord {
  return ResourceRecord.parse({
    uri: 'fs://work/docs/harness.md', system: 'fs', stat: { uri: 'fs://work/docs/harness.md', name: 'harness.md', type: 'file', format: 'markdown', size: 41_200, version: '3' },
    links: [], seenAt: T0, ...overrides,
  });
}

/** An LLM call in a list. */
export function llmSummary(overrides: Loose<LlmInteraction> = {}): LlmSummary {
  return LlmSummary.parse({ ...llmCall(overrides), request: undefined, response: undefined });
}

/** The fake admin callers. */
export function fakeAdminApi() {
  return {
    systems: fakeCaller<'systems'>(() => Promise.resolve([systemView(), systemView({ name: 'notes', status: 'needs-config', needsConfig: true, config: undefined })])),
    system: fakeCaller<'system'>(({ system }) => Promise.resolve(systemView({ name: system }))),
    pairings: fakeCaller<'pairings'>(() => Promise.resolve([pairing()])),
    approvePairing: fakeCaller<'approvePairing'>(() => Promise.resolve({})),
    createPairingToken: fakeCaller<'createPairingToken'>(({ expiresIn }) => Promise.resolve({ token: 'ptk-secret-123', expiresAt: T0 + expiresIn })),
    configureSystem: fakeCaller<'configureSystem'>(() => Promise.resolve({ version: 3 })),
    enableSystem: fakeCaller<'enableSystem'>(({ functions, renderers }) => Promise.resolve({ enabled: { functions: functions ?? true, renderers: renderers ?? true } })),
    removeSystem: fakeCaller<'removeSystem'>(() => Promise.resolve({ fnsUnavailable: 12 })),
    installSystem: fakeCaller<'installSystem'>(() => Promise.resolve({ name: systemName('weather') })),
    startSystem: fakeCaller<'startSystem'>(() => Promise.resolve({ ok: true })),
    stopSystem: fakeCaller<'stopSystem'>(() => Promise.resolve({ ok: true })),
    upgradeSystem: fakeCaller<'upgradeSystem'>(({ version }) => Promise.resolve({ from: '0.4.0', to: version ?? '0.5.0' })),
    reimport: fakeCaller<'reimport'>(() => Promise.resolve(ImportReport.parse({ added: ['fs/stat'], updated: [], removed: [], refused: [] }))),
    systemFns: fakeCaller<'systemFns'>(() => Promise.resolve([fnRecord(), fnRecord({ name: 'fs/write_file', available: { unavailable: 'disabled', detail: 'Turned off by an admin' } })])),
    systemLogs: fakeCaller<'systemLogs'>(() => Promise.resolve([logLine('listening on 4401'), logLine('warning: slow disk', { stream: 'stderr' })])),
    providers: fakeCaller<'providers'>(() => Promise.resolve([{ id: model().provider, provider: 'openrouter' as const, models: 1 }])),
    configureProvider: fakeCaller<'configureProvider'>(() => Promise.resolve({ models: 42 })),
    models: fakeCaller<'models'>(() => Promise.resolve([model()])),
    modelCategories: fakeCaller<'modelCategories'>(() => Promise.resolve([category()])),
    setModelCategory: fakeCaller<'setModelCategory'>(() => Promise.resolve({ id: 'mct_2' })),
    budgets: fakeCaller<'budgets'>(() => Promise.resolve([budget()])),
    setBudget: fakeCaller<'setBudget'>(() => Promise.resolve({ id: 'bgt_2' })),
    priorityRules: fakeCaller<'priorityRules'>(() => Promise.resolve([priorityRule()])),
    setPriority: fakeCaller<'setPriority'>(() => Promise.resolve({ id: 'pri_2' })),
    resolveLimits: fakeCaller<'resolveLimits'>(() => Promise.resolve({
      priority: 'normal' as const, priorityFrom: { default: 'hub' as const }, turn: { cost: 0.5, time: 600_000 }, budgets: [{ rule: budget().id, scope: { scope: 'hub' as const }, remaining: 3.75 }], limitedBy: budget().id,
    })),
    policies: fakeCaller<'policies'>(() => Promise.resolve([policy()])),
    setPolicy: fakeCaller<'setPolicy'>(() => Promise.resolve({ id: 'pol_2' })),
    removeRule: fakeCaller<'removeRule'>(() => Promise.resolve({ ok: true })),
    actors: fakeCaller<'actors'>(() => Promise.resolve([actor(), actor({ id: 'act_eng', kind: 'group', name: 'Engineering', about: 'The builders', email: undefined, role: undefined })])),
    actorSettings: fakeCaller<'actorSettings'>(() => Promise.resolve({ declared: [settingView()], values: [settingValue()] })),
    setActorSetting: fakeCaller<'setActorSetting'>(() => Promise.resolve({ ok: true })),
    runs: fakeCaller<'runs'>(() => Promise.resolve({ items: [run({ id: 'run_a' }), run({ id: 'run_b', status: 'failed' })] })),
    llmCalls: fakeCaller<'llmCalls'>(() => Promise.resolve({ items: [llmSummary({ id: 'llm_a' })] })),
    resources: fakeCaller<'resources'>(() => Promise.resolve({ items: [resourceRecord()] })),
    pairing: fakeCaller<'pairing'>(({ pairing: id }) => Promise.resolve(pairing({ id, description: 'Files on Phil’s laptop', instance: 'laptop', configType: FS_CONFIG }))),
    ...fakeBuild2Api(),
  };
}

/** The fake admin callers. */
export type FakeAdminApi = ReturnType<typeof fakeAdminApi>;

function systemName(name: string): SystemName {
  return systemView({ name }).name;
}

/** A channel a test pushes into. */
function channel<E>(): { subscribe: (listener: (event: E) => void) => () => void; push(event: E): void; readonly size: number } {
  const listeners = new Set<(event: E) => void>();
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push: (event) => { for (const listener of listeners) { listener(event); } },
    get size() { return listeners.size; },
  };
}

/** A probe that finds two tools, or refuses a secret that isn't `hmcp_good`; it keeps what it was asked. */
export function fakeProbe(): McpProbe & { readonly asked: { url: string; secret: string }[] } {
  const asked: { url: string; secret: string }[] = [];
  return {
    asked,
    tools: (url, secret) => {
      asked.push({ url, secret });
      const found: ProbeResult = { server: { name: 'harness', version: '0.0.0' }, tools: [{ name: 'fs_read', description: 'Read a file' }, { name: 'fs_search', description: 'Search the files' }] };
      return secret.startsWith('hmcp_') ? Promise.resolve(found) : Promise.reject(new Error('The MCP refused that secret.'));
    },
  };
}

/** The admin store on fakes, with its channels. */
export function fakeAdmin(options: { api?: FakeAdminApi } = {}) {
  const api = options.api ?? fakeAdminApi();
  const chatApi = {
    run: fakeCaller<'run'>(({ run: id }) => Promise.resolve(run({ id }))),
    llmCall: fakeCaller<'llmCall'>(({ id }) => Promise.resolve(llmCall({ id }))),
    background: fakeCaller<'background'>(() => Promise.resolve({ accepted: true })),
    undoTurn: fakeCaller<'undoTurn'>(({ turn }) => Promise.resolve({ turn, undone: [], failed: [], notUndoable: [] })),
    resource: fakeCaller<'resource'>(({ uri }) => Promise.resolve({ stat: { uri, name: 'harness.md', type: 'file' as const, format: 'markdown', version: '1' }, text: { inline: '# Harness' } })),
  };
  const user = channel<UserEvent>();
  const logs = channel<{ system: SystemName; line: OutputLine }>();
  const systemLogs: SystemLogEvents = (system, listener) => logs.subscribe((event) => { if (event.system === system) { listener(event.line); } });
  const sender = fakeSender();
  const probe = fakeProbe();
  const admin = new AdminStore({ api, chat: chatApi, userEvents: user.subscribe, systemLogs, sender, probe });
  return { admin, api, chatApi, user, logs, sender, probe };
}
