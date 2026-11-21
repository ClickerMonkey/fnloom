/**
 * The agent tools' arg check: a model that fills a strict schema sends `null` for every optional field it leaves out,
 * and aeye hands those back as `undefined`; a field left `undefined` counts as left out instead of refusing the call
 * (found by the 2026-11-21 scenario run: every `hub/fns_search` call from GPT-6 Luna was refused).
 */
import { describe, expect, it } from 'vitest';
import { acceptObject } from './tools.ts';

describe('acceptObject', () => {
  it('takes args whose left-out fields came back undefined, at any depth', () => {
    const got = acceptObject({ text: 'weather', kinds: undefined, limit: 10, filter: { systems: undefined, available: true }, items: [{ a: undefined, b: 1 }] });
    expect(got).toEqual({ text: 'weather', limit: 10, filter: { available: true }, items: [{ b: 1 }] });
  });

  it('keeps null as null', () => {
    expect(acceptObject({ kinds: null })).toEqual({ kinds: null });
  });

  it('still refuses what is not one JSON object', () => {
    expect(acceptObject('{"text":"weather"}')).toBeInstanceOf(Error);
    expect(acceptObject([1, 2])).toBeInstanceOf(Error);
    expect(acceptObject(undefined)).toBeInstanceOf(Error);
  });
});
