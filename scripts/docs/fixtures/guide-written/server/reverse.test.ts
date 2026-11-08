/** The guide-written system runs as well as compiles: served to the in-memory hub, its fn reverses text. */
import { expectType, type Equal, type Infer } from '@harness/sdk';
import { serve } from '@harness/sdk/server';
import { FakeHub } from '@harness/sdk/server/testing';
import { describe, expect, it } from 'vitest';
import { reverse } from '../shared/index.ts';
import { createImpl } from './impl.ts';

// the model's declarations carry the types the guide promises
expectType<Equal<Infer<typeof reverse.fns.reverse.args>, { text: string }>>(true);
expectType<Equal<typeof reverse.fns.reverse.name, 'reverse/reverse'>>(true);

describe('a system written from the guide alone', () => {
  it('serves and reverses text', async () => {
    const hub = new FakeHub({ config: {} });
    const running = await serve(reverse, createImpl(), { hub: 'ws://hub.test/link', state: 'unused', version: '0.1.0' }, hub.host());
    try {
      await running.ready();
      expect(await hub.run('reverse/reverse', { text: 'harness' })).toMatchObject({ status: 'done', result: 'ssenrah' });
    } finally {
      await running.stop();
    }
  });
});
