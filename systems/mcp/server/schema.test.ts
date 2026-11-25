import { describe, expect, it } from 'vitest';
import { ginOfJsonSchema } from './schema';

describe('ginOfJsonSchema', () => {
  it('an open object input takes any keys (a record of any JSON)', () => {
    for (const schema of [{ type: 'object' }, { type: 'object', additionalProperties: true }]) {
      const mapped = ginOfJsonSchema(schema, { object: true });
      expect(mapped.degraded).toBeUndefined();
      expect(mapped.def).toMatchObject({ name: 'record' });
    }
  });

  it('declared properties stay an object', () => {
    const mapped = ginOfJsonSchema({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, { object: true });
    expect(mapped.def).toMatchObject({ name: 'obj', props: { q: { type: { name: 'text' } } } });
  });
});
