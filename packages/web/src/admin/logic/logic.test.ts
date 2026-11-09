import { ActorId, BudgetId, LlmInteractionId, QualifiedName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RunFilter } from '@harness/core';
import { budget, installed, pairing, policy, systemView, T0 } from '../test/fakes.ts';
import { LLM_STATUS_LOOK, filterOf, llmTimes } from './browsers.ts';
import {
  budgetBody, budgetDraft, categoryBody, installFields, installSource, policyBody, policyDraft, priorityBody, priorityDraft, providerBody, providerFields, tokenBody, autoPairPart,
} from './forms.ts';
import { budgetAmount, budgetUse, periodText, resolvedText, scopeText } from './limits.ts';
import { adminNav } from './nav.ts';
import { decisionText, sortPolicies, subjectText, targetText } from './policies.ts';
import { autoPairState, availabilityText, endsText, groupedCode, pendingPairings, sortSystems, systemActions, timeLeft } from './systems.ts';
import { decisionDraft, decisionModelText, decisionOf, previewParts } from './suggestions.ts';

const names: Record<string, string> = { act_eng: 'Engineering', act_ada: 'Ada' };
const nameOf = (id: ActorId): string => names[id] ?? id;

describe('systems', () => {
  it('offers the lifecycle actions that apply now', () => {
    expect([...systemActions(systemView({ installed: installed({ status: 'running' }) }))]).toEqual(['stop', 'restart', 'upgrade', 'reimport', 'remove']);
    expect([...systemActions(systemView({ installed: installed({ status: 'crashed' }), status: 'disconnected' }))]).toEqual(['start', 'upgrade', 'remove']);
    expect([...systemActions(systemView({ installed: installed({ status: 'installing' }), status: 'pairing' }))]).toEqual(['remove']);
    expect([...systemActions(systemView({ status: 'removed' }))]).toEqual([]);
  });

  it('lists what needs the admin first: crashes, pairing, config, offline, then by name', () => {
    const order = sortSystems([
      systemView({ name: 'zeta' }), systemView({ name: 'alpha' }), systemView({ name: 'cfg', status: 'needs-config' }),
      systemView({ name: 'off', status: 'disconnected' }), systemView({ name: 'boom', installed: installed({ status: 'crashed' }) }),
    ]).map((s) => s.name);
    expect(order).toEqual(['boom', 'cfg', 'off', 'alpha', 'zeta']);
  });

  it('keeps pending, unexpired pairings, soonest first, and reads codes and time left plainly', () => {
    const soon = pairing({ expiresAt: T0 + 60_000 });
    const later = pairing({ expiresAt: T0 + 600_000 });
    expect(pendingPairings([later, pairing({ status: 'approved' }), pairing({ expiresAt: T0 - 1 }), soon], T0)).toEqual([soon, later]);
    expect(groupedCode('483912')).toBe('483 912');
    expect(timeLeft(T0 + 90_000, T0)).toBe('2m');
    expect(timeLeft(T0 + 3_900_000, T0)).toBe('1h 5m');
    expect(timeLeft(T0 + 7_200_000, T0)).toBe('2h');
    expect(timeLeft(T0, T0)).toBe('expired');
    expect(availabilityText(true)).toBe('');
    expect(availabilityText({ unavailable: 'system-needs-config', detail: '' })).toBe('Its system needs config');
  });
});

