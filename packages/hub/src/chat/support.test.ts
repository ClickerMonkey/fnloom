import { IDS } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { agentActorId, agentName, allowsSystem, asQualified, clip, unmark, escapeAttribute, escapeBody, sameJson, turnScope } from './support.ts';
import { knownZone, timeInfo, weekday } from '../execution/time.ts';

const at = Date.UTC(2026, 10, 7, 14, 30, 5);

describe('time for a person', () => {
  it('gives local time with the zone offset', () => {
    expect(timeInfo(at, 'America/New_York')).toEqual({ now: at, timeZone: 'America/New_York', local: '2026-11-07T09:30:05-05:00' });
    expect(timeInfo(at, 'Asia/Kolkata').local).toBe('2026-11-07T20:00:05+05:30');
  });

  it('falls back to UTC for a zone the platform does not know', () => {
    expect(knownZone('Mars/Olympus')).toBe(false);
    expect(timeInfo(at, 'Mars/Olympus')).toEqual({ now: at, timeZone: 'UTC', local: '2026-11-07T14:30:05+00:00' });
  });

  it('names the weekday in the zone', () => {
    expect(weekday(Date.UTC(2026, 10, 7, 2), 'America/Los_Angeles')).toBe('Friday');
    expect(weekday(Date.UTC(2026, 10, 7, 2), 'UTC')).toBe('Saturday');
  });
});

describe('names and scopes', () => {
  it('gives each agent fn one stable actor id and a readable name', () => {
    expect(agentActorId('hub/chat')).toBe(agentActorId('hub/chat'));
    expect(agentActorId('hub/chat')).not.toBe(agentActorId('crm/coach'));
    expect(agentName('hub/chat')).toBe('Chat');
    expect(agentName('crm/deal_coach')).toBe('Deal coach');
  });

  it('keys sessionless state by turn, apart from every real session', () => {
    expect(turnScope(IDS.turn.parse('trn_1'))).toBe('ses_turn.trn_1');
  });

  it('parses qualified names', () => {
    expect(asQualified('fs/read')).toBe('fs/read');
    expect(asQualified('read')).toBeUndefined();
    expect(asQualified('Bad/x')).toBeUndefined();
  });

  it('always allows the hub, and other systems as the session says', () => {
    expect(allowsSystem({ systems: [] }, 'hub')).toBe(true);
    expect(allowsSystem({ systems: 'all' }, 'fs')).toBe(true);
    expect(allowsSystem({ systems: [] }, 'fs')).toBe(false);
  });
});

describe('text', () => {
  it('escapes tag bodies and attributes', () => {
    expect(escapeBody('a </mention> & b')).toBe('a &lt;/mention&gt; &amp; b');
    expect(escapeAttribute('say "hi"\nnow')).toBe('say &quot;hi&quot; now');
  });

  it('clips on a word boundary', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('Find every TODO in the repository today', 20)).toBe('Find every TODO in…');
    expect(clip('  many   spaces  ', 20)).toBe('many spaces');
  });

  it('compares JSON ignoring key order', () => {
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson(undefined, undefined)).toBe(true);
    expect(sameJson(undefined, null)).toBe(false);
  });
});

describe('markdown as plain text', () => {
  it('keeps what markdown reads as and drops its markers', () => {
    expect(unmark('# Title\n\nOne **hub** owns every `LLM` call, while *systems* add [fns](https://x.dev).')).toBe('Title\n\nOne hub owns every LLM call, while systems add fns.');
    expect(unmark('- first\n- second\n1. third\n> quoted')).toBe('first\nsecond\nthird\nquoted');
    expect(unmark('```ts\nconst a = 1;\n```')).toBe('const a = 1;\n');
    expect(unmark('snake_case_name and 2 * 3 * 4 stay')).toBe('snake_case_name and 2 * 3 * 4 stay');
  });
});
