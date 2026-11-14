/**
 * A stand-in hub for building and checking the web app before the real hub runs. Sign-in is real: the single admin
 * account, passwords checked, signed access tokens through `@ayepi/auth`'s bearer middleware, refresh and the
 * WebSocket all work. The inbox is real too: a list in memory, marked read for real, and (with
 * `HARNESS_MOCK_NOTIFY_EVERY`) a new notification pushed on the `user` channel every so often. The chat is a scripted
 * stand-in (`mockChat.ts`): sessions, history, streamed answers with live runs, approvals and the inspectors. The admin
 * pages are backed by `mockAdmin.ts` (systems, pairing, output, models, limits, policies, settings and the browsers,
 * with `HARNESS_MOCK_LOG_EVERY` writing an output line every so often), and build 2's by `mockBuild2.ts` (model roles
 * and limits, model calls, fn metrics, hub MCPs, fleets, packages, data exports and the pairing page). Every other
 * endpoint answers with `@ayepi/mock`'s generated, schema-valid data.
 *
 * Run: npm run mock-hub -w @harness/web   (then `npm run dev -w @harness/web` with HARNESS_PORT set to its port)
 */
import { fixture } from './fixture.ts';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { implement, server } from '@ayepi/core';
import { bearerAuth, signJwt } from '@ayepi/auth/server';
import { env } from '@ayepi/env';
import { mockHandlers } from '@ayepi/mock';
import { createRequestListener, handleUpgrade } from '@ayepi/node';
import { telemetry } from '@ayepi/otel/server';
import {
  AccessClaims, DEFAULT_PORTS, IDS, Port, Notification, ResourceQuery, ResourceReadArgs, UserView, adminOnly, hubAuth, mintId, tel,
  type ActorId, type NotificationReason, type Tokens, type UserEvent,
} from '@harness/core';
import { z } from 'zod';
import { hubNameOf, hubWebSpec, Json, PageRequest, SystemName, type HubIdentity } from '@harness/core';
import { logger, type Logger } from '@ayepi/log';
import { MockAdmin } from './mockAdmin.ts';
import { isFilters, legacyOf, LlmPage, ModelCallPage, ResourcePage, RunPage, SessionPage } from './mockQuery.ts';
import { declaredStatusLogger } from './mockLog.ts';
import { EMPTY_ZIP, MOCK_EXPORTS, MockBuild2 } from './mockBuild2.ts';
import { MockBuild3 } from './mockBuild3.ts';
import { MockBuild4, readAccess, readActors } from './mockBuild4.ts';
import { selectionReport } from '../src/chat/test/fakes.ts';
import { MockChat } from './mockChat.ts';
import { MockFns } from './mockBuild5.ts';
import { MockReviews } from './mockBuild7.ts';
import { MockData } from './mockBuild8.ts';
import { CLAUDE_WAITING, MockBuild9, PERMIT_PREVIEW, QUESTION_ASK } from './mockBuild9.ts';
import { graphOf, SAMPLE_EDGES, SAMPLE_NODES } from '../src/graph/test/graph.ts';
import { fsAuthoringGraph } from './fsGraph.ts';
import { contextFolderSamples, FS_CLIENT, HOSTED_RANDOM, MOCK_CLIENTS, MockExplorer, systemPartsOf } from './mockBuild6.ts';
import { DATABASE_CONFIG_TYPE, SHOP_CONFIG, shopFns, shopTypes } from './mockDatabase.ts';
import { drillRead } from './mockDrill.ts';
import { withOpenable } from './mockOpenable.ts';
import { systemView } from '../src/admin/test/fakes.ts';
import { instanceView } from '../src/admin/test/build2.ts';
import { MOCK_FILES, MOCK_UPLOADS, MockResources } from './mockResources.ts';
import { ContextGraphDouble } from '../src/context/test/graph.ts';

/** The mock hub's settings. */
export const mockHubEnv = env({
  HARNESS_MOCK_PORT: Port.default(DEFAULT_PORTS.mockHub),
  /** Start as a new hub that still needs its admin account. */
  HARNESS_MOCK_NEEDS_ADMIN: z.boolean().default(false),
  /** Push a new notification this often (ms); 0 never does. */
  HARNESS_MOCK_NOTIFY_EVERY: z.number().int().min(0).default(0),
  /** The installed system writes an output line this often (ms); 0 never does. */
  HARNESS_MOCK_LOG_EVERY: z.number().int().min(0).default(2_000),
});

