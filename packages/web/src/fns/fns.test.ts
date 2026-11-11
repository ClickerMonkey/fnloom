/**
 * The owner's build 5 feedback in the web app: fn calls in a row grouped, a fn's view (its facts, examples and the
 * store behind the modal and the page), the auto classifier setting, and the browser's logs and traffic sent to the hub.
 */
import { client } from '@ayepi/core/client';
import { AutoClassifier, noFnStats, QualifiedName, type HubWebSpec } from '@harness/core';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { classifierDraft, classifierOf, classifierText } from '../admin/logic/classifier.ts';
import { manifest } from '../api/manifest.gen.ts';
import { withTraffic, type CallSeen } from '../api/traffic.ts';
import RunGroup from '../chat/components/RunGroup.vue';
import { groupCount, groupSummary, groupText } from '../chat/logic/groups.ts';
import { run } from '../chat/test/fakes.ts';
import { ClientLogs } from '../state/client-logs.ts';
import { fakeCaller, fakeUserEvents } from '../test/fakes.ts';
import FnOverview from './components/FnOverview.vue';
import { costText, exampleCall, factFigures } from './logic/facts.ts';
import { FnInfoStore } from './state/fn-info.ts';
import { fakeFnsApi, SAMPLE_EXAMPLES, SAMPLE_FACTS, SAMPLE_FN, SAMPLE_HIT } from './test/fakes.ts';

describe('fn calls in a row', () => {
  it('condenses repeated calls by fn, the most recent fn first, and says what is failing or in progress', () => {
    const runs = [run({ fn: 'fs/read_file', status: 'done' }), run({ fn: 'fs/bash', status: 'failed' }), run({ fn: 'fs/read_file', status: 'done' }), run({ fn: 'fs/glob', status: 'running' })];
    const summary = groupSummary(runs);
    expect(groupText(summary)).toBe('Glob · Read file ×2 · Bash');
    expect(summary.status).toBe('running');
    expect(groupCount(summary)).toBe('4 fn calls, 1 in progress');
    expect(groupCount(groupSummary(runs.slice(0, 3)))).toBe('3 fn calls, 1 failed');
    expect(groupSummary(runs.slice(0, 3)).status).toBe('failed');
  });

  it('opens by itself while a run in it waits for approval, so the approval is never hidden', () => {
    const runs = [run({ status: 'done' }), run({ fn: 'fs/bash', status: 'awaiting-approval' })];
    const group = mount(RunGroup, { props: { runs, now: 0, collapsed: () => true, viewOf: () => undefined, showOf: () => 'card', open: false } });
    expect(group.get('[data-testid=run-group-toggle]').attributes('aria-expanded')).toBe('true');
    expect(group.findAll('[data-testid=run-card]')).toHaveLength(2);
    expect(group.get('.run-dot').attributes('data-status')).toBe('awaiting-approval');
  });
});

describe('a fn view', () => {
  it('says what a call costs and how long it takes, in words', () => {
    expect(costText(SAMPLE_FACTS.cost)).toBe('Free');
    expect(costText({ min: 0.001, typical: 0.004, max: 0.01, basis: 'history', runs: 9 })).toBe('$0.004 ($0.001–$0.01)');
    expect(factFigures(SAMPLE_FACTS).map((f) => [f.key, f.value])).toEqual([['cost', 'Free'], ['time', '2.4s'], ['slow', '18s'], ['runs', '42']]);
    expect(factFigures({ cost: { min: 0, typical: 0, max: 0, basis: 'unknown', runs: 0 } }).map((f) => f.key)).toEqual(['cost', 'runs']);
    expect(exampleCall('bash', { args: { command: 'ls' } })).toBe('bash({"command":"ls"})');
  });

  it('loads the fn, its facts and its examples a page at a time, and reads the facts again when it runs', async () => {
    const api = fakeFnsApi();
    const events = fakeUserEvents();
    const store = new FnInfoStore(api, events.subscribe);
    await store.open(SAMPLE_FN);
    expect(store.about.value.value).toEqual(SAMPLE_HIT);
    expect(api.searchFns.calls[0]?.[0]).toEqual({ names: [SAMPLE_FN], items: ['fn'], available: false, limit: 1 });
    expect(store.facts.value.value).toEqual(SAMPLE_FACTS);
    expect(store.examples.value).toHaveLength(5);
    expect(store.examplesNext.value).toBe(5);
    await store.moreExamples();
    expect(store.examples.value.map((e) => e.id)).toEqual(SAMPLE_EXAMPLES.map((e) => e.id));
    expect(store.examplesNext.value).toBeUndefined();
    events.push({ type: 'fn', fn: SAMPLE_FN, system: SAMPLE_HIT.system, stats: noFnStats() });
    await Promise.resolve();
    expect(api.fnFacts.calls).toHaveLength(2);
    store.close();
    expect(events.listeners).toBe(0);
    expect(store.examples.value).toEqual([]);
  });

  it('draws the overview: what it does to data, its signature, the fns it uses and its examples with how many are left', async () => {
    const view = mount(FnOverview, {
      props: {
        name: SAMPLE_FN, about: SAMPLE_HIT, facts: { ...SAMPLE_FACTS, uses: [SAMPLE_FN, QualifiedName.parse('fs/read')] }, loading: false,
        examples: SAMPLE_EXAMPLES.slice(0, 5), examplesTotal: 7, moreExamples: true, examplesLoading: false,
      },
    });
    expect(view.get('[data-testid=fn-mode]').text()).toBe('Deletes');
    expect(view.get('[data-testid=fn-signature]').text()).toContain('bash(command: text');
    expect(view.get('[data-testid=fn-uses]').text()).not.toContain('Bash');
    await view.get('.chip.link').trigger('click');
    expect(view.emitted('fn')?.[0]).toEqual(['fs/read']);
    expect(view.get('[data-testid=fn-examples]').text()).toContain('List a folder.');
    await view.get('[data-testid=fn-more-examples]').trigger('click');
    expect(view.get('[data-testid=fn-more-examples]').text()).toContain('2 left');
    expect(view.emitted('more')).toHaveLength(1);
  });
});

