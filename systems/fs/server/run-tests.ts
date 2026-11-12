/**
 * Run one system folder's own tests and print the `SystemTestReport` (or `null` when it has none) as one JSON line.
 * fs's install_system starts it as a sandboxed child (`ProcessSystemTests`), never in its own process, with the Node
 * flags of the processes that run the test files (`ProcessSystemTests.testArgs`) as a JSON array after the folder.
 */
import { NodeFiles, runSystemTests } from '@harness/build';
import { z } from 'zod';

const [dir, flags] = process.argv.slice(2);
const execArgv = z.array(z.string()).safeParse(flags === undefined ? undefined : JSON.parse(flags));
if (dir === undefined || !execArgv.success) {
  process.stderr.write('usage: run-tests <system folder> <test process flags as a JSON array>\n');
  process.exit(2);
}
const report = await runSystemTests(dir, new NodeFiles(), { sandbox: { execArgv: execArgv.data } });
process.stdout.write(`\n${JSON.stringify(report ?? null)}\n`);
process.exit(0);
