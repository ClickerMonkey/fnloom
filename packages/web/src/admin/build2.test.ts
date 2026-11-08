/**
 * Build 2's admin logic and stores: model roles and limits, hub MCP rules and probes, fn metrics, model calls,
 * instances, packages and the pairing page, each on fakes.
 */
import { DURATION_BUCKETS, HubMcpId, InstanceName, ModelCallId, PairingId, QualifiedName, SystemName, type McpSelector } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { fakeCaller } from '../test/fakes.ts';
import { limitsView, mcpView, modelCall, roleView } from './test/build2.ts';
import { fakeAdmin, model, pairing, T0 } from './test/fakes.ts';
import { addEntry, connectSnippets, entryText, readFnMatch, readResourceSelector, removeEntry, selectorSize, slugOf } from './logic/mcps.ts';
import { dayBars, figures, niceMax, percentile } from './logic/metrics.ts';
import { callPurpose, callTook, sizeText, unitsText } from './logic/model-calls.ts';
import { limitsDraft, limitsOf, modelsFor, resolvedText, roleChoiceOf, roleDraft, roleWorks } from './logic/roles.ts';
import { answerJson, HttpMcpProbe } from './probe.ts';
import { fnDays, fnMetrics } from './test/build2.ts';
import { PairingPageStore } from './state/pairing.ts';
import { isPackageFile } from './state/packages.ts';

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('model roles', () => {
  it('reads a role into the editor and back, for every engine', () => {
    const browser = roleView('dictate');
    expect(roleDraft(browser)).toEqual({ engine: 'browser', model: '', provider: '', language: '' });
    expect(roleChoiceOf('dictate', roleDraft(browser))).toEqual({ ok: true, choice: { role: 'dictate', engine: { engine: 'browser' } } });
    const byModel = roleChoiceOf('dictate', { engine: 'model', model: 'openai/whisper-1', provider: '', language: 'en-GB' });
    expect(byModel).toEqual({ ok: true, choice: { role: 'dictate', engine: { engine: 'model', model: { model: 'openai/whisper-1' } }, language: 'en-GB' } });
    if (!byModel.ok) { throw new Error('expected a choice'); }
    expect(roleDraft(roleView('dictate', { choice: byModel.choice }))).toEqual({ engine: 'model', model: 'openai/whisper-1', provider: '', language: 'en-GB' });
    expect(roleChoiceOf('transcribe', { engine: 'model', model: ' ', provider: '', language: '' })).toEqual({ ok: false, problem: 'Choose a model.' });
    expect(roleDraft(roleView('transcribe')).model).toBe('openai/whisper-1');
  });

  it('puts models that can do the job first, and says what a role resolves to', () => {
    const hearing = model({ id: 'openai/whisper-1', name: 'Whisper', capabilities: ['hearing'] });
    const chat = model();
    expect(modelsFor('transcribe', [chat, hearing])).toEqual({ able: [hearing], other: [chat] });
    expect(resolvedText(roleView('transcribe'))).toBe('openai/whisper-1 on openai');
    expect(resolvedText(roleView('speak'))).toBe('Not set: this job is off.');
    expect(roleWorks(roleView('speak', { from: 'setting', resolved: { problem: 'No provider' } }))).toBe(false);
  });

  it('reads limits: blank leaves a field to the next source, the schema bounds the rest', () => {
    expect(limitsDraft(limitsView())).toEqual({ contextWindow: '', maxOutputTokens: '512', reasoningTokens: '', charsPerToken: '' });
    expect(limitsOf({ contextWindow: '4096', maxOutputTokens: '', reasoningTokens: '', charsPerToken: '3.5' })).toEqual({ ok: true, limits: { contextWindow: 4_096, charsPerToken: 3.5 } });
    expect(limitsOf({ contextWindow: 'lots', maxOutputTokens: '', reasoningTokens: '', charsPerToken: '' })).toEqual({ ok: false, problem: 'Context window must be a number.' });
    const small = limitsOf({ contextWindow: '100', maxOutputTokens: '', reasoningTokens: '', charsPerToken: '' });
    expect(small.ok).toBe(false);
  });

  it('saves a role and limits, replacing their rows', async () => {
    const { admin, api } = fakeAdmin();
    await admin.roles.loadRoles();
    const result = await admin.roles.setRole({ role: 'dictate', engine: { engine: 'browser' }, language: 'fr-FR' });
    expect(result.ok).toBe(true);
    expect(admin.roles.role('dictate')?.from).toBe('setting');
    expect(admin.roles.roles.value.value).toHaveLength(6);
    await admin.roles.clearRole('dictate');
    expect(api.clearModelRole.calls).toEqual([[{ role: 'dictate' }]]);
    await admin.roles.loadLimits();
    await admin.roles.setLimits('ollama/qwen2.5:3b', { contextWindow: 8_192 });
    expect(admin.roles.limits.value.value?.find((l) => l.model === 'ollama/qwen2.5:3b')?.limits.contextWindow).toBe(8_192);
  });
});