describe('the auto classifier setting', () => {
  it('reads the form into the setting, with no model meaning every such call waits for the person', () => {
    expect(classifierDraft(undefined)).toEqual({ model: '', messages: '4' });
    const read = classifierOf({ model: 'gpt-4o-mini', messages: '6' });
    expect(read).toEqual({ ok: true, value: { model: { model: { model: 'gpt-4o-mini' } }, messages: 6 } });
    expect(classifierOf({ model: '', messages: '30' }).ok).toBe(false);
    expect(classifierText({ value: AutoClassifier.parse({}) })).toContain('waits for the person');
    expect(classifierText({ value: { model: { model: { model: 'gpt-4o-mini' } }, messages: 1 } })).toBe('gpt-4o-mini · reads the last 1 message');
  });
});

describe('browser logs and traffic', () => {
  /** A real ayepi client whose HTTP answers come from `answer`. */
  const hubWith = (answer: () => Response) => client<HubWebSpec>({ baseUrl: 'http://hub.test/api', manifest, fetchImpl: () => Promise.resolve(answer()) });

  it('sees every call a caller makes: method, path, status and time, never its body', async () => {
    const seen: CallSeen[] = [];
    let now = 1_000;
    const ok = withTraffic(hubWith(() => Response.json(SAMPLE_FACTS)), (call) => { seen.push(call); }, () => (now += 25));
    await ok.caller('fnFacts').call({ fn: SAMPLE_FN });
    const refused = withTraffic(hubWith(() => Response.json({ error: { code: 'NO_FN', message: 'no' } }, { status: 404 })), (call) => { seen.push(call); }, () => (now += 25));
    await expect(refused.caller('fnFacts').call({ fn: SAMPLE_FN })).rejects.toThrow();
    expect(seen).toEqual([
      { at: 1_025, method: 'POST', endpoint: '/fnFacts', status: 200, duration: 25 },
      { at: 1_075, method: 'POST', endpoint: '/fnFacts', status: 404, duration: 25 },
    ]);
    expect(JSON.stringify(seen)).not.toContain('bash');
  });

  it('sends lines only while signed in, and reports the window\'s uncaught errors with their stack', () => {
    const send = fakeCaller<'clientLogs'>(() => Promise.resolve({ uri: 'hub://logs/a.jsonl', written: 1 }));
    let signedIn = false;
    const logs = new ClientLogs({ send, signedIn: () => signedIn, page: () => '/chat/ses_1', clock: () => 5 });
    logs.log('warn', 'early');
    expect(send.calls).toHaveLength(0);
    signedIn = true;
    const stop = logs.watch(window);
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('x is null'), message: 'x is null' }));
    logs.traffic({ at: 4, method: 'POST', endpoint: '/send', status: 200, duration: 12 });
    stop();
    const [error, traffic] = send.calls.map(([batch]) => batch.entries[0]);
    expect(error).toMatchObject({ type: 'log', level: 'error', message: 'TypeError: x is null', fields: { source: 'window' } });
    expect(error?.type === 'log' ? error.fields?.['stack'] : undefined).toContain('TypeError');
    expect(traffic).toEqual({ type: 'traffic', at: 4, method: 'POST', endpoint: '/send', status: 200, duration: 12 });
    expect(send.calls).toHaveLength(2);
    expect(send.calls[0]?.[0].page).toBe('/chat/ses_1');
  });
});
