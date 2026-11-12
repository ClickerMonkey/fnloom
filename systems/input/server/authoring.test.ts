/**
 * `get_input` on the form authoring agent, with the SDK test kit: the model is scripted (`mockModel`, `toolCall`), the
 * tools open stage by stage (find, then the field guide, then draft), a draft the check refuses is fixed, the clean form
 * is kept as the person's own `input/form` fn, and the next request reuses it, worded headless when nobody watches.
 */
import { QualifiedName, type LlmForward } from '@harness/core';
import { mockModel, replyChunks, testHub, toolCall } from '@harness/sdk/testing';
import { describe, expect, it } from 'vitest';
import { FORM_KIND, HEADLESS_ASKED, WAIT_FOR_ANSWERS, input } from '../shared/index.ts';
import { inputEnv } from './env.ts';
import { createInputImpl } from './impl.ts';

inputEnv.set({ INPUT_MAX_FIELDS: '3' });

/** The trip form as the agent drafts it: every question has its words. */
const TRIP = {
  title: 'Trip details',
  description: 'Where and when you are going.',
  type: { name: 'obj', props: { city: { docs: 'Which city?', type: { name: 'text' } }, nights: { docs: 'How many nights?', type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } } } },
};

/** The tools a forward offered, sorted. */
const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

describe('get_input', () => {
  it('writes a form, fixes a refused draft, keeps it as the person’s own, and reuses it next time', async () => {
    const tooWide = { ...TRIP, type: { name: 'obj', props: { ...TRIP.type.props, a: { docs: 'A?', type: { name: 'bool' } }, b: { docs: 'B?', type: { name: 'bool' } } } } };
    // #region authoring-test
    const model = mockModel([
      toolCall('find_forms', { text: 'trip details' }), toolCall('field_types', {}), toolCall('draft', { draft: tooWide }), toolCall('draft', { draft: TRIP }), toolCall('save', {}), replyChunks('Saved.'),
      toolCall('find_forms', { text: 'trip details' }), toolCall('use_saved', { fn: 'input/trip_details' }), replyChunks('Reused.'),
    ]);
    const kit = await testHub(input, createInputImpl({ settings: inputEnv.parse() }), { config: {}, model });
    try {
      const watched = kit.hub.runInfo(QualifiedName.parse('input/get_input'), { watched: true });
      const made = await kit.call('get_input', { detailedDescription: 'The trip: the city and how many nights.' }, { run: watched });
      expect(made.result).toMatchObject({ form: { title: 'Trip details' }, saved: 'input/trip_details', call: 'input/trip_details({})', next: WAIT_FOR_ANSWERS });
      expect(kit.hub.fns.kept.get('input/trip_details')?.saved).toMatchObject({ kind: FORM_KIND, payload: TRIP, share: { visibility: 'private', with: [] } });
      const forwards = made.hubCalls.forwards;
      // find first; the field guide and draft only after; save only after a clean draft
      expect(offered(forwards[0])).toEqual(['find_forms']);
      expect(offered(forwards[1])).toEqual(['field_types', 'find_forms']);
      expect(offered(forwards[2])).toEqual(['draft', 'find_forms']);
      expect(offered(forwards[3])).not.toContain('save');
      expect(JSON.stringify(forwards[3]?.request.messages)).toContain('at most 3');
      expect(offered(forwards[4])).toContain('save');
      // #endregion authoring-test

      const reused = await kit.call('get_input', { detailedDescription: 'Trip: city and nights.' });
      expect(reused.result).toMatchObject({ saved: 'input/trip_details', form: { title: 'Trip details' }, next: HEADLESS_ASKED });
      expect(kit.hub.fns.kept.get('input/trip_details')?.version).toBe(1);
    } finally {
      await kit.stop();
    }
  });
});
