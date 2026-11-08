import { describe, expect, it } from 'vitest';
import {
  ChatModeConfig, ContextorConfig, ContextorType, ChatModeType, DeclaredLink, FormKind, GinExprDef, GinTypeDef, HUB_TABLES, InstanceName, InstanceRef, MAIN_INSTANCE,
  ModelForward, NameGlob, OutcomeCounts, OutcomeWire, PackagePath, RESERVED_SYSTEM_NAMES, RoleChoice, RunOutcome, SystemPackageManifest, familyOf,
  instanceLabel, isConvertedKind, isGinExprDef, isGinTypeDef, isReservedSystemName, linkTargetKey, phaseOf, RUN_STATUS_WORDS, ModelLimits, ResolvedModelLimits,
} from './index.ts';

describe('modes and contextors', () => {
  it('fills a static mode and a graph contextor from their defaults', () => {
    expect(ChatModeConfig.parse({ type: 'static' })).toEqual({ type: 'static', protocol: 'auto', placement: 'system-end', loadDetail: 'full' });
    expect(ContextorConfig.parse({ type: 'graph' })).toMatchObject({
      type: 'graph', metrics: {}, spread: { damping: 0.5, hops: 2 }, floorExchanges: 1, shares: { history: 0.45, context: 0.35, fns: 0.2 }, threshold: 0.15, evaluate: 'perMessage',
    });
    expect(ChatModeType.options).toEqual(['tools', 'static']);
    expect(ContextorType.options).toEqual(['plain', 'suggest', 'graph']);
  });

  it('keeps model limits partial until resolved', () => {
    expect(ModelLimits.parse({})).toEqual({});
    expect(ResolvedModelLimits.safeParse({ contextWindow: 4096 }).success).toBe(false);
  });
});

describe('the context graph', () => {
  it('keys every kind of link target', () => {
    expect(linkTargetKey({ kind: 'context', name: 'fs/guide' })).toBe('context:fs/guide');
    expect(linkTargetKey({ kind: 'fn', name: 'fs/read' })).toBe('fn:fs/read');
    expect(linkTargetKey({ kind: 'type', name: 'fs/Entry' })).toBe('type:fs/Entry');
    expect(linkTargetKey({ kind: 'resource', uri: 'file:///a.md' })).toBe('resource:file:///a.md');
    expect(linkTargetKey(DeclaredLink.parse({ to: { kind: 'resource', uri: 'file:///a.md', section: 'Usage' }, relation: 'about' }).to)).toBe('resource:file:///a.md#Usage');
  });

  it('refuses relations only the hub may find', () => {
    expect(DeclaredLink.safeParse({ to: { kind: 'fn', name: 'fs/read' }, relation: 'learned' }).success).toBe(false);
    expect(DeclaredLink.parse({ to: { kind: 'fn', name: 'fs/read' }, relation: 'brings' }).weight).toBe(0.5);
  });

  it('keeps context links in their own table, keyed by edge', () => {
    expect(HUB_TABLES.contextLinks.fields).toEqual(['from', 'toKey', 'relation']);
  });
});

describe('forms and families', () => {
  it('tells converted versions from model-made forms', () => {
    expect(isConvertedKind('markdown')).toBe(true);
    expect(isConvertedKind('description')).toBe(false);
    expect(FormKind.options).toContain('table');
  });

  it('finds a family by format, then by the mime type, else other', () => {
    expect(familyOf('markdown')).toBe('document');
    expect(familyOf('nope', 'image/png')).toBe('image');
    expect(familyOf(undefined, 'audio/mpeg')).toBe('audio');
    expect(familyOf(undefined, 'video/mp4')).toBe('video');
    expect(familyOf(undefined, 'application/x-thing')).toBe('other');
    expect(familyOf(undefined)).toBe('other');
  });
});

