/**
 * The input system over the SDK's real link runtime and an in-memory hub: the quick forms, `get_input` writing a form
 * with the form agent (a refused form tried again), saving a form as an `input/form` fn, reusing it by name, running
 * it through its kind, and adding the saved forms again after a restart.
 */
import { readFileSync } from 'node:fs';
import { SystemPackageManifest, mintId, type Json, type LlmForwardChunk, type OutcomeWire } from '@harness/core';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub, TEST_USER, streamOf } from '@harness/sdk/server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WAIT_FOR_ANSWERS, input } from '../shared/index.ts';
import { ANSWER_FIELD, answerText, formProblems, quickForms } from '../shared/forms.ts';
import { LlmFormAuthor, readWritten } from './author.ts';
import { inputEnv } from './env.ts';
import { bestMatch, cosine, createInputImpl, mayUse, slugOf, type InputServer } from './impl.ts';
import { MemoryForms, type SavedRecord } from './store.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));
const settings = inputEnv.parse();

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

/** A form the model "writes": a trip form. */
const TRIP = {
  title: 'Trip details',
  description: 'Where and when you are going.',
  type: { name: 'obj', props: { city: { docs: 'Which city?', type: { name: 'text' } }, nights: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } } } },
};

function answers(...texts: string[]): FakeHub['onLlm'] {
  let next = 0;
  return () => {
    const content = texts[Math.min(next, texts.length - 1)] ?? '';
    next += 1;
    const chunks: LlmForwardChunk[] = [
      { type: 'chunk', chunk: { content } },
      { type: 'chunk', chunk: { finishReason: 'stop' } },
      { type: 'done', usage: { input: 1, output: 1 }, cost: 0, interaction: mintId('llmInteraction'), model: 'test/model' },
    ];
    return streamOf(chunks);
  };
}

describe('input over the link', () => {
  let running: RunningSystem<'input'> | undefined;
  let hub: FakeHub;
  let store: MemoryForms;
  let server: InputServer;
  const removed: string[] = [];

  async function start(): Promise<void> {
    hub = new FakeHub({ config: {} });
    server = createInputImpl({
      settings, store, author: new LlmFormAuthor({ retries: 2, maxFields: 10 }), now: () => 1_000,
      runtime: () => (running === undefined ? undefined : {
        add: async (name, def) => { await running?.add(name, def); },
        remove: async (name) => { removed.push(name); },
      }),
    });
    running = await serve(input, server.impl, { hub: 'ws://hub.test/link', state: 'unused', version: packageManifest.version }, hub.host());
    await running.ready();
  }

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it('is named as system.json says, and declares its fns, the form kind and the guide', async () => {
    store = new MemoryForms();
    await start();
    expect(input.name).toBe(packageManifest.name);
    const manifest = hub.manifests[0];
    expect(manifest?.kinds.map((k) => k.name)).toEqual(['form']);
    expect(manifest?.fns.map((f) => f.name).sort()).toEqual(['ask_choice', 'ask_confirm', 'ask_date', 'ask_number', 'ask_text', 'get_input', 'save_form']);
    expect(manifest?.fns.find((f) => f.name === 'save_form')?.visibility).toBe('user');
  });

  it('asks quick questions as one-field forms, and refuses a choice of one', async () => {
    store = new MemoryForms();
    await start();
    expect(done(await hub.run('input/ask_confirm', { question: 'Book it?' }))).toMatchObject({ form: { title: 'Book it?', type: { name: 'obj', props: { answer: { docs: 'Book it?', type: { name: 'bool' } } } } } });
    expect(done(await hub.run('input/ask_choice', { question: 'Size?', options: ['S', 'M', 'M'], multiple: true }))).toMatchObject({ form: { type: { props: { answer: { type: { name: 'list' } } } } } });
    expect(await hub.run('input/ask_choice', { question: 'Size?', options: ['S', ' S '] })).toMatchObject({ status: 'invalid-input' });
    expect(await hub.run('input/ask_number', { question: 'How many?', min: 5, max: 1 })).toMatchObject({ status: 'invalid-input' });
  });

  it('writes a form for get_input, trying again when gin refuses the first', async () => {
    store = new MemoryForms();
    await start();
    hub.onLlm = answers('```json\n{"title":"Trip","description":"x","type":{"name":"obj","props":{"city":{"type":{"name":"Place"}}}}}\n```', JSON.stringify(TRIP));
    const result = done(await hub.run('input/get_input', { detailedDescription: 'The city they go to, and how many nights (optional).' }));
    expect(result).toMatchObject({ form: { title: 'Trip details', type: TRIP.type }, next: WAIT_FOR_ANSWERS });
    expect(result).not.toHaveProperty('saved');
    hub.onLlm = answers('not json');
    expect(await hub.run('input/get_input', { detailedDescription: 'Anything.' })).toMatchObject({ status: 'failed', error: { code: 'form-refused' } });
  });

  it('saves a form as an input/form fn, reuses it by name, runs it through its kind, and adds it again after a restart', async () => {
    store = new MemoryForms();
    await start();
    const saved = done(await hub.run('input/save_form', { name: 'Trip details', description: 'Where and when you go.', form: TRIP, visibility: 'public' }));
    expect(saved).toEqual({ fn: 'input/trip_details', name: 'Trip details' });
    expect(hub.patches.at(-1)?.upsert.fns?.[0]).toMatchObject({ name: 'trip_details', kind: 'input/form', payload: TRIP });
    expect(store.records.get('trip_details')).toMatchObject({ owner: TEST_USER.id, visibility: 'public' });
    expect(hub.shares.at(-1)).toMatchObject({ fn: 'trip_details', share: { visibility: 'public', with: [] } });
    expect(store.records.get('trip_details')?.vector).toHaveLength(2);

    hub.onLlm = () => { throw new Error('the agent is not needed'); };
    expect(done(await hub.run('input/get_input', { detailedDescription: 'Use the trip details form.' }))).toMatchObject({ saved: 'input/trip_details', form: { title: 'Trip details' } });
    expect(done(await hub.run('input/trip_details', {}, { kind: 'input/form', payload: TRIP }))).toMatchObject({ saved: 'input/trip_details', form: { title: 'Trip details' } });
    // the same name again, or a contract fn's name, gets a free one (the SDK refuses a fn added twice)
    expect(done(await hub.run('input/save_form', { name: 'Trip details', description: 'Again.', form: TRIP }))).toEqual({ fn: 'input/trip_details_2', name: 'Trip details' });
    expect(done(await hub.run('input/save_form', { name: 'Ask text', description: 'A clash.', form: TRIP }))).toEqual({ fn: 'input/ask_text_2', name: 'Ask text' });
    expect(await hub.run('input/save_form', { name: 'Bad', description: 'x', form: { ...TRIP, type: { name: 'text' } } })).toMatchObject({ status: 'invalid-input' });
    // shared names its people; shared with nobody is refused
    expect(await hub.run('input/save_form', { name: 'Nobody', description: 'x', form: TRIP, visibility: 'shared' })).toMatchObject({ status: 'invalid-input' });
    // a form fn that isn't kept (still being saved, or its sharing failed) doesn't run
    expect(await hub.run('input/unkept', {}, { kind: 'input/form', payload: TRIP })).toMatchObject({ status: 'failed', error: { code: 'form-unsaved' } });
    expect(removed).toEqual([]);

    await running?.stop();
    running = undefined;
    await start();
    expect(await server.restore()).toBe(3);
    expect(hub.patches.slice(-3).map((patch) => patch.upsert.fns?.[0]?.name).sort()).toEqual(['ask_text_2', 'trip_details', 'trip_details_2']);
  });
});

