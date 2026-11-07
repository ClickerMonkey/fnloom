/**
 * A stand-in for the chat's system client, for the renderer tests and the preview page: `rerun` returns a live
 * delivery that the caller settles, so every delivery state can be shown and checked.
 */
import { mintId, type DeliveryId, type DeliveryStatus } from '@harness/core';
import type { Delivery, SystemClient } from '@harness/sdk';
import { reactive } from 'vue';
import type { CommandOutput, FsContract } from '../shared/index.ts';

/** A fake fs system client and the handles to drive it. */
export interface FakeFsSystem {
  readonly system: SystemClient<FsContract['defs']>;
  /** The commands sent with `rerun`, in order. */
  readonly sent: string[];
  /** The latest delivery's status, live. */
  readonly delivery: { id: DeliveryId; status: DeliveryStatus; result: Promise<CommandOutput> };
  /** Finish the latest rerun with this output. */
  settle(output: CommandOutput): void;
  /** Move the latest delivery to a status without finishing it. */
  move(status: DeliveryStatus): void;
}

/** Make a fake fs system client. */
export function fakeFsSystem(online = true): FakeFsSystem {
  let finish: (output: CommandOutput) => void = () => undefined;
  const sent: string[] = [];
  const delivery = reactive<FakeFsSystem['delivery']>({ id: mintId('delivery'), status: 'queued', result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) });
  const system: SystemClient<FsContract['defs']> = {
    online,
    send: {
      rerun: (input): Delivery<CommandOutput> => {
        sent.push(input.command);
        delivery.id = mintId('delivery');
        delivery.status = online ? 'delivered' : 'queued';
        delivery.result = new Promise<CommandOutput>((resolve) => { finish = resolve; });
        return delivery;
      },
    },
  };
  return {
    system, sent, delivery,
    settle: (output) => { delivery.status = 'done'; finish(output); },
    move: (status) => { delivery.status = status; },
  };
}