describe('limits', () => {
  it('says where a rule lives, its period and its amount', () => {
    expect(scopeText({ scope: 'hub' }, nameOf)).toBe('Whole hub');
    expect(scopeText({ scope: 'group', group: ActorId.parse('act_eng') }, nameOf)).toBe('Group: Engineering');
    expect(scopeText({ scope: 'fn', fn: 'fs/read_file' }, nameOf)).toBe('Fn: Read file');
    expect(periodText({ window: 86_400_000 })).toBe('per day');
    expect(periodText({ window: 7_200_000 })).toBe('per 2h 00m');
    expect(periodText('per-turn')).toBe('per message');
    expect(budgetAmount(budget({ maxTokens: 50_000 }))).toBe('$5.00 per day · 50,000 tokens');
  });

  it('warms the meter as a budget runs out', () => {
    expect(budgetUse({ spent: 1, maxCost: 4 })).toEqual({ fraction: 0.25, tone: 'ok' });
    expect(budgetUse({ spent: 3.5, maxCost: 4 }).tone).toBe('warn');
    expect(budgetUse({ spent: 9, maxCost: 4 })).toEqual({ fraction: 1, tone: 'danger' });
    expect(budgetUse({ spent: 0, maxCost: 0 }).fraction).toBe(1);
  });

  it('explains resolved limits and finds the tightest budget', () => {
    const tight = BudgetId.parse('bgt_tight');
    const text = resolvedText({
      priority: 'normal', priorityFrom: { default: 'group', cappedBy: 'hub' }, turn: { cost: 0.5, time: 60_000 },
      budgets: [{ rule: BudgetId.parse('bgt_hub'), scope: { scope: 'hub' }, remaining: 4 }, { rule: tight, scope: { scope: 'hub' }, remaining: 1 }], limitedBy: tight,
    });
    expect(text.priority).toBe('Normal, from the group default, capped by the hub.');
    expect(text.turn).toBe('Each message may spend up to $0.50 and run for 1m 00s.');
    expect(text.tightest).toBe(1);
  });
});

describe('policies', () => {
  it('reads who, which fns and what as plain words', () => {
    expect(subjectText({ everyone: true }, nameOf)).toBe('Everyone');
    expect(subjectText({ group: ActorId.parse('act_eng') }, nameOf)).toBe('Group Engineering');
    expect(subjectText({ kind: 'agent' }, nameOf)).toBe('All agents');
    expect(targetText({ fn: 'fs/*', tags: ['write'] })).toBe('fs/*, tagged write');
    expect(targetText({ fn: 'fs/read_file' })).toBe('Read file');
    expect(targetText({})).toBe('any fn');
    expect(decisionText({ effect: 'ask', approver: { by: 'group', group: ActorId.parse('act_eng'), quorum: 2 } }, nameOf)).toEqual({ word: 'Ask', detail: 'asks group Engineering (2 needed)', tone: 'warn' });
    expect(decisionText({ effect: 'deny', reason: 'No.' }, nameOf).tone).toBe('danger');
  });

  it('weighs higher ranks first, then deny before ask before allow', () => {
    const allow = policy({ id: 'pol_a', priority: 5, decision: { effect: 'allow' } });
    const deny = policy({ id: 'pol_d', priority: 5, decision: { effect: 'deny', reason: 'x' } });
    const top = policy({ id: 'pol_t', priority: 9 });
    expect(sortPolicies([allow, deny, top]).map((p) => p.id)).toEqual(['pol_t', 'pol_d', 'pol_a']);
  });
});