describe('gin on the wire', () => {
  it('checks the outer shape of types and expressions', () => {
    expect(isGinTypeDef({ name: 'text' })).toBe(true);
    expect(isGinTypeDef([])).toBe(false);
    expect(isGinExprDef({ kind: 'get' })).toBe(true);
    expect(isGinExprDef({ kind: 3 })).toBe(false);
    expect(isGinExprDef(null)).toBe(false);
    expect(GinExprDef.safeParse({ name: 'text' }).success).toBe(false);
    expect(GinTypeDef.safeParse({ name: 'text' }).success).toBe(true);
  });
});

describe('instances, names and packages', () => {
  it('names instances like systems and labels refs', () => {
    expect(MAIN_INSTANCE).toBe('main');
    expect(instanceLabel(InstanceRef.parse({ system: 'fs', instance: 'laptop' }))).toBe('fs@laptop');
    expect(InstanceName.safeParse('Laptop').success).toBe(false);
  });

  it('keeps reserved system names for the hub', () => {
    expect(RESERVED_SYSTEM_NAMES).toContain('memory');
    expect(isReservedSystemName('resource')).toBe(true);
    expect(isReservedSystemName('fs')).toBe(false);
  });

  it('matches name globs', () => {
    expect(NameGlob.safeParse('fs/*').success).toBe(true);
    expect(NameGlob.safeParse('hub/search_*').success).toBe(true);
    expect(NameGlob.safeParse('no-slash').success).toBe(false);
  });

  it('refuses package paths that leave the folder', () => {
    expect(PackagePath.safeParse('server/main.js').success).toBe(true);
    expect(PackagePath.safeParse('../evil.js').success).toBe(false);
    expect(PackagePath.safeParse('/abs.js').success).toBe(false);
    expect(PackagePath.safeParse('a\\b.js').success).toBe(false);
  });

  it('reads system.json with its defaults', () => {
    const manifest = SystemPackageManifest.parse({ format: 1, name: 'notes', version: '0.1.0', description: 'Notes.', protocol: 1, server: { entry: 'server/main.js' } });
    expect(manifest.instances).toBe('one');
    expect(manifest.server.external).toEqual({});
    expect(SystemPackageManifest.safeParse({ ...manifest, version: 'one' }).success).toBe(false);
  });
});

describe('invalid input', () => {
  it('is a settled outcome worded softly, in the retry phase', () => {
    expect(OutcomeWire.parse({ status: 'invalid-input', invalid: { source: 'schema', problems: [{ path: 'path', message: 'expected text' }] } })).toMatchObject({ status: 'invalid-input' });
    expect(OutcomeWire.safeParse({ status: 'invalid-input', invalid: { source: 'json', problems: [] } }).success).toBe(false);
    expect(RUN_STATUS_WORDS['invalid-input']).toBe('Retried');
    expect(phaseOf('invalid-input', 1)).toBe('retry');
  });

  it('is counted apart in metrics', () => {
    expect(RunOutcome.options).toEqual(['done', 'invalid-input', 'failed', 'cancelled']);
    expect(OutcomeCounts.safeParse({ done: 1, failed: 0, cancelled: 0 }).success).toBe(false);
  });
});

describe('model calls and roles', () => {
  it('forwards every non-chat modality with its run', () => {
    expect(ModelForward.parse({ modality: 'embed', texts: ['a'], run: 'run_1' })).toEqual({ modality: 'embed', texts: ['a'], run: 'run_1' });
    expect(ModelForward.safeParse({ modality: 'chat' }).success).toBe(false);
  });

  it('gives dictation an engine and every other role a model', () => {
    expect(RoleChoice.parse({ role: 'dictate', engine: { engine: 'browser' } })).toEqual({ role: 'dictate', engine: { engine: 'browser' } });
    expect(RoleChoice.parse({ role: 'transcribe', model: { model: 'openai/whisper-1' } })).toMatchObject({ role: 'transcribe' });
    expect(RoleChoice.safeParse({ role: 'dictate', model: { model: 'x' } }).success).toBe(false);
  });
});
