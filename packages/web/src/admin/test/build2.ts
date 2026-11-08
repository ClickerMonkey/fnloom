/**
 * Test doubles for build 2's admin pages: model roles and limits, model calls of every modality, fn metrics, hub MCPs,
 * a fleet's instances and pairing pages. Every record is parsed through the hub's own schema (so ids are the real
 * branded types and a schema change breaks the fixtures), and the mock hub's data is made from the same builders.
 */
import {
  DURATION_BUCKETS, FnMetrics, InstanceRef, FnMetricsDay, HubMcpView, InstanceView, McpScopePreview, McpSessionView, ModelCall, ModelLimitsView, ModelRoleView, type ModelRole,
} from '@harness/core';
import { fakeCaller } from '../../test/fakes.ts';
import { T0 } from '../../chat/test/fakes.ts';

type Loose<T> = Partial<Record<keyof T, unknown>>;

const DAY = 86_400_000;

/** A role as the models page lists it. */
export function roleView(role: ModelRole, overrides: Loose<ModelRoleView> = {}): ModelRoleView {
  const base = role === 'dictate'
    ? { role, choice: { role, engine: { engine: 'browser' } }, from: 'setting', resolved: { model: 'browser', provider: 'browser' } }
    : role === 'transcribe'
      ? { role, choice: { role, model: { model: 'openai/whisper-1' } }, from: 'env', resolved: { model: 'openai/whisper-1', provider: 'openai' } }
      : role === 'chat'
        ? { role, choice: { role, model: { model: 'openai/gpt-oss-20b:free' } }, from: 'env', resolved: { model: 'openai/gpt-oss-20b:free', provider: 'openrouter' } }
        : { role, from: 'none' };
  return ModelRoleView.parse({ ...base, ...overrides });
}

/** Every role, as a fresh hub lists them. */
export function roleViews(): ModelRoleView[] {
  return (['chat', 'transcribe', 'dictate', 'speak', 'describe', 'ocr'] as const).map((role) => roleView(role));
}

/** A model's resolved limits. */
export function limitsView(overrides: Loose<ModelLimitsView> = {}): ModelLimitsView {
  return ModelLimitsView.parse({
    model: 'ollama/qwen2.5:3b', limits: { contextWindow: 4_096, maxOutputTokens: 512, reasoningTokens: 0, charsPerToken: 3.6 },
    sources: { contextWindow: 'probe', maxOutputTokens: 'admin', reasoningTokens: 'default', charsPerToken: 'default' }, ratio: 1.08, ...overrides,
  });
}

let nextCall = 1;
/** A model call (a chat call unless `units` says otherwise). */
export function modelCall(overrides: Loose<ModelCall> = {}): ModelCall {
  const n = nextCall++;
  return ModelCall.parse({
    id: `mdl_${n}`, modality: 'chat', provider: 'openrouter', model: 'openai/gpt-oss-20b:free', run: 'run_a', session: 'ses_1', fn: 'hub/chat',
    units: { modality: 'chat', input: 1_840, output: 212 }, cost: 0, status: 'done', sent: 7_400, received: 900, queued: 40, firstByte: 620, total: 2_310,
    startedAt: T0 - n * 60_000, endedAt: T0 - n * 60_000 + 2_310, ...overrides,
  });
}

/** One model call of each modality, newest first. */
export function modelCallsOfEach(): ModelCall[] {
  return [
    modelCall({ interaction: 'llm_a' }),
    modelCall({ modality: 'embed', model: 'embeddinggemma', provider: 'embedder', units: { modality: 'embed', texts: 12, characters: 9_400, dimensions: 768 }, purpose: 'index', run: undefined, session: undefined, fn: undefined, sent: 9_400, received: 36_864, firstByte: undefined, total: 180 }),
    modelCall({ modality: 'transcribe', model: 'openai/whisper-1', provider: 'openai', units: { modality: 'transcribe', seconds: 14.2, bytes: 226_000 }, fn: 'hub/dictate', cost: 0.0014, sent: 226_000, received: 240, total: 1_900 }),
    modelCall({ modality: 'image', model: 'openai/gpt-image-1', provider: 'openai', units: { modality: 'image', images: 1, size: '1024x1024' }, system: 'fs', fn: 'fs/illustrate', cost: 0.04, sent: 300, received: 1_400_000, total: 9_800 }),
    modelCall({ modality: 'speech', model: 'openai/tts-1', provider: 'openai', units: { modality: 'speech', characters: 420, seconds: 26 }, fn: 'hub/speak', cost: 0.006, sent: 420, received: 410_000, total: 1_200 }),
    modelCall({ status: 'failed', error: 'The provider refused the request (429).', units: { modality: 'chat', input: 900, output: 0 }, firstByte: undefined, total: 300 }),
  ];
}

