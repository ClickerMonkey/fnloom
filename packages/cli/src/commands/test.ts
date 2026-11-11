/**
 * `harness test [dir]`: run a system folder's own tests (the SDK test kit, `@harness/sdk/testing`) and print what
 * passed and failed, or the whole `SystemTestReport` as JSON (`--json`, what fs's `install_system` reads). With
 * `--previews` the kit also shoots its component previews into `<dir>/.harness-test/previews/`, with a gallery.
 */
import { join, relative, resolve } from 'node:path';
import { PREVIEW_DIR } from '@harness/build';
import type { SystemTestReport } from '@harness/core';
import { z } from 'zod';
import { command } from '../command.ts';

/** How many lines of a failure are printed. */
const FAILURE_LINES = 6;

/** A report as lines for a person: the counts, then each failure with the first lines of why. */
export function reportLines(report: SystemTestReport, label: string, previewDir: string): string[] {
  const real = report.cases.filter((c) => c.real === true).length;
  const lines = [
    `${report.system} ${report.version} (${label}): ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`
      + `${real === 0 ? '' : `, ${real} on a real model`} in ${(report.duration / 1000).toFixed(1)} s`,
  ];
  for (const failed of report.cases.filter((c) => c.status === 'failed')) {
    lines.push(`  failed: ${failed.file} > ${failed.name}`);
    for (const line of (failed.error ?? '').split('\n').slice(0, FAILURE_LINES)) { if (line.trim() !== '') { lines.push(`    ${line.trim()}`); } }
  }
  if (report.more !== undefined) { lines.push(`  and ${report.more} more tests`); }
  if (report.previews !== undefined) { lines.push(`previews: ${report.previews.length} shots in ${join(previewDir, 'gallery.html')}`); }
  return lines;
}

export const testCommand = command({
  path: ['test'],
  summary: "Run a system's own tests (the SDK test kit); --previews also shoots its components into a gallery.",
  usage: '[dir] [--previews] [--json] [--filter <text>]',
  args: z.object({
    positionals: z.array(z.string()).max(1),
    values: z.object({
      previews: z.boolean().default(false),
      json: z.boolean().default(false),
      filter: z.string().optional(),
    }),
  }),
  async run({ positionals, values }, io) {
    const dir = resolve(io.cwd, positionals[0] ?? '.');
    const report = await io.tests.run(dir, { previews: values.previews, ...(values.filter === undefined ? {} : { filters: [values.filter] }) });
    if (report === undefined) {
      if (values.json) { io.out.line('null'); } else { io.out.line(`${relative(io.cwd, dir) || '.'} has no tests.`); }
      return 0;
    }
    if (values.json) {
      io.out.line(JSON.stringify(report));
    } else {
      for (const line of reportLines(report, relative(io.cwd, dir) || '.', relative(io.cwd, join(dir, PREVIEW_DIR)))) { io.out.line(line); }
    }
    return report.failed === 0 ? 0 : 1;
  },
});
