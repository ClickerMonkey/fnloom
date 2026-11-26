/** How a system serves resources. Built on `@aeye/resources` parsers where they fit. */
import type { ContentRef, Page, ReadWant, ResourceChange, ResourceRead, ResourceRoot, ResourceStat, ResourceUri } from '@harness/core';

/**
 * A read as a provider makes it: a `ResourceRead`, except that its bytes may be the bytes themselves (`data` and their
 * `mime`). The SDK holds those for the hub to fetch and sends their ref, so a provider never handles content refs.
 */
export type ProvidedRead = Omit<ResourceRead, 'bytes'> & { readonly bytes?: ContentRef | ProvidedBytes | undefined };

/** A file's bytes as a provider hands them over, with their media type. */
export interface ProvidedBytes {
  readonly data: Uint8Array;
  readonly mime: string;
}

/** A system's resource service: its roots, and listing, stat, reading and watching under them. */
export interface ResourceProvider {
  roots(): Promise<ResourceRoot[]>;
  list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>>;
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  /**
   * A read. It may include more than was asked for if it had it anyway. Content that isn't text (a picture, a pdf, a
   * recording) goes as its bytes, so the hub reads it the way its kind needs; text goes as text.
   */
  read(uri: ResourceUri, want: ReadWant[]): Promise<ProvidedRead>;
  /** Report changes until the returned function is called. */
  watch?(uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void;
}
