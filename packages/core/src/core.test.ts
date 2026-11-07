import { manifestFromSpec } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import {
  ChatMessage, GinTypeDef, Membership, HUB_TABLES, IDS, ID_PREFIXES, Json, MANIFEST_SECTION_NAMES, Manifest, QualifiedName, RunId, SystemName,
  hubLinkSpec, hubWebSpec, mintId, qualify, splitName, systemLinkSpec,
} from './index.ts';

describe('ids', () => {
  it('mints ids with their kind\'s prefix, branded so they parse as that kind', () => {
    const run = mintId('run', () => 'abc');
    expect(run).toBe('run_abc');
    expect(RunId.parse(run)).toBe(run);
    expect(mintId('session')).toMatch(/^ses_[0-9a-z]{20}$/);
  });

  it('has a schema and a unique prefix for every kind', () => {
    expect(Object.keys(IDS).sort()).toEqual(Object.keys(ID_PREFIXES).sort());
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('names', () => {
  it('qualifies and splits names', () => {
    expect(qualify('fs', 'read')).toBe('fs/read');
    expect(splitName('fs/Entry.reveal')).toEqual({ system: 'fs', local: 'Entry.reveal' });
    expect(QualifiedName.safeParse('fs/read').success).toBe(true);
    expect(QualifiedName.safeParse('Fs/read').success).toBe(false);
    expect(SystemName.safeParse('my-system2').success).toBe(true);
    expect(SystemName.safeParse('2fast').success).toBe(false);
  });
});

describe('schemas', () => {
  it('accepts JSON and refuses what JSON cannot hold', () => {
    expect(Json.safeParse({ a: [1, 'b', null, true] }).success).toBe(true);
    expect(Json.safeParse({ a: () => 1 }).success).toBe(false);
  });

  it('checks the outer shape of a gin type definition', () => {
    expect(GinTypeDef.safeParse({ name: 'text' }).success).toBe(true);
    expect(GinTypeDef.safeParse({ type: 'text' }).success).toBe(false);
  });

  it('parses a chat message with every kind of part', () => {
    const message = {
      id: 'msg_1', session: 'ses_1', turn: 'trn_1', author: 'act_1', role: 'user', runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 1,
      parts: [
        { type: 'text', text: 'hi' },
        { type: 'mention', provider: 'fs/files', label: 'a.md', target: { path: 'a.md' }, text: 'File a.md' },
        { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'time', text: '09:30' }] },
      ],
    };
    expect(ChatMessage.parse(message).parts).toHaveLength(3);
  });

  it('lists every manifest section in the manifest', () => {
    const keys = Object.keys(Manifest.shape);
    for (const section of MANIFEST_SECTION_NAMES) { expect(keys).toContain(section); }
  });

  it('keys every table', () => {
    expect(Object.keys(HUB_TABLES)).toContain('runs');
    expect(HUB_TABLES.memberships.key(Membership.parse({ group: 'act_g', user: 'act_u', addedBy: 'act_a', addedAt: 1 }))).toBe('act_g\u0000act_u');
  });
});

describe('specs', () => {
  for (const [name, spec] of [['hubLinkSpec', hubLinkSpec], ['systemLinkSpec', systemLinkSpec], ['hubWebSpec', hubWebSpec]] as const) {
    it(`${name} builds a manifest with a unique short ws id per endpoint`, () => {
      const manifest = manifestFromSpec(spec);
      const ids = Object.values(manifest.endpoints).map((e) => e.ws);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('gives the web spec its realtime channels', () => {
    expect(Object.keys(manifestFromSpec(hubWebSpec).events).sort()).toEqual(['session', 'systemLog', 'user']);
  });
});