/** Duration stats: `runs` runs spread over the buckets around `typical` ms. */
function durations(runs: number, typical: number): FnMetricsDay['ran'] {
  const histogram: number[] = new Array<number>(DURATION_BUCKETS.length + 1).fill(0);
  const at = DURATION_BUCKETS.findIndex((bound) => typical <= bound);
  const bucket = at === -1 ? DURATION_BUCKETS.length : at;
  histogram[bucket] = Math.ceil(runs * 0.7);
  histogram[Math.min(bucket + 1, DURATION_BUCKETS.length)] = (histogram[Math.min(bucket + 1, DURATION_BUCKETS.length)] ?? 0) + Math.floor(runs * 0.3);
  return { count: runs, sum: runs * typical, max: typical * 4, histogram };
}

/** One fn's day of runs. */
export function fnDay(day: string, runs: number, overrides: Loose<FnMetricsDay> = {}): FnMetricsDay {
  const failed = Math.floor(runs / 12);
  const invalid = Math.floor(runs / 9);
  return FnMetricsDay.parse({
    fn: 'fs/read_file', system: 'fs', day, outcomes: { done: runs - failed - invalid, 'invalid-input': invalid, failed, cancelled: 0 },
    queued: durations(runs, 20), approval: durations(0, 0), ran: durations(runs, 140), cost: 0, tokens: runs * 320, retries: invalid, modelCalls: 0, updatedAt: T0, ...overrides,
  });
}

/** The last `count` days of one fn, oldest first, with a weekday rhythm. */
export function fnDays(count: number, fn = 'fs/read_file'): FnMetricsDay[] {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(T0 - (count - 1 - i) * DAY);
    const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6;
    return fnDay(at.toISOString().slice(0, 10), weekend ? 6 + (i % 4) : 18 + ((i * 7) % 15), { fn });
  });
}

/** A fn's rollup over a period. */
export function fnMetrics(overrides: Loose<FnMetrics> = {}): FnMetrics {
  return FnMetrics.parse({
    fn: 'fs/read_file', system: 'fs', from: '2026-11-01', to: '2026-11-07', runs: 140, outcomes: { done: 118, 'invalid-input': 14, failed: 8, cancelled: 0 },
    p50: 140, p95: 480, averageQueued: 22, averageCost: 0, cost: 0, tokens: 44_800, retries: 14, lastRunAt: T0 - 30_000, ...overrides,
  });
}

/** A hub MCP as the admin list shows it. */
export function mcpView(overrides: Loose<HubMcpView> = {}): HubMcpView {
  return HubMcpView.parse({
    id: 'mcp_claude', slug: 'claude', name: 'Claude sessions', instructions: 'Read files and search the project through the hub.',
    rules: { include: { systems: ['fs'] }, exclude: { fns: [{ fn: 'fs/bash' }] } }, toolMode: 'each', user: 'act_ada', actor: 'act_mcp_claude',
    grantees: ['claude'], origins: [], enabled: true, createdBy: 'act_ada', createdAt: T0 - 3 * DAY, updatedAt: T0 - DAY,
    url: 'http://127.0.0.1:4300/mcp/claude', sessions: 2, callsToday: 37, ...overrides,
  });
}

/** What rules expose now. */
export function scopePreview(overrides: Loose<McpScopePreview> = {}): McpScopePreview {
  return McpScopePreview.parse({
    fns: ['fs/read', 'fs/search', 'fs/list'], types: ['fs/Entry'], closure: ['fs/Match'], context: ['fs/docs'], resources: [{ uri: 'file://' }],
    reach: ['hub/resource_read'], warnings: ['fs/docs brings fs/bash, which is excluded.'], ...overrides,
  });
}

/** An open session on a hub MCP. */
export function mcpSession(overrides: Loose<McpSessionView> = {}): McpSessionView {
  return McpSessionView.parse({ mcp: 'mcp_claude', session: 'mcs_1', label: 'claude session 3', client: { name: 'claude-code', version: '2.1.0' }, since: T0 - 40 * 60_000, lastCallAt: T0 - 60_000, calls: 21, ...overrides });
}

