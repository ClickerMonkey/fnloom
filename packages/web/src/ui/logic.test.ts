import { describe, expect, it, vi } from 'vitest';
import { place } from './floating.ts';
import { countLabel, hueOf, initials, relativeTime } from './format.ts';
import { moveIndex } from './keys.ts';
import { LayerStack, type Layer } from './layers.ts';

const viewport = { width: 400, height: 800 };
const options = { side: 'bottom', align: 'start', offset: 6, margin: 8 } as const;

describe('place', () => {
  it('opens below the anchor, lined up with its start, at its natural size', () => {
    const at = place({ left: 20, top: 100, width: 80, height: 40 }, { width: 200, height: 150 }, viewport, options);
    expect(at).toMatchObject({ left: 20, top: 146, side: 'bottom', maxWidth: 384 });
    expect(at.maxHeight).toBe(800 - 140 - 6 - 8);
  });

  it('flips above when there is more room there', () => {
    const at = place({ left: 20, top: 700, width: 80, height: 40 }, { width: 200, height: 300 }, viewport, options);
    expect(at.side).toBe('top');
    expect(at.top).toBe(700 - 6 - 300);
  });

  it('stays below and caps its height when neither side fits', () => {
    const at = place({ left: 20, top: 300, width: 80, height: 40 }, { width: 200, height: 900 }, viewport, options);
    expect(at.side).toBe('bottom');
    expect(at.maxHeight).toBe(800 - 340 - 14);
  });

  it('slides left to stay on screen, and caps its width to the viewport', () => {
    expect(place({ left: 350, top: 10, width: 40, height: 40 }, { width: 200, height: 50 }, viewport, options).left).toBe(400 - 8 - 200);
    const wide = place({ left: 10, top: 10, width: 40, height: 40 }, { width: 900, height: 50 }, viewport, options);
    expect(wide).toMatchObject({ left: 8, maxWidth: 384 });
  });

  it('lines up with the anchor end or centre, and opens to the sides', () => {
    expect(place({ left: 200, top: 10, width: 100, height: 40 }, { width: 60, height: 50 }, viewport, { ...options, align: 'end' }).left).toBe(240);
    expect(place({ left: 200, top: 10, width: 100, height: 40 }, { width: 60, height: 50 }, viewport, { ...options, align: 'center' }).left).toBe(220);
    const right = place({ left: 50, top: 100, width: 40, height: 40 }, { width: 120, height: 60 }, viewport, { ...options, side: 'right' });
    expect(right).toMatchObject({ side: 'right', left: 96, top: 100 });
    const flipped = place({ left: 300, top: 100, width: 40, height: 40 }, { width: 120, height: 60 }, viewport, { ...options, side: 'right' });
    expect(flipped).toMatchObject({ side: 'left', left: 300 - 6 - 120 });
  });
});

describe('moveIndex', () => {
  it('moves with arrows, wraps, and jumps with Home and End', () => {
    expect(moveIndex('ArrowRight', 0, 3, 'horizontal')).toBe(1);
    expect(moveIndex('ArrowRight', 2, 3, 'horizontal')).toBe(0);
    expect(moveIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2);
    expect(moveIndex('ArrowDown', 0, 3, 'horizontal')).toBeUndefined();
    expect(moveIndex('ArrowDown', 0, 3, 'vertical')).toBe(1);
    expect(moveIndex('Home', 2, 3, 'both')).toBe(0);
    expect(moveIndex('End', 0, 3, 'both')).toBe(2);
    expect(moveIndex('a', 0, 3, 'both')).toBeUndefined();
    expect(moveIndex('ArrowDown', 0, 0, 'vertical')).toBeUndefined();
  });

  it('skips items that are refused, from anywhere including no current item', () => {
    const disabled = (at: number): boolean => at === 1;
    expect(moveIndex('ArrowDown', 0, 3, 'vertical', disabled)).toBe(2);
    expect(moveIndex('ArrowUp', 2, 3, 'vertical', disabled)).toBe(0);
    expect(moveIndex('Home', 1, 3, 'vertical', (at) => at === 0)).toBe(1);
    expect(moveIndex('End', 0, 3, 'vertical', (at) => at === 2)).toBe(1);
    expect(moveIndex('ArrowDown', -1, 3, 'vertical')).toBe(0);
    expect(moveIndex('ArrowDown', 0, 2, 'vertical', () => true)).toBeUndefined();
  });
});

describe('LayerStack', () => {
  const layer = (dismissOnOutside: boolean, inside: Node | null = null): { layer: Layer; closed: () => number } => {
    const close = vi.fn<() => void>();
    return { layer: { close, dismissOnOutside, contains: (target) => target === inside }, closed: () => close.mock.calls.length };
  };

  it('closes only the top layer on Escape', () => {
    const stack = new LayerStack();
    const bottom = layer(true);
    const top = layer(true);
    stack.push(bottom.layer);
    const removeTop = stack.push(top.layer);
    expect(stack.escape()).toBe(true);
    expect(top.closed()).toBe(1);
    expect(bottom.closed()).toBe(0);
    removeTop();
    expect(stack.top).toBe(bottom.layer);
    expect(stack.size).toBe(1);
  });

  it('closes the top layer on a press outside it, only when it asks to', () => {
    const stack = new LayerStack();
    const inside = document.createElement('div');
    const outside = document.createElement('div');
    const top = layer(true, inside);
    stack.push(top.layer);
    expect(stack.press(inside)).toBe(false);
    expect(stack.press(outside)).toBe(true);
    expect(top.closed()).toBe(1);
    const sticky = layer(false);
    stack.push(sticky.layer);
    expect(stack.press(outside)).toBe(false);
    expect(new LayerStack().escape()).toBe(false);
  });

  it('listens for Escape on a document and stops the event', () => {
    const stack = new LayerStack();
    const top = layer(true);
    stack.push(top.layer);
    const stop = stack.listen(document);
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    document.body.dispatchEvent(event);
    expect(top.closed()).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    stop();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(top.closed()).toBe(1);
  });
});

describe('format', () => {
  it('caps counts', () => {
    expect(countLabel(5)).toBe('5');
    expect(countLabel(99)).toBe('99');
    expect(countLabel(100)).toBe('99+');
  });

  it('makes initials from names and emails', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('ada king lovelace')).toBe('AL');
    expect(initials('Grace')).toBe('G');
    expect(initials('alan.turing@example.com')).toBe('AT');
    expect(initials('   ')).toBe('?');
  });

  it('gives the same name the same hue', () => {
    expect(hueOf('Ada')).toBe(hueOf('Ada'));
    expect(hueOf('Ada')).toBeGreaterThanOrEqual(0);
    expect(hueOf('Ada')).toBeLessThan(360);
  });

  it('says how long ago in short words', () => {
    const now = Date.UTC(2026, 10, 7, 12);
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4d');
    expect(relativeTime(Date.UTC(2026, 2, 12, 12), now, 'en-GB')).toBe('12 Mar');
    expect(relativeTime(Date.UTC(2025, 2, 12, 12), now, 'en-GB')).toBe('12 Mar 2025');
  });
});
