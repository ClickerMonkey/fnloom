/**
 * Moving build 1's single-instance facts off system rows: a system row that still carries a key (`LegacyInstanceFields`)
 * gets a `main` instance with that key, config and history, and the legacy fields are cleared, so a hub upgraded
 * from build 1 keeps every pairing. Runs once per start, before systems connect; a row already moved is left alone.
 * This is the one reader of those fields.
 */
import type { Logger } from '@ayepi/log';
import { MAIN_INSTANCE, type InstanceRecord, type SystemRecord } from '@harness/core';
import { allRows } from '../catalog/rows.ts';
import type { HubStore } from '../store/index.ts';

/** A system row split into its build 1 instance fields and the rest. */
function split(record: SystemRecord) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the migration is the one reader of the build 1 fields it moves
  const { keyFingerprint, publicKey, config, pairedAt, pairedBy, lastSeenAt, address, ...system } = record;
  return { legacy: { keyFingerprint, publicKey, config, pairedAt, pairedBy, lastSeenAt, address }, system };
}

/** Give every system row that still holds a key its `main` instance. Returns how many were moved. */
export async function migrateLegacyInstances(store: HubStore, log: Logger): Promise<number> {
  let moved = 0;
  for (const row of await allRows(store.table('systems'))) {
    const { legacy, system } = split(row);
    const { keyFingerprint, publicKey, config, pairedAt, pairedBy, lastSeenAt, address } = legacy;
    if (keyFingerprint === undefined || publicKey === undefined) { continue; }
    const ref = { system: system.name, instance: MAIN_INSTANCE };
    if (await store.table('instances').get(ref) === undefined) {
      const instance: InstanceRecord = {
        ...ref, description: '', status: system.status === 'removed' ? 'removed' : 'disconnected', keyFingerprint, publicKey,
        version: system.version, manifestHash: system.manifestHash,
        ...(config === undefined ? {} : { config }),
        ...(pairedAt === undefined ? {} : { pairedAt }),
        ...(pairedBy === undefined ? {} : { pairedBy }),
        ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
        ...(address === undefined ? {} : { address }),
      };
      await store.table('instances').put(instance);
    }
    await store.table('systems').put({ ...system, status: system.status === 'removed' ? 'removed' : 'disconnected' });
    moved += 1;
  }
  if (moved > 0) { log.info('link.instances.migrated', { systems: moved }); }
  return moved;
}
