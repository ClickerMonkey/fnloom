/**
 * What the code authoring agent is shown must be what it may send. Every example program in `examples` (CODE_GUIDE)
 * and the instructions parses against the strict Expr schema its `set` tool is sent (gin's `buildSchemas`, `newStrict`),
 * each example signature against the TypeDef schema `signature` is sent, and each program checks clean against its
 * signature, so a model that copies an example is never refused for the example's own shape.
 */
import { GinExprDef, QualifiedName } from '@harness/core';
import { checkProgram, ProgramScope } from '@harness/sdk/program';
import { describe, expect, it } from 'vitest';
import { CODE_EXAMPLES } from './authoring.ts';

/** The weather fn example 3 calls, as the agent would have loaded it. */
const FORECAST = { name: QualifiedName.parse('weather/forecast'), description: 'The forecast for a city.', args: { name: 'obj', props: { city: { type: { name: 'text' } } } }, returns: { name: 'obj', props: { summary: { type: { name: 'text' } } } }, mode: 'read' as const };

/** Each example's program and signature (example 3 reads like example 1's args). */
const examples = [
  { name: 'priceWithTax', program: CODE_EXAMPLES.priceWithTax.program, signature: CODE_EXAMPLES.priceWithTax.signature },
  { name: 'withLocal', program: CODE_EXAMPLES.withLocal.program, signature: CODE_EXAMPLES.withLocal.signature },
  { name: 'callsFn', program: CODE_EXAMPLES.callsFn.program, signature: CODE_EXAMPLES.callsFn.signature },
];

describe('the code examples the agent is shown', () => {
  for (const example of examples) {
    it(`${example.name} fits the schemas the tools are sent and checks clean`, () => {
      const program = new ProgramScope();
      program.addFn(FORECAST);
      const { Expr, Type } = program.schemas();
      expect(Expr.safeParse(example.program).success, 'program fits the set tool schema').toBe(true);
      expect(Type.safeParse(example.signature.args).success, 'args fit the signature tool schema').toBe(true);
      expect(Type.safeParse(example.signature.returns).success, 'returns fit the signature tool schema').toBe(true);
      expect(checkProgram(program, GinExprDef.parse(example.program), { args: example.signature.args, returns: example.signature.returns }).problems).toEqual([]);
    });
  }
});
