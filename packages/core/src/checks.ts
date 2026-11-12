/**
 * What is checked about a system before it runs and before it goes live: the scan of its built server bundle
 * (moved here from `@harness/build`, which still makes it), the result of its own tests (`harness test`, the SDK test
 * kit) and its component previews. `fs/install_system` puts them on the install card (`InstallSubject.checks`), and the
 * review page shows them (`SystemReview.checks`).
 */
import { z } from 'zod';
import { Duration, SystemName, Timestamp } from './primitives.ts';
import { ContentRef } from './resources.ts';

// ─── The bundle scan ──────────────────────────────────────────────────────────

/** What a line of concern is. */
export const SCAN_CONCERNS = ['builtin', 'dynamic-import', 'dynamic-require', 'eval', 'new-function'] as const;
export const ScanConcernKind = z.enum(SCAN_CONCERNS);
export type ScanConcernKind = z.infer<typeof ScanConcernKind>;

/** One line of concern: what it is, the line (1-based) and the code on it, cut short. */
export const ScanConcern = z.object({ kind: ScanConcernKind, line: z.number().int().min(1), detail: z.string(), code: z.string() });
export type ScanConcern = z.infer<typeof ScanConcern>;

/** What the scan found in a bundle. */
export const ScanReport = z.object({
  /** The bundle's size in bytes. */
  size: z.number().int().min(0),
  /** Every Node built-in it imports or requires, without the `node:` prefix, sorted. */
  builtins: z.array(z.string()),
  /** The risky built-ins, non-literal imports and requires, `eval` and `new Function`, in bundle order. */
  concerns: z.array(ScanConcern),
  /** Literal http(s) URLs in it, sorted, and their hosts. */
  urls: z.array(z.string()),
  hosts: z.array(z.string()),
});
export type ScanReport = z.infer<typeof ScanReport>;

// ─── A system's own tests ─────────────────────────────────────────────────────

/** How one test ended. `skipped` covers real-model tests run without keys. */
export const TestStatus = z.enum(['passed', 'failed', 'skipped']);
export type TestStatus = z.infer<typeof TestStatus>;

/** One test: its file, its full name, how it ended and, when it failed, the first lines of why. */
export const TestCase = z.object({
  file: z.string().min(1),
  name: z.string().min(1),
  status: TestStatus,
  duration: Duration,
  /** Marked as calling a real model (`kit.real`): run only with keys, never in the quick tier. */
  real: z.boolean().optional(),
  error: z.string().max(4000).optional(),
});
export type TestCase = z.infer<typeof TestCase>;

/** The viewports a component preview is shot at. */
export const PREVIEW_VIEWPORTS = ['phone', 'desktop'] as const;
export const PreviewViewport = z.enum(PREVIEW_VIEWPORTS);
export type PreviewViewport = z.infer<typeof PreviewViewport>;

/** The named states every preview offers; a system adds its own beside them (`PreviewShot.state` is free text). */
export const PREVIEW_STATES = ['empty', 'loading', 'error', 'typical', 'long'] as const;
export const PreviewState = z.enum(PREVIEW_STATES);
export type PreviewState = z.infer<typeof PreviewState>;

/** One screenshot of a system's component in one state, viewport and theme, stored as hub content. */
export const PreviewShot = z.object({
  /** The component as the client registers it: a renderer's type, a visual's registry entry, an input or editor. */
  component: z.string().min(1),
  state: z.string().min(1),
  viewport: PreviewViewport,
  theme: z.enum(['light', 'dark']),
  image: ContentRef,
});
export type PreviewShot = z.infer<typeof PreviewShot>;

/** What `harness test` reports for one system: every test, the counts, and the previews it shot. */
export const SystemTestReport = z.object({
  system: SystemName,
  version: z.string().min(1),
  ranAt: Timestamp,
  duration: Duration,
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  /** The failed tests first, then the rest; capped, with `more` counting what was left out. */
  cases: z.array(TestCase).max(500),
  more: z.number().int().min(0).optional(),
  previews: z.array(PreviewShot).max(200).optional(),
});
export type SystemTestReport = z.infer<typeof SystemTestReport>;

/** Everything checked about a build: its scan and its tests (absent when the system has none). */
export const InstallChecks = z.object({ scan: ScanReport, tests: SystemTestReport.optional() });
export type InstallChecks = z.infer<typeof InstallChecks>;
