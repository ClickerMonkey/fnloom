/**
 * `@harness/sdk/testing`: the SDK's test kit, for a system's own tests (vitest).
 *
 * - `testHub(contract, impl, options)`: the system served to a fake hub in memory; every `ctx.*` call recorded.
 * - `callFn(contract, impl, name, args)` / `kit.call(name, args)`: typed args in, the typed result, its progress and
 *   what it asked the hub for out.
 * - `mockModel([...])` (scripted, with `toolCall`) or `mockModel({ recording })` (recorded once, replayed after) for
 *   fast tests; `realModel.it(...)` for a few tests on a real free model, skipped without a key.
 * - `preview({ name, module, states })`: a component in named states, shot at phone and desktop sizes in light and
 *   dark into a gallery; `renderHtml` for a quick in-process render.
 * - `kit.kindProps(kind, payload)`: what a kind derives from a payload. `contextFolder(dir, contract)`: the context
 *   folder parses, its links resolve, and the fns each context brings.
 * - `kit.flags(fn, args)`: the sensitive files a run would touch, as the hub asks first. `kit.mentions(provider, q)`:
 *   a mention provider's options and the resource searches it made. `kit.records(type)`: the records runs saved
 *   (`ctx.data`, answered in memory by the fake hub). `scratchFolder({ git, files })`: a folder (a git repository) to
 *   run file and command fns in, for change sets and sensitive files.
 *
 * `harness test` runs a system's tests from anywhere and reports them (`SystemTestReport`).
 */
export { CallNotDone, callFn, testHub, TestSystem, type FnArgsOf, type FnNameOf, type FnResultOf, type HubCalls, type KindNameOf, type KindPayloadOf, type KindProps, type TestCall, type TestHubOptions, type TestOutcome, type TestRun } from './hub.ts';
export { ModelRecording, RecordedModelLink, liveTurn, mockModel, realModel, toolCall, type RealModelTest, type RecordingOptions, type ScriptStep } from './models.ts';
export { OpenRouterModelLink, type OpenRouterOptions } from './openrouter.ts';
export { galleryHtml, preview, renderHtml, type PreviewOptions, type SavedShot } from './preview.ts';
export { PREVIEW_INDEX, PREVIEW_THEMES, PreviewIndex, type PreviewTheme } from './shots.ts';
export { contextFolder, type OtherNames, type TestedContext } from './context.ts';
export { kitEnv } from './env.ts';
export { scratchFolder, type ScratchFolder, type ScratchOptions } from './scratch.ts';
export { FakeHub, FakeHubWidgets, FakeModelLink, HUB_WIDGET_FNS, TEST_USER, replyChunks, type FakeTableSource } from '../server/testing.ts';
export { FakeRecords, type StoredTypeDecl } from '../server/fake-records.ts';
