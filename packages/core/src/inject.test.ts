import { describe, expect, it } from 'vitest';
import { ContextFileHeader } from './context-files.ts';
import { AgentInjected, AgentTargetDecl, InjectDecl, injectTargetProblems, isAgentPattern, targetAgents, targetHits } from './inject.ts';
import { HookDecl } from './manifest.ts';
import { QualifiedName } from './primitives.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);
const AGENTS = ['hub/chat', 'hub/chat_small', 'hub/chatty', 'crm/reviewer', 'crm/main.reviewer', 'crm/Reviewer', 'support/review_bot', 'database/main.ask'].map(q);

describe('agent targets', () => {
  it('accepts agents\' names and patterns, and refuses the rest with why', () => {
    for (const target of ['*', 'hub/chat', 'hub/chat*', 'crm/*', '*/review*', 'crm/main.reviewer', '*/*', 'c*m/rev*er', 'hub/*_small']) {
      expect(AgentTargetDecl.safeParse(target).success, target).toBe(true);
    }
    for (const target of ['', 'chat', 'hub/', '/chat', 'hub/chat/x', 'Hub/chat', 'hub chat/x', 'hub/chat?', 'hub/ch at']) {
      expect(AgentTargetDecl.safeParse(target).success, target).toBe(false);
    }
    const doubled = AgentTargetDecl.safeParse('hub/**');
    expect(doubled.success).toBe(false);
    expect(doubled.error?.issues[0]?.message).toBe('write one *');
    expect(AgentTargetDecl.safeParse('**').success).toBe(false);
    expect(AgentTargetDecl.safeParse('crm/**x').error?.issues.map((issue) => issue.message)).toContain('write one *');
  });

  it('tells a pattern from an exact name by its *', () => {
    expect(isAgentPattern('hub/chat*')).toBe(true);
    expect(isAgentPattern('*')).toBe(true);
    expect(isAgentPattern('hub/chat')).toBe(false);
  });

  it('* alone hits every agent', () => {
    expect(targetAgents('*', AGENTS)).toEqual(AGENTS);
  });

  it('an exact name hits only itself, case and all', () => {
    expect(targetAgents('hub/chat', AGENTS)).toEqual([q('hub/chat')]);
    expect(targetAgents('crm/reviewer', AGENTS)).toEqual([q('crm/reviewer')]);
    expect(targetHits('crm/reviewer', q('crm/Reviewer'))).toBe(false);
    expect(targetHits('hub/chat', q('hub/chat_small'))).toBe(false);
  });

  it('a * stands for any run of characters, none included, on its own side of the /', () => {
    expect(targetAgents('hub/chat*', AGENTS)).toEqual([q('hub/chat'), q('hub/chat_small'), q('hub/chatty')]);
    expect(targetAgents('hub/*_small', AGENTS)).toEqual([q('hub/chat_small')]);
    expect(targetAgents('*/review*', AGENTS)).toEqual([q('crm/reviewer'), q('support/review_bot')]);
    expect(targetAgents('c*m/*', AGENTS)).toEqual([q('crm/reviewer'), q('crm/main.reviewer'), q('crm/Reviewer')]);
    expect(targetAgents('*/*', AGENTS)).toEqual(AGENTS);
  });

  it('a * crosses . (a saved agent) but never /', () => {
    expect(targetHits('crm/*', q('crm/main.reviewer'))).toBe(true);
    expect(targetHits('crm/*reviewer', q('crm/main.reviewer'))).toBe(true);
    expect(targetHits('database/*', q('database/main.ask'))).toBe(true);
    // the system side never takes the local side's text
    expect(targetHits('c*/reviewer', q('crm/reviewer'))).toBe(true);
    expect(targetHits('crm*', q('crm/reviewer'))).toBe(false);
    expect(targetHits('hub/*', q('hub/a/b'))).toBe(false);
    expect(targetHits('*/b', q('hub/a/b'))).toBe(false);
  });

  it('case counts in patterns', () => {
    expect(targetAgents('crm/R*', AGENTS)).toEqual([q('crm/Reviewer')]);
    expect(targetAgents('crm/r*', AGENTS)).toEqual([q('crm/reviewer')]);
    expect(targetHits('HUB/*', q('hub/chat'))).toBe(false);
  });

  it('a pattern\'s other characters stand for themselves (a . is not any character)', () => {
    expect(targetHits('crm/main.*', q('crm/mainXreviewer'))).toBe(false);
    expect(targetHits('crm/main.*', q('crm/main.reviewer'))).toBe(true);
    expect(targetHits('hub/chat-*', q('hub/chat-x'))).toBe(true);
  });

  it('refuses an exact name that is no agent, and warns of a pattern that hits none yet', () => {
    const { problems, warnings } = injectTargetProblems(['hub/chat', 'crm/reviewr', 'billing/*', '*/review*'], AGENTS);
    expect(problems).toEqual(['crm/reviewr is not an agent: inject into hub/llm fns only']);
    expect(warnings).toEqual(['billing/* hits no agent yet']);
    expect(injectTargetProblems(['*'], [])).toEqual({ problems: [], warnings: ['* hits no agent yet'] });
  });
});

