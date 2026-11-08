import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { clampPage, PDF_DOCUMENTS, type PdfDocuments } from '../logic/pdf.ts';
import PdfViewer from './PdfViewer.vue';

/** An engine that opens every pdf as `pages` pages (or refuses), and records what it opened and closed. */
function engine(pages: number | 'refuse') {
  const opened: string[] = [];
  const closed: string[] = [];
  const documents: PdfDocuments = {
    open: (url) => {
      opened.push(url);
      if (pages === 'refuse') { return Promise.reject(new Error('not a pdf')); }
      return Promise.resolve({ pages, draw: () => Promise.resolve(), close: () => { closed.push(url); return Promise.resolve(); } });
    },
  };
  return { documents, opened, closed };
}

describe('the pdf viewer', () => {
  it('keeps the page inside the document', () => {
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(9, 3)).toBe(3);
    expect(clampPage(2.7, 3)).toBe(2);
    expect(clampPage(9, 0)).toBe(9);
  });

  it('opens the pdf with the engine, counts its pages, and closes it when it goes', async () => {
    const { documents, opened, closed } = engine(12);
    const wrapper = mount(PdfViewer, { props: { src: '/files/a.pdf', page: 3 }, global: { provide: { [PDF_DOCUMENTS]: documents } } });
    await flushPromises();
    expect(opened).toEqual(['/files/a.pdf']);
    expect(wrapper.find('[data-testid="pdf-sheet"] canvas').exists()).toBe(true);
    expect(wrapper.find('[data-testid="pdf-pages"]').text()).toBe('of 12');
    expect(wrapper.find('[data-testid="pdf-frame"]').exists()).toBe(false);
    await wrapper.find('button[aria-label="Next page"]').trigger('click');
    expect(wrapper.emitted('update:page')).toEqual([[4]]);
    wrapper.unmount();
    await flushPromises();
    expect(closed).toEqual(['/files/a.pdf']);
  });

  it('shows the browser’s viewer when the engine can’t open it, or there is none', async () => {
    const refusing = mount(PdfViewer, { props: { src: '/files/b.pdf', page: 2 }, global: { provide: { [PDF_DOCUMENTS]: engine('refuse').documents } } });
    await flushPromises();
    expect(refusing.find('[data-testid="pdf-frame"]').attributes('src')).toBe('/files/b.pdf#page=2');
    const none = mount(PdfViewer, { props: { src: '/files/c.pdf' } });
    expect(none.find('[data-testid="pdf-frame"]').exists()).toBe(true);
  });
});
