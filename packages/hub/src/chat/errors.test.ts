import { ApiError } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import { ChatError } from './errors.ts';

describe('chat errors', () => {
  it('are ayepi API errors, so a refusal reaches the person as a 4xx with its reason, never a 500', () => {
    const error = new ChatError('unavailable', "/gollum can't be used now: memory has never connected.");
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'unavailable', name: 'ChatError', message: "/gollum can't be used now: memory has never connected." });
    expect(new ChatError('not-found', 'gone').status).toBe(404);
  });
});