describe('inject on the wire', () => {
  it('fills its defaults and checks its targets', () => {
    expect(InjectDecl.parse({ into: ['hub/chat*'] })).toEqual({ into: ['hub/chat*'], order: 100, requires: [] });
    expect(InjectDecl.parse({ into: ['crm/*'], order: 40, requires: ['crm/lookup'], mode: 'tools' })).toEqual({ into: ['crm/*'], order: 40, requires: ['crm/lookup'], mode: 'tools' });
    expect(InjectDecl.safeParse({ into: [] }).success).toBe(false);
    expect(InjectDecl.safeParse({ into: ['hub/**'] }).success).toBe(false);
    expect(InjectDecl.safeParse({ into: ['*'], order: 1001 }).success).toBe(false);
    expect(InjectDecl.safeParse({ into: ['*'], mode: 'graph' }).success).toBe(false);
  });

  it('is in a context file\'s header, and alwaysFor is not', () => {
    const header = ContextFileHeader.parse({ key: 'asking', description: 'Forms.', summary: 'Show a form.', inject: { into: ['hub/chat*'], order: 40 } });
    expect(header.inject).toEqual({ into: ['hub/chat*'], order: 40, requires: [] });
    expect(ContextFileHeader.safeParse({ key: 'asking', description: 'Forms.', summary: 'Show a form.', alwaysFor: ['hub/chat'] }).success).toBe(false);
    expect(ContextFileHeader.safeParse({ key: 'asking', description: 'Forms.', summary: 'Show a form.', inject: { into: ['hub/**'] } }).success).toBe(false);
  });

  it('an agent takes its section in full, at its summaries, capped, or not at all', () => {
    expect(AgentInjected.parse({})).toEqual({ detail: 'full' });
    expect(AgentInjected.parse({ detail: 'summary', maxTokens: 600 })).toEqual({ detail: 'summary', maxTokens: 600 });
    expect(AgentInjected.parse('none')).toBe('none');
    expect(AgentInjected.safeParse({ maxTokens: 0 }).success).toBe(false);
    expect(AgentInjected.safeParse('some').success).toBe(false);
  });

  it('a hook may say what its block means', () => {
    expect(HookDecl.parse({ name: 'git', description: 'Git state.', explains: 'The branch and changed files.', order: 50, timeout: 500 }).explains).toBe('The branch and changed files.');
    expect(HookDecl.parse({ name: 'git', description: 'Git state.', order: 50, timeout: 500 }).explains).toBeUndefined();
    expect(HookDecl.safeParse({ name: 'git', description: 'Git state.', explains: '', order: 50, timeout: 500 }).success).toBe(false);
  });
});
