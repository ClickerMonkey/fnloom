import { describe, expect, it } from 'vitest';
import { CONTEXT_BODY_REFERENCE, ContextDecl, ContextFileHeader, FnApproval, contextDeclOf, ApprovalPreview } from './index.ts';

describe('build 6 contracts', () => {
  it('turns a context file header and body into a context declaration keyed by its stable key', () => {
    const header = ContextFileHeader.parse({
      key: 'authoring.kinds',
      title: 'Kinds',
      description: 'How a kind derives its fns.',
      summary: 'Kinds derive fns from a payload.',
      fns: ['fs/write'],
      choices: [{ to: 'fs/authoring.fns', when: 'Pick this when the fn is plain code.' }],
    });
    const decl = contextDeclOf(header, 'Body with [fns](context:fs/authoring.fns) and fn:fs/write.');
    expect(ContextDecl.parse(decl).name).toBe('authoring.kinds');
    expect(decl.imports).toEqual([]);
    expect([...decl.content?.matchAll(CONTEXT_BODY_REFERENCE) ?? []].map((match) => `${match[1]}:${match[2]}`)).toEqual(['context:fs/authoring.fns', 'fn:fs/write']);
  });

  it('refuses a header without a summary or with an unknown field', () => {
    expect(ContextFileHeader.safeParse({ key: 'a', description: 'A.' }).success).toBe(false);
    expect(ContextFileHeader.safeParse({ key: 'a', description: 'A.', summary: 'A.', nme: 'x' }).success).toBe(false);
  });

  it('carries an install subject on a preview and an admins approver on a fn', () => {
    const subject = {
      kind: 'system-install', system: 'random', instance: 'main', version: '0.1.0', manifestHash: 'm', bundleHash: 'b', sourceHash: 's',
      host: { system: 'fs', instance: 'main' },
    };
    expect(ApprovalPreview.parse({ title: 'Install random 0.1.0 on fs/main', parts: [], irreversible: false, subject }).subject?.system).toBe('random');
    expect(FnApproval.parse({ preview: true, remember: false, approver: 'admins' }).approver).toBe('admins');
  });
});
