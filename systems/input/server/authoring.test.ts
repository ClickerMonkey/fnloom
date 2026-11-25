/**
 * `get_input` on the form authoring agent, with the SDK test kit: the model is scripted (`mockModel`, `toolCall`), the
 * tools open stage by stage (find, then the field guide, then draft), a draft the check refuses is fixed, the clean form
 * is kept as the person's own `input/form` fn, and the next request reuses it, worded headless when nobody watches.
 */
import { QualifiedName, type LlmForward } from '@harness/core';
import { examplesChecked, mockModel, replyChunks, testHub, toolCall } from '@harness/sdk/testing';
import { describe, expect, it } from 'vitest';
import { FORM_KIND, HEADLESS_ASKED, WAIT_FOR_ANSWERS, input } from '../shared/index.ts';
import { inputEnv } from './env.ts';
import { createInputImpl } from './impl.ts';
import { LENIENT } from '@aeye/schema';
import { FormDraftSchema } from './authoring.ts';
import { PROJECT_FORM } from '../shared/index.ts';

inputEnv.set({ INPUT_MAX_FIELDS: '3' });

/** The project form as the agent drafts it: every question has its words. */
const PROJECT = {
  title: 'Project details',
  description: 'What it is and when it is due.',
  type: { name: 'obj', props: { project: { docs: 'Which project?', type: { name: 'text' } }, hours: { docs: 'How many hours?', type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } } } },
};

/** The tools a forward offered, sorted. */
const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

describe('get_input', () => {
  it('writes a form, fixes a refused draft, keeps it as the person’s own, and reuses it next time', async () => {
    const tooWide = { ...PROJECT, type: { name: 'obj', props: { ...PROJECT.type.props, a: { docs: 'A?', type: { name: 'bool' } }, b: { docs: 'B?', type: { name: 'bool' } } } } };
    // #region authoring-test
    const model = mockModel([
      toolCall('find_forms', { text: 'project details' }), toolCall('field_types', {}), toolCall('draft', { draft: tooWide }), toolCall('draft', { draft: PROJECT }), toolCall('save', {}), replyChunks('Saved.'),
      toolCall('find_forms', { text: 'project details' }), toolCall('use_saved', { fn: 'input/project_details' }), replyChunks('Reused.'),
    ]);
    const kit = await testHub(input, createInputImpl({ settings: inputEnv.parse() }), { config: {}, model });
    try {
      const watched = kit.hub.runInfo(QualifiedName.parse('input/get_input'), { watched: true, inChat: true });
      const made = await kit.call('get_input', { detailedDescription: 'The project: its name and how many hours.' }, { run: watched });
      expect(made.result).toMatchObject({ form: { title: 'Project details' }, saved: 'input/project_details', call: 'input/project_details({})', next: WAIT_FOR_ANSWERS });
      expect(kit.hub.fns.kept.get('input/project_details')?.saved).toMatchObject({ kind: FORM_KIND, payload: PROJECT, share: { visibility: 'private', with: [] } });
      const forwards = made.hubCalls.forwards;
      // find first; the field guide and draft only after; save only after a clean draft
      expect(offered(forwards[0])).toEqual(['find_forms']);
      expect(offered(forwards[1])).toEqual(['field_types', 'find_forms']);
      // every example call the prompts showed reads back through the tool it shows, written for each schema dialect
      const examples = examplesChecked(kit.hub.sent);
      expect(examples.problems).toEqual([]);
      expect(examples.values).toBeGreaterThan(0);
      expect(offered(forwards[2])).toEqual(['draft', 'find_forms']);
      expect(offered(forwards[3])).not.toContain('save');
      expect(JSON.stringify(forwards[3]?.request.messages)).toContain('at most 3');
      expect(offered(forwards[4])).toContain('save');
      // #endregion authoring-test

      const reused = await kit.call('get_input', { detailedDescription: 'Project: name and hours.' });
      expect(reused.result).toMatchObject({ saved: 'input/project_details', form: { title: 'Project details' }, next: HEADLESS_ASKED });
      expect(kit.hub.fns.kept.get('input/project_details')?.version).toBe(1);
    } finally {
      await kit.stop();
    }
  });
});

describe('the form kind', () => {
  it('describes a saved form with an example: called with nothing, its answers filled like a sample', async () => {
    const kit = await testHub(input, createInputImpl({ settings: inputEnv.parse() }), { config: {} });
    try {
      const props = await kit.kindProps('form', PROJECT);
      expect(props.problems).toEqual([]);
      // the required question filled by its name, the optional one left out
      expect(props.description?.examples).toEqual([{ args: {}, note: 'Shows the form "Project details". The person\'s answers come in their next message, filled like {"project":"project"}.' }]);
    } finally {
      await kit.stop();
    }
  });
});

describe('the draft call the instructions show', () => {
  it('is a form the draft tool takes as is', () => {
    expect(FormDraftSchema.bind().render(LENIENT).parse(PROJECT_FORM, { inPlace: false }).ok).toBe(true);
  });
});
