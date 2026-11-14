/**
 * What the api authoring agent is shown must be what it may send. Every example request and output program in
 * `examples` (API_GUIDE) parses against the strict Expr schema its `set` tool is sent (gin's `buildSchemas`,
 * `newStrict`, with the api's own types), each example signature against the TypeDef schema, and each example passes
 * the api's own check (a literal method, one body slot, both programs typed), so a model that copies an example is
 * never refused for the example's own shape.
 */
import { ApiFnSpec } from '@harness/core';
import { ProgramScope } from '@harness/sdk/program';
import { describe, expect, it } from 'vitest';
import { HTTP_TYPES } from '../shared/index.ts';
import { API_EXAMPLES } from './authoring.ts';
import { checkApi } from './program.ts';

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
      const { Expr, Type } = program.schemas();
      expect(Expr.safeParse(example.spec.request).success, 'request fits the set tool schema').toBe(true);
      if ('output' in example.spec) expect(Expr.safeParse(example.spec.output).success, 'output fits the set tool schema').toBe(true);
      expect(Type.safeParse(example.spec.args).success, 'args fit the signature tool schema').toBe(true);
      expect(Type.safeParse(example.spec.returns).success, 'returns fit the signature tool schema').toBe(true);
      expect(checkApi(program, ApiFnSpec.parse({ service: 'tracker', ...example.spec })).problems).toEqual([]);
    });
  }
});
