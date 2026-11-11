/**
 * Run one system folder's own tests in this process and print the `SystemTestReport` (or `null` when it has none) as
 * one JSON line. fs's install_system starts it as a sandboxed child (`ProcessSystemTests`), never in its own process.
 */
import { NodeFiles, runSystemTests } from '@harness/build';

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write('usage: run-tests <system folder>\n');
  process.exit(2);
}
const report = await runSystemTests(dir, new NodeFiles());
process.stdout.write(`\n${JSON.stringify(report ?? null)}\n`);
process.exit(0);
