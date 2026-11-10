/**
 * The random system's client renderers: Vue components for what its contract declares. Without renderers the chat
 * draws everything itself, so this can stay empty.
 */
import { client } from '@harness/sdk';
import { random } from '../shared/index.ts';

export default client(random, {
  // No renderers needed: the random fn takes numbers and returns a number, which the chat draws itself.
});
