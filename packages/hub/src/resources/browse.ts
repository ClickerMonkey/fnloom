/**
 * Browsing resources: the filters of a `ResourceQuery`, and the groups (facets) the browser draws, computed in the
 * hub from one rule per grouping so groups and the folder tree never need every row in the browser.
 *
 * - **type**: the format family (`familyOf`, core's one table);
 * - **source**: the serving system, uploads, web pages by domain, or fn outputs by fn;
 * - **path**: the next folder below the one being looked at (`under`), from the URI's segments;
 * - **date**: today, yesterday, this week, this month, then by month (modified time, else when the hub saw it).
 */
import { FORMAT_FAMILIES, type FormatFamily, type ResourceFacet, type ResourceGrouping, type ResourceQuery, type ResourceRecord } from '@harness/core';
import { familyOfStat } from './rules.ts';

/** How each family is named in the browser's groups. */
export const FAMILY_LABELS: Readonly<Record<FormatFamily, string>> = {
  document: 'Documents', code: 'Code', image: 'Images', table: 'Tables', audio: 'Audio', video: 'Video', web: 'Web pages', data: 'Data',
  archive: 'Archives', folder: 'Folders', other: 'Other',
};

/** A day in milliseconds. */
const DAY = 24 * 60 * 60 * 1000;

/** Where a resource came from, as the source filter names it. */
export function sourceKind(record: ResourceRecord): NonNullable<ResourceQuery['source']> {
  return record.source?.from ?? 'system';
}

/** The folder a URI is in, below `under` (or below its root when `under` is absent), with its name; undefined for a direct child. */
function folderBelow(uri: string, under: string | undefined): { value: string; label: string } | undefined {
  const base = under ?? /^[a-z][a-z0-9+.-]*:\/\/[^/]*\//.exec(uri)?.[0] ?? '';
  if (!uri.startsWith(base)) { return undefined; }
  const rest = uri.slice(base.endsWith('/') ? base.length : base.length + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0) { return undefined; }
  const name = rest.slice(0, slash);
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return { value: `${prefix}${name}/`, label: decodeURIComponent(name) };
}

/** When a resource last changed, for the date groups. */
function timeOf(record: ResourceRecord): number {
  return record.stat.modifiedAt ?? record.seenAt;
}

/** A resource's value and label in one grouping. */
export function groupOf(record: ResourceRecord, grouping: ResourceGrouping, context: { under?: string | undefined; now: number }): { value: string; label: string } {
  switch (grouping) {
    case 'type': {
      const family = familyOfStat(record.stat);
      return { value: family, label: FAMILY_LABELS[family] };
    }
    case 'source': {
      const source = record.source;
      switch (source?.from) {
        case undefined: case 'system': return { value: `system:${record.system}`, label: record.system };
        case 'upload': return { value: 'upload', label: 'Uploads' };
        case 'web': {
          const host = new URL(source.finalUrl ?? source.url).host;
          return { value: `web:${host}`, label: host };
        }
        case 'run': return { value: `run:${source.fn}`, label: source.fn };
      }
      break;
    }
    case 'path': return folderBelow(record.stat.uri, context.under) ?? { value: '', label: 'Here' };
    case 'date': {
      const today = Math.floor(context.now / DAY);
      const day = Math.floor(timeOf(record) / DAY);
      if (day >= today) { return { value: 'today', label: 'Today' }; }
      if (day === today - 1) { return { value: 'yesterday', label: 'Yesterday' }; }
      if (day > today - 7) { return { value: 'week', label: 'This week' }; }
      const month = new Date(timeOf(record)).toISOString().slice(0, 7);
      if (month === new Date(context.now).toISOString().slice(0, 7)) { return { value: 'month', label: 'This month' }; }
      return { value: month, label: month };
    }
  }
}

/** Whether a record passes a query's filters (all but the group value, which `inGroup` checks). */
export function matches(record: ResourceRecord, query: ResourceQuery): boolean {
  const search = query.search?.trim().toLowerCase();
  if (search !== undefined && search !== '' && !`${record.stat.name}\n${record.uri}`.toLowerCase().includes(search)) { return false; }
  if (query.system !== undefined && record.system !== query.system) { return false; }
  if (query.family !== undefined && familyOfStat(record.stat) !== query.family) { return false; }
  if (query.source !== undefined && sourceKind(record) !== query.source) { return false; }
  if (query.under !== undefined && !record.uri.startsWith(query.under)) { return false; }
  const forms = record.forms ?? [];
  if (query.form !== undefined && !forms.includes(query.form)) { return false; }
  if (query.missing !== undefined && forms.includes(query.missing)) { return false; }
  return true;
}

/** Whether a record is in the query's chosen group value (always, when none is chosen). */
export function inGroup(record: ResourceRecord, query: ResourceQuery, now: number): boolean {
  return query.group === undefined || query.in === undefined || groupOf(record, query.group, { under: query.under, now }).value === query.in;
}

/** The counts of one grouping's values over some records, biggest first (families in their table order). */
export function facetsOf(records: readonly ResourceRecord[], grouping: ResourceGrouping, context: { under?: string | undefined; now: number }): ResourceFacet[] {
  const counts = new Map<string, ResourceFacet>();
  for (const record of records) {
    const { value, label } = groupOf(record, grouping, context);
    const facet = counts.get(value);
    counts.set(value, { value, label, count: (facet?.count ?? 0) + 1 });
  }
  const facets = [...counts.values()];
  if (grouping === 'type') {
    const order = (value: string) => FORMAT_FAMILIES.findIndex((family) => family === value);
    return facets.sort((a, b) => order(a.value) - order(b.value));
  }
  return facets.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
