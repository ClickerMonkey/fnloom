/**
 * `harness system export-data <name> [--instance <name>] [--out <file>] [--with-secrets --yes]`: have the hub quiesce
 * an instance it runs, zip its data folder (with its config only when asked, and confirmed with `--yes`, since the
 * config may hold keys) and download the zip. `harness system install <zip> --data <export>` restores it.
 */
import { relative, resolve } from 'node:path';
import { InstanceName, MAIN_INSTANCE, SystemName, dataExportFileName } from '@harness/core';
import { z } from 'zod';
import { HUB_OPTIONS, command } from '../command.ts';

export const exportDataCommand = command({
  path: ['system', 'export-data'],
  summary: 'Download an installed instance’s data folder as a zip (its config too, with --with-secrets --yes).',
  usage: '<system> [--instance <name>] [--out <file>] [--with-secrets --yes]',
  args: z.object({
    positionals: z.tuple([SystemName]),
    values: z.object({ ...HUB_OPTIONS, instance: InstanceName.default(MAIN_INSTANCE), out: z.string().optional(), 'with-secrets': z.boolean().default(false), yes: z.boolean().default(false) }),
  }),
  async run({ positionals: [system], values }, io) {
    const withSecrets = values['with-secrets'];
    if (withSecrets && !values.yes) {
      io.out.warn('--with-secrets puts the instance’s whole config in the zip, keys and passwords included: add --yes to go ahead');
      return 1;
    }
    const hub = await io.hub(values);
    try {
      const exported = await hub.api.call('exportSystemData', { system, instance: values.instance, withSecrets });
      const out = resolve(io.cwd, values.out ?? dataExportFileName({ system, instance: values.instance }));
      await io.files.write(out, await hub.download(exported.url));
      io.out.line(`exported ${system}@${values.instance}: ${exported.size} bytes to ${relative(io.cwd, out) || out}`);
      return 0;
    } finally {
      hub.close();
    }
  },
});
