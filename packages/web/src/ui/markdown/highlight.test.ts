import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import UiCodeBlock from '../UiCodeBlock.vue';
import { highlight, knowsLanguage } from './highlight.ts';
import { safeLink } from './inline.ts';
import UiMarkdown from './UiMarkdown.vue';

const kinds = (code: string, language: string) => highlight(code, language).filter((t) => t.kind !== 'plain').map((t) => [t.kind, t.text]);

describe('highlight', () => {
  it('colours keywords, strings, numbers, literals and comments, and keeps every character', () => {
    const code = 'const x = "a\\"b"; // note\nreturn 42 + null;';
    expect(highlight(code, 'ts').map((t) => t.text).join('')).toBe(code);
    expect(kinds(code, 'ts')).toEqual([['keyword', 'const'], ['string', '"a\\"b"'], ['comment', '// note'], ['keyword', 'return'], ['number', '42'], ['literal', 'null']]);
    expect(kinds('def f(): # hi\n  return None', 'python')).toEqual([['keyword', 'def'], ['comment', '# hi'], ['keyword', 'return'], ['literal', 'None']]);
    expect(kinds('SELECT a FROM t /* x */', 'sql')).toEqual([['keyword', 'SELECT'], ['keyword', 'FROM'], ['comment', '/* x */']]);
    expect(kinds('echo a#b', 'bash')).toEqual([['keyword', 'echo']]);
    expect(kinds('v2 = 3', 'js')).toEqual([['number', '3']]);
    expect(highlight('anything', 'klingon')).toEqual([{ kind: 'plain', text: 'anything' }]);
    expect(knowsLanguage('TypeScript')).toBe(true);
  });

  it('draws tokens as text spans in a code block', () => {
    const block = mount(UiCodeBlock, { props: { code: 'let a = "<b>"', language: 'js' } });
    expect(block.find('.tok-keyword').text()).toBe('let');
    expect(block.find('.tok-string').text()).toBe('"<b>"');
    expect(block.find('b').exists()).toBe(false);
    const numbered = mount(UiCodeBlock, { props: { code: 'let a\nlet b', language: 'js', lineNumbers: true } });
    expect(numbered.findAll('.line')).toHaveLength(2);
    expect(numbered.findAll('.tok-keyword')).toHaveLength(2);
  });
});

describe('markdown links and images', () => {
  it('links resource URIs (in links and code spans) to navigate, never script URLs', async () => {
    expect(safeLink('fs://docs/a.md')).toBe('fs://docs/a.md');
    expect(safeLink('javascript://x')).toBeUndefined();
    expect(safeLink('data://x')).toBeUndefined();
    const navigate = vi.fn();
    const md = mount(UiMarkdown, { props: { source: 'See [the doc](fs://docs/a.md) and `fs://docs/b.md`.', navigate }, attachTo: document.body });
    const links = md.findAll('a');
    expect(links.map((a) => a.attributes('href'))).toEqual(['fs://docs/a.md', 'fs://docs/b.md']);
    expect(links[0]?.attributes('target')).toBeUndefined();
    await links[0]?.trigger('click');
    await links[1]?.trigger('click');
    expect(navigate.mock.calls).toEqual([['fs://docs/a.md'], ['fs://docs/b.md']]);
    md.unmount();
  });

  it('opens an image large, and closes it', async () => {
    const md = mount(UiMarkdown, { props: { source: '![A chart](/img/chart.png)' }, attachTo: document.body });
    await md.get('.md-image-open').trigger('click');
    await nextTick();
    const viewer = document.querySelector('[data-testid=image-viewer]');
    expect(viewer?.querySelector('img')?.getAttribute('src')).toBe('/img/chart.png');
    const zoomIn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Zoom in');
    zoomIn?.click();
    await nextTick();
    expect(viewer?.textContent).toContain('150%');
    const close = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Close');
    close?.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    md.unmount();
  });
});
