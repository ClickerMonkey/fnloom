/**
 * The input system over the SDK's real link runtime and an in-memory hub: `get_input` declared as an authoring fn
 * (the agent itself is tested in `authoring.test.ts`), `check_form`, the quick forms, saving a form in
 * the hub (`hub/fns_save`, a taken name tried again), and running a saved form through its kind. Nothing is kept here.
 */
import { readFileSync } from 'node:fs';
import { QualifiedName, SystemPackageManifest, type Json, type OutcomeWire } from '@harness/core';
import { hub as hubContract } from '@harness/sdk';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub } from '@harness/sdk/server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { FORM_KIND, HEADLESS_ASKED, WAIT_FOR_ANSWERS, input } from '../shared/index.ts';
import { ANSWER_FIELD, answerText, formProblems, quickForms } from '../shared/forms.ts';
import { inputEnv } from './env.ts';
import { createInputImpl, nameFor, slugOf } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));
inputEnv.set({ INPUT_MAX_FIELDS: '3' });
const settings = inputEnv.parse();

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

/** A project form. */
const PROJECT = {
  title: 'Project details',
  description: 'What it is and when it is due.',
  type: { name: 'obj', props: { project: { docs: 'Which project?', type: { name: 'text' } }, hours: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } } } },
};


describe('input over the link', () => {
  let running: RunningSystem<'input'> | undefined;
  let hub: FakeHub;

  async function start(): Promise<void> {
    hub = new FakeHub({ config: {} });
    running = await serve(input, createInputImpl({ settings }), { hub: 'ws://hub.test/link', state: 'unused', version: packageManifest.version }, hub.host());
    await running.ready();
  }

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it('declares get_input as an authoring fn with its examples and effects, and every fn with instructions', async () => {
    await start();
    expect(input.name).toBe(packageManifest.name);
    const manifest = hub.manifests[0];
    // every fn is in one of its API groups, which the hub indexes (`<system>/api.<group>`)
    expect(manifest?.groups?.map((group) => group.name)).toEqual(['ask', 'forms']);
    for (const decl of manifest?.fns ?? []) { expect(['ask', 'forms'], decl.name).toContain(decl.group); }
    expect(manifest?.kinds.map((k) => k.name)).toEqual(['form']);
    expect(manifest?.fns.map((f) => f.name).sort()).toEqual(['ask_choice', 'ask_confirm', 'ask_date', 'ask_number', 'ask_text', 'check_form', 'get_input', 'save_form']);
    const getInput = manifest?.fns.find((f) => f.name === 'get_input');
    expect(getInput).toMatchObject({ kind: 'native', deps: [hubContract.fns.fns_get.name, hubContract.fns.fns_save.name], effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: FORM_KIND }] } });
    expect(getInput?.examples?.[0]).toMatchObject({ result: { form: { title: 'Project details' }, saved: 'input/project_details', next: WAIT_FOR_ANSWERS } });
    for (const decl of manifest?.fns ?? []) {
      expect(decl.instructions, decl.name).toBeTruthy();
      expect(decl.examples?.length ?? 0, decl.name).toBeGreaterThan(0);
    }
    expect(manifest?.fns.find((f) => f.name === 'check_form')?.visibility).toBe('llm');
    expect(manifest?.fns.find((f) => f.name === 'save_form')?.visibility).toBe('user');
  });

  it('checks a draft form', async () => {
    await start();
    expect(done(await hub.run('input/check_form', { form: PROJECT }))).toEqual({ ok: true, problems: [], fields: 2 });
    const wide = { ...PROJECT, type: { name: 'obj', props: { a: { type: { name: 'text' } }, b: { type: { name: 'text' } }, c: { type: { name: 'text' } }, d: { type: { name: 'bool' } } } } };
    expect(done(await hub.run('input/check_form', { form: wide }))).toMatchObject({ ok: false, fields: 4, problems: [expect.stringContaining('at most 3')] });
    expect(done(await hub.run('input/check_form', { form: { ...PROJECT, type: { name: 'obj', props: { a: { type: { name: 'color' } } } } } }))).toMatchObject({ ok: false, problems: [expect.stringContaining('"color"')] });
  });

  // what chat models send for "ask me where and how long": a column map, a field list, the type as a JSON string, a
  // bare type name, no type at all; a choice as a comma list, a number range as words
  it('refuses the form shapes models send wrongly as invalid input with their path, before anyone is asked', async () => {
    await start();
    const props = PROJECT.type.props;
    const guessed: Json[] = [
      { project: 'text', hours: 'number' },
      [{ name: 'project', type: 'text' }, { name: 'hours', type: 'num' }],
      JSON.stringify(PROJECT.type),
      'obj',
      { name: 'obj', props: { project: { type: 'text' } } },
      { name: 'list', generic: { V: { name: 'text' } } },
    ];
    for (const type of guessed) {
      for (const fn of ['input/check_form', 'input/save_form'] as const) {
        const args = fn === 'input/check_form' ? { form: { ...PROJECT, type } } : { name: 'Project', description: 'What it is.', form: { ...PROJECT, type } };
        const refused = await hub.run(fn, args);
        expect(refused.status, `${fn} ${JSON.stringify(type)}`).toBe('invalid-input');
        expect(refused.status === 'invalid-input' ? refused.invalid.problems.map((problem) => problem.path).join(' ') : '', `${fn} ${JSON.stringify(type)}`).toContain('form.type');
      }
    }
    // a form with no title, or none at all
    const untitled = await hub.run('input/check_form', { form: { description: '', type: { name: 'obj', props } } });
    expect(untitled.status === 'invalid-input' ? untitled.invalid.problems.map((problem) => problem.path) : untitled).toContain('form.title');
    expect(await hub.run('input/check_form', {})).toMatchObject({ status: 'invalid-input' });
    // the quick questions: options as one comma-separated string, a range given as words, no question
    const choice = await hub.run('input/ask_choice', { question: 'Size?', options: 'S, M, L' });
    expect(choice.status === 'invalid-input' ? choice.invalid.problems.map((problem) => problem.path) : choice).toContain('options');
    const number = await hub.run('input/ask_number', { question: 'How many?', min: 'one' });
    expect(number.status === 'invalid-input' ? number.invalid.problems.map((problem) => problem.path) : number).toContain('min');
    const nothing = await hub.run('input/ask_text', { placeholder: 'harness-docs' });
    expect(nothing.status === 'invalid-input' ? nothing.invalid.problems.map((problem) => problem.path) : nothing).toContain('question');
    // nothing was kept
    expect(hub.fns.kept.size).toBe(0);
  });

  it('asks quick questions as one-field forms, and refuses a choice of one', async () => {
    await start();
    expect(done(await hub.run('input/ask_confirm', { question: 'Book it?' }))).toMatchObject({ form: { title: 'Book it?', type: { name: 'obj', props: { answer: { docs: 'Book it?', type: { name: 'bool' } } } } } });
    expect(done(await hub.run('input/ask_choice', { question: 'Size?', options: ['S', 'M', 'M'], multiple: true }))).toMatchObject({ form: { type: { props: { answer: { type: { name: 'list' } } } } } });
    expect(await hub.run('input/ask_choice', { question: 'Size?', options: ['S', ' S '] })).toMatchObject({ status: 'invalid-input' });
    expect(await hub.run('input/ask_number', { question: 'How many?', min: 5, max: 1 })).toMatchObject({ status: 'invalid-input' });
  });

  it('keeps a saved form in the hub as the person\'s input/form fn, tries the next name when one is taken, and runs it through its kind', async () => {
    await start();
    const saved = done(await hub.run('input/save_form', { name: 'Project details', description: 'What it is and when it is due.', form: PROJECT, visibility: 'public', askedFor: 'the project and hours' }));
    expect(saved).toEqual({ fn: 'input/project_details', name: 'Project details' });
    expect(hub.fns.kept.get('input/project_details')?.saved).toMatchObject({
      kind: FORM_KIND, name: 'project_details', payload: PROJECT, share: { visibility: 'public', with: [] }, examples: [{ args: {}, note: 'Made for: the project and hours' }],
    });
    // nothing is added to the system's own manifest: the form is the hub's
    expect(hub.patches).toEqual([]);
    expect(done(await hub.run('input/save_form', { name: 'Project details', description: 'Again.', form: PROJECT }))).toEqual({ fn: 'input/project_details_2', name: 'Project details' });
    expect(hub.fns.kept.get('input/project_details_2')?.saved.share).toEqual({ visibility: 'private', with: [] });
    expect(done(await hub.run('input/save_form', { name: 'Ask text', description: 'A clash with a contract fn.', form: PROJECT }))).toEqual({ fn: 'input/ask_text_form', name: 'Ask text' });
    expect(await hub.run('input/save_form', { name: 'Bad', description: 'x', form: { ...PROJECT, type: { name: 'text' } } })).toMatchObject({ status: 'invalid-input' });
    expect(await hub.run('input/save_form', { name: 'Nobody', description: 'x', form: PROJECT, visibility: 'shared' })).toMatchObject({ status: 'invalid-input' });
    // the hub finds it for the agent by its words and kind
    expect(hub.fns.search({ text: 'project what it is', kinds: [FORM_KIND] }).items[0]).toMatchObject({ name: 'input/project_details', kind: FORM_KIND });
    const watched = hub.runInfo(QualifiedName.parse('input/project_details'), { watched: true, inChat: true });
    expect(done(await hub.run('input/project_details', {}, { kind: 'input/form', payload: PROJECT, run: watched }))).toMatchObject({ saved: 'input/project_details', form: { title: 'Project details' }, next: WAIT_FOR_ANSWERS });
    // the chat's own run with the chat closed (iteration 1's scenarios): the answers still come back, so end the turn
    const closed = hub.runInfo(QualifiedName.parse('input/project_details'), { inChat: true });
    expect(done(await hub.run('input/project_details', {}, { kind: 'input/form', payload: PROJECT, run: closed }))).toMatchObject({ next: WAIT_FOR_ANSWERS });
    // a run that is not the chat's own (a nested agent, an MCP call): the caller is told not to wait for answers
    expect(done(await hub.run('input/project_details', {}, { kind: 'input/form', payload: PROJECT }))).toMatchObject({ next: HEADLESS_ASKED });
  });
});

