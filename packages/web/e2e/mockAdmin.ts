/**
 * The mock hub's admin side: systems (one installed and running, one needing config, one offline), a pairing request
 * waiting, fns, live output lines, providers and models, categories, budgets, priority rules, policies, actors and
 * actor settings, and resources, all in memory and changed for real by the admin endpoints. The runs and LLM call
 * browsers read the mock chat's own runs and calls, so what the chat does shows up there. Built from the same
 * fixtures as the unit tests.
 */
import { fixture } from './fixture.ts';
import {
  ImportReport, SystemName, mintId, type ActorKind, type QualifiedName, type ActorId, type BudgetId, type InstallSource, type Json, type LlmInteraction, type ModelCategory, type PairingId, type PairingRequest,
  type Policy, type PriorityRule, type ProviderId, type ProviderKind, type ResolvedLimits, type ResourceRead, type ResourceRecord, type ResourceUri, type Run, type SystemStatus, type SystemView,
  type UserEvent,
} from '@harness/core';
import type { BudgetView, LlmFilter, OutputLine, ModelInfo, ResourceFilter, RuleRef, RunFilter } from '@harness/core';
import {
  actor, budget, category, fnRecord, installed, logLine, model, pairing, policy, priorityRule, resourceRecord, settingValue, settingView, systemView,
} from '../src/admin/test/fakes.ts';
import type { MockChat } from './mockChat.ts';

/** Send an event to every signed-in browser, or a system's output line to those watching it. */
export interface AdminEmit {
  user(event: UserEvent): void;
  log(system: SystemName, line: OutputLine): void;
}

const MINUTE = 60_000;
const FS = SystemName.parse('fs');
const PAIR_NAMES = ['weather', 'tickets', 'crm', 'mail', 'photos'] as const;
const OUTPUT = [
  'fs: watching /work (3 folders)', 'fs: read docs/harness.md (41 KB)', 'fs: index refreshed in 84ms', 'fs: shell `npm test` exited 0',
  'fs: read packages/web/src/main.ts', 'fs: wrote notes/todo.md',
];

/** Pages a list by index. */
function pageOf<T>(all: readonly T[], cursor: string | undefined, limit: number | undefined): { items: T[]; cursor?: string } {
  const start = cursor === undefined ? 0 : Number(cursor);
  const end = start + (limit ?? 50);
  return { items: all.slice(start, end), ...(end < all.length ? { cursor: String(end) } : {}) };
}

/** The mock admin state and its handlers' logic. */
export class MockAdmin {
  readonly #chat: MockChat;
  readonly #now: () => number;
  #emit: AdminEmit = { user: () => undefined, log: () => undefined };
  #line = 0;
  #asked = 0;
  readonly systems = new Map<SystemName, SystemView>();
  readonly logs = new Map<SystemName, OutputLine[]>();
  pairings: PairingRequest[];
  providers: { id: ProviderId; provider: ProviderKind; models: number }[];
  models: ModelInfo[];
  categories: ModelCategory[];
  budgets: BudgetView[];
  priorities: PriorityRule[];
  policies: Policy[];
  readonly actors = [
    actor({ id: 'act_admin', name: 'Ada Admin', email: 'admin@harness.test' }),
    actor({ id: 'act_grace', name: 'Grace Hopper', email: 'grace@harness.test', role: 'member' }),
    actor({ id: 'act_eng', kind: 'group', name: 'Engineering', about: 'The builders', email: undefined, role: undefined }),
    actor({ id: 'act_ops', kind: 'group', name: 'Operations', about: 'Keeps it running', email: undefined, role: undefined }),
  ];
  settings = { declared: [settingView()], values: [settingValue()] };
  readonly resources: ResourceRecord[];

