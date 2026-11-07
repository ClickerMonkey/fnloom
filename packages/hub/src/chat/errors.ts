/** The errors chat services throw, each with a stable code the web API maps to a status. */

import { messageOf } from '@harness/core';

/** Why a chat request was refused. */
export const CHAT_ERROR_CODES = {
  /** No such session, message, turn, run or delivery, or the asker can't see it. */
  'not-found': 404,
  /** The asker may see it but not do this (only the owner can change a session). */
  forbidden: 403,
  /** The request doesn't fit: a bad mention target, an undeclared state field, a value of the wrong type. */
  invalid: 422,
  /** It can't be done in the current state: undoing a running turn, a reply into another session. */
  conflict: 409,
  /** What it needs isn't there now: a disabled system, a provider that isn't connected. */
  unavailable: 503,
} as const;

/** A chat error code. */
export type ChatErrorCode = keyof typeof CHAT_ERROR_CODES;

/** A refused chat request. `status` is the HTTP status the web API answers with, typed by the code. */
export class ChatError<C extends ChatErrorCode = ChatErrorCode> extends Error {
  override readonly name = 'ChatError';
  readonly code: C;
  readonly status: (typeof CHAT_ERROR_CODES)[C];

  constructor(code: C, message: string) {
    super(message);
    this.code = code;
    this.status = CHAT_ERROR_CODES[code];
  }
}

/** The message of anything thrown (one definition, in `@harness/core`). */
export { messageOf };
