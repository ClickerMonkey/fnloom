/** Kinds describe their fns on their own system: the hub asks it over the link (`check`). */
import { splitName, type Json, type KindDescription, type QualifiedName } from '@harness/core';
import type { KindDescriber } from '../catalog/index.ts';
import type { LinkService } from './index.ts';

/** Thrown when the system a kind belongs to isn't connected, so nothing can describe its fns now. */
export class KindUnreachable extends Error {
  override readonly name = 'KindUnreachable';
}

/** Asks the connected system that defines a kind to check and describe a payload. */
export class LinkKindDescriber implements KindDescriber {
  readonly #links: LinkService;

  constructor(links: LinkService) {
    this.#links = links;
  }

  async describe(kind: QualifiedName, payload: Json): Promise<{ problems: string[]; description?: KindDescription | undefined }> {
    const { system, local } = splitName(kind);
    const connection = this.#links.connected().find((c) => c.system === system);
    if (connection === undefined) { throw new KindUnreachable(`${system} is not connected, so ${kind} can't describe a payload`); }
    return connection.peer.call('check', { kind: local, payload });
  }
}
