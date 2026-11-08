/**
 * The mock hub's build 2 admin side, in memory and changed for real by its endpoints: model roles (dictation's engine
 * drives the chat's capabilities) and limits, every model call (the fixtures of each modality plus the mock chat's
 * own LLM calls), fn metrics per day, hub MCPs (made, edited, rotated, deleted, with a preview worked out from their
 * rules over the mock's fns), a fleet's instances, package installs and data exports, and the pairing page's request.
 * Built from the same fixtures as the unit tests, so a schema change breaks both.
 */
import { fixture } from './fixture.ts';
import {
  HubMcpView, InstanceRef, McpScopePreview, ModelCall, QualifiedName, mintId, type ChatCapabilities, type FnMatch, type HubMcpId, type HubMcpInput, type InstanceName, type InstanceView,
  type LlmInteraction, type McpRules, type ModelCallQuery, type ModelLimits, type ModelLimitsView, type ModelRole, type ModelRoleView, type PairingId, type PairingRequest,
  type RoleChoice, type SystemName, type FnMetricsQuery,
} from '@harness/core';
import {
  fleet, fnDays, fnMetrics, instanceView, limitsView, mcpSession, mcpView, modelCallsOfEach, roleView, roleViews,
} from '../src/admin/test/build2.ts';
import { FS_CONFIG } from '../src/admin/test/fakes.ts';
import type { MockAdmin } from './mockAdmin.ts';
import type { MockChat } from './mockChat.ts';

/** Where a data export is served from. */
export const MOCK_EXPORTS = '/mock-exports/';
/** The bytes of an (empty) zip, for a data export to download. */
export const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

/** Pages a list by index. */
function pageOf<T>(all: readonly T[], cursor: string | undefined, limit: number | undefined): { items: T[]; cursor?: string } {
  const start = cursor === undefined ? 0 : Number(cursor);
  const end = start + (limit ?? 50);
  return { items: all.slice(start, end), ...(end < all.length ? { cursor: String(end) } : {}) };
}

/** Whether a name matches a glob of `*`s. */
function globMatch(glob: string, name: string): boolean {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(name);
}

/** The mock's build 2 admin state. */
export class MockBuild2 {
  readonly #admin: MockAdmin;
  readonly #chat: MockChat;
  readonly #now: () => number;
  roles: ModelRoleView[] = roleViews();
  limits: ModelLimitsView[] = [limitsView(), limitsView({ model: 'meta-llama/llama-3.3-8b-instruct:free', limits: { contextWindow: 131_072, maxOutputTokens: 4_096, reasoningTokens: 0, charsPerToken: 4 }, sources: { contextWindow: 'model-info', maxOutputTokens: 'model-info', reasoningTokens: 'default', charsPerToken: 'default' } })];
  readonly calls: ModelCall[] = modelCallsOfEach();
  readonly mcps = new Map<HubMcpId, HubMcpView>([[mcpView().id, mcpView()]]);
  readonly instances = new Map<SystemName, InstanceView[]>([[instanceView().system, fleet()]]);

  constructor(admin: MockAdmin, chat: MockChat, now: () => number) {
    this.#admin = admin;
    this.#chat = chat;
    this.#now = now;
  }

  // ─── Roles and limits ───────────────────────────────────────────────────────

  setRole(choice: RoleChoice): ModelRoleView {
    const model = choice.role === 'dictate' ? (choice.engine.engine === 'browser' ? undefined : choice.engine.model) : choice.model;
    const resolved = model === undefined ? { model: 'speech recognition', provider: 'the browser' } : 'model' in model ? { model: model.model, provider: 'openrouter' } : { problem: 'The mock picks only named models.' };
    const view = roleView(choice.role, { choice, from: 'setting', resolved });
    this.roles = this.roles.map((r) => (r.role === choice.role ? view : r));
    return view;
  }

  clearRole(role: ModelRole): ModelRoleView {
    const view = roleView(role);
    this.roles = this.roles.map((r) => (r.role === role ? view : r));
    return view;
  }

  /** The chat's voice capabilities, from the dictation role. */
  voice(): Pick<ChatCapabilities, 'voiceInput' | 'dictation'> {
    const dictate = this.roles.find((r) => r.role === 'dictate');
    const choice = dictate?.choice;
    if (choice?.role !== 'dictate') { return { voiceInput: false }; }
    return { voiceInput: true, dictation: { engine: choice.engine.engine, ...(choice.language === undefined ? {} : { language: choice.language }) } };
  }

  limitsOf(model: string | undefined): ModelLimitsView[] {
    return this.limits.filter((l) => model === undefined || l.model === model);
  }

