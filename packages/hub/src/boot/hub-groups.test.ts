import { hub, manifestOf } from '@harness/sdk';
import { GENERAL_GROUP } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { hubGroupOf, withHubGroups } from './hub-groups.ts';

describe('the hub\'s API groups', () => {
  it('put every hub fn in a described group', async () => {
    const manifest = withHubGroups(await manifestOf(hub, { version: '1.0.0' }));
    const ungrouped = manifest.fns.filter((fn) => fn.group === GENERAL_GROUP).map((fn) => fn.name);
    expect(ungrouped).toEqual([]);
    const described = new Set(manifest.groups?.map((group) => group.name));
    expect(manifest.fns.every((fn) => fn.group !== undefined && described.has(fn.group))).toBe(true);
    expect(hubGroupOf('item_versions')).toBe('catalog');
  });
});
