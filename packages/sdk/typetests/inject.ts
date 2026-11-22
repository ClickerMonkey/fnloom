// Compile-time proof for injected context: an item's `inject.into` takes agents' refs (only `hub/llm` fns fit) and
// patterns (strings holding `*`), the `agents` helpers build patterns from refs, a hook says what its block means, and
// an agent says how it takes its injected section. Nothing here runs: `npm run typecheck` fails if an expectation
// breaks, and every `@ts-expect-error` marks a mistake that must not compile.

import { agent, agents, context, expectType, fn, g, hook, hub, system, type AgentPattern, type AgentRef, type AgentTarget, type Equal, type LlmPayload } from '@harness/sdk';

const support = system('support', { description: 'Support tickets.' }).with({
  fns: { triage: agent({ description: 'Sorts a ticket.', args: g.obj({ ticket: g.text() }), returns: g.text(), instructions: 'You sort tickets.' }) },
});

const crm = system('crm', { description: 'Customers.' })
  .with({
    fns: {
      lookup: fn({ description: 'Find a customer.', args: g.obj({ name: g.text() }), returns: g.text() }),
      reviewer: agent({ description: 'Reviews a deal.', args: g.obj({ deal: g.text() }), returns: g.text(), instructions: 'You review deals.\n\n{{injectedContext}}', injected: { maxTokens: 1500 } }),
      summarizer: agent({ description: 'Sums up a deal.', args: g.obj({ deal: g.text() }), returns: g.text(), instructions: 'You sum up deals.', injected: { detail: 'summary', maxTokens: 600 } }),
      quiet: agent({ description: 'Takes nothing injected.', args: g.obj({}), returns: g.text(), instructions: 'You answer briefly.', injected: 'none' }),
    },
  })
  .with(({ fns }) => ({
    context: {
      // refs, patterns built from refs, and plain pattern strings, with order, requires and mode
      deals: context({
        title: 'Deals',
        description: 'How deals are reviewed.',
        content: `Look a customer up with ${fns.lookup.name} first.`,
        fns: [fns.lookup],
        inject: { into: [fns.reviewer, agents.startingWith(hub.fns.chat), agents.of(support), support.fns.triage, 'billing/*', '*/review*'], order: 40, requires: [fns.lookup], mode: 'tools' },
      }),
      everyone: context({ description: 'Said to every agent.', content: 'Be brief.', inject: { into: [agents.all] } }),
    },
    hooks: {
      stage: hook({ description: 'Adds the deal stage.', explains: 'The deal\'s stage: lead, open or won. Mention it only when it matters.', order: 50 }),
    },
  }));

// an agent's ref is an AgentRef; a plain fn's is not
expectType<Equal<typeof crm.fns.reviewer.kind, 'hub/llm'>>(true);
expectType<Equal<typeof hub.fns.chat.kind, 'hub/llm'>>(true);
const reviewer: AgentRef = crm.fns.reviewer;
void reviewer;

// the helpers' patterns are typed by the names they come from
expectType<Equal<ReturnType<typeof agents.startingWith<'hub/chat'>>, 'hub/chat*'>>(true);
const ofCrm = agents.of(crm);
expectType<Equal<typeof ofCrm, 'crm/*'>>(true);
expectType<Equal<typeof support.fns.triage.kind, 'hub/llm'>>(true);
expectType<Equal<typeof agents.all, '*'>>(true);

// patterns hold a `*`
const pattern: AgentPattern = 'hub/chat*';
const target: AgentTarget = '*';
void pattern;
void target;
// @ts-expect-error a target without `*` is a string, not a pattern: name one agent by its ref
const exact: AgentPattern = 'crm/reviewer';
void exact;

// @ts-expect-error a target without `*` as a string doesn't compile
context({ description: 'Wrong.', content: 'x', inject: { into: ['crm/reviewer'] } });
// @ts-expect-error a plain fn's ref is not an agent, so it can't be a target
context({ description: 'Wrong.', content: 'x', inject: { into: [crm.fns.lookup] } });
// @ts-expect-error a context ref is not an agent either
context({ description: 'Wrong.', content: 'x', inject: { into: [crm.context.deals] } });
// @ts-expect-error at least one target
context({ description: 'Wrong.', content: 'x', inject: { into: [] } });
// @ts-expect-error a mode is tools or static
context({ description: 'Wrong.', content: 'x', inject: { into: ['*'], mode: 'graph' } });
// @ts-expect-error requires takes fn refs, not names
context({ description: 'Wrong.', content: 'x', inject: { into: ['*'], requires: ['crm/lookup'] } });
// @ts-expect-error a plain fn's ref is not an agent for startingWith
agents.startingWith(crm.fns.lookup);
// @ts-expect-error agents.of takes a system, not a fn
agents.of(crm.fns.reviewer);

// an agent's injected section: a detail and a cap, or none
// @ts-expect-error a detail is full or summary
agent({ description: 'x', args: g.obj({}), returns: g.text(), instructions: 'x', injected: { detail: 'brief' } });
expectType<Equal<LlmPayload['injected'], 'none' | { detail?: 'full' | 'summary' | undefined; maxTokens?: number | undefined } | undefined>>(true);

// a hook's explains is text
// @ts-expect-error explains is text
hook({ description: 'x', explains: 42 });
