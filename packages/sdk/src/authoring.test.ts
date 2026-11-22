/**
 * The authoring agent on aeye through a scripted hub model: its tools open stage by stage (find, then inspect, then
 * draft), a failed check moves it to fix and a clean one offers save, the saved fn is the answer, a fix past the cap
 * gives up with the last problems, and `Disclosure` keeps what was seen and loaded per level.
 */
import { mintId, type LlmForward, type LlmForwardChunk } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuthoringError, authoringAgent, authoringTool, Disclosure, type AuthoredFn } from './authoring.ts';
import { FakeModelLink, fakeHubAi, replyChunks } from './server/fake-models.ts';

/** A reply that calls one tool. */
function callTool(name: string, args: object): LlmForwardChunk[] {
  return [
    { type: 'chunk', chunk: { toolCall: { id: mintId('llmInteraction'), name, arguments: JSON.stringify(args) } } },
    { type: 'chunk', chunk: { finishReason: 'tool_calls' } },
    { type: 'done', usage: { input: 1, output: 1 }, cost: 0, interaction: mintId('llmInteraction'), model: 'fake/model' },
  ];
}

/** The tools a forward offered, by name, sorted. */
const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

const SAVED: AuthoredFn = { fn: 'notes/by_tag', version: 1, signature: 'notes/by_tag(tag: text)', about: 'Notes with a tag.', reused: false, call: 'notes/by_tag({ tag: "work" })' };

/** A small authoring agent over notes: search, load a note type, draft a filter, check that its tag is known. */
function notesAgent(fixes = 2) {
  const search = authoringTool<{ tags: string[] }, { tag: string }, { text: string }>({
    name: 'search', stage: 'find', description: 'Search the saved fns.', schema: z.object({ text: z.string() }),
    call: (_input, session) => { session.disclosure.markSearched('fn'); session.disclosure.markAware('type', ['Note']); return 'Nothing saved fits. The Note type has a tag.'; },
  });
  const load = authoringTool<{ tags: string[] }, { tag: string }, { name: string }>({
    name: 'load', stage: 'inspect', description: 'Load a type.', schema: z.object({ name: z.string() }),
    when: (session) => session.disclosure.awareUnloaded('type').length > 0,
    call: (input, session) => { session.disclosure.markLoaded('type', [input.name]); return 'Note { tag: text, text: text }'; },
  });
  return authoringAgent<{ tags: string[] }, { tag: string }>({
    name: 'notes_query', description: 'Write a notes query.', instructions: 'Find, inspect, draft, then save.', tools: [search, load], fixes,
    draft: { description: 'The tag to filter by.', schema: z.object({ tag: z.string() }) },
    check: (draft, session) => Promise.resolve(session.state.tags.includes(draft.tag) ? { problems: [], preview: [{ text: 'hi' }] } : { problems: [`There is no tag ${draft.tag}.`] }),
    save: () => Promise.resolve(SAVED),
  });
}

