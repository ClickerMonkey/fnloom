/**
 * The widget pass's start-up migration: build 8 saved widgets as fns of the hub's own kind `hub/widget`
 * (`hub/<name>`); the widget pass moves the kind to the bundled widgets system. Each such fn becomes `widgets/<name>`
 * of kind `widgets/widget` with its payload upgraded (`upgradeWidgetSpec`), its version history, owner and sharing kept.
 * It runs at every start before the catalog imports anything, whether or not the widgets system is paired yet: the fn
 * is stored with an open signature (`any`), which the widgets kind describes when the system connects, and is
 * unavailable until then. A store with none left does nothing.
 */
import type { Logger } from '@ayepi/log';
import {
  accessKey, itemVersionId, Json, jsonOf, qualify, scopeReads, splitName, SystemName, upgradeWidgetSpec, WIDGET_KIND, WIDGET_KIND_V1, WIDGETS_SYSTEM, WidgetSpecV1,
  type FnDecl, type FnRecord, type QualifiedName,
} from '@harness/core';
import { canonicalJson, sha256 } from '@harness/sdk';
import { unavailable } from '../catalog/availability.ts';
import type { HubStore } from '../store/index.ts';
import { allRows } from '../store/rows.ts';

/** An open signature: the kind works out the real one from the payload. */
const OPEN = { name: 'any' } as const;

/** A build 8 widget fn's declaration as the widget pass's, or undefined when its payload is not a build 8 spec. */
export function upgradedWidgetDecl(decl: FnDecl): FnDecl | undefined {
  const spec = WidgetSpecV1.safeParse(decl.payload);
  if (!spec.success) { return undefined; }
  const upgraded = upgradeWidgetSpec(spec.data);
  return { ...decl, kind: WIDGET_KIND, payload: jsonOf(upgraded), args: OPEN, returns: OPEN, deps: [upgraded.source] };
}

/** Move every `hub/widget` fn to the widgets system. Returns how many moved. */
export async function migrateWidgets(store: HubStore, log: Logger): Promise<number> {
  // the fns of the old kind, from the links the catalog keeps (an index read, not a scan of every fn)
  const links = await allRows(store.table('fnLinks'), { where: { to: WIDGET_KIND_V1, link: 'kind' } });
  let moved = 0;
  for (const link of links) {
    const from = link.fn;
    const old = await store.table('fns').get(from);
    const decl = old === undefined || old.decl.kind !== WIDGET_KIND_V1 ? undefined : upgradedWidgetDecl(old.decl);
    if (old === undefined || decl === undefined) {
      log.warn('tables.widgets.migrate.skipped', { fn: from, reason: old === undefined ? 'no such fn' : 'not a build 8 widget spec' });
      continue;
    }
    const to = qualify(SystemName.parse(WIDGETS_SYSTEM), splitName(from).local);
    if ((await store.table('fns').get(to)) !== undefined) {
      log.warn('tables.widgets.migrate.skipped', { fn: from, reason: `${to} is taken` });
      continue;
    }
    await store.tx(async (tx) => { await moveWidget(tx, old, to, decl); });
    await forgetSearchEntries(store, from);
    moved += 1;
  }
  if (moved > 0) { log.info('tables.widgets.migrated', { moved }); }
  return moved;
}

/** Move one widget fn, with its index rows, versions and sharing, inside a transaction. */
async function moveWidget(tx: HubStore, old: FnRecord, to: QualifiedName, decl: FnDecl): Promise<void> {
  const system = SystemName.parse(WIDGETS_SYSTEM);
  const fns = tx.table('fns');
  await fns.put({
    ...old, name: to, system, decl, version: await sha256(canonicalJson(Json.parse(decl))),
    available: unavailable('system-disconnected', `${system} has not connected since the widget moved to it`),
  });
  await fns.remove(old.name);
  // index rows: its kind and source now, and no signature types until its kind describes it
  for (const row of await allRows(tx.table('fnLinks'), { where: { fn: old.name } })) { await tx.table('fnLinks').remove({ fn: row.fn, to: row.to, link: row.link }); }
  for (const row of await allRows(tx.table('fnSignatureTypes'), { where: { fn: old.name } })) { await tx.table('fnSignatureTypes').remove({ fn: row.fn, type: row.type }); }
  await tx.table('fnLinks').putAll([{ fn: to, to: WIDGET_KIND, link: 'kind', system }, ...decl.deps.map((dep) => ({ fn: to, to: dep, link: 'dep' as const, system }))]);
  // its facts are worked out again under the new name
  await tx.table('fnFacts').remove(old.name);
  for (const row of await allRows(tx.table('fnTypes'), { where: { fn: old.name } })) { await tx.table('fnTypes').remove({ fn: row.fn, type: row.type, use: row.use }); }
  for (const row of await allRows(tx.table('fnUses'), { where: { fn: old.name } })) { await tx.table('fnUses').remove({ fn: row.fn, uses: row.uses }); }
  // its history, each version upgraded where it parses
  const versions = await allRows(tx.table('itemVersions'), { where: { system: old.system, section: 'fns', name: old.name } });
  for (const version of versions) {
    const parsed = WidgetSpecV1.safeParse(typeof version.decl === 'object' && version.decl !== null && !Array.isArray(version.decl) ? version.decl['payload'] : undefined);
    const versionDecl = parsed.success && typeof version.decl === 'object' && version.decl !== null && !Array.isArray(version.decl)
      ? jsonOf({ ...version.decl, kind: WIDGET_KIND, payload: upgradeWidgetSpec(parsed.data) })
      : version.decl;
    await tx.table('itemVersions').put({
      ...version, id: itemVersionId(system, 'fns', to, version.number), system, name: to, decl: versionDecl, hash: await sha256(canonicalJson(versionDecl)),
    });
    await tx.table('itemVersions').remove(version.id);
  }
  // its owner and who it is shared with
  const access = await tx.table('access').get(accessKey({ kind: 'fn', fn: old.name }));
  if (access !== undefined) {
    const target = { kind: 'fn' as const, fn: to };
    await tx.table('access').put({ ...access, key: accessKey(target), target, scoped: scopeReads({ target, sharing: access.sharing }) });
    await tx.table('access').remove(access.key);
  }
}

/**
 * Drop the old name's search entries (its index rows, text and vectors under every embedder), so a search no longer
 * lists a fn that is gone; the widgets system's are written when it connects and its contract is indexed.
 */
async function forgetSearchEntries(store: HubStore, name: QualifiedName): Promise<void> {
  const rows = await allRows(store.table('index'), { where: { kind: 'fn', key: name } });
  for (const row of rows) {
    await store.table('index').remove({ embedder: row.embedder, kind: row.kind, key: row.key });
    await store.vectors.remove(row.embedder, 'fn', [name]);
  }
  await store.text.remove('fn', [name]);
}
