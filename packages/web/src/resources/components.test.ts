import type { ResourceUri } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import ResourceViewer from './ResourceViewer.vue';
import ResourceList from './browser/ResourceList.vue';
import CodeViewer from './viewers/CodeViewer.vue';
import JsonTree from './viewers/JsonTree.vue';
import MediaViewer from './viewers/MediaViewer.vue';
import PagesViewer from './viewers/PagesViewer.vue';
import TableViewer from './viewers/TableViewer.vue';
import { FIXTURES, uri } from './test/fakes.ts';

afterEach(() => { document.body.innerHTML = ''; });

/** Mount the viewer for a resource on fake stores. */
async function viewer(address: string, mode = '') {
  const fakes = fakeStores({ signedIn: true });
  const wrapper = mount(ResourceViewer, { props: { uri: uri(address), mode }, global: { provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

describe('ResourceViewer', () => {
  it('previews markdown with its diagram and math, and switches mode through its v-model', async () => {
    const wrapper = await viewer('fs://work/README.md');
    expect(wrapper.attributes('data-draws')).toBe('markdown');
    expect(wrapper.find('h1').text()).toBe('Harness');
    expect(wrapper.find('[data-testid="diagram"]').exists()).toBe(true);
    expect(wrapper.find('math').exists()).toBe(true);
    const source = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === 'Source');
    await source?.trigger('click');
    expect(wrapper.emitted('update:mode')?.[0]).toEqual(['source']);
    await wrapper.setProps({ mode: 'source' });
    await flushPromises();
    expect(wrapper.find('[data-testid="code-view"]').exists()).toBe(true);
  });

  it("draws a workbook's sheets from its table form", async () => {
    const wrapper = await viewer('fs://work/data/book.xlsx');
    expect(wrapper.attributes('data-draws')).toBe('table');
    await flushPromises();
    expect(wrapper.find('[data-testid="table-view"]').text()).toContain('Grace');
    expect(wrapper.findAll('[data-testid="table-view"] [role="tab"]').map((t) => t.text().replace(/\d+$/, '').trim())).toEqual(['People', 'Places']);
  });

  it('draws json as a tree, an image from its download, and info', async () => {
    expect((await viewer('fs://work/package.json')).find('[data-testid="json-view"]').text()).toContain('workspaces');
    const image = await viewer('fs://work/art/logo.png');
    expect(image.find('[data-testid="image-view"] img').attributes('src')).toContain('logo.png');
    const info = await viewer('fs://work/art/logo.png', 'info');
    expect(info.find('[data-testid="resource-info"]').text()).toContain('fs://work/art/logo.png');
  });
});

describe('the viewers', () => {
  it('sorts and filters a table', async () => {
    const wrapper = mount(TableViewer, { props: { tables: [{ headers: ['name', 'age'], rows: [['Ada', '36'], ['Grace', '9'], ['Alan', '41']] }] } });
    const ages = (): string[] => wrapper.findAll('tbody tr').map((row) => row.findAll('td')[1]?.text() ?? '');
    await wrapper.findAll('thead button')[1]?.trigger('click');
    expect(ages()).toEqual(['9', '36', '41']);
    await wrapper.find('input[type="search"]').setValue('al');
    expect(ages()).toEqual(['41']);
  });

  it('searches a JSON tree and lights the match', async () => {
    const wrapper = mount(JsonTree, { props: { text: '{"a":{"b":"needle"}}' } });
    await wrapper.find('input[type="search"]').setValue('needle');
    expect(wrapper.find('.row.match').text()).toContain('needle');
  });

  it('goes to a line in code, and pages through pages', async () => {
    const code = mount(CodeViewer, { props: { code: 'a\nb\nc', language: 'ts' } });
    await code.find('input[type="number"]').setValue('9');
    await code.find('form').trigger('submit');
    expect(code.emitted('update:line')?.[0]).toEqual([3]);
    const pages = mount(PagesViewer, { props: { pages: ['one', 'two'], page: 1 } });
    expect(pages.find('.text').text()).toBe('one');
    await pages.findAll('.number')[1]?.trigger('click');
    expect(pages.emitted('update:page')?.[0]).toEqual([2]);
  });

  it('shows a transcript beside media with its times', () => {
    const wrapper = mount(MediaViewer, { props: { src: '', kind: 'audio', transcript: '[0:03] Hello' } });
    expect(wrapper.find('.stamp').text()).toBe('0:03');
    expect(wrapper.text()).toContain('Hello');
  });

  it('lists resources with their badges and emits open, toggle and sort', async () => {
    const wrapper = mount(ResourceList, { props: { records: FIXTURES, selected: new Set<ResourceUri>(), sort: 'seen', descending: false, now: 1_700_000_100_000 } });
    expect(wrapper.findAll('[data-testid="resource-row"]')).toHaveLength(FIXTURES.length);
    expect(wrapper.text()).toContain('Transcript');
    await wrapper.find('.open').trigger('click');
    expect(wrapper.emitted('open')?.[0]).toEqual(['fs://work/README.md']);
    await wrapper.find('[data-testid="resource-row"] input').trigger('change');
    expect(wrapper.emitted('toggle')?.[0]).toEqual(['fs://work/README.md']);
    await wrapper.find('.sorter').trigger('click');
    expect(wrapper.emitted('sort')?.[0]).toEqual(['name']);
  });
});
