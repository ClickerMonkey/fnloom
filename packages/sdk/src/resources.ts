/** How a system serves resources. Built on `@aeye/resources` parsers where they fit. */
import type { Page, ReadWant, ResourceChange, ResourceRead, ResourceRoot, ResourceStat, ResourceUri } from '@harness/core';

/** A system's resource service: its roots, and listing, stat, reading and watching under them. */
export interface ResourceProvider {
  roots(): Promise<ResourceRoot[]>;
  list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>>;
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  /** A read. It may include more than was asked for if it had it anyway. */
  read(uri: ResourceUri, want: ReadWant[]): Promise<ResourceRead>;
  /** Report changes until the returned function is called. */
  watch?(uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void;
}
