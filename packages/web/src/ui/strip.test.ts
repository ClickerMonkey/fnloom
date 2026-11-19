/**
 * Sideways strips and dividers (Phil, 2026-11-18: the LLM call sidebar's JSON tab could not be reached with a mouse;
 * "the mouse wheel scrolls sideways, plus edge arrows"; the side panel drags wider from its left edge).
 */
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { dragWidth } from './split.ts';
import { ARROW_ROOM, arrowScroll, revealScroll, WHEEL_LINE, wheelScroll } from './strip.ts';
import UiSplitter from './UiSplitter.vue';
import UiTabs from './UiTabs.vue';

afterEach(() => { document.body.innerHTML = ''; });

/** A 300px strip holding 1000px of tabs. */
const box = (scrollLeft: number) => ({ scrollLeft, clientWidth: 300, scrollWidth: 1000 });

describe('wheelScroll', () => {
  it('turns a vertical wheel into a sideways scroll, in pixels, lines or pages', () => {
    expect(wheelScroll({ deltaX: 0, deltaY: 100, deltaMode: 0 }, box(0))).toBe(100);
    expect(wheelScroll({ deltaX: 0, deltaY: -100, deltaMode: 0 }, box(250))).toBe(150);
    expect(wheelScroll({ deltaX: 0, deltaY: 3, deltaMode: 1 }, box(0))).toBe(3 * WHEEL_LINE);
    expect(wheelScroll({ deltaX: 0, deltaY: 1, deltaMode: 2 }, box(0))).toBe(300);
  });

  it('stops at the ends, and leaves the wheel to the page there', () => {
    expect(wheelScroll({ deltaX: 0, deltaY: 500, deltaMode: 0 }, box(600))).toBe(700);
    expect(wheelScroll({ deltaX: 0, deltaY: 100, deltaMode: 0 }, box(700))).toBeUndefined();
    expect(wheelScroll({ deltaX: 0, deltaY: -100, deltaMode: 0 }, box(0))).toBeUndefined();
  });

  it('leaves a sideways swipe, a pinch and a strip that fits alone', () => {
    expect(wheelScroll({ deltaX: 40, deltaY: 10, deltaMode: 0 }, box(0))).toBeUndefined();
    expect(wheelScroll({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: true }, box(0))).toBeUndefined();
    expect(wheelScroll({ deltaX: 0, deltaY: 100, deltaMode: 0 }, { scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toBeUndefined();
  });
});

describe('arrowScroll and revealScroll', () => {
  it('pages most of a strip each way, within its range', () => {
    expect(arrowScroll(1, box(0))).toBe(240);
    expect(arrowScroll(1, box(600))).toBe(700);
    expect(arrowScroll(-1, box(100))).toBe(0);
  });

  it('brings an item into view clear of the arrows, and leaves one already shown', () => {
    // past the end: its right edge lands the arrow's room inside the strip
    expect(revealScroll({ left: 800, width: 60 }, box(0))).toBe(800 + 60 + ARROW_ROOM - 300);
    // before the start: its left edge lands the arrow's room inside
    expect(revealScroll({ left: 200, width: 60 }, box(400))).toBe(200 - ARROW_ROOM);
    expect(revealScroll({ left: 100, width: 60 }, box(0))).toBe(0);
    // the last tab never scrolls past the end
    expect(revealScroll({ left: 940, width: 60 }, box(0))).toBe(700);
    // one wider than the room shows from its start
    expect(revealScroll({ left: 500, width: 400 }, box(0))).toBe(500 - ARROW_ROOM);
  });
});

describe('UiSplitter side', () => {
  it('sizes the pane after it: dragging or arrowing left widens it, within its limits', async () => {
    expect(dragWidth(400, -50, 'after')).toBe(450);
    expect(dragWidth(400, -50, 'before')).toBe(350);
    const width = ref(440);
    const splitter = mount(UiSplitter, {
      props: {
        label: 'Panel width', side: 'after', min: 360, max: 800, reset: 440, modelValue: width.value,
        'onUpdate:modelValue': (next: number) => { width.value = next; void splitter.setProps({ modelValue: next }); },
      },
    });
    await splitter.trigger('keydown', { key: 'ArrowLeft' });
    expect(width.value).toBe(456);
    await splitter.trigger('keydown', { key: 'ArrowRight' });
    expect(width.value).toBe(440);
    splitter.get<HTMLElement>('[data-testid=splitter]').element.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 1000, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700 }));
    expect(width.value).toBe(740);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 }));
    expect(width.value).toBe(800);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 2000 }));
    expect(width.value).toBe(360);
    window.dispatchEvent(new PointerEvent('pointerup', {}));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 900 }));
    expect(width.value).toBe(360);
    await splitter.trigger('dblclick');
    expect(width.value).toBe(440);
  });
});

describe('UiTabs strip', () => {
  /** Give the mounted strip a 300px window onto 1000px of tabs (happy-dom lays nothing out). */
  function sized(list: HTMLElement): void {
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 1000 });
    // happy-dom glides later, if at all: land at once
    Object.defineProperty(list, 'scrollTo', { configurable: true, value: (options: ScrollToOptions) => { list.scrollLeft = options.left ?? list.scrollLeft; } });
  }
  const tabs = ['saw', 'said', 'usage', 'raw', 'json'].map((value) => ({ value, label: value }));

  it('scrolls sideways on a vertical wheel, and lets the page have it at the end', async () => {
    const view = mount(UiTabs, { props: { tabs, label: 'Call', modelValue: 'saw' }, attachTo: document.body });
    const list = view.get<HTMLElement>('[role=tablist]').element;
    sized(list);
    const turn = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    list.dispatchEvent(turn);
    expect(list.scrollLeft).toBe(120);
    expect(turn.defaultPrevented).toBe(true);
    list.scrollLeft = 700;
    const past = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    list.dispatchEvent(past);
    expect(past.defaultPrevented).toBe(false);
  });

  it('shows an arrow only at an end with more beyond it, and an arrow pages the strip', async () => {
    const view = mount(UiTabs, { props: { tabs, label: 'Call', modelValue: 'saw' }, attachTo: document.body });
    expect(view.find('[data-testid=tabs-on]').exists()).toBe(false);
    const list = view.get<HTMLElement>('[role=tablist]').element;
    sized(list);
    list.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(view.find('[data-testid=tabs-back]').exists()).toBe(false);
    expect(view.find('[data-testid=tabs-on]').exists()).toBe(true);
    await view.get('[data-testid=tabs-on]').trigger('click');
    expect(list.scrollLeft).toBe(240);
    list.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(view.find('[data-testid=tabs-back]').exists()).toBe(true);
    // the arrows are mouse aids: out of the tab order
    expect(view.get('[data-testid=tabs-on]').attributes('tabindex')).toBe('-1');
  });

  it('keeps the chosen tab in view', async () => {
    const view = mount(UiTabs, { props: { tabs, label: 'Call', modelValue: 'saw' }, attachTo: document.body });
    const list = view.get<HTMLElement>('[role=tablist]').element;
    sized(list);
    const json = view.get<HTMLElement>('[role=tab][id$="-tab-json"]').element;
    Object.defineProperty(json, 'offsetLeft', { configurable: true, value: 900 });
    Object.defineProperty(json, 'offsetWidth', { configurable: true, value: 60 });
    await view.setProps({ modelValue: 'json' });
    await nextTick();
    expect(list.scrollLeft).toBe(900 + 60 + ARROW_ROOM - 300);
  });
});
