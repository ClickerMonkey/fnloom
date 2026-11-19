/** Each kind of chat side panel keeps its own width (Phil, 2026-11-18: "a width per panel type"). */
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { memoryStore } from '../test/fakes.ts';
import PanelHost from '../chat/components/PanelHost.vue';
import { LAYOUT_KEY, LayoutStore, PANEL_WIDTH, panelWidthIn, panelWidthMax } from './layout.ts';

afterEach(() => { document.body.innerHTML = ''; });

describe('panel widths', () => {
  it('caps a panel at a share of the window, never under its least', () => {
    expect(panelWidthMax(2000)).toBe(1200);
    expect(panelWidthMax(400)).toBe(PANEL_WIDTH.min);
    expect(panelWidthIn(900, 1000)).toBe(600);
    expect(panelWidthIn(200, 1000)).toBe(PANEL_WIDTH.min);
    expect(panelWidthIn(500.4, 2000)).toBe(500);
  });

  it('saves each kind of panel its own width; the others keep the default', () => {
    const store = memoryStore();
    const layout = new LayoutStore(store);
    expect(layout.panelWidth('llm')).toBe(PANEL_WIDTH.reset);
    layout.setPanelWidth('llm', 720);
    layout.setPanelWidth('run', 100);
    expect(layout.panelWidth('llm')).toBe(720);
    expect(layout.panelWidth('run')).toBe(PANEL_WIDTH.min);
    expect(layout.panelWidth('tree')).toBe(PANEL_WIDTH.reset);
    const reloaded = new LayoutStore(store);
    expect(reloaded.panelWidth('llm')).toBe(720);
    expect(reloaded.panelWidth('run')).toBe(PANEL_WIDTH.min);
  });

  it('reads a layout saved before panel widths, and a bad width drops only the widths', () => {
    expect(new LayoutStore(memoryStore({ [LAYOUT_KEY]: '{"collapsed":true}' })).panelWidth('llm')).toBe(PANEL_WIDTH.reset);
    const bad = new LayoutStore(memoryStore({ [LAYOUT_KEY]: JSON.stringify({ collapsed: true, treeWidth: 300, panelWidths: { llm: 'wide' } }) }));
    expect(bad.collapsed).toBe(true);
    expect(bad.treeWidth).toBe(300);
    expect(bad.panelWidth('llm')).toBe(PANEL_WIDTH.reset);
  });
});

describe('PanelHost width', () => {
  it('drags the column wider from its left edge, and the sheet the same, but not a phone sheet', async () => {
    let width = 440;
    const host = mount(PanelHost, {
      props: { inline: true, open: true, label: 'LLM call', max: 900, width, 'onUpdate:width': (next: number | undefined) => { width = next ?? width; void host.setProps({ width: next }); } },
      slots: { default: () => 'body' },
      attachTo: document.body,
    });
    const edge = host.get('[data-testid=splitter]');
    expect(edge.attributes('aria-label')).toBe('LLM call width');
    await edge.trigger('keydown', { key: 'ArrowLeft' });
    expect(width).toBe(456);
    await edge.trigger('keydown', { key: 'End' });
    expect(width).toBe(900);
    await edge.trigger('dblclick');
    expect(width).toBe(PANEL_WIDTH.reset);
    await host.setProps({ inline: false });
    await nextTick();
    const sheet = document.querySelector<HTMLElement>('[data-testid=chat-panel]');
    expect(sheet?.querySelector('[data-testid=splitter]')).not.toBeNull();
    expect(sheet?.closest<HTMLElement>('[role=dialog]')?.style.getPropertyValue('--modal-width')).toBe('440px');
    await host.setProps({ phone: true });
    await nextTick();
    expect(document.querySelector('[data-testid=chat-panel] [data-testid=splitter]')).toBeNull();
  });
});
