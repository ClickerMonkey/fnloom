/**
 * The install checks shown on the review page and the install card: the preview gallery grouped by component and
 * state, and the install card's tests (failures only) and gallery (capped).
 */
import { ApprovalPreview, SystemTestReport } from '@harness/core';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { previewShots, review } from '../../admin/test/review.ts';
import ApprovalPreviewView from '../approvals/ApprovalPreview.vue';
import { previewGroups } from './gallery.ts';

const shots = SystemTestReport.shape.previews.unwrap().parse(previewShots([['NoteCard', ['empty', 'typical']], ['NoteList', ['loading']]]));

describe('the preview gallery', () => {
  it('groups shots by component and state, phone before desktop and light before dark', () => {
    const groups = previewGroups([...shots].reverse());
    expect(groups.map((group) => group.component)).toEqual(['NoteList', 'NoteCard']);
    expect(groups[1]?.states.map((state) => state.state)).toEqual(['typical', 'empty']);
    expect(groups[0]?.states[0]?.shots.map((shot) => `${shot.viewport}-${shot.theme}`)).toEqual(['phone-light', 'phone-dark', 'desktop-light', 'desktop-dark']);
  });

  it('shows an install card with its failed tests and a capped gallery', () => {
    const checks = review().checks;
    const preview = ApprovalPreview.parse({ title: 'Install notes', parts: [], irreversible: false, checks });
    const text = mount(ApprovalPreviewView, { props: { preview } }).text();
    expect(text).toContain('3 passed');
    expect(text).toContain('finds notes');
    expect(text).not.toContain('saves');
    expect(text).toContain('NoteCard');
    expect(text).toContain('typical');
  });
});