/** One instance of a system. */
export function instanceView(overrides: Loose<InstanceView> = {}): InstanceView {
  return InstanceView.parse({
    system: 'fs', instance: 'main', description: 'This computer', status: 'connected', keyFingerprint: 'SHA256:9f2c41a0b7', version: '0.4.0', manifestHash: 'a1b2c3d4',
    config: { value: { roots: [{ path: '/work', name: 'work', writable: true }] }, version: 2, setBy: 'act_ada', setAt: T0 - 3_600_000 },
    dirs: { state: '.harness/systems/fs/instances/main/state', data: '.harness/systems/fs/instances/main/data', cache: '.harness/systems/fs/instances/main/cache' },
    pairedAt: T0 - DAY, pairedBy: 'act_ada', lastSeenAt: T0 - 5_000, address: '127.0.0.1', ...overrides,
  });
}

/** A fleet: the main fs and a laptop. */
export function fleet(): InstanceView[] {
  return [
    instanceView(),
    instanceView({ instance: 'laptop', description: 'Phil’s laptop', address: '192.168.50.31', dirs: undefined, lastSeenAt: T0 - 12 * 60_000, status: 'disconnected', keyFingerprint: 'SHA256:5bd0e7', config: undefined }),
  ];
}

/** The fake build 2 admin callers. */
export function fakeBuild2Api() {
  return {
    modelRoles: fakeCaller<'modelRoles'>(() => Promise.resolve(roleViews())),
    setModelRole: fakeCaller<'setModelRole'>((choice) => Promise.resolve(roleView(choice.role, { choice, from: 'setting' }))),
    clearModelRole: fakeCaller<'clearModelRole'>(({ role }) => Promise.resolve(roleView(role))),
    modelLimits: fakeCaller<'modelLimits'>(() => Promise.resolve([limitsView(), limitsView({ model: 'openai/gpt-oss-20b:free', limits: { contextWindow: 131_072, maxOutputTokens: 4_096, reasoningTokens: 1_024, charsPerToken: 4 }, sources: { contextWindow: 'model-info', maxOutputTokens: 'model-info', reasoningTokens: 'default', charsPerToken: 'default' } })])),
    setModelLimits: fakeCaller<'setModelLimits'>(({ model, limits }) => Promise.resolve(limitsView({ model, limits: { ...limitsView().limits, ...limits } }))),
    modelCalls: fakeCaller<'modelCalls'>(() => Promise.resolve({ items: modelCallsOfEach() })),
    modelCall: fakeCaller<'modelCall'>(({ id }) => Promise.resolve(modelCall({ id }))),
    fnMetrics: fakeCaller<'fnMetrics'>(() => Promise.resolve([fnMetrics()])),
    fnMetricsDays: fakeCaller<'fnMetricsDays'>(({ fn, days }) => Promise.resolve(fnDays(days ?? 7, fn))),
    mcps: fakeCaller<'mcps'>(() => Promise.resolve([mcpView()])),
    mcp: fakeCaller<'mcp'>(({ mcp }) => Promise.resolve(mcpView({ id: mcp }))),
    createMcp: fakeCaller<'createMcp'>((input) => Promise.resolve({ mcp: mcpView({ ...input, id: 'mcp_new' }), secret: 'hmcp_new-secret' })),
    updateMcp: fakeCaller<'updateMcp'>(({ mcp, ...change }) => Promise.resolve(mcpView({ id: mcp, ...change }))),
    rotateMcpSecret: fakeCaller<'rotateMcpSecret'>(() => Promise.resolve({ secret: 'hmcp_rotated-secret' })),
    deleteMcp: fakeCaller<'deleteMcp'>(() => Promise.resolve({ ok: true })),
    previewMcp: fakeCaller<'previewMcp'>(() => Promise.resolve(scopePreview())),
    mcpSessions: fakeCaller<'mcpSessions'>(() => Promise.resolve([mcpSession()])),
    instances: fakeCaller<'instances'>(() => Promise.resolve(fleet())),
    installPackage: fakeCaller<'installPackage'>(({ instance }) => Promise.resolve(InstanceRef.parse({ system: 'fs', instance: instance ?? 'main' }))),
    removeInstance: fakeCaller<'removeInstance'>(() => Promise.resolve({ ok: true })),
    exportSystemData: fakeCaller<'exportSystemData'>(() => Promise.resolve({ hash: 'c'.repeat(64), size: 2_048, mime: 'application/zip', url: '/_files/export.zip' })),
    upload: fakeCaller<'upload'>(({ name }) => Promise.resolve({ url: `/_files?put=${name}`, upload: `up_${name}` })),
    uploaded: fakeCaller<'uploaded'>(() => Promise.resolve({ hash: 'd'.repeat(64), size: 4_096, mime: 'application/zip' })),
    search: fakeCaller<'search'>(() => Promise.resolve([])),
  };
}