describe('forms', () => {
  it('turns a budget draft into the body setBudget takes, and back', () => {
    const draft = { ...budgetDraft(), scope: { level: 'group' as const, target: 'act_eng' }, maxCost: '2.5', maxTokens: '1000', share: 'each' as const };
    const checked = budgetBody(draft);
    expect(checked).toEqual({ ok: true, value: { target: { scope: 'group', group: 'act_eng' }, period: { window: 86_400_000 }, maxCost: 2.5, maxTokens: 1000, share: 'each', onLimit: 'refuse' } });
    expect(budgetBody({ ...draft, maxCost: '' })).toMatchObject({ ok: false, problems: { maxCost: 'Required.' } });
    const blank = budgetBody({ ...draft, scope: { level: 'group', target: '' } });
    expect(!blank.ok && typeof blank.problems.target).toBe('string');
    const perTurn = budgetBody({ ...budgetDraft(), period: 'per-turn', maxCost: '1', maxTime: '90' });
    expect(perTurn.ok && perTurn.value.maxTime).toBe(90_000);
    expect(budgetDraft(budget({ target: { scope: 'user', user: 'act_ada' }, maxTime: 30_000, period: 'per-turn' }))).toMatchObject({ scope: { level: 'user', target: 'act_ada' }, period: 'per-turn', maxTime: '30' });
  });

  it('asks a priority rule for a default or a ceiling', () => {
    expect(priorityBody(priorityDraft())).toEqual({ ok: false, problems: { default: 'Set a default, a ceiling, or both.' } });
    expect(priorityBody({ ...priorityDraft(), max: 'normal' })).toEqual({ ok: true, value: { target: { scope: 'hub' }, max: 'normal' } });
  });

  it('builds a policy from its draft and round-trips one', () => {
    const made = policyBody({ ...policyDraft(), description: 'Writes ask', subject: 'group', subjectValue: 'act_eng', fn: 'fs/*', tags: ['write', 'delete'], effect: 'ask', approver: 'group', approverValue: 'act_eng', quorum: '2', priority: '3' });
    expect(made).toEqual({ ok: true, value: {
      description: 'Writes ask', subject: { group: 'act_eng' }, target: { fn: 'fs/*', tags: ['write', 'delete'] },
      decision: { effect: 'ask', approver: { by: 'group', group: 'act_eng', quorum: 2 } }, priority: 3,
    } });
    expect(policyBody({ ...policyDraft(), description: 'x', effect: 'deny' })).toEqual({ ok: false, problems: { decision: 'Say why, for the people it stops.' } });
    expect(policyBody(policyDraft())).toEqual({ ok: false, problems: { description: 'Required.' } });
    const existing = policy();
    const again = policyBody(policyDraft(existing));
    expect(again.ok && again.value).toEqual({ description: existing.description, subject: existing.subject, target: existing.target, decision: existing.decision, priority: existing.priority });
  });

  it('needs a category name and at least one model', () => {
    expect(categoryBody({ name: ' ', description: '', models: ['m'] })).toEqual({ ok: false, problems: { name: 'Required.' } });
    expect(categoryBody({ name: 'fast', description: '', models: [] })).toEqual({ ok: false, problems: { models: 'Add at least one model.' } });
    expect(categoryBody({ name: 'fast', description: 'd', models: ['m'] })).toEqual({ ok: true, value: { name: 'fast', description: 'd', models: ['m'] } });
  });

  it('takes provider fields from the input schema, secrets hidden', () => {
    expect(providerFields('openai').map((f) => [f.name, f.secret, f.required])).toEqual([['apiKey', true, true], ['baseURL', false, false]]);
    expect(providerBody('openrouter', {})).toEqual({ ok: false, problems: { apiKey: 'Required.' } });
    expect(providerBody('openai', { apiKey: 'sk', baseURL: 'nope' })).toEqual({ ok: false, problems: { baseURL: 'Enter a web address.' } });
    expect(providerBody('openai', { apiKey: ' sk ', baseURL: '' })).toEqual({ ok: true, value: { provider: 'openai', apiKey: 'sk' } });
  });

  it('shows the AWS sign-in chosen and gathers its fields under auth', () => {
    expect(providerFields('aws', 'keys').map((f) => [f.name, f.secret, f.required])).toEqual([
      ['region', false, true], ['accessKeyId', false, true], ['secretAccessKey', true, true], ['sessionToken', true, false], ['profilePrefix', false, false],
    ]);
    expect(providerFields('aws', 'apiKey').map((f) => f.name)).toEqual(['region', 'apiKey', 'profilePrefix']);
    expect(providerBody('aws', { region: 'us-east-1' }, 'apiKey')).toEqual({ ok: false, problems: { apiKey: 'Required.' } });
    expect(providerBody('aws', { accessKeyId: 'AKIA' }, 'keys')).toEqual({ ok: false, problems: { region: 'Required.', secretAccessKey: 'Required.' } });
    expect(providerBody('aws', { region: ' eu-west-1 ', apiKey: 'bedrock-key', accessKeyId: 'ignored' }, 'apiKey')).toEqual({
      ok: true, value: { provider: 'aws', region: 'eu-west-1', auth: { kind: 'apiKey', apiKey: 'bedrock-key' } },
    });
  });

  it('takes install fields from the source schema and needs them all', () => {
    expect(installFields('git')).toEqual(['git', 'ref']);
    expect(installSource({ kind: 'package', fields: {} })).toEqual({ ok: false, problems: { package: 'Required.', version: 'Required.' } });
    expect(installSource({ kind: 'path', fields: { path: ' /opt/notes ' } })).toEqual({ ok: true, value: { path: '/opt/notes' } });
  });

  it('checks a pairing token name', () => {
    expect(tokenBody('', 60_000)).toEqual({ ok: true, value: { expiresIn: 60_000 } });
    expect(tokenBody('notes', 60_000)).toEqual({ ok: true, value: { name: 'notes', expiresIn: 60_000 } });
    expect(tokenBody('Bad Name', 60_000)).toMatchObject({ ok: false, problems: { name: 'Lowercase letters, digits and dashes, starting with a letter.' } });
  });
});