  constructor(chat: MockChat, now: () => number) {
    this.#chat = chat;
    this.#now = now;
    const at = now();
    const fs = systemView({ installed: installed(), lastSeenAt: at - 2_000 });
    const notes = systemView({
      name: 'notes', description: 'Meeting notes and their summaries.', status: 'needs-config', needsConfig: true, config: undefined, fns: 4, version: '0.3.1',
      configType: { name: 'obj', props: { folder: { type: { name: 'text', options: { minLength: 1 } }, docs: 'Where the notes live.' }, summarize: { type: { name: 'bool' } } } },
    });
    const embedder = systemView({
      name: 'embedder', description: 'Turns text into vectors for search (EmbeddingGemma).', status: 'disconnected', fns: 1, lastSeenAt: at - 42 * MINUTE,
      configType: undefined, config: undefined, enabled: { functions: true, renderers: false },
    });
    for (const s of [fs, notes, embedder]) { this.systems.set(s.name, s); }
    this.logs.set(fs.name, [logLine('started fs 0.4.0', { stream: 'hub', at: at - 3 * MINUTE }), ...OUTPUT.slice(0, 4).map((text, i) => logLine(text, { at: at - (4 - i) * 30_000 }))]);
    this.pairings = [pairing({ id: 'par_notes', name: 'calendar', version: '1.0.2', createdAt: at - MINUTE, expiresAt: at + 9 * MINUTE })];
    this.providers = [{ id: mintId('provider'), provider: model().provider, models: 3 }];
    this.models = [
      model(),
      model({ id: 'meta-llama/llama-3.3-8b-instruct:free', name: 'Llama 3.3 8B (free)', contextWindow: 128_000 }),
      model({ id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', contextWindow: 200_000, pricing: { input: 3, output: 15 }, capabilities: ['chat', 'tools', 'vision', 'reasoning'] }),
    ];
    this.categories = [category(), category({ id: 'mct_careful', name: 'careful', description: 'Hard problems, checked twice', models: ['anthropic/claude-sonnet', 'openai/gpt-oss-20b:free'] })];
    this.budgets = [
      budget(),
      budget({ id: 'bgt_eng', target: { scope: 'group', group: 'act_eng' }, period: { window: 604_800_000 }, maxCost: 20, spent: 17.2, share: 'pooled', onLimit: 'ask' }),
      budget({ id: 'bgt_turn', target: { scope: 'user', user: 'act_grace' }, period: 'per-turn', maxCost: 0.5, maxTime: 600_000, spent: 0 }),
    ];
    this.priorities = [priorityRule(), priorityRule({ id: 'pri_eng', target: { scope: 'group', group: 'act_eng' }, default: 'interactive', max: 'urgent' })];
    this.policies = [
      policy(),
      policy({ id: 'pol_shell', description: 'No shell for agents', subject: { kind: 'agent' }, target: { fn: 'fs/shell' }, decision: { effect: 'deny', reason: 'Agents may not run commands.' }, priority: 20 }),
      policy({ id: 'pol_read', description: 'Reading is fine', target: { tags: ['read'] }, decision: { effect: 'allow' }, priority: 0 }),
    ];
    this.resources = [
      resourceRecord(),
      resourceRecord({ uri: 'fs://work/packages/web/src/main.ts', stat: { uri: 'fs://work/packages/web/src/main.ts', name: 'main.ts', type: 'file', format: 'typescript', size: 1_480, version: '7' }, indexedVersion: '7', seenAt: at - 5 * MINUTE }),
      resourceRecord({ uri: 'fs://work/docs', stat: { uri: 'fs://work/docs', name: 'docs', type: 'folder', version: '2' }, seenAt: at - 60 * MINUTE }),
    ];
  }

  /** Where events go, once the server exists. */
  attach(emit: AdminEmit): void {
    this.#emit = emit;
  }

  /** The installed system writes a line now and then. */
  tick(): void {
    const text = OUTPUT[this.#line++ % OUTPUT.length] ?? 'fs: idle';
    const line = logLine(text, { at: this.#now(), stream: this.#line % 5 === 0 ? 'stderr' : 'stdout' });
    this.#log(FS, line);
  }

  list(): SystemView[] { return [...this.systems.values()]; }

  system(name: SystemName): SystemView {
    const found = this.systems.get(name);
    if (found === undefined) { throw new Error(`no system ${name}`); }
    return found;
  }

  answerPairing(id: PairingId, approve: boolean): { system?: SystemName } {
    const request = this.pairings.find((p) => p.id === id);
    this.pairings = this.pairings.filter((p) => p.id !== id);
    // another system asks soon after, so the page has something live to show (and each e2e run one to approve)
    if (this.pairings.length === 0) { setTimeout(() => { this.#askToPair(); }, 1_500); }
    if (request === undefined || !approve) { return {}; }
    const made = systemView({ name: request.name, description: 'A newly paired system.', version: request.version, status: 'connected', fns: 3, configType: undefined, config: undefined });
    this.systems.set(made.name, made);
    this.#emit.user({ type: 'system', system: made.name, status: 'connected' });
    return { system: made.name };
  }

  configure(name: SystemName, config: Json): { version: number } | { problems: string[] } {
    const current = this.system(name);
    if (typeof config !== 'object' || config === null || Array.isArray(config)) { return { problems: ['The config must be an object.'] }; }
    const version = (current.config?.version ?? 0) + 1;
    this.#set({ ...current, config: { value: config, version, setBy: this.actors[0]?.id ?? current.actor, setAt: this.#now() }, needsConfig: false, status: current.status === 'needs-config' ? 'connected' : current.status });
    return { version };
  }

  enable(name: SystemName, change: { functions?: boolean | undefined; renderers?: boolean | undefined }): { enabled: SystemView['enabled'] } {
    const current = this.system(name);
    const enabled = { functions: change.functions ?? current.enabled.functions, renderers: change.renderers ?? current.enabled.renderers };
    this.systems.set(name, { ...current, enabled });
    return { enabled };
  }

  process(name: SystemName, status: 'running' | 'stopped'): { ok: boolean } {
    const current = this.system(name);
    if (current.installed === undefined) { return { ok: false }; }
    this.systems.set(name, { ...current, installed: { ...current.installed, status, ...(status === 'running' ? { pid: 4000 + Math.floor(Math.random() * 999) } : {}) } });
    this.#log(name, logLine(status === 'running' ? `started ${name} ${current.version}` : `stopped ${name}`, { stream: 'hub', at: this.#now() }));
    this.#setStatus(name, status === 'running' ? 'connected' : 'disconnected');
    return { ok: true };
  }

  upgrade(name: SystemName, version: string | undefined): { from: string; to: string } {
    const current = this.system(name);
    const to = version ?? '0.5.0';
    this.systems.set(name, { ...current, version: to, ...(current.installed === undefined ? {} : { installed: { ...current.installed, version: to } }) });
    this.#log(name, logLine(`upgraded ${name} ${current.version} → ${to}`, { stream: 'hub', at: this.#now() }));
    return { from: current.version, to };
  }

  reimport(): ImportReport {
    return fixture(ImportReport, { added: ['fs/stat'], updated: ['fs/read_file'], removed: [], refused: [] });
  }

  remove(name: SystemName): { fnsUnavailable: number } {
    const current = this.system(name);
    this.systems.delete(name);
    return { fnsUnavailable: current.fns };
  }

  install(source: InstallSource, autoStart: boolean): { name: SystemName } {
    const raw = 'package' in source ? source.package.split('/').pop() ?? 'system' : 'git' in source ? source.git.split('/').pop()?.replace(/\.git$/, '') ?? 'system'
      : 'zip' in source ? source.file.replace(/(-\d[\w.]*)?\.zip$/, '') : source.path.split(/[\\/]/).pop() ?? 'system';
    const made = systemView({
      name: raw.replace(/^system-/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '') || 'system', description: 'Installed by the hub.', status: 'pairing', fns: 0,
      installed: installed({ source, status: 'installing', autoStart }), configType: undefined, config: undefined,
    });
    this.systems.set(made.name, made);
    return { name: made.name };
  }

  fns(name: SystemName) {
    const system = this.system(name);
    const names = ['read_file', 'write_file', 'list', 'search', 'shell', 'move'].slice(0, Math.max(1, Math.min(6, system.fns)));
    return names.map((local, i) => fnRecord({
      name: `${name}/${local}`, system: name,
      available: system.status === 'connected' ? (local === 'shell' ? { unavailable: 'disabled', detail: 'Turned off by an admin' } : true) : { unavailable: system.status === 'needs-config' ? 'system-needs-config' : 'system-disconnected', detail: '' },
      decl: { ...fnRecord().decl, name: local, description: ['Read a file', 'Write a file', 'List a folder', 'Search the files', 'Run a command', 'Move files'][i] ?? 'Do something', tags: local.startsWith('read') || local === 'list' || local === 'search' ? ['read'] : ['write'] },
      stats: { runs: 140 - i * 23, failures: i, averageCost: 0, averageTime: 40 + i * 30, lastRunAt: this.#now() - (i + 1) * 7 * MINUTE },
    }));
  }

  output(name: SystemName, limit: number | undefined): OutputLine[] {
    return (this.logs.get(name) ?? []).slice(-(limit ?? 500));
  }

  saveProvider(provider: ProviderKind): { models: number } {
    const existing = this.providers.find((p) => p.provider === provider);
    if (existing === undefined) { this.providers.push({ id: mintId('provider'), provider, models: 12 }); }
    return { models: existing?.models ?? 12 };
  }

  saveCategory(body: Omit<ModelCategory, 'id'>): { id: string } {
    const existing = this.categories.find((c) => c.name === body.name);
    const id = existing?.id ?? mintId('modelCategory');
    this.categories = [...this.categories.filter((c) => c.id !== id), { ...body, id }];
    return { id };
  }

  saveBudget(body: Omit<BudgetView, 'id' | 'setBy' | 'spent'>, by: ActorId): { id: string } {
    const same = this.budgets.find((b) => JSON.stringify(b.target) === JSON.stringify(body.target) && JSON.stringify(b.period) === JSON.stringify(body.period));
    const id: BudgetId = same?.id ?? mintId('budget');
    this.budgets = [...this.budgets.filter((b) => b.id !== id), { ...body, id, setBy: by, spent: same?.spent ?? 0 }];
    return { id };
  }

  savePriority(body: Omit<PriorityRule, 'id' | 'setBy'>, by: ActorId): { id: string } {
    const same = this.priorities.find((p) => JSON.stringify(p.target) === JSON.stringify(body.target));
    const id = same?.id ?? mintId('priorityRule');
    this.priorities = [...this.priorities.filter((p) => p.id !== id), { ...body, id, setBy: by }];
    return { id };
  }

  savePolicy(body: Omit<Policy, 'id' | 'createdBy' | 'createdAt'>, by: ActorId): { id: string } {
    const id = mintId('policy');
    this.policies = [...this.policies, { ...body, id, createdBy: by, createdAt: this.#now() }];
    return { id };
  }

  removeRule(rule: RuleRef): { ok: boolean } {
    switch (rule.kind) {
      case 'budget': this.budgets = this.budgets.filter((b) => b.id !== rule.id); break;
      case 'priority': this.priorities = this.priorities.filter((p) => p.id !== rule.id); break;
      case 'policy': this.policies = this.policies.filter((p) => p.id !== rule.id); break;
      case 'category': this.categories = this.categories.filter((c) => c.id !== rule.id); break;
      case 'provider': this.providers = this.providers.filter((p) => p.id !== rule.id); break;
    }
    return { ok: true };
  }

  resolve(): ResolvedLimits {
    const [hub, eng] = this.budgets;
    return {
      priority: 'interactive', priorityFrom: { default: 'group', cappedBy: 'hub' }, turn: { cost: 0.5, time: 600_000 },
      budgets: [hub, eng].flatMap((b) => (b === undefined ? [] : [{ rule: b.id, scope: b.target, remaining: Math.max(0, b.maxCost - b.spent) }])),
      ...(eng === undefined ? {} : { limitedBy: eng.id }),
    };
  }

  setSetting(setting: QualifiedName, actorId: ActorId, value: Json, by: ActorId): { ok: boolean } {
    const values = this.settings.values.filter((v) => v.setting !== setting || v.actor !== actorId);
    this.settings = { ...this.settings, values: [...values, settingValue({ setting, actor: actorId, value, setBy: by, updatedAt: this.#now() })] };
    return { ok: true };
  }

  runs(filter: RunFilter, cursor: string | undefined, limit: number | undefined): { items: Run[]; cursor?: string } {
    const matches = (run: Run): boolean => (filter.status === undefined || run.status === filter.status)
      && (filter.fn === undefined || (filter.fn.endsWith('*') ? run.fn.startsWith(filter.fn.slice(0, -1)) : run.fn === filter.fn))
      && (filter.system === undefined || run.system === filter.system) && (filter.session === undefined || run.session === filter.session);
    return pageOf([...this.#chat.runs.values()].filter(matches).sort((a, b) => b.createdAt - a.createdAt), cursor, limit);
  }

  llmCalls(filter: LlmFilter, cursor: string | undefined, limit: number | undefined) {
    const matches = (call: LlmInteraction): boolean => (filter.status === undefined || call.status === filter.status)
      && (filter.model === undefined || call.model.includes(filter.model)) && (filter.system === undefined || call.system === filter.system)
      && (filter.session === undefined || call.session === filter.session);
    const all = [...this.#chat.calls.values()].filter(matches).sort((a, b) => b.queuedAt - a.queuedAt).map(({ request: _request, response: _response, ...summary }) => summary);
    return pageOf(all, cursor, limit);
  }

  resourceList(filter: ResourceFilter, cursor: string | undefined, limit: number | undefined): { items: ResourceRecord[]; cursor?: string } {
    const q = filter.search?.toLowerCase() ?? '';
    return pageOf(this.resources.filter((r) => (q === '' || `${r.uri} ${r.stat.name}`.toLowerCase().includes(q)) && (filter.system === undefined || r.system === filter.system)), cursor, limit);
  }

  /** The actors, or those of one kind. */
  actorsOf(filter: { kind?: ActorKind | undefined }) {
    return this.actors.filter((a) => filter.kind === undefined || a.kind === filter.kind);
  }

  /** A resource's text and links, for the viewer. */
  read(uri: ResourceUri): ResourceRead {
    const found = this.resources.find((r) => r.uri === uri) ?? resourceRecord({ uri, stat: { uri, name: uri.split('/').at(-1) ?? uri, type: 'file', format: 'markdown', size: 12_400, version: '1' } });
    const text = found.stat.type === 'folder' ? undefined
      : found.stat.format === 'markdown' ? '# Harness\n\nA web-based agent harness.\n\n- The **hub** owns every LLM call.\n- **Systems** add fns, types and resources.\n'
        : 'import { createApp } from \'vue\';\nimport App from \'./app/App.vue\';\n\ncreateApp(App).mount(\'#app\');\n';
    const children = this.resources.filter((r) => r.uri !== uri && r.uri.startsWith(`${uri}/`));
    return {
      stat: found.stat,
      ...(text === undefined ? {} : { text: { inline: text } }),
      links: children.map((child) => ({ uri: child.uri, raw: child.stat.name, kind: 'child' as const, title: child.stat.name })),
    };
  }

  /** A new system asks to pair, as the hub announces it. */
  #askToPair(): void {
    const at = this.#now();
    const name = `${PAIR_NAMES[this.#asked % PAIR_NAMES.length] ?? 'system'}${this.#asked >= PAIR_NAMES.length ? `-${Math.floor(this.#asked / PAIR_NAMES.length) + 1}` : ''}`;
    this.#asked++;
    const request = pairing({ id: mintId('pairing'), name, version: '1.0.0', createdAt: at, expiresAt: at + 10 * MINUTE, code: String(100_000 + Math.floor(Math.random() * 900_000)) });
    this.pairings = [...this.pairings, request];
    this.#emit.user({ type: 'pairing', pairing: request });
  }

  #set(view: SystemView): void {
    const before = this.systems.get(view.name)?.status;
    this.systems.set(view.name, view);
    if (before !== view.status) { this.#emit.user({ type: 'system', system: view.name, status: view.status }); }
  }

  #setStatus(name: SystemName, status: SystemStatus): void {
    this.#set({ ...this.system(name), status, lastSeenAt: this.#now() });
  }

  #log(name: SystemName, line: OutputLine): void {
    this.logs.set(name, [...(this.logs.get(name) ?? []), line].slice(-1_000));
    this.#emit.log(name, line);
  }
}
