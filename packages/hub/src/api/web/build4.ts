/**
 * Build 4's web slices: visibility (`accessSlice`), per-person connections (`connectionsSlice`) and pickers
 * (`pickerSlice`). Stubs from the design lane that answer 501; the hub lane replaces this file freely.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { accessSlice, connectionsSlice, pickerSlice } from '@harness/core';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** Refuse a build 4 endpoint the hub lane has not served yet. */
const notYet = (): never => { throw reject(501, 'NOT_YET', 'not served yet (build 4, hub lane)'); };

/** The build 4 plugins. Require the systems plugin, which binds `hubAuth`. */
export function build4Plugins(systems: ReturnType<typeof systemsPlugin>) {
  return [
    plugin({ name: 'web.access', spec: accessSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof accessSlice> => ({ accessInfo: notYet, access: notYet, setAccess: notYet })),
    plugin({ name: 'web.connections', spec: connectionsSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof connectionsSlice> => ({ connectPages: notYet, connect: notYet, updateConnection: notYet, disconnect: notYet })),
    plugin({ name: 'web.picker', spec: pickerSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof pickerSlice> => ({ pick: notYet })),
  ] as const;
}
