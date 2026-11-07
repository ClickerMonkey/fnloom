/**
 * Reading through the store's bounded, paged reads (`Table.find`). The api and boot code read every matching row
 * with `collect`, or stop at the first match with `first`, instead of writing the cursor loop again.
 */

/** Reads one page from a cursor (undefined for the first page). */
export type PageReader<T> = (cursor: string | undefined) => Promise<{ items: T[]; cursor?: string | undefined }>;

/** How many rows a read takes at once when the caller doesn't say. */
export const PAGE = 100;

/** Every row of a paged read, up to `max` (reads stay bounded). */
export async function collect<T>(read: PageReader<T>, max = 10_000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined && out.length < max);
  return out.slice(0, max);
}

/** The first row of a paged read that matches, reading no further pages once one does. */
export async function first<T, U extends T>(read: PageReader<T>, match: (item: T) => item is U): Promise<U | undefined>;
export async function first<T>(read: PageReader<T>, match: (item: T) => boolean): Promise<T | undefined>;
export async function first<T>(read: PageReader<T>, match: (item: T) => boolean): Promise<T | undefined> {
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    const found = page.items.find(match);
    if (found !== undefined) { return found; }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return undefined;
}
