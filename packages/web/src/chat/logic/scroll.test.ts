import { describe, expect, it } from 'vitest';
import { ScrollFollower, type ScrollLayout } from './scroll.ts';

/** A scroll box with rows of known heights, laid out top to bottom. */
function box(rows: Array<[string, number]>, view = 400) {
  const state = { top: 0, view, rows: [...rows], smooth: 0 };
  const height = (): number => state.rows.reduce((sum, [, h]) => sum + h, 0);
  const offset = (key: string): number | undefined => {
    let y = 0;
    for (const [k, h] of state.rows) { if (k === key) { return y - state.top; } y += h; }
    return undefined;
  };
  const layout: ScrollLayout = {
    get top() { return state.top; },
    get height() { return height(); },
    get view() { return state.view; },
    scrollTo(top, smooth) {
      // a smooth scroll only starts here; the test moves it along by hand
      if (smooth) { state.smooth++; } else { state.top = Math.max(0, Math.min(top, height() - state.view)); }
    },
    firstVisible() {
      let y = 0;
      for (const [key, h] of state.rows) { if (y + h > state.top) { return { key, offset: y - state.top }; } y += h; }
      return undefined;
    },
    offsetOf: offset,
  };
  return { state, layout, bottom: () => Math.max(0, height() - state.view) };
}

describe('ScrollFollower', () => {
  it('follows content growing below while at the bottom, even when a scroll event sees the growth first', () => {
    const b = box([['a', 300], ['b', 300]]);
    const f = new ScrollFollower(b.layout);
    f.toBottom();
    expect(b.state.top).toBe(200);
    // a run card opens: the content grows by far more than the slack before the resize is observed
    b.state.rows.push(['card', 900]);
    expect(f.scrolled()).toEqual({ atBottom: true, older: true });
    expect(b.state.top).toBe(b.bottom());
    b.state.rows.push(['more', 500]);
    f.resized();
    expect(b.state.top).toBe(b.bottom());
    expect(f.fresh).toBe(0);
  });

  it('stops following only when the reader moves up, and counts rows that arrive below', () => {
    const b = box([['a', 600], ['b', 600], ['c', 600]]);
    const f = new ScrollFollower(b.layout);
    f.toBottom();
    b.state.top -= 300;
    expect(f.scrolled().atBottom).toBe(false);
    expect(f.following).toBe(false);
    f.beforeChange();
    b.state.rows.push(['d', 200]);
    f.added(1);
    f.resized();
    expect(f.fresh).toBe(1);
    expect(b.state.top).toBe(1100);
    b.state.top = b.bottom();
    expect(f.scrolled().atBottom).toBe(true);
    expect(f.fresh).toBe(0);
  });

  it('keeps the row the reader looks at in place when older history is prepended', () => {
    const b = box([['m5', 500], ['m6', 500], ['m7', 500]]);
    const f = new ScrollFollower(b.layout);
    f.toBottom();
    b.state.top = 650;
    f.scrolled();
    expect(f.following).toBe(false);
    const before = b.layout.offsetOf('m6');
    f.beforeChange();
    b.state.rows.unshift(['m1', 400], ['m2', 400]);
    f.resized();
    expect(b.layout.offsetOf('m6')).toBe(before);
    expect(b.state.top).toBe(1450);
  });

  it('leaves the bottom on a wheel or swipe up, before any scroll event', () => {
    const b = box([['a', 900]]);
    const f = new ScrollFollower(b.layout);
    f.toBottom();
    b.state.top -= 100;
    f.leave();
    b.state.rows.push(['b', 300]);
    f.resized();
    expect(b.state.top).toBe(400);
    expect(f.following).toBe(false);
  });

  it('glides to the bottom smoothly without fighting its own scroll, and holds a revealed message', () => {
    const b = box([['a', 900], ['b', 900]]);
    const f = new ScrollFollower(b.layout);
    f.hold();
    f.toBottom(true);
    expect(b.state.smooth).toBe(1);
    f.resized();
    expect(b.state.smooth).toBe(2);
    b.state.top = 700;
    expect(f.scrolled().atBottom).toBe(true);
    expect(f.following).toBe(true);
    b.state.top = b.bottom();
    f.scrolled();
    f.hold();
    expect(f.following).toBe(false);
    expect(f.distance()).toBe(0);
    expect(new ScrollFollower(box([]).layout).scrolled()).toEqual({ atBottom: true, older: true });
  });
});