  setLimits(model: string, limits: ModelLimits): ModelLimitsView {
    const base = this.limits.find((l) => l.model === model) ?? limitsView({ model });
    const sources = { ...base.sources };
    for (const field of ['contextWindow', 'maxOutputTokens', 'reasoningTokens', 'charsPerToken'] as const) { if (limits[field] !== undefined) { sources[field] = 'admin'; } }
    const view = limitsView({ model, limits: { ...base.limits, ...limits }, sources, ratio: base.ratio });
    this.limits = [...this.limits.filter((l) => l.model !== model), view];
    return view;
  }

  // ─── Model calls and metrics ────────────────────────────────────────────────

  /** Every model call: the chat's LLM calls (as chat model calls pointing at their interaction) and the fixtures, newest first. */
  #allCalls(): ModelCall[] {
    const chat = [...this.#chat.calls.values()].map((call) => this.#fromInteraction(call));
    return [...chat, ...this.calls].sort((a, b) => b.startedAt - a.startedAt);
  }

  #fromInteraction(call: LlmInteraction): ModelCall {
    return fixture(ModelCall, {
      id: `mdl_${call.id.slice(4)}`, modality: 'chat', provider: call.provider, model: call.model, run: call.run, turn: call.turn, session: call.session, fn: 'hub/chat',
      interaction: call.id, units: { modality: 'chat', input: call.usage?.input ?? 0, output: call.usage?.output ?? 0 }, cost: call.cost,
      status: call.status === 'streaming' || call.status === 'queued' ? 'running' : call.status, sent: 7_400, received: 1_200, queued: 30,
      ...(call.firstTokenAt === undefined || call.startedAt === undefined ? {} : { firstByte: call.firstTokenAt - call.startedAt }),
      ...(call.endedAt === undefined || call.startedAt === undefined ? {} : { total: call.endedAt - call.startedAt, endedAt: call.endedAt }),
      startedAt: call.startedAt ?? call.queuedAt,
    });
  }

  modelCalls(query: ModelCallQuery): { items: ModelCall[]; cursor?: string } {
    const matches = (call: ModelCall): boolean => (query.modality === undefined || call.modality === query.modality) && (query.status === undefined || call.status === query.status)
      && (query.model === undefined || call.model.includes(query.model)) && (query.system === undefined || call.system === query.system)
      && (query.session === undefined || call.session === query.session) && (query.run === undefined || call.run === query.run);
    return pageOf(this.#allCalls().filter(matches), query.cursor, query.limit);
  }

  modelCall(id: string): ModelCall {
    const found = this.#allCalls().find((c) => c.id === id);
    if (found === undefined) { throw new Error(`no model call ${id}`); }
    return found;
  }

  fnMetrics(query: FnMetricsQuery) {
    const names = query.fn === undefined ? this.#fnNames().filter((fn) => query.system === undefined || fn.startsWith(`${query.system}/`)) : [query.fn];
    return names.map((fn, i) => fnMetrics({ fn, system: fn.split('/')[0], runs: 140 - i * 17, outcomes: { done: 118 - i * 15, 'invalid-input': 14 - i, failed: 8 - Math.min(i, 8), cancelled: 0 } }));
  }

  fnDays(fn: QualifiedName, days: number | undefined) {
    return fnDays(days ?? 7, fn);
  }

  #fnNames(): QualifiedName[] {
    return [...this.#admin.systems.keys()].flatMap((system) => this.#admin.fns(system).map((f) => f.name));
  }

  // ─── Hub MCPs ───────────────────────────────────────────────────────────────

  mcpList(): HubMcpView[] { return [...this.mcps.values()]; }

  mcp(id: HubMcpId): HubMcpView {
    const found = this.mcps.get(id);
    if (found === undefined) { throw new Error(`no MCP ${id}`); }
    return found;
  }

  createMcp(input: HubMcpInput, by: string): { mcp: HubMcpView; secret: string } {
    const id = mintId('mcp');
    const at = this.#now();
    const made = fixture(HubMcpView, { ...input, id, actor: `act_mcp_${input.slug}`, createdBy: by, createdAt: at, updatedAt: at, url: `http://127.0.0.1:4300/mcp/${input.slug}`, sessions: 0, callsToday: 0 });
    this.mcps.set(id, made);
    return { mcp: made, secret: `hmcp_${mintId('mcp').slice(4)}${Math.random().toString(36).slice(2, 10)}` };
  }

  updateMcp(id: HubMcpId, change: { readonly [K in keyof HubMcpInput]?: HubMcpInput[K] | undefined }): HubMcpView {
    const given = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
    const next = fixture(HubMcpView, { ...this.mcp(id), ...given, updatedAt: this.#now(), ...(change.slug === undefined ? {} : { url: `http://127.0.0.1:4300/mcp/${change.slug}` }) });
    this.mcps.set(id, next);
    return next;
  }

  rotate(id: HubMcpId): { secret: string } {
    this.mcps.set(id, { ...this.mcp(id), sessions: 0 });
    return { secret: `hmcp_${Math.random().toString(36).slice(2, 14)}` };
  }

  deleteMcp(id: HubMcpId): { ok: boolean } {
    return { ok: this.mcps.delete(id) };
  }

  /** What rules expose over the mock's fns: included by system or matcher, less the excluded, never admin fns. */
  preview(rules: McpRules): McpScopePreview {
    const fnMatches = (match: FnMatch, fn: string): boolean => (match.fn === undefined || globMatch(match.fn, fn)) && (match.system === undefined || fn.startsWith(`${match.system}/`));
    const selects = (side: McpRules['include'], fn: string): boolean => (side.systems ?? []).some((s) => fn.startsWith(`${s}/`)) || (side.fns ?? []).some((m) => fnMatches(m, fn));
    const fns = this.#fnNames().filter((fn) => selects(rules.include, fn) && !selects(rules.exclude, fn));
    const systems = [...new Set(fns.map((fn) => fn.split('/')[0] ?? ''))];
    const types = systems.flatMap((s) => (s === 'fs' ? ['fs/Entry'] : [])).filter((t) => !(rules.exclude.types ?? []).some((g) => globMatch(g, t)));
    const context = [...systems.map((s) => `${s}/docs`), ...(rules.include.context ?? []).filter((c) => !c.includes('*'))].filter((c) => !(rules.exclude.context ?? []).some((g) => globMatch(g, c)));
    const warnings = [
      ...((rules.exclude.types ?? []).some((g) => globMatch(g, 'fs/Entry')) && fns.some((f) => f.startsWith('fs/')) ? ['fs/Entry is excluded, but exposed fs fns need it, so it is exposed anyway.'] : []),
      ...(context.includes('fs/docs') && !fns.includes('fs/shell') ? ['fs/docs brings fs/shell, which is not exposed.'] : []),
    ];
    const qualified = (names: readonly string[]): QualifiedName[] => names.map((name) => QualifiedName.parse(name));
    return fixture(McpScopePreview, {
      fns, types: qualified(types.filter((t) => (rules.include.types ?? []).some((g) => globMatch(g, t)))), closure: qualified(types), context: qualified([...new Set(context)]),
      resources: [...(rules.include.resources ?? []), ...systems.map((s) => ({ uri: `${s === 'fs' ? 'file' : s}://`, system: s }))], reach: fns.length > 0 ? ['hub/resource_read'] : [], warnings,
    });
  }

  sessions(id: HubMcpId) {
    return this.mcp(id).sessions === 0 ? [] : [mcpSession({ mcp: id }), mcpSession({ mcp: id, session: 'mcs_2', label: 'secret', client: { name: 'mcp-inspector', version: '0.9' }, calls: 4 })];
  }

  // ─── Pairing, fleets, packages and data ─────────────────────────────────────

  /** A pairing request as the pairing page reads it: what the system said about itself, with its config type. */
  pairing(id: PairingId): PairingRequest {
    const found = this.#admin.pairings.find((p) => p.id === id);
    if (found === undefined) { throw new Error(`no pairing ${id}`); }
    return { description: `${found.name} on Phil’s laptop`, instance: instanceName('laptop'), configType: FS_CONFIG, ...found };
  }

  instancesOf(system: SystemName): InstanceView[] {
    const known = this.instances.get(system);
    if (known !== undefined) { return known; }
    const view = this.#admin.systems.get(system);
    return view === undefined ? [] : [instanceView({ system, description: view.description, status: view.status, version: view.version, config: view.config, installed: view.installed, dirs: undefined })];
  }

  install(file: string, hash: string, instance: InstanceName | undefined): InstanceRef {
    const { name } = this.#admin.install({ zip: hash, file }, true);
    const ref = fixture(InstanceRef, { system: name, instance: instance ?? 'main' });
    this.instances.set(name, [...this.instancesOf(name), instanceView({ system: name, instance: ref.instance, description: `Installed from ${file}`, status: 'pairing', config: undefined, version: '1.0.0' })]);
    return ref;
  }

  removeInstance(ref: InstanceRef): { ok: boolean } {
    const list = this.instancesOf(ref.system);
    this.instances.set(ref.system, list.filter((i) => i.instance !== ref.instance));
    return { ok: list.some((i) => i.instance === ref.instance) };
  }

  exportData(ref: InstanceRef): { hash: string; size: number; mime: string; url: string } {
    return { hash: 'e'.repeat(64), size: EMPTY_ZIP.length, mime: 'application/zip', url: `/api${MOCK_EXPORTS}${ref.system}-${ref.instance}-data.zip` };
  }
}

/** An instance name, checked. */
function instanceName(name: string): InstanceName {
  return InstanceRef.shape.instance.parse(name);
}