/** The admin account the mock hub starts with (unless it starts needing one). */
export const MOCK_ADMIN = { email: 'admin@harness.test', password: 'harness-admin-1', name: 'Ada Admin' } as const;

const SECRET = 'mock-hub-secret-not-for-real-use';
const ACCESS_FOR = 15 * 60_000;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

interface Account { readonly user: UserView; password: string }

/** What the mock hub keeps. */
class MockState {
  account: Account | undefined;
  readonly refreshTokens = new Map<string, ActorId>();
  notifications: Notification[];

  constructor(needsAdmin: boolean) {
    this.account = needsAdmin ? undefined : { user: this.#user(MOCK_ADMIN.name, MOCK_ADMIN.email), password: MOCK_ADMIN.password };
    const owner = this.account?.user.id ?? IDS.actor.parse('act_admin');
    this.notifications = SAMPLE.map((sample, i) => fixture(Notification, {
      id: `ntf_sample_${i}`, user: owner, read: i >= 3, pushed: false, createdAt: NOW - (i * 47 + 3) * 60_000, ...sample,
    }));
  }

  makeAdmin(name: string, email: string, password: string): Account {
    this.account = { user: this.#user(name, email), password };
    return this.account;
  }

  tokensFor(user: UserView): Tokens {
    const refresh = mintId('authSession');
    this.refreshTokens.set(refresh, user.id);
    const claims = fixture(AccessClaims, { actor: user.id, session: refresh, version: 1 });
    const { token } = signJwt(claims, { secret: SECRET, expiresIn: ACCESS_FOR / 1_000 });
    return { access: token, refresh, expiresIn: ACCESS_FOR, user };
  }

  #user(name: string, email: string): UserView {
    return fixture(UserView, { id: 'act_admin', kind: 'user', name, email, role: 'admin' });
  }
}

const SAMPLE: readonly Pick<z.input<typeof Notification>, 'reason' | 'title' | 'body' | 'link'>[] = [
  { reason: 'approval-needed', title: 'Approve writing 3 files', body: 'fs/write wants to change src/app.ts, src/main.ts and README.md.', link: { run: 'run_orders_write' } },
  { reason: 'turn-finished', title: 'Your refactor is done', body: 'Renamed 14 symbols across 6 files. All tests pass.', link: { session: 'ses_refactor' } },
  { reason: 'pairing-requested', title: 'A system wants to pair', body: 'notes (v0.3.1) on ws://192.168.50.20 asked to connect.', link: { pairing: 'par_notes' } },
  { reason: 'replied', title: 'Chat agent replied', body: 'Here is the summary of the meeting notes you asked for.', link: { session: 'ses_meeting' } },
  { reason: 'system-disconnected', title: 'embedder went offline', body: 'Search falls back to words until it reconnects.', link: { system: 'embedder' } },
  { reason: 'spend-limit', title: 'Daily budget reached', body: 'This session used $2.00 of its $2.00 daily budget.', link: { session: 'ses_budget' } },
];

const SYSTEM_NAMES = ['fs', 'embedder', 'notes', 'calendar'] as const;

const LIVE: readonly { reason: NotificationReason; title: string; body: string }[] = [
  { reason: 'turn-finished', title: 'Build finished', body: 'vite build completed in 4.2s.' },
  { reason: 'input-needed', title: 'A run needs your answer', body: 'fs/move asks which folder to move the files to.' },
  { reason: 'replied', title: 'New reply', body: 'The agent answered your question about the router.' },
];

/** Build the mock hub app. */
export function mockHub(options: { needsAdmin: boolean; logger?: Logger }) {
  const state = new MockState(options.needsAdmin);
  const owner = (): ActorId => state.account?.user.id ?? IDS.actor.parse('act_admin');
  const build3 = new MockBuild3(() => NOW, owner);
  const chat = new MockChat(owner);
  const admin = new MockAdmin(chat, Date.now);
  const library = new MockResources(Date.now());
  const build2 = new MockBuild2(admin, chat, Date.now);
  const build4 = new MockBuild4(admin, owner);
  const fns = new MockFns();
  const build8 = new MockData(Date.now);
  const build9 = new MockBuild9(Date.now);
  const claudeChat = chat.seedClaude(CLAUDE_WAITING, PERMIT_PREVIEW, QUESTION_ASK);
  build9.seedClaude(claudeChat.chat, claudeChat.waiting);
  const fsCluster = fsAuthoringGraph();
  const sampleIds = new Set<string>(SAMPLE_NODES.map((n) => n.id));
  const graphNodes = [...SAMPLE_NODES, ...fsCluster.nodes.filter((n) => !sampleIds.has(n.id))];
  const graphEdges = [...SAMPLE_EDGES, ...fsCluster.edges];
  const graph = new ContextGraphDouble(owner(), Date.now);
  graph.records.push(...contextFolderSamples(Date.now()));
  // build 5: the database system, one instance (`shop`) with its tables and saved queries
  const shopConfig = { value: SHOP_CONFIG, version: 3, setBy: owner(), setAt: Date.now() - 86_400_000 };
  const DATABASE = SystemName.parse('database');
  admin.systems.set(DATABASE, systemView({
    name: 'database', description: 'Query and change SQL databases: every table is a type, every query asked for is kept as a fn.', status: 'connected', version: '0.1.0',
    fns: 5, configType: DATABASE_CONFIG_TYPE, config: shopConfig, defaultInstance: 'shop',
  }));
  build2.instances.set(DATABASE, [instanceView({ system: 'database', instance: 'shop', description: 'Shop orders (Postgres)', version: '0.1.0', config: shopConfig })]);
  // build 6: a system fs hosts, and fs's files for the explorer
  const explorer = new MockExplorer();
  const RANDOM = SystemName.parse('random');
  admin.systems.set(RANDOM, systemView({ name: 'random', description: 'Rolls dice; written and installed from the chat.', status: 'connected', version: '0.2.0', fns: 1, configType: undefined, config: undefined, host: HOSTED_RANDOM }));
  /** A system as the admin pages get it, with its instances. */
  const reviews = new MockReviews(() => NOW);
  const withInstances = (view: ReturnType<MockAdmin['system']>): ReturnType<MockAdmin['system']> => ({ ...view, instances: build2.instancesOf(view.name), stage: reviews.stage(view.name) });
  /** Tell every signed-in browser about a change (set once the app exists). */
  let announce: (event: UserEvent) => void = () => undefined;
  /** The hub name an admin set; undefined goes back to the default. */
  let hubName: string | undefined;
  const identity = (): HubIdentity => ({ ...hubNameOf(hubName, undefined), version: '0.0.0-mock' });

  const real = implement(hubWebSpec)
    .middleware(telemetry.server(tel, { level: 'debug', response: { status: true, duration: true, error: true }, logger: declaredStatusLogger(options.logger ?? logger) }))
    .middleware(bearerAuth.server(hubAuth, {
      secret: SECRET, claims: AccessClaims,
      toUser: (claims) => (state.account !== undefined && claims.actor === state.account.user.id ? state.account.user : null),
    }))
    .middleware(adminOnly, async (io) => io.next())
    .handlers({
      setup: () => ({ needsAdmin: state.account === undefined, name: identity().name, version: identity().version }),
      identity: () => identity(),
      setHubName: ({ data }) => {
        hubName = data.name ?? undefined;
        announce({ type: 'identity', identity: identity() });
        return identity();
      },
      createAdmin: ({ data }) => state.tokensFor(state.makeAdmin(data.name, data.email, data.password).user),
      signIn: ({ data, fail }) => {
        const account = state.account;
        if (account?.user.email !== data.email || account.password !== data.password) { return fail(401, { reason: 'Wrong email or password.' }); }
        return state.tokensFor(account.user);
      },
      refresh: ({ data }) => {
        const actor = state.refreshTokens.get(data.refresh);
        if (actor === undefined || state.account === undefined) { throw new Error('unknown refresh token'); }
        state.refreshTokens.delete(data.refresh);
        return state.tokensFor(state.account.user);
      },
      signOut: () => undefined,
      me: ({ user }) => user,
      notifications: ({ data }) => {
        const all = state.notifications.filter((n) => data.unread !== true || !n.read);
        const page = PageRequest.parse(legacyOf(data));
        const start = page.cursor === undefined ? 0 : Number(page.cursor);
        const end = start + (page.limit ?? 30);
        return { items: all.slice(start, end), ...(end < all.length ? { cursor: String(end) } : {}) };
      },
      readNotifications: ({ data }) => {
        const ids = new Set(data.ids);
        state.notifications = state.notifications.map((n) => (ids.has(n.id) ? { ...n, read: true } : n));
      },
      capabilities: () => ({ ...chat.capabilities(), ...build2.voice() }),
      sessions: ({ data }) => {
        const { search, archived } = SessionPage.parse(legacyOf(data));
        return { items: chat.list(search, archived ?? false) };
      },
      session: ({ data }) => chat.session(data.session),
      createSession: ({ data }) => chat.create(data.title),
      updateSession: ({ data }) => {
        const { session, title, archived, notify, systems, mode, contextor, fnMode } = data;
        return chat.update(session, {
          ...(title === undefined ? {} : { title }), ...(archived === undefined ? {} : { archived }), ...(notify === undefined ? {} : { notify }), ...(systems === undefined ? {} : { systems }),
          ...(mode === undefined ? {} : { mode }), ...(contextor === undefined ? {} : { contextor }), ...(fnMode === undefined ? {} : { fnMode }),
        });
      },
      limits: ({ data }) => chat.limits(data.session),
      messages: ({ data }) => chat.page(data.session, data.cursor, data.limit ?? 50),
      send: ({ data }) => chat.send(data.session, data.parts, data.replyTo),
      invoke: ({ data }) => chat.invoke(data.session, data.fn, data.args),
      control: () => ({ pause: false, cancel: false, uncancellable: [], undoLastTurn: true }),
      background: () => ({ accepted: true }),
      undoTurn: ({ data }) => chat.undo(data.turn),
      tree: ({ data }) => chat.tree(data.turn),
      run: ({ data }) => chat.run(data.run),
      llmCall: ({ data }) => chat.llmCall(data.id),
      suggest: ({ data }) => (data.text.length < 12 ? [] : [
        { kind: 'fn' as const, name: 'fs/read_file' as const, description: 'Read a file', score: 0.82 },
        { kind: 'context' as const, name: 'fs/docs' as const, description: 'The design docs', score: 0.74 },
      ]),
      mentions: ({ data }) => chat.mentions(data.query),
      mentionHover: ({ data }) => chat.hover(data.target),
      waiting: ({ data }) => chat.waiting(data.session),
      approvals: ({ data }) => chat.approvalsOf(data.runs),
      contributions: () => [],
      searchFns: ({ data }) => build8.widgets(data) ?? fns.search(data),
      // build 8: stored data, widgets' row actions and version history
      dataSets: ({ data }) => build8.sets(data),
      records: ({ data }) => build9.records(data) ?? { items: [] },
      recordTable: ({ data }) => build8.table(data),
      record: ({ data }) => build8.record(data),
      saveRecord: ({ data }) => build8.save(data, owner()),
      updateRecord: ({ data }) => build8.update(data, owner()),
      removeRecord: ({ data }) => build8.remove(data),
      recordVersions: ({ data }) => build8.versions(data),
      rowActions: () => build8.actions(),
      itemVersions: ({ data }) => build8.itemVersions(data),
      fnFacts: ({ data }) => fns.facts(data.fn),
      fnExamples: ({ data }) => fns.examples(data),
      autoClassifier: () => fns.classifier(),
      setAutoClassifier: ({ data, user }) => fns.setClassifier(data, user.id),
      clientLogs: ({ data }) => fns.log(data),
      exploreRoots: () => explorer.roots(),
      exploreList: ({ data }) => explorer.list(data.uri),
      exploreRead: ({ data }) => explorer.read(data.uri),
      approve: ({ data }) => chat.approve(data.approval, data.approve),
      presence: () => undefined,
      systems: () => admin.list().map(withInstances),
      system: ({ data }) => withInstances(admin.system(data.system)),
      pairings: ({ data }) => admin.pairingsWith(data.status),
      approvePairing: ({ data }) => {
        // the pairing page names the instance and sets the config in the same step
        const answered = admin.answerPairing(data.pairing, data.approve, data.instance);
        if (answered.system !== undefined && data.config !== undefined) { admin.configure(answered.system, data.config); }
        return answered;
      },
      createPairingToken: ({ data }) => ({ token: mintId('pairingToken'), expiresAt: Date.now() + data.expiresIn }),
      configureSystem: ({ data }) => (build9.has(data.system) && data.instance !== undefined ? build9.configure(data.system, data.instance, data.config) : admin.configure(data.system, data.config)),
      enableSystem: ({ data }) => {
        if (data.context !== undefined) { graph.switchSystem(data.system, data.context); }
        return admin.enable(data.system, data);
      },
      switchItem: ({ data }) => {
        const system = reviews.systemOf(data.name);
        if (system !== undefined) { reviews.switchItem(system, data, data.on); }
        return data.section === 'fns' ? admin.switchFn(data.name, data.on) : graph.switchItem(data.name, data.on);
      },
      switchPart: ({ data }) => reviews.switchItem(data.system, data, data.on),
      systemReview: ({ data }) => reviews.review(data.system),
      goLive: ({ data }) => reviews.goLive(data),
      approveReview: ({ data }) => reviews.approve(data),
      rejectReview: ({ data }) => reviews.reject(data.system),
      testCall: () => reviews.testCall(),
      refusals: ({ data }) => reviews.refusals(data),
      // build 7: the graph of every system's items, from the sample graph
      // the sample graph with the fs system's real authoring context, so the fs cluster is real-sized (build 8)
      graph: ({ data }) => graphOf(data, graphNodes, graphEdges),
      systemParts: ({ data }) => systemPartsOf(data.system),
      removeSystem: ({ data }) => admin.remove(data.system),
      installSystem: ({ data }) => admin.install(data.source, data.autoStart ?? true),
      startSystem: ({ data }) => admin.process(data.system, 'running'),
      stopSystem: ({ data }) => admin.process(data.system, 'stopped'),
      upgradeSystem: ({ data }) => admin.upgrade(data.system, data.version),
      reimport: () => admin.reimport(),
      // plus the fns its chats, runs and graph open that the lists lack (mockOpenable.ts); a system it doesn't know has none, as the real hub answers
      systemFns: ({ data }) => withOpenable(data.system, build9.has(data.system) ? [] : data.system === 'database' ? shopFns(Date.now()) : data.system === 'widgets' ? build8.widgetFns(Date.now()) : admin.systems.has(data.system) ? admin.fns(data.system) : [], Date.now()),
      types: ({ data }) => {
        const known = [...shopTypes(Date.now()), ...build8.types(Date.now())].filter((type) => data.names.includes(type.name));
        return { types: known, missing: data.names.filter((name) => !known.some((type) => type.name === name)) };
      },
      // the `types` list (a system's or a fleet instance's types) and the `contexts` list (a system's context) are asked for through `query`
      query: ({ data }) => {
        if (data.list === 'contexts') {
          const found = graph.list({ query: data.query });
          return { items: found.items.map((record) => Json.parse(record)), sort: [{ field: 'name', dir: 'asc' as const }], total: found.items.length, ...(found.cursor === undefined ? {} : { cursor: found.cursor }) };
        }
        if (data.list !== 'types') { return { items: [], sort: [], total: 0 }; }
        const wanted = isFilters(data.query);
        const items = shopTypes(Date.now()).filter((type) => (wanted['system'] ?? type.system) === type.system && (wanted['instance'] ?? type.instance) === type.instance);
        return { items: items.map((type) => Json.parse(type)), sort: [{ field: 'name', dir: 'asc' as const }], total: items.length };
      },
      systemLogs: ({ data }) => admin.output(data.system, data.limit),
      providers: () => admin.providers,
      configureProvider: ({ data }) => admin.saveProvider(data.provider),
      models: () => admin.models,
      modelCategories: () => admin.categories,
      setModelCategory: ({ data }) => admin.saveCategory(data),
      budgets: () => admin.budgets,
      setBudget: ({ data }) => admin.saveBudget(data, owner()),
      priorityRules: () => admin.priorities,
      setPriority: ({ data }) => admin.savePriority(data, owner()),
      resolveLimits: () => admin.resolve(),
      policies: () => admin.policies,
      setPolicy: ({ data }) => admin.savePolicy(data, owner()),
      removeRule: ({ data }) => admin.removeRule(data),
      actors: ({ data }) => admin.actorsOf(data),
      actorSettings: () => admin.settings,
      setActorSetting: ({ data }) => admin.setSetting(data.setting, data.actor, data.value, owner()),
      runs: ({ data }) => { const { cursor, limit, ...filter } = RunPage.parse(legacyOf(data)); return admin.runs(filter, cursor, limit); },
      llmCalls: ({ data }) => { const { cursor, limit, ...filter } = LlmPage.parse(legacyOf(data)); return admin.llmCalls(filter, cursor, limit); },
      resources: ({ data }) => { const { cursor, limit, ...filter } = ResourcePage.parse(legacyOf(data)); return admin.resourceList(filter, cursor, limit); },
      resource: ({ data }) => admin.read(data.uri),
      browseResources: ({ data }) => library.browse(ResourceQuery.parse(legacyOf(data))),
      resourceForms: ({ data }) => library.forms(data.uri),
      readResource: ({ data }) => library.read(ResourceReadArgs.parse(data)),
      convertResource: ({ data }) => {
        const made = library.convert(data.uri, data.kind);
        announce({ type: 'resource', uri: data.uri, forms: library.forms(data.uri).record.forms ?? [] });
        return made;
      },
      downloadResource: ({ data }) => library.download(data.uri, data.form, '/api'),
      importResource: ({ data }) => ('url' in data ? library.importUrl(data.url) : library.importUpload(data.name, data.content.hash)),
      upload: ({ data }) => library.presign(data.name, data.mime),
      uploaded: ({ data }) => library.uploaded(data.upload),
      renameResource: ({ data }) => library.rename(data.uri, data.name),
      deleteResource: ({ data }) => library.remove(data.uri),
      // build 2: chat modes, model roles and limits, model calls, fn metrics, hub MCPs, fleets, packages and pairing pages
      previewSelection: ({ data }) => {
        const session = chat.session(data.session);
        return selectionReport({ mode: session.mode?.type ?? 'tools', contextor: session.contextor?.type ?? 'graph', linear: Math.min(6, Math.ceil(data.text.length / 40)) });
      },
      modelLimits: ({ data }) => build2.limitsOf(data.model),
      setModelLimits: ({ data }) => build2.setLimits(data.model, data.limits),
      modelRoles: () => build2.roles,
      setModelRole: ({ data }) => { const view = build2.setRole(data); announce({ type: 'capabilities' }); return view; },
      clearModelRole: ({ data }) => { const view = build2.clearRole(data.role); announce({ type: 'capabilities' }); return view; },
      modelCalls: ({ data }) => build2.modelCalls(ModelCallPage.parse(legacyOf(data))),
      modelCall: ({ data }) => build2.modelCall(data.id),
      fnMetrics: ({ data }) => build2.fnMetrics(data),
      fnMetricsDays: ({ data }) => build2.fnDays(data.fn, data.days),
      mcps: () => build2.mcpList(),
      mcp: ({ data }) => build2.mcp(data.mcp),
      createMcp: ({ data }) => build2.createMcp(data, owner()),
      updateMcp: ({ data }) => { const { mcp, ...change } = data; return build2.updateMcp(mcp, change); },
      rotateMcpSecret: ({ data }) => build2.rotate(data.mcp),
      deleteMcp: ({ data }) => build2.deleteMcp(data.mcp),
      previewMcp: ({ data }) => build2.preview(data.rules),
      mcpSessions: ({ data }) => build2.sessions(data.mcp),
      pairing: ({ data }) => build2.pairing(data.pairing),
      instances: ({ data }) => (build9.has(data.system) ? build9.instancesOf(data.system) : build2.instancesOf(data.system)),
      // build 9: MCP servers and API services added from the browser, and a server's status
      addInstance: ({ data }) => build9.add(data),
      readFn: ({ data }) => build9.read(data) ?? drillRead(data) ?? null,
      installPackage: ({ data }) => build2.install(library.nameOf(data.zip.hash) ?? 'package.zip', data.zip.hash, data.instance),
      removeInstance: ({ data }) => (build9.has(data.system) ? build9.remove(data) : build2.removeInstance(data)),
      exportSystemData: ({ data }) => build2.exportData(data),
      // build 3: auto pair secrets and the decision model for suggestions
      autoPairs: ({ data }) => build3.autoPairs(data.system),
      revokeAutoPair: ({ data }) => build3.revoke(data.id),
      suggestDecision: () => build3.decision,
      setSuggestDecision: ({ data }) => build3.setDecision(data),
      previewSuggestions: () => build3.preview(),
      // build 4: pickers and visibility (a hub with more than one person, so the controls show)
      pick: ({ data }) => build4.pick(data),
      accessInfo: () => ({ multiUser: true }),
      access: ({ data }) => data.targets.map((target) => build4.access(readAccess(target))),
      setAccess: ({ data }) => build4.setAccess(readAccess(data.target), { visibility: data.sharing.visibility, with: readActors(data.sharing.with) }),
      // build 4: the calendar each person connects
      connectPages: () => [...build4.connectPages(), ...build9.connectPages()],
      connect: () => build4.connect(),
      updateConnection: ({ data }) => build4.updateConnection(data),
      disconnect: ({ data }) => build4.disconnect(data.connection),
      // the context graph: every item, one item with its links, memory, links drawn by people, context from a resource
      contexts: ({ data }) => graph.list(data),
      contextItem: ({ data }) => graph.item(data.name),
      remember: ({ data }) => { const made = graph.remember(data); announce({ type: 'context', name: made.name }); return made; },
      updateMemory: ({ data }) => { const done = graph.update(data); announce({ type: 'context', name: done.name }); return done; },
      forget: ({ data }) => { const done = graph.forget(data.name); announce({ type: 'context', name: data.name }); return done; },
      linkContext: ({ data }) => { const made = graph.link(data); announce({ type: 'context', name: data.from }); return made; },
      unlinkContext: ({ data }) => { const done = graph.unlink(data); announce({ type: 'context', name: data.from }); return done; },
      contextFromResource: ({ data }) => {
        const made = graph.fromResource(data);
        for (const name of [...made.created, ...made.updated]) { announce({ type: 'context', name }); }
        return made;
      },
    });

  // the endpoints `real` answers; server() fails to compile unless these and the generated rest cover every endpoint once
  const realNames = [
    'setup', 'identity', 'setHubName', 'createAdmin', 'signIn', 'refresh', 'signOut', 'me', 'notifications', 'readNotifications',
    'capabilities', 'types', 'sessions', 'session', 'createSession', 'updateSession', 'limits', 'messages', 'send', 'invoke', 'control', 'background', 'undoTurn',
    'tree', 'run', 'llmCall', 'suggest', 'mentions', 'mentionHover', 'waiting', 'approve', 'approvals', 'contributions', 'presence',
    'searchFns', 'fnFacts', 'fnExamples', 'autoClassifier', 'setAutoClassifier', 'clientLogs', 'query', 'exploreRoots', 'exploreList', 'exploreRead',
    'systems', 'system', 'pairings', 'approvePairing', 'createPairingToken', 'configureSystem', 'enableSystem', 'switchItem', 'switchPart', 'systemReview', 'goLive', 'approveReview', 'rejectReview', 'testCall', 'refusals', 'graph', 'systemParts', 'removeSystem', 'installSystem', 'startSystem',
    'stopSystem', 'upgradeSystem', 'reimport', 'systemFns', 'systemLogs', 'providers', 'configureProvider', 'models', 'modelCategories', 'setModelCategory',
    'budgets', 'setBudget', 'priorityRules', 'setPriority', 'resolveLimits', 'policies', 'setPolicy', 'removeRule', 'actors', 'actorSettings', 'setActorSetting',
    'runs', 'llmCalls', 'resources', 'resource',
    'upload', 'uploaded', 'browseResources', 'resourceForms', 'readResource', 'convertResource', 'downloadResource', 'importResource', 'renameResource', 'deleteResource', 'contextFromResource',
    'previewSelection', 'modelLimits', 'setModelLimits', 'modelRoles', 'setModelRole', 'clearModelRole', 'modelCalls', 'modelCall', 'fnMetrics', 'fnMetricsDays',
    'mcps', 'mcp', 'createMcp', 'updateMcp', 'rotateMcpSecret', 'deleteMcp', 'previewMcp', 'mcpSessions', 'pairing', 'instances', 'installPackage', 'removeInstance', 'exportSystemData', 'addInstance', 'readFn',
    'autoPairs', 'revokeAutoPair', 'suggestDecision', 'setSuggestDecision', 'previewSuggestions',
    'pick', 'accessInfo', 'access', 'setAccess', 'connectPages', 'connect', 'updateConnection', 'disconnect',
    'contexts', 'contextItem', 'remember', 'updateMemory', 'forget', 'linkContext', 'unlinkContext',
    'dataSets', 'records', 'recordTable', 'record', 'saveRecord', 'updateRecord', 'removeRecord', 'recordVersions', 'rowActions', 'itemVersions',
  ] as const;
  // system names must match their pattern, which the generator can't read from a regex
  const systemName = (g: { rng: () => number }): string => SYSTEM_NAMES[Math.floor(g.rng() * SYSTEM_NAMES.length)] ?? 'fs';
  const overrides = { fields: { name: systemName, system: systemName } };
  const rest = implement(hubWebSpec).handlers(mockHandlers(hubWebSpec, { seed: 'harness-ui', now: () => NOW, overrides, except: realNames }));
  const app = server(hubWebSpec, [real, rest]);
  chat.attach((session, event) => { app.emit('session', { session }, event); });
  admin.attach({ user: (event) => { app.emit('user', event); }, log: (system, line) => { app.emit('systemLog', { system }, line); } });

  let live = 0;
  /** Push a new notification to every signed-in browser. */
  const notify = (): void => {
    const sample = LIVE[live++ % LIVE.length];
    if (sample === undefined) { return; }
    const notification = fixture(Notification, {
      id: mintId('notification'), user: owner(), reason: sample.reason, title: sample.title, body: sample.body,
      link: { session: 'ses_live' }, read: false, pushed: false, createdAt: Date.now(),
    });
    state.notifications = [notification, ...state.notifications];
    app.emit('user', { type: 'notification', notification });
  };

  announce = (event) => { app.emit('user', event); };
  return { app, notify, tick: () => { admin.tick(); }, library };
}

/** Serve the mock hub on `port`: the API under `/api` (as the real hub serves it) and the socket at `/ws`. */
export function serveMockHub(port: number, options: { needsAdmin: boolean; notifyEvery: number; logEvery?: number; logger?: Logger }): { stop: () => Promise<void>; notify: () => void } {
  const { app, notify, tick, library } = mockHub(options);
  const listener = createRequestListener(app);
  const httpServer = http.createServer((req, res) => {
    req.url = (req.url ?? '/').replace(/^\/api(?=\/|$)/, '') || '/';
    if (req.url.startsWith(MOCK_UPLOADS) && req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      req.on('end', () => {
        const ok = library.receive(req.url?.slice(MOCK_UPLOADS.length) ?? '', new Uint8Array(Buffer.concat(chunks)));
        res.writeHead(ok ? 200 : 404);
        res.end();
      });
      return;
    }
    if (req.url.startsWith(MOCK_EXPORTS)) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment' });
      res.end(Buffer.from(EMPTY_ZIP));
      return;
    }
    if (req.url === `${MOCK_CLIENTS}fs/index.js` && existsSync(FS_CLIENT)) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(readFileSync(FS_CLIENT));
      return;
    }
    if (req.url.startsWith(MOCK_FILES)) {
      const file = library.file(req.url.slice(MOCK_FILES.length));
      res.writeHead(file === undefined ? 404 : 200, { 'content-type': file?.mime ?? 'text/plain', 'accept-ranges': 'bytes' });
      res.end(file === undefined ? 'not found' : Buffer.from(file.bytes));
      return;
    }
    listener(req, res);
  });
  const sockets = handleUpgrade(app, httpServer, { path: '/ws' });
  const timer = options.notifyEvery > 0 ? setInterval(notify, options.notifyEvery) : undefined;
  const ticker = (options.logEvery ?? 0) > 0 ? setInterval(tick, options.logEvery) : undefined;
  httpServer.listen(port, '0.0.0.0', () => { console.info('mock.hub.ready', { port, admin: MOCK_ADMIN.email }); });
  return {
    notify,
    stop: () => new Promise<void>((resolve, reject) => {
      clearInterval(timer);
      clearInterval(ticker);
      for (const ws of sockets.clients) { ws.terminate(); }
      sockets.close(() => { httpServer.close((error) => { if (error) { reject(error); } else { resolve(); } }); });
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const settings = mockHubEnv.parse();
  const hub = serveMockHub(settings.HARNESS_MOCK_PORT, { needsAdmin: settings.HARNESS_MOCK_NEEDS_ADMIN, notifyEvery: settings.HARNESS_MOCK_NOTIFY_EVERY, logEvery: settings.HARNESS_MOCK_LOG_EVERY });
  const stop = (): void => { void hub.stop().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