describe('the authoring agent', () => {
  it('opens its tools stage by stage, fixes a failed check, and answers with the saved fn', async () => {
    const script = [
      callTool('search', { text: 'notes by tag' }), callTool('load', { name: 'Note' }), callTool('draft', { draft: { tag: 'wrk' } }),
      callTool('draft', { draft: { tag: 'work' } }), callTool('save', {}), replyChunks('Saved notes/by_tag.'),
    ];
    const link = new FakeModelLink({ reply: () => script.shift() ?? replyChunks('done') });
    const { result, session } = await notesAgent().run(await fakeHubAi(link), 'Notes with a given tag', { tags: ['work'] });
    expect(result).toEqual(SAVED);
    expect(session.log.map((step) => step.tool)).toEqual(['search', 'load', 'draft', 'draft', 'save']);
    expect(session.fixes).toBe(1);
    // only find's tools at first (and draft, save, load withheld); load once the search made a type known
    expect(offered(link.forwards[0])).toEqual(['search']);
    expect(offered(link.forwards[1])).toEqual(['load', 'search']);
    expect(offered(link.forwards[2])).toEqual(['draft', 'search']);
    expect(offered(link.forwards[4])).toEqual(['draft', 'save', 'search']);
    expect(JSON.stringify(link.forwards[3]?.request.messages)).toContain('There is no tag wrk.');
  });

  it('gives up past its fix cap with the last problems', async () => {
    const script = [callTool('search', { text: 'x' }), callTool('load', { name: 'Note' }), callTool('draft', { draft: { tag: 'a' } }), callTool('draft', { draft: { tag: 'b' } }), replyChunks('I could not write it.')];
    const link = new FakeModelLink({ reply: () => script.shift() ?? replyChunks('I could not write it.') });
    const failed = notesAgent(1).run(await fakeHubAi(link), 'Notes', { tags: ['work'] });
    await expect(failed).rejects.toBeInstanceOf(AuthoringError);
    await expect(failed).rejects.toMatchObject({ stage: 'fix', problems: ['There is no tag b.'] });
  });

  it('answers args that don\'t fit with the first problems at their paths, and reads a field sent as a JSON string', async () => {
    const script = [
      callTool('search', { text: 'x' }), callTool('load', { name: 'Note' }), callTool('draft', { draft: { tag: 5 } }),
      callTool('draft', { draft: JSON.stringify({ tag: 'work' }) }), callTool('save', {}), replyChunks('Saved.'),
    ];
    const link = new FakeModelLink({ reply: () => script.shift() ?? replyChunks('done') });
    const { session } = await notesAgent().run(await fakeHubAi(link), 'Notes', { tags: ['work'] });
    const told = JSON.stringify(link.forwards[3]?.request.messages);
    expect(told).toContain("the args don't fit; fix these and send the whole call again:");
    expect(told).toContain('- draft.tag: Invalid input: expected string, received number');
    // the double-encoded draft was read as its JSON, checked clean and saved
    expect(session.log.map((step) => step.tool)).toEqual(['search', 'load', 'draft', 'save']);
  });

  it('caps every model step at HARNESS_AUTHORING_MAX_TOKENS', async () => {
    const script = [callTool('search', { text: 'x' }), callTool('load', { name: 'Note' }), callTool('draft', { draft: { tag: 'work' } }), callTool('save', {}), replyChunks('Saved.')];
    const link = new FakeModelLink({ reply: () => script.shift() ?? replyChunks('done') });
    await notesAgent().run(await fakeHubAi(link), 'Notes', { tags: ['work'] });
    expect(link.forwards.length).toBeGreaterThan(4);
    // the default cap on every step, the last (after save, no tool required) too
    expect(link.forwards.map((forward) => forward.request.maxTokens)).toEqual(link.forwards.map(() => 16_000));
  });
});

describe('Disclosure', () => {
  it('keeps what was searched, seen and loaded per level', () => {
    const disclosure = new Disclosure();
    expect(disclosure.searched('fn')).toBe(false);
    disclosure.markSearched('fn');
    disclosure.markAware('type', ['A', 'B']);
    disclosure.markLoaded('type', ['A']);
    disclosure.markLoaded('table', ['orders']);
    expect(disclosure.searched('fn')).toBe(true);
    expect(disclosure.awareUnloaded('type')).toEqual(['B']);
    expect(disclosure.isLoaded('type', 'A')).toBe(true);
    expect(disclosure.loaded('table')).toEqual(['orders']);
    expect(disclosure.awareUnloaded('table')).toEqual([]);
  });
});

describe('an authoring agent handed what it builds on', () => {
  const Draft = z.object({ title: z.string().min(1) });
  type Draft = z.infer<typeof Draft>;

  it('skips find, drafts and saves with the tool names it gives', async () => {
    const source = authoringTool<object, Draft, object>({ name: 'source', stage: 'inspect', description: 'The source.', schema: z.object({}), call: () => 'owner: text, open: integer' });
    const agent = authoringAgent<object, Draft>({
      name: 'make_report', description: 'Make a report.', instructions: 'Inspect the source, draft, check, save.', tools: [source],
      stages: { find: false }, toolNames: { draft: 'report_check', save: 'report_save' },
      draft: { description: 'The report.', schema: Draft },
      check: () => Promise.resolve({ problems: [] }),
      save: () => Promise.resolve(SAVED),
    });
    const script = [callTool('source', {}), callTool('report_check', { draft: { title: 'Open by owner' } }), callTool('report_save', {}), replyChunks('Saved.')];
    const link = new FakeModelLink({ reply: () => script.shift() ?? replyChunks('done') });
    const { result, session } = await agent.run(await fakeHubAi(link), 'Open tasks by owner', {});
    expect(result).toEqual(SAVED);
    expect(offered(link.forwards[0])).toEqual(['source']);
    expect(session.log.map((step) => step.tool)).toEqual(['source', 'report_check', 'report_save']);
  });

  it('refuses find tools when it skips find', () => {
    const search = authoringTool<object, Draft, object>({ name: 'search', stage: 'find', description: 'x', schema: z.object({}), call: () => '' });
    expect(() => authoringAgent<object, Draft>({
      name: 'w', description: 'w', instructions: 'w', tools: [search], stages: { find: false },
      draft: { description: 'x', schema: Draft }, check: () => Promise.resolve({ problems: [] }), save: () => Promise.reject(new Error('no')),
    })).toThrow(/skips find/);
  });
});
