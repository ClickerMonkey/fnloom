import { manifestFromSpec } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import {
  ChatMessage, GinTypeDef, Membership, HUB_TABLES, IDS, ID_PREFIXES, Json, MANIFEST_SECTION_NAMES, Manifest, MessageView, OutgoingPart, QualifiedName, RunId,
  SystemName, SystemStatus, TypeRecord, adminSlice, authSlice, chatSlice, contentSlice, eventsSlice, findSlice, hubLinkSpec, hubWebSpec, inboxSlice,
  ProviderConfig, ProviderInput, ProviderKind, RunControl, RunControlAction, SessionControlAction, SessionId, isIdKind,
  isHeardSystemStatus, mintId, qualify, runsSlice, settingsSlice, splitName, systemLinkSpec, systemsSlice,
  contextSlice, contextorSlice, mcpsSlice, metricsSlice, modelsSlice, packagingSlice, resourcesSlice, querySlice, suggestionsSlice, autoPairSlice,
  accessSlice, connectionsSlice, pickerSlice, approvalsSlice, registriesSlice, fnsSlice, explorerSlice, reviewSlice, graphSlice, injectionsSlice, identitySlice, versionsSlice, dataSlice, rowActionsSlice, exportSlice, imageEmbeddingSlice, outsideImagesSlice, httpsSlice, peopleSlice,
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

  it('parses text as an id only when it starts with the prefix of its kind', () => {
    expect(SessionId.safeParse('ses_x').success).toBe(true);
    expect(SessionId.safeParse('run_abc').success).toBe(false);
    expect(RunId.safeParse('ses_x').success).toBe(false);
    expect(RunId.safeParse('run_').success).toBe(false);
    expect(RunId.safeParse('run').success).toBe(false);
    expect(RunId.safeParse('xrun_1').success).toBe(false);
    for (const kind of Object.keys(ID_PREFIXES).filter(isIdKind)) {
      expect(IDS[kind].safeParse(mintId(kind)).success).toBe(true);
      expect(IDS[kind].safeParse('zzz_1').success).toBe(false);
    }
  });
});

describe('providers', () => {
  it('reads the provider kinds off the one provider table, and both unions agree on them', () => {
    expect(ProviderKind.options).toEqual(['openai', 'openrouter', 'ollama', 'aws']);
    expect(ProviderInput.options.map((o) => o.shape.provider.value)).toEqual(ProviderKind.options);
    expect(Object.keys(ProviderInput.options[0].shape)).toEqual(Object.keys(ProviderConfig.options[0].shape));
  });

  it('holds a key as a secret id in the stored config and as the key itself in the input', () => {
    expect(ProviderConfig.safeParse({ provider: 'openrouter', apiKey: mintId('secret') }).success).toBe(true);
    expect(ProviderConfig.safeParse({ provider: 'openrouter', apiKey: 'sk-or-1' }).success).toBe(false);
    expect(ProviderInput.safeParse({ provider: 'openrouter', apiKey: 'sk-or-1' }).success).toBe(true);
    expect(ProviderInput.safeParse({ provider: 'openrouter', apiKey: '' }).success).toBe(false);
    // Bedrock needs a region and either a key pair or an API key
    expect(ProviderInput.safeParse({ provider: 'aws', region: 'us-east-1' }).success).toBe(false);
    expect(ProviderInput.safeParse({ provider: 'aws', region: 'us-east-1', auth: { kind: 'apiKey', apiKey: 'bk-1' } }).success).toBe(true);
    expect(ProviderConfig.safeParse({ provider: 'aws', region: 'us-east-1', auth: { kind: 'keys', accessKeyId: 'AKID', secretAccessKey: mintId('secret') } }).success).toBe(true);
    expect(ProviderConfig.safeParse({ provider: 'aws', region: 'us-east-1', auth: { kind: 'keys', accessKeyId: 'AKID', secretAccessKey: 'raw' } }).success).toBe(false);
    // a local Ollama takes no key, and listens where Ollama does by default
    expect(ProviderConfig.parse({ provider: 'ollama' })).toEqual({ provider: 'ollama', baseURL: 'http://127.0.0.1:11434' });
  });
});

describe('controls', () => {
  it('names the run and session control actions the schemas use', () => {
    expect(RunControl.shape.action).toBe(RunControlAction);
    expect(RunControlAction.options).toEqual(['cancel', 'pause']);
    expect(SessionControlAction.options).toEqual(['pause', 'resume', 'cancel']);
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

  it('lets a person send a mention without the text the hub writes for it', () => {
    const mention = { type: 'mention', provider: 'fs/files', label: 'a.md', target: { path: 'a.md' } };
    expect(OutgoingPart.parse({ ...mention, text: 'File a.md' })).toEqual(mention);
    expect(OutgoingPart.safeParse({ type: 'reasoning', text: 'hm' }).success).toBe(false);
  });

  it('shows systems a message with the fields of the chat message it comes from', () => {
    expect(Object.keys(MessageView.shape).sort()).toEqual(['author', 'createdAt', 'id', 'replyAll', 'replyTo', 'role', 'session', 'text']);
    expect(MessageView.shape.role).toBe(ChatMessage.shape.role);
  });

  it('tells systems only about statuses that change whether a system can be reached', () => {
    expect(SystemStatus.options.filter(isHeardSystemStatus)).toEqual(['connected', 'disconnected', 'removed']);
  });

  it('keeps the references of a type record as qualified names', () => {
    const record = { name: 'shop/Order', system: 'shop', description: '', def: { name: 'obj' }, display: { label: 'Order' }, references: ['shop/Product'], updatedAt: 0 };
    expect(TypeRecord.safeParse(record).success).toBe(true);
    expect(TypeRecord.safeParse({ ...record, references: ['Product'] }).success).toBe(false);
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
      // a raw stream (the CSV export) is HTTP only, so it has no ws id
      const ids = Object.values(manifest.endpoints).filter((e) => !e.httpOnly).map((e) => e.ws);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('joins the web spec from its slices, every endpoint the same object as in its slice', () => {
    const slices = [
      authSlice, chatSlice, runsSlice, findSlice, inboxSlice, contentSlice, systemsSlice, settingsSlice, adminSlice, eventsSlice,
      resourcesSlice, contextSlice, contextorSlice, modelsSlice, metricsSlice, mcpsSlice, packagingSlice, querySlice, suggestionsSlice, autoPairSlice,
      accessSlice, connectionsSlice, pickerSlice, approvalsSlice, registriesSlice, fnsSlice, explorerSlice, reviewSlice, graphSlice, injectionsSlice,
      identitySlice, versionsSlice, dataSlice, rowActionsSlice, exportSlice, imageEmbeddingSlice, outsideImagesSlice, httpsSlice, peopleSlice,
    ];
    const fromSlices = slices.flatMap((slice) => Object.entries(slice.endpoints));
    expect(Object.keys(hubWebSpec.endpoints)).toHaveLength(fromSlices.length);
    for (const [name, endpoint] of fromSlices) { expect(Object.entries(hubWebSpec.endpoints)).toContainEqual([name, endpoint]); }
  });

  it('gives the web spec its realtime channels', () => {
    expect(Object.keys(manifestFromSpec(hubWebSpec).events).sort()).toEqual(['session', 'systemLog', 'user']);
  });
});
