import { describe, expect, it } from 'vitest';
import { agent, context, fn, g, hook, hub, manifestOf, system } from '../index.ts';
import { authoredNameWarnings, declaredNames } from './authored-names.ts';

const notes = system('notes', { description: 'Notes.', about: 'Keep notes: add one with notes/add.' })
  .with({
    fns: {
      add: fn({ description: 'Add a note. Then notes/lst them.', args: g.obj({ text: g.text() }), returns: g.text(), examples: [{ args: { text: 'x' }, note: 'See fn:notes/gone.' }] }),
      helper: agent({ description: 'Helps.', args: g.obj({}), returns: g.text(), instructions: 'Use notes/add, then hub/fns_serch, never context:notes/nope.' }),
    },
  })
  .with(({ fns }) => ({
    context: { guide: context({ description: 'How notes work.', content: `Add one with ${fns.add}; a saved one is notes/main.daily, a family notes/tag_; src/index.ts is a path.` }) },
    hooks: { recent: hook({ description: 'Recent notes.', explains: 'The notes changed today (see context:notes/guide).' }) },
  }));

describe('the build\'s check of names in model-facing text', () => {
  it('warns on refs that name nothing and on misspelt bare names, never on examples, paths or other systems', async () => {
    const manifest = await manifestOf(notes, { version: '0.0.0' });
    const own = declaredNames(manifest);
    const ofHub = declaredNames(await manifestOf(hub, { version: '0.0.0' }));
    const warnings = authoredNameWarnings(manifest, {
      fns: new Set([...own.fns, ...ofHub.fns]), context: new Set([...own.context, ...ofHub.context]), types: new Set([...own.types, ...ofHub.types]), systems: new Set(['notes', 'hub']),
    });
    expect(warnings).toEqual([
      expect.stringMatching(/^fns\.add\.description: notes\/lst names no fn, context item or type — did you mean .*notes\/add/),
      expect.stringMatching(/^fns\.add\.examples\[0\]\.note: fn:notes\/gone names no fn/),
      expect.stringMatching(/^fns\.helper\.payload\.instructions: hub\/fns_serch names no fn, context item or type — did you mean .*hub\/fns_search/),
      expect.stringMatching(/^fns\.helper\.payload\.instructions: context:notes\/nope names no context item/),
    ]);
  });
});