describe('input helpers', () => {
  it('names saved forms from their names', () => {
    expect(slugOf('Project details!')).toBe('project_details');
    expect(slugOf('2026 plan')).toBe('form_2026_plan');
    expect(nameFor('project', 0)).toBe('project');
    expect(nameFor('project', 2)).toBe('project_3');
    expect(nameFor('get_input', 0)).toBe('get_input_form');
  });

  it('checks form types and writes answers as label lines', () => {
    expect(formProblems(PROJECT.type)).toEqual([]);
    expect(formProblems({ name: 'text' })[0]).toContain('object');
    expect(formProblems({ name: 'obj', props: { a: { type: { name: 'color' } } } })[0]).toContain('"color"');
    expect(formProblems({ name: 'obj', props: { a: { type: { name: 'text', options: { bogus: 1 } } } } })[0]).toContain('bogus');
    expect(answerText(PROJECT.type, { project: 'Website', hours: 3, extra: true })).toBe('Which project?: Website\nHours: 3');
    const form = quickForms.choice({ question: 'Pick', options: ['a', 'b'], multiple: true });
    expect(answerText(form.type, { [ANSWER_FIELD]: ['a', 'b'] })).toBe('Pick: a, b');
    expect(answerText(quickForms.confirm({ question: 'Ok?' }).type, { answer: false })).toBe('Ok?: no');
  });
});
