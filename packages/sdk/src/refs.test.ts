import { describe, expect, it } from 'vitest';
import { context, fn, g, hub, system } from './index.ts';

const notes = system('notes', { description: 'Notes.' })
  .with({ fns: { add: fn({ description: 'Add a note.', args: g.obj({ text: g.text() }), returns: g.text() }) } })
  .with(({ fns }) => ({ context: { guide: context({ description: 'How notes work.', content: `Add one with ${fns.add}.` }) } }));

describe('refs in model-facing text', () => {
  it('write fn: and context: refs, which the hub renders as the model name and the plain key', () => {
    expect(`${notes.fns.add}`).toBe('fn:notes/add');
    expect(`${notes.context.guide}`).toBe('context:notes/guide');
    expect(`${hub.fns.fns_search}`).toBe('fn:hub/fns_search');
  });

  it('leave a ref\'s JSON and equality as they were', () => {
    expect(Object.keys(notes.fns.add)).not.toContain('toString');
    expect(JSON.parse(JSON.stringify(notes.context.guide))).toEqual({ ref: 'context', name: 'notes/guide' });
  });
});