describe('hub MCP rules', () => {
  const empty: McpSelector = {};

  it('adds and removes entries of every part, refusing what isn’t one', () => {
    let selector = empty;
    for (const [part, text] of [['systems', 'fs'], ['fns', 'fs/* #read'], ['types', 'fs/Entry'], ['context', 'memory/*'], ['resources', 'file:// on fs@laptop']] as const) {
      const added = addEntry(selector, part, text);
      if (!added.ok) { throw new Error(added.problem); }
      selector = added.value;
    }
    expect(selectorSize(selector)).toBe(5);
    expect(entryText('fns', selector)).toEqual(['fs/* #read']);
    expect(entryText('resources', selector)).toEqual(['file:// on fs@laptop']);
    expect(addEntry(selector, 'systems', 'Not A System').ok).toBe(false);
    expect(addEntry(selector, 'types', 'no-slash').ok).toBe(false);
    const removed = removeEntry(selector, 'systems', 0);
    expect(removed.systems).toBeUndefined();
    expect(selectorSize(removed)).toBe(4);
  });

  it('reads fn matchers and resource selectors', () => {
    expect(readFnMatch('fs/read')).toEqual({ ok: true, value: { fn: 'fs/read' } });
    expect(readFnMatch('#write system:fs')).toEqual({ ok: true, value: { tags: ['write'], system: 'fs' } });
    expect(readFnMatch('  ').ok).toBe(false);
    expect(readResourceSelector('file://')).toEqual({ ok: true, value: { uri: 'file://' } });
    expect(readResourceSelector('file:// on fs')).toEqual({ ok: true, value: { uri: 'file://', system: 'fs' } });
  });

  it('makes a route from a name, and connect snippets with or without the secret', () => {
    expect(slugOf('Claude sessions!')).toBe('claude-sessions');
    expect(slugOf('42')).toBeUndefined();
    const mcp = mcpView();
    expect(connectSnippets(mcp).claude).toBe('claude mcp add --transport http claude http://127.0.0.1:4300/mcp/claude --header "Authorization: Bearer <secret>"');
    expect(JSON.parse(connectSnippets(mcp, 'hmcp_x').json)).toEqual({ mcpServers: { claude: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer hmcp_x' } } } });
  });

  it('edits rules with a live preview, saves, rotates (keeping the secret to show once) and tries the MCP', async () => {
    const { admin, api, probe } = fakeAdmin();
    const id = HubMcpId.parse('mcp_claude');
    await admin.mcp.open(id, 'hmcp_first');
    expect(admin.mcp.secret.value).toBe('hmcp_first');
    expect(admin.mcp.changed.value).toBe(false);
    await flush();
    expect(api.previewMcp.calls).toHaveLength(1);
    admin.mcp.edit({ include: { systems: [SystemName.parse('fs')] }, exclude: {} });
    expect(admin.mcp.changed.value).toBe(true);
    await flush();
    expect(api.previewMcp.calls[1]?.[0]).toEqual({ rules: { include: { systems: ['fs'] }, exclude: {} } });
    expect((await admin.mcp.update()).ok).toBe(true);
    expect(api.updateMcp.calls[0]?.[0]).toMatchObject({ mcp: id, rules: { include: { systems: ['fs'] }, exclude: {} } });
    expect(admin.mcp.changed.value).toBe(false);
    await admin.mcp.rotateSecret();
    expect(admin.mcp.secret.value).toBe('hmcp_rotated-secret');
    await admin.mcp.tryIt('');
    expect(probe.asked).toEqual([{ url: mcpView().url, secret: 'hmcp_rotated-secret' }]);
    expect(admin.mcp.tried.value.value?.tools.map((t) => t.name)).toEqual(['fs_read', 'fs_search']);
    await admin.mcp.tryIt('wrong');
    expect(admin.mcp.tried.problem.value).toBe("Couldn't reach the MCP with that secret.");
    admin.mcp.close();
    expect(admin.mcp.secret.value).toBe('');
  });

  it('makes an MCP and lists it', async () => {
    const { admin } = fakeAdmin();
    await admin.mcps.load();
    const made = await admin.mcps.make({ slug: mcpView().slug, name: 'New', instructions: '', rules: { include: {}, exclude: {} }, toolMode: 'static', user: mcpView().user, grantees: [], origins: [], enabled: true });
    expect(made.ok && made.value.secret).toBe('hmcp_new-secret');
    expect(admin.mcps.list.value.value).toHaveLength(2);
  });
});

describe('the MCP probe', () => {
  it('reads an answer that came as JSON or as server-sent events', () => {
    expect(answerJson('application/json', '{"a":1}')).toEqual({ a: 1 });
    expect(answerJson('text/event-stream', 'event: message\ndata: {"partial"\ndata: {"b":2}\n\n')).toEqual({ b: 2 });
    expect(() => answerJson('text/event-stream', ': ping\n')).toThrow('no answer');
  });

  it('initializes with the secret, keeps the session, and lists the tools', async () => {
    const sent: { headers: Headers; body: unknown }[] = [];
    const probe = new HttpMcpProbe((_url, init) => {
      const headers = new Headers(init.headers);
      const body: unknown = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      sent.push({ headers, body });
      const method: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'method') : undefined;
      const id: unknown = Reflect.get(Object(body), 'id');
      if (method === 'notifications/initialized') { return Promise.resolve(new Response(null, { status: 202 })); }
      const result = method === 'initialize' ? { serverInfo: { name: 'harness', version: '1' }, instructions: 'Hi' } : { tools: [{ name: 'fs_read' }] };
      return Promise.resolve(new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' } }));
    });
    expect(await probe.tools('http://hub/mcp/x', 'hmcp_k')).toEqual({ server: { name: 'harness', version: '1' }, instructions: 'Hi', tools: [{ name: 'fs_read' }] });
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer hmcp_k');
    expect(sent[2]?.headers.get('mcp-session-id')).toBe('s1');
    const refused = new HttpMcpProbe(() => Promise.resolve(new Response('no', { status: 401 })));
    await expect(refused.tools('http://hub/mcp/x', 'bad')).rejects.toThrow('refused that secret');
  });
});

describe('fn metrics', () => {
  it('reads percentiles from a histogram to within a bucket', () => {
    const histogram = new Array<number>(DURATION_BUCKETS.length + 1).fill(0);
    histogram[2] = 8;
    histogram[5] = 2;
    const stats = { count: 10, sum: 0, max: 2_400, histogram };
    expect(percentile(stats, 0.5)).toBe(DURATION_BUCKETS[2]);
    expect(percentile(stats, 0.95)).toBe(DURATION_BUCKETS[5]);
    expect(percentile({ ...stats, count: 0 }, 0.5)).toBeUndefined();
  });

  it('makes the strip and the day bars, keeping retried input apart from failures', () => {
    const strip = figures(fnMetrics());
    expect(strip.find((f) => f.key === 'retried')?.value).toBe('14');
    expect(strip.find((f) => f.key === 'failed')?.value).toBe('8');
    expect(strip.find((f) => f.key === 'runs')?.detail).toBe('84% done');
    const days = fnDays(7);
    const runs = dayBars(days, 'runs');
    expect(runs).toHaveLength(7);
    expect(runs[0]?.value).toBe(days[0]?.ran.count);
    expect(runs[0]?.lines[1]).toContain('retried');
    expect(dayBars(days, 'time')[0]?.lines[0]).toMatch(/^Typical /);
    expect([niceMax(0), niceMax(7), niceMax(12), niceMax(480)]).toEqual([1, 10, 20, 500]);
  });

  it('follows its fn: a settled run updates the numbers', async () => {
    const { admin, api, user } = fakeAdmin();
    const fn = QualifiedName.parse('fs/read_file');
    await admin.fn.open(fn, 30);
    expect(api.fnMetricsDays.calls[0]?.[0]).toEqual({ fn, days: 30 });
    expect(admin.fn.daily.value.value).toHaveLength(30);
    user.push({ type: 'fn', fn, system: SystemName.parse('fs'), stats: { runs: 141, failures: 3, averageCost: 0, averageTime: 40 } });
    expect(admin.fn.record.value.value?.stats.runs).toBe(141);
    await flush();
    expect(api.fnMetrics.calls).toHaveLength(2);
  });
});

describe('model calls', () => {
  it('says what a call used, for what, and how big it was', () => {
    expect(unitsText({ modality: 'chat', input: 1_840, output: 212 })).toBe('1.8k in, 212 out');
    expect(unitsText({ modality: 'transcribe', seconds: 14.2, bytes: 1 })).toBe('14s of audio');
    expect(unitsText({ modality: 'embed', texts: 1, characters: 400, dimensions: 768 })).toBe('1 text, 100 tokens, 768 dims');
    expect(callPurpose({ fn: QualifiedName.parse('fs/x'), system: SystemName.parse('fs') })).toBe('for fs/x (fs)');
    expect(callPurpose({ purpose: 'index' })).toBe('hub: index');
    expect(sizeText({ sent: 2_048, received: 10 })).toBe('2.0 KB sent, 10 B received');
    expect(callTook({ status: 'running', startedAt: T0 - 500 }, T0)).toBe(500);
  });

  it('opens a chat call with its interaction', async () => {
    const { admin, api, chatApi } = fakeAdmin();
    api.modelCall = fakeCaller<'modelCall'>(({ id }) => Promise.resolve(modelCall({ id, interaction: 'llm_a' })));
    await admin.modelCalls.open(ModelCallId.parse('mdl_9'));
    expect(admin.modelCalls.opened.value.value?.interaction?.id).toBe('llm_a');
    expect(chatApi.llmCall.calls).toEqual([[{ id: 'llm_a' }]]);
    api.modelCall = fakeCaller<'modelCall'>(({ id }) => Promise.resolve(modelCall({ id, modality: 'embed', units: { modality: 'embed', texts: 1, characters: 4, dimensions: 768 } })));
    await admin.modelCalls.open(ModelCallId.parse('mdl_10'));
    expect(admin.modelCalls.opened.value.value?.interaction).toBeUndefined();
  });
});

describe('instances and packages', () => {
  it('opens an instance, saves its own config, exports its data and removes it', async () => {
    const { admin, api } = fakeAdmin();
    const key = { system: SystemName.parse('fs'), instance: InstanceName.parse('laptop') };
    await admin.instance.open(key);
    expect(admin.instance.view.value?.description).toBe('Phil’s laptop');
    const saved = await admin.instance.configure({ roots: [] });
    expect(saved).toEqual({ ok: true, version: 3 });
    expect(api.configureSystem.calls[0]?.[0]).toEqual({ system: 'fs', instance: 'laptop', config: { roots: [] } });
    const exported = await admin.instance.exportData(true);
    expect(exported).toEqual({ ok: true, value: { url: '/_files/export.zip', size: 2_048 } });
    expect(api.exportSystemData.calls[0]?.[0]).toEqual({ ...key, withSecrets: true });
    expect(await admin.instance.remove()).toBe(true);
  });

  it('uploads a package zip with progress and installs it as an instance', async () => {
    const { admin, api, sender } = fakeAdmin();
    expect(isPackageFile({ name: 'fs-0.4.0.zip' })).toBe(true);
    const zip = new File(['PK'], 'fs-0.4.0.zip', { type: 'application/zip' });
    const refused = await admin.packages.installZip(zip, { instance: 'Bad Name', autoStart: true });
    expect(refused.ok).toBe(false);
    const result = await admin.packages.installZip(zip, { instance: 'desk', autoStart: false });
    expect(result).toEqual({ ok: true, value: { system: 'fs', instance: 'desk' } });
    expect(sender.sent).toHaveLength(1);
    expect(admin.packages.progress.value).toBe(1);
    expect(api.installPackage.calls[0]?.[0]).toMatchObject({ instance: 'desk', autoStart: false, zip: { mime: 'application/zip' } });
    expect((await admin.packages.installZip(new File(['x'], 'notes.txt'), { instance: '', autoStart: true })).ok).toBe(false);
  });
});

describe('the pairing page', () => {
  it('approves with an instance and config, then follows the system until it connects', async () => {
    const { admin, api, user } = fakeAdmin();
    const store = admin.pairing;
    const id = PairingId.parse('par_qr');
    api.pairing = fakeCaller<'pairing'>(() => Promise.resolve(pairing({ id, name: 'fs', code: '483912', expiresAt: Date.now() + 60_000 })));
    expect(store.phase.value).toBe('loading');
    await store.open(id);
    expect(store.phase.value).toBe('waiting');
    expect(store.codeMatches('483912')).toBe(true);
    expect(store.codeMatches('111111')).toBe(false);
    api.approvePairing = fakeCaller<'approvePairing'>(() => Promise.resolve({ system: SystemName.parse('fs') }));
    await store.approve(InstanceName.parse('laptop'), { roots: [] });
    expect(api.approvePairing.calls[0]?.[0]).toEqual({ pairing: id, approve: true, instance: 'laptop', config: { roots: [] } });
    expect(store.phase.value).toBe('joining');
    user.push({ type: 'system', system: SystemName.parse('fs'), status: 'connected' });
    expect(store.phase.value).toBe('connected');
  });

  it('says when a request expired, was refused, or was answered elsewhere', async () => {
    const { api, user } = fakeAdmin();
    const store = new PairingPageStore(api, user.subscribe, () => T0);
    const id = PairingId.parse('par_old');
    api.pairing = fakeCaller<'pairing'>(() => Promise.resolve(pairing({ id, expiresAt: T0 - 1 })));
    await store.open(id);
    expect(store.phase.value).toBe('expired');
    api.pairing = fakeCaller<'pairing'>(() => Promise.resolve(pairing({ id, expiresAt: T0 + 60_000 })));
    await store.open(id);
    user.push({ type: 'pairing', pairing: pairing({ id, status: 'approved', expiresAt: T0 + 60_000 }) });
    expect(store.phase.value).toBe('elsewhere');
    expect(await store.refuse()).toBe(true);
    expect(store.phase.value).toBe('refused');
  });
});