describe('input helpers', () => {
  const record = (over: Partial<SavedRecord>): SavedRecord => ({
    name: 'trip', title: 'Trip details', description: 'd', form: TRIP, owner: TEST_USER.id, visibility: 'private', with: [], vector: [1, 0], savedAt: 0, ...over,
  });

  it('matches by named title, else by cosine above the threshold; only the owner\'s or public forms', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([], [1])).toBe(0);
    expect(bestMatch('please use TRIP DETAILS', [], [record({})], 0.9)?.name).toBe('trip');
    // a title matches as whole words only
    expect(bestMatch('the stripe payment', [], [record({ title: 'Trip' })], 0.9)).toBeUndefined();
    expect(bestMatch('book a trip, please', [], [record({ title: 'Trip' })], 0.9)?.name).toBe('trip');
    expect(bestMatch('something', [0.9, 0.1], [record({}), record({ name: 'far', title: 'Far away', vector: [0, 1] })], 0.8)?.name).toBe('trip');
    expect(bestMatch('something', [0, 1], [record({})], 0.8)).toBeUndefined();
    const other = { id: mintId('actor') };
    expect(mayUse(record({}), other)).toBe(false);
    expect(mayUse(record({ visibility: 'public' }), other)).toBe(true);
    expect(mayUse(record({ visibility: 'shared', with: [other.id] }), other)).toBe(true);
    expect(mayUse(record({ visibility: 'shared', with: [] }), other)).toBe(false);
    expect(slugOf('Trip details!')).toBe('trip_details');
    expect(slugOf('2026 plan')).toBe('form_2026_plan');
  });

  it('checks form types and writes answers as label lines', () => {
    expect(formProblems(TRIP.type)).toEqual([]);
    expect(formProblems({ name: 'text' })[0]).toContain('object');
    expect(formProblems({ name: 'obj', props: { a: { type: { name: 'color' } } } })[0]).toContain('"color"');
    expect(formProblems({ name: 'obj', props: { a: { type: { name: 'text', options: { bogus: 1 } } } } })[0]).toContain('bogus');
    expect(answerText(TRIP.type, { city: 'Lisbon', nights: 3, extra: true })).toBe('Which city?: Lisbon\nNights: 3');
    const form = quickForms.choice({ question: 'Pick', options: ['a', 'b'], multiple: true });
    expect(answerText(form.type, { [ANSWER_FIELD]: ['a', 'b'] })).toBe('Pick: a, b');
    expect(answerText(quickForms.confirm({ question: 'Ok?' }).type, { answer: false })).toBe('Ok?: no');
    expect(readWritten('{"title":""}')).toHaveProperty('problem');
  });
});
