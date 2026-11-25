/**
 * What the code authoring agent is shown must be what it may send. Every example program in `examples` (CODE_GUIDE)
 * and the instructions parses against the Expr schema its `set` tool is sent (gin's grammar over the session's registry, `newStrict`), in the code shape and
 * through OpenAI's strict wire shape (encoded, then decoded back),
 * each example signature against the TypeDef schema `signature` is sent, and each program checks clean against its
 * signature, so a model that copies an example is never refused for the example's own shape.
 */
import { buildSchemas } from '@aeye/gin';
import { LENIENT, OPENAI_STRICT, type Bound } from '@aeye/schema';
import { GinExprDef, QualifiedName } from '@harness/core';
import { checkProgram, PROGRAM_GRAMMAR, ProgramScope } from '@harness/sdk/program';
import { describe, expect, it } from 'vitest';
import { CODE_EXAMPLES, CodeDraftSchema, SET_EXAMPLE } from './authoring.ts';

/** Whether a value fits a bound schema as code holds it, and once encoded for a strict model and decoded back. */
function fits<T>(bound: Bound<T>, value: unknown): boolean {
  if (!bound.render(LENIENT).parse(value, { inPlace: false }).ok) return false;
  const strict = bound.render(OPENAI_STRICT);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- it fit as code holds it, just above
  return strict.parse(strict.encode(value as T)).ok;
}

/** The tickets fn example 3 calls, as the agent would have loaded it. */
const STATUS_FN = { name: QualifiedName.parse('tickets/status'), description: 'The status of a ticket.', args: { name: 'obj', props: { ticket: { type: { name: 'text' } } } }, returns: { name: 'obj', props: { summary: { type: { name: 'text' } } } }, mode: 'read' as const };

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
      program.addFn(STATUS_FN);
      const { Expr, Type } = buildSchemas(program.registry(), PROGRAM_GRAMMAR);
      expect(fits(Expr, example.program), 'program fits the set tool schema').toBe(true);
      expect(fits(Type, example.signature.args), 'args fit the signature tool schema').toBe(true);
      expect(fits(Type, example.signature.returns), 'returns fit the signature tool schema').toBe(true);
      expect(checkProgram(program, GinExprDef.parse(example.program), { args: example.signature.args, returns: example.signature.returns }).problems).toEqual([]);
    });
  }
});

describe('the set call the instructions show', () => {
  it('is one `draft` arg holding every part, its program fitting the set schema and its sample every arg', () => {
    const program = new ProgramScope();
    expect(Object.keys(SET_EXAMPLE)).toEqual(['draft']);
    expect(Object.keys(SET_EXAMPLE.draft).sort()).toEqual(['description', 'name', 'program', 'sample']);
    expect(fits(CodeDraftSchema.bind(...program.grammar()), SET_EXAMPLE.draft)).toBe(true);
    expect(fits(CodeDraftSchema.bind(...program.grammar()), { ...SET_EXAMPLE.draft, program: { kind: 'nope' } }), 'a program of no kind is refused').toBe(false);
    expect(Object.keys(SET_EXAMPLE.draft.sample).sort()).toEqual(Object.keys(CODE_EXAMPLES.priceWithTax.signature.args.props).sort());
  });
});
