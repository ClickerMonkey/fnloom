/**
 * The form card: its own fields for a form, sending the answers as one `input-answer` (and refusing missing required
 * fields), showing "Answered" with the values, the chat's value editor when given, and saving the form.
 */
import { mintId, type RunId, type ShareRule } from '@harness/core';
import { g, wireType, type SystemClient } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import type { AskedValue, InputContract } from '../shared/index.ts';
import { quickForms } from '../shared/forms.ts';
import { checkAnswers, choiceAnswer, controlOf } from './form.ts';
import FormCard from './FormCard.vue';
import { ACCESS_INFO, INPUT_ANSWERS, SHARE_EDITOR, VALUE_EDITOR, type InputAnswer, type InputAnswers } from './host.ts';

const PROJECT: AskedValue = {
  form: {
    title: 'Project details', description: 'What it is.',
    type: { name: 'obj', props: { project: { docs: 'Which project?', type: { name: 'text', options: { maxLength: 100 } } }, hours: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } } } },
  },
  next: 'wait',
};

function fakeSystem(): { system: SystemClient<InputContract['defs']>; saved: unknown[] } {
  const saved: unknown[] = [];
  const run = (args: unknown): Promise<RunId> => { saved.push(args); return Promise.resolve(mintId('run')); };
  const system: SystemClient<InputContract['defs']> = {
    online: true, send: {},
    run: { get_input: run, check_form: run, ask_text: run, ask_choice: run, ask_confirm: run, ask_number: run, ask_date: run, save_form: run },
  };
  return { system, saved };
}

function fakeAnswers(): InputAnswers & { sent: InputAnswer[] } {
  const sent: InputAnswer[] = [];
  return { sent, send: (answer) => { sent.push(answer); return Promise.resolve(); }, answerOf: (run) => sent.find((answer) => answer.run === run) };
}

describe('FormCard', () => {
  it('draws the fields, refuses a missing required one, sends the answers and then shows them', async () => {
    const answers = fakeAnswers();
    const run = mintId('run');
    const card = mount(FormCard, { props: { run, result: PROJECT, system: fakeSystem().system }, global: { provide: { [INPUT_ANSWERS]: answers } } });
    expect(card.find('h3').text()).toBe('Project details');
    expect(card.findAll('.field')).toHaveLength(2);
    expect(card.find('.optional').exists()).toBe(true);
    await card.find('form.fields').trigger('submit');
    expect(card.find('[role="alert"]').text()).toBe('Fill in Which project?.');
    expect(answers.sent).toHaveLength(0);

    await card.find('input[type="text"]').setValue('Website');
    await card.find('input[type="number"]').setValue('3');
    await card.find('form.fields').trigger('submit');
    await flushPromises();
    expect(answers.sent).toEqual([{ run, title: 'Project details', value: { project: 'Website', hours: 3 }, text: 'Which project?: Website\nHours: 3' }]);
    expect(card.find('.done').text()).toBe('Answered');
    expect(card.find('.answers').text()).toContain('Website');
    expect(card.find('form.fields').exists()).toBe(false);
  });

  it('uses the chat\'s value editor when there is one, and says when answers can\'t be sent', async () => {
    const Editor = defineComponent({ props: { type: { type: Object, required: true }, modelValue: { type: null, default: undefined } }, emits: ['update:modelValue'], setup: (_props, { emit }) => () => h('button', { class: 'editor', onClick: () => { emit('update:modelValue', { project: 'Website' }); } }) });
    const answers = fakeAnswers();
    const card = mount(FormCard, { props: { run: mintId('run'), result: PROJECT, system: fakeSystem().system }, global: { provide: { [INPUT_ANSWERS]: answers, [VALUE_EDITOR]: Editor } } });
    await card.find('.editor').trigger('click');
    await card.find('form.fields').trigger('submit');
    await flushPromises();
    expect(answers.sent[0]?.value).toEqual({ project: 'Website' });

    const lonely = mount(FormCard, { props: { run: mintId('run'), result: PROJECT, system: fakeSystem().system } });
    expect(lonely.find('[role="note"]').text()).toContain('can\'t send');
    expect(lonely.find('button.primary').attributes('disabled')).toBeDefined();
  });

  it('saves the form for next time, with who may use it in a multi-person hub', async () => {
    const { system, saved } = fakeSystem();
    const card = mount(FormCard, { props: { run: mintId('run'), result: PROJECT, system }, global: { provide: { [ACCESS_INFO]: { multiUser: true } } } });
    await card.find('button.link').trigger('click');
    expect(card.find<HTMLInputElement>('input[maxlength="60"]').element.value).toBe('Project details');
    expect(card.findAll('.segment').map((segment) => segment.text())).toEqual(['Only me', 'Everyone']);
    await card.findAll('.segment')[1]?.trigger('click');
    await card.find('form.save-form').trigger('submit');
    await flushPromises();
    expect(saved).toEqual([{ name: 'Project details', description: 'What it is.', form: PROJECT.form, visibility: 'public' }]);
    expect(card.find('.saved').exists()).toBe(true);

    const reused = mount(FormCard, { props: { run: mintId('run'), result: { ...PROJECT, saved: 'input/project' }, system } });
    expect(reused.find('.save').exists()).toBe(false);
  });

  it('saves a form for chosen people through the app share editor, and refuses sharing with nobody', async () => {
    const { system, saved } = fakeSystem();
    const ben = mintId('actor');
    let pick: ShareRule = { visibility: 'shared', with: [] };
    // the app's editor: here a button that sets the rule the test picks
    const Share = defineComponent({
      props: { modelValue: { type: Object, required: true } },
      emits: ['update:modelValue'],
      setup: (_props, { emit }) => () => h('button', { type: 'button', class: 'share', onClick: () => { emit('update:modelValue', pick); } }, 'share'),
    });
    const card = mount(FormCard, { props: { run: mintId('run'), result: PROJECT, system }, global: { provide: { [ACCESS_INFO]: { multiUser: true }, [SHARE_EDITOR]: Share } } });
    await card.find('button.link').trigger('click');
    expect(card.find('.segments').exists()).toBe(false);
    await card.find('button.share').trigger('click');
    await card.find('form.save-form').trigger('submit');
    expect(card.find('.save-form [role="alert"]').text()).toContain('people or groups');
    expect(saved).toEqual([]);
    pick = { visibility: 'shared', with: [ben] };
    await card.find('button.share').trigger('click');
    await card.find('form.save-form').trigger('submit');
    await flushPromises();
    expect(saved).toEqual([{ name: 'Project details', description: 'What it is.', form: PROJECT.form, visibility: 'shared', with: [ben] }]);
  });

  it('shows nothing but the error for a result that is not a form', () => {
    const card = mount(FormCard, { props: { run: mintId('run'), result: { nope: true }, error: { class: 'retry', message: 'No form' }, system: fakeSystem().system } });
    expect(card.text()).toBe('No form');
  });
});

