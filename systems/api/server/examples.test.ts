/**
 * What the api authoring agent is shown must be what it may send. Every example request and output program in
 * `examples` (API_GUIDE) parses against the Expr schema its `set` tool is sent (gin's grammar over the session's
 * registry, `newStrict`, with the api's own types), in the code shape and through OpenAI's strict wire shape, each example signature against the TypeDef schema, and each example passes
 * the api's own check (a literal method, one body slot, both programs typed), so a model that copies an example is
 * never refused for the example's own shape.
 */
import { buildSchemas } from '@aeye/gin';
import { LENIENT, OPENAI_STRICT, type Bound } from '@aeye/schema';
import { ApiFnSpec } from '@harness/core';
import { PROGRAM_GRAMMAR, ProgramScope } from '@harness/sdk/program';
import { describe, expect, it } from 'vitest';
import { HTTP_TYPES } from '../shared/index.ts';
import { API_EXAMPLES, ApiDraftSchema, SET_EXAMPLE } from './authoring.ts';
import { checkApi } from './program.ts';

/** Whether a value fits a bound schema as code holds it, and once encoded for a strict model and decoded back. */
function fits<T>(bound: Bound<T>, value: unknown): boolean {
  if (!bound.render(LENIENT).parse(value, { inPlace: false }).ok) return false;
  const strict = bound.render(OPENAI_STRICT);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- it fit as code holds it, just above
  return strict.parse(strict.encode(value as T)).ok;
}

const text = { name: 'text' } as const;
const OWNER_REPO = { name: 'obj', props: { owner: { type: text }, repo: { type: text } } };

/** Each example with the signature it was written for (the POST adds a title; its result is obj{number}). */
const examples = [
  { name: 'repo', spec: { args: API_EXAMPLES.repo.signature.args, returns: API_EXAMPLES.repo.signature.returns, request: API_EXAMPLES.repo.request, responseType: API_EXAMPLES.repo.responseType, output: API_EXAMPLES.repo.output } },
  { name: 'openIssues', spec: { args: API_EXAMPLES.openIssues.signature.args, returns: API_EXAMPLES.openIssues.signature.returns, request: API_EXAMPLES.openIssues.request } },
  { name: 'createIssue', spec: { args: { name: 'obj', props: { ...OWNER_REPO.props, title: { type: text } } }, returns: { name: 'obj', props: { number: { type: { name: 'num' } } } }, request: API_EXAMPLES.createIssue.request } },
];

describe('the api examples the agent is shown', () => {
  for (const example of examples) {
    it(`${example.name} fits the schemas the tools are sent and passes the api check`, () => {
      const program = new ProgramScope();
      program.addOwn(HTTP_TYPES.map((name) => `api/${name}`));
      const { Expr, Type } = buildSchemas(program.registry(), PROGRAM_GRAMMAR);
      expect(fits(Expr, example.spec.request), 'request fits the set tool schema').toBe(true);
      if ('output' in example.spec) expect(fits(Expr, example.spec.output), 'output fits the set tool schema').toBe(true);
      expect(fits(Type, example.spec.args), 'args fit the signature tool schema').toBe(true);
      expect(fits(Type, example.spec.returns), 'returns fit the signature tool schema').toBe(true);
      expect(checkApi(program, ApiFnSpec.parse({ service: 'tracker', ...example.spec })).problems).toEqual([]);
    });
  }
});

describe('the set call the instructions show', () => {
  it('is one `draft` arg holding every part, its request fitting the set schema and its sample every arg', () => {
    const program = new ProgramScope();
    program.addOwn(HTTP_TYPES.map((name) => `api/${name}`));
    expect(Object.keys(SET_EXAMPLE)).toEqual(['draft']);
    expect(fits(ApiDraftSchema.bind(...program.grammar()), SET_EXAMPLE.draft)).toBe(true);
    expect(Object.keys(SET_EXAMPLE.draft.sample).sort()).toEqual(Object.keys(API_EXAMPLES.openIssues.signature.args.props).sort());
  });
});
