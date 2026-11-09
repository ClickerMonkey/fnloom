/**
 * Build 5's web slices: approvals by run (`approvalsSlice`) and registry contributions (`registriesSlice`). Stubs from
 * the design lane that answer 501; the hub lane replaces this file freely.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { approvalsSlice, registriesSlice } from '@harness/core';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** Refuse a build 5 endpoint the hub lane has not served yet. */
const notYet = (): never => { throw reject(501, 'NOT_YET', 'not served yet (build 5, hub lane)'); };

/** The build 5 plugins. Require the systems plugin, which binds `hubAuth`. */
export function build5Plugins(systems: ReturnType<typeof systemsPlugin>) {
  return [
    plugin({ name: 'web.approvals', spec: approvalsSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof approvalsSlice> => ({ approvals: notYet })),
    plugin({ name: 'web.registries', spec: registriesSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof registriesSlice> => ({ contributions: notYet })),
  ] as const;
}
