/**
 * The install checks shown on the review page and the install card: the preview gallery grouped by component and
 * state, and the install card's tests (failures only) and gallery (capped).
 */
import { ApprovalPreview, SystemTestReport } from '@harness/core';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { previewShots, review } from '../../admin/test/review.ts';
import ApprovalPreviewView from '../approvals/ApprovalPreview.vue';
import { previewGroups, shotSummary } from './gallery.ts';
import PreviewGallery from './PreviewGallery.vue';

const shots = SystemTestReport.shape.previews.unwrap().parse(previewShots([['NoteCard', ['empty', 'typical']], ['NoteList', ['loading']]]));

describe('the preview gallery', () => {
  it('groups shots by component and state, phone before desktop and light before dark', () => {
    const groups = previewGroups([...shots].reverse());
    expect(groups.map((group) => group.component)).toEqual(['NoteList', 'NoteCard']);
    expect(groups[1]?.states.map((state) => state.state)).toEqual(['typical', 'empty']);
    expect(groups[0]?.states[0]?.shots.map((shot) => `${shot.viewport}-${shot.theme}`)).toEqual(['phone-light', 'phone-dark', 'desktop-light', 'desktop-dark']);
  });

  it('shows every state as phone and desktop pictures in the picked theme, or says what was shot without links', async () => {
    const urls = Object.fromEntries(shots.map((shot) => [shot.image.hash, `https://files.test/${shot.component}-${shot.state}-${shot.viewport}-${shot.theme}.png`]));
    const wrapper = mount(PreviewGallery, { props: { shots, urls } });
    const sources = () => wrapper.findAll('[data-testid="checks-preview-shot"] img').map((img) => img.attributes('src'));
    expect(sources()).toEqual(['NoteCard-empty-phone-light', 'NoteCard-empty-desktop-light', 'NoteCard-typical-phone-light', 'NoteCard-typical-desktop-light', 'NoteList-loading-phone-light', 'NoteList-loading-desktop-light'].map((name) => `https://files.test/${name}.png`));
    await wrapper.findAll('[data-testid="checks-preview-theme"] [role="radio"]')[1]?.trigger('click');
    expect(sources()[0]).toBe('https://files.test/NoteCard-empty-phone-dark.png');
    const plain = mount(PreviewGallery, { props: { shots } });
    expect(plain.find('img').exists()).toBe(false);
    const first = previewGroups(shots)[0];
    expect(first && shotSummary(first)).toBe('phone and desktop, light and dark');
    expect(plain.text()).toContain('phone and desktop, light and dark');
    expect(plain.text()).toContain('empty · typical');
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
