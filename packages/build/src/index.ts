/**
 * `@harness/build`: building systems, shared by the CLI (`harness system build` / `pack`) and fs (`install_system`).
 *
 * - `buildSystem(dir, { builder, files }, options)`: typecheck, the contract's name, the context folder check, a
 *   self-contained server bundle, client renderers, `dist/system.json`, and the bundle's scan.
 * - `checkContextFolder(dir, known)`: every context file's header, key and link, and `imports` cycles, with file and line.
 * - `scanBundle(code)`: the built-ins, computed imports, `eval`, `new Function` and URLs a bundle holds.
 * - `runSystemTests(dir, files, options)`: the folder's own tests (the SDK test kit) as a `SystemTestReport`.
 * - `ViteBuilder` (`SystemBuilder`), `NodeFiles` (`BuildFiles`) and the system folder's layout (`DIST`, `BUILT`, …).
 */
export {
  BUILD_ONLY_MODULES, ContractError, ViteBuilder, isExternal, summaryOf, summaryOfManifest,
  type ContractSummary, type ManifestsOptions, type SystemBuilder, type ViteBuilderOptions,
} from './builder.ts';
export { BuiltContract, CONTRACT_ENTRY, CONTRACT_FILE, buildSystem, requiredNames, type BuildDeps, type CatalogLookup, type KnownToBuild, type BuildOptions, type BuildRefused, type BuildResult, type Built } from './build-system.ts';
export { checkContextFolder, type CheckedContext, type KnownNames } from './context.ts';
export { NodeFiles, type BuildFiles, type FileStat } from './files.ts';
export { BUILT, DIST, FolderError, NOT_SOURCE, builtManifest, isStale, readSystemJson } from './folder.ts';
export { RISKY_BUILTINS, SCAN_CONCERNS, ScanConcern, ScanConcernKind, ScanReport, scanBundle } from './scan.ts';
export { PREVIEW_DIR, VitestRunner, runSystemTests, type SystemTestRunner, type TestRunOptions } from './tests.ts';