describe('form logic', () => {
  it('picks a control per field type', () => {
    expect(controlOf({ name: 'bool' })).toEqual({ control: 'yes-no' });
    expect(controlOf({ name: 'list', generic: { V: { name: 'enum', generic: { V: { name: 'text' } }, options: { values: { a: 'a' } } } } })).toEqual({ control: 'choice', options: ['a'], multiple: true });
    expect(controlOf({ name: 'list', generic: { V: { name: 'text' } } })).toEqual({ control: 'lines' });
    expect(controlOf({ name: 'date' })).toEqual({ control: 'date' });
    expect(controlOf({ name: 'obj' })).toEqual({ control: 'json' });
  });

  it('offers an authored enum\'s members, the words it accepts, not its keys, and reads a choice typed loosely as its member', () => {
    // as an agent authors a form: { key: words the person reads }; gin's member is the words
    const child = { name: 'enum', generic: { V: { name: 'text' } }, options: { values: { emma: 'Emma', leo: 'Leo' } } };
    const chore = { name: 'enum', generic: { V: { name: 'text' } }, options: { values: { bed: 'Make bed — 2 points', dog: 'Feed the dog — 2 points' } } };
    const type = { name: 'obj', props: { child: { type: child }, chores: { type: { name: 'list', generic: { V: chore } } }, note: { type: { name: 'optional', generic: { T: child } } } } };
    expect(controlOf(child)).toEqual({ control: 'choice', options: ['Emma', 'Leo'], multiple: false });
    // the members as shown, a key, another case and stray spaces all name the same choice
    expect(checkAnswers(type, { child: 'Emma', chores: ['Make bed — 2 points'] })).toEqual({ value: { child: 'Emma', chores: ['Make bed — 2 points'] } });
    expect(checkAnswers(type, { child: 'leo', chores: ['dog', ' feed the  dog — 2 POINTS '], note: 'EMMA' })).toEqual({ value: { child: 'Leo', chores: ['Feed the dog — 2 points', 'Feed the dog — 2 points'], note: 'Emma' } });
    expect(checkAnswers(type, { child: 'Sam', chores: ['bed'] })).toHaveProperty('problem');
    expect(choiceAnswer(child, 'nobody')).toBe('nobody');
  });

  it('checks answers with the form\'s gin type', () => {
    const form = quickForms.number({ question: 'How many?', min: 1, max: 3, whole: true });
    expect(checkAnswers(form.type, { answer: 2 })).toEqual({ value: { answer: 2 } });
    expect(checkAnswers(form.type, { answer: 9 })).toHaveProperty('problem');
    expect(checkAnswers(quickForms.date({ question: 'When?' }).type, { answer: '2026-11-08' })).toEqual({ value: { answer: '2026-11-08' } });
  });

  it('says which field inside a list item is wrong, and the key it likely meant', () => {
    const type = wireType(g.obj({ items: g.list(g.obj({ category: g.text(), monthlyAmount: g.num({ min: 0 }) })) }));
    expect(checkAnswers(type, { items: [{ category: 'Food', monthlyAmount: '800' }] })).toEqual({ value: { items: [{ category: 'Food', monthlyAmount: 800 }] } });
    const wrong = checkAnswers(type, { items: [{ category: 'Food', amount: 800 }] });
    expect(wrong).toHaveProperty('problem');
    const problem = (wrong as { problem: string }).problem;
    expect(problem).toContain('items');
    expect(problem).toContain('monthlyAmount');
  });
});
