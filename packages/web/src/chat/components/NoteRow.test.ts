import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { message } from '../test/fakes.ts';
import NoteRow from './NoteRow.vue';

afterEach(() => { document.body.innerHTML = ''; });

describe('NoteRow', () => {
  it('lists what an undone compare\'s variants left done, each variant with its fns as pills', () => {
    const note = message({
      role: 'note', parts: [
        { type: 'text', text: 'What the variants did stays as it is: 2 changes by Fast, one change by Variant B.' },
        { type: 'kept-effects', variants: [
          { variant: 0, label: 'Fast', effects: [{ run: 'run_a', fn: 'fs/write_file' }, { run: 'run_b', fn: 'fs/delete_file' }] },
          { variant: 1, label: 'Variant B', effects: [{ run: 'run_c', fn: 'mail/send' }] },
        ] },
      ],
    });
    const row = mount(NoteRow, { props: { message: note } });
    expect(row.get('.line').text()).toBe('What the variants did stays as it is: 2 changes by Fast, one change by Variant B.');
    const variants = row.get('[data-testid=note-kept]').findAll('li');
    expect(variants.map((v) => v.get('.label').text())).toEqual(['Fast', 'Variant B']);
    expect(variants.map((v) => v.findAll('[data-testid=fn-pill]').map((p) => p.attributes('data-fn')))).toEqual([['fs/write_file', 'fs/delete_file'], ['mail/send']]);
  });

  it('shows no list for a note without kept effects', () => {
    const row = mount(NoteRow, { props: { message: message({ role: 'note', parts: [{ type: 'text', text: 'Undid the turn. It had changed nothing.' }] }) } });
    expect(row.find('[data-testid=note-kept]').exists()).toBe(false);
  });
});
