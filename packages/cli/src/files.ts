/**
 * The file system as commands see it: `@harness/build`'s files, so commands and builds share one disk (`NodeFiles`)
 * and one fake (`MemoryFiles` in `testing.ts`).
 */
export { NodeFiles, type BuildFiles as CliFiles, type FileStat } from '@harness/build';