describe('browsers and nav', () => {
  it('reads a filter from the URL field by field, dropping bad values', () => {
    expect(filterOf(RunFilter, { status: 'failed', fn: ' fs/* ', system: 'Not A Name', session: '' })).toEqual({ status: 'failed', fn: 'fs/*' });
    expect(filterOf(RunFilter, { status: 'nope' })).toEqual({});
  });

  it('times an LLM call', () => {
    expect(llmTimes({ queuedAt: T0, startedAt: T0 + 100, firstTokenAt: T0 + 400, endedAt: T0 + 1_100 }, T0 + 5_000)).toEqual({ firstToken: 300, total: 1_000 });
    expect(llmTimes({ queuedAt: T0 }, T0 + 5_000)).toEqual({});
    expect(LLM_STATUS_LOOK.streaming.live).toBe(true);
    expect(LlmInteractionId.parse('llm_1')).toBe('llm_1');
  });

  it('lists every admin section and marks the current one', () => {
    const entries = adminNav({ name: 'system' }, { systems: 2 });
    expect(entries.map((e) => e.id)).toEqual(['systems', 'fns', 'models', 'limits', 'policies', 'actor-settings', 'runs', 'model-calls', 'mcps']);
    // the resource browser is a top-level page; the admin nav has no entry that only redirects there
    expect(entries.find((e) => e.label === 'Budgets')?.id).toBe('limits');
    // the LLM calls browser and a fn's page sit under their sections
    expect(adminNav({ name: 'llm-calls' }).find((e) => e.active)?.id).toBe('model-calls');
    expect(adminNav({ name: 'fn' }).find((e) => e.active)?.id).toBe('fns');
    expect(entries.find((e) => e.active)?.id).toBe('systems');
    expect(entries[0]?.count).toBe(2);
    expect(adminNav({ name: undefined }).some((e) => e.active)).toBe(false);
  });
});

describe('build 3 admin forms', () => {
  it('reads the decision model form, says the setting in words and splits a try-out', () => {
    const off = decisionDraft(undefined);
    expect(decisionOf(off)).toMatchObject({ ok: true, value: { enabled: false, messages: 3, cap: 6 } });
    expect(decisionOf({ ...off, enabled: true })).toMatchObject({ ok: false, at: 'model' });
    expect(decisionOf({ ...off, cap: '99' })).toEqual({ ok: false, problem: 'Most it picks is out of range.', at: 'numbers' });
    const on = decisionOf({ ...off, enabled: true, model: 'gpt-4o-mini' });
    if (!on.ok) { throw new Error(on.problem); }
    expect(decisionDraft({ value: on.value }).model).toBe('gpt-4o-mini');
    expect(decisionModelText({ value: on.value })).toBe('gpt-4o-mini · last 3 messages · up to 6 of 20 above 0.2');
    expect(decisionModelText(undefined)).toBe('Off: the score threshold decides');
    const parts = previewParts({ by: 'decision', items: [
      { used: true, kind: 'fn', name: QualifiedName.parse('fs/read') },
      { used: false, kind: 'fn', name: QualifiedName.parse('fs/write'), reason: 'declined', note: 'only reads' },
    ] });
    expect(parts.used.map((i) => i.name)).toEqual(['fs/read']);
    expect(parts.left[0]?.why).toContain('only reads');
  });

  it('says where an auto pair secret stands and when it ends', () => {
    const now = T0;
    expect(autoPairState({}, now)).toBe('active');
    expect(autoPairState({ expiresAt: now - 1 }, now)).toBe('expired');
    expect(autoPairState({ expiresAt: now + 1, revokedAt: now }, now)).toBe('revoked');
    expect(endsText(undefined, now)).toBe('never ends');
    expect(endsText(now + 78 * 86_400_000, now)).toBe('ends in 78 days');
    expect(endsText(now - 86_400_000, now)).toBe('ended 1 day ago');
    expect(autoPairPart(undefined)).toEqual({});
    expect(autoPairPart({ expiresIn: null })).toEqual({ autoPair: { expiresIn: null } });
  });
});
