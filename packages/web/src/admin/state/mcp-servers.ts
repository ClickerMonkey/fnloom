/**
 * Build 9: the MCP servers pages' state. The list is the `mcp` system's instances (`FleetStore`), each with its status
 * (`mcp/server_status` run quietly as the admin on that instance: state, what the server said about itself, counts,
 * degraded tools). One server's page adds what it mirrors into the hub: its tools (the fns routed to it), its prompts
 * (context items with `/commands`, by the hub's `contexts` list) and its resources (under `mcp://<instance>/`, browsed
 * in the resource browser).
 */
import {
  ContextRecord, McpServerStatus, QualifiedName, type FnRecord, type InstanceName, type QueryFnArgs,
} from '@harness/core';
import { shallowRef } from 'vue';
import { Loaded } from '../../state/loaded.ts';
import { problemText } from '../../state/problems.ts';
import type { AdminApi } from '../api.ts';
import { instanceFns } from '../logic/instances.ts';
import { MCP, mirrorPrefix, promptsOf, type StatusRead } from '../logic/mcp-servers.ts';
import { FleetStore, type FleetApi } from './fleet.ts';

type ServersApi = FleetApi & Pick<AdminApi, 'readFn' | 'systemFns' | 'query'>;

/** The fn that answers a server's status. */
export const SERVER_STATUS_FN = QualifiedName.parse(`${MCP}/server_status`);

/** The most prompts of one server read at once. */
export const PROMPTS_PAGE = 200;

/** The hub `contexts` list query for one server's prompts: the `mcp` system's items named with its prefix. */
export function promptsQuery(instance: InstanceName): QueryFnArgs {
  return {
    list: 'contexts',
    query: {
      filters: [{ field: 'system', op: 'is', value: MCP }, { field: 'name', op: 'contains', value: mirrorPrefix(instance) }],
      sort: [{ field: 'name', dir: 'asc' }], limit: PROMPTS_PAGE,
    },
  };
}

/** The MCP servers, their statuses, and the open server's tools and prompts. */
export class McpServersStore {
  readonly #api: ServersApi;
  readonly fleet: FleetStore;
  /** Each server's last status read, by instance. */
  readonly statuses = shallowRef<ReadonlyMap<InstanceName, StatusRead>>(new Map());
  /** The open server. */
  readonly open = shallowRef<InstanceName | undefined>(undefined);
  readonly tools = new Loaded<readonly FnRecord[]>();
  readonly prompts = new Loaded<readonly ContextRecord[]>();

  constructor(api: ServersApi) {
    this.#api = api;
    this.fleet = new FleetStore(api, MCP);
  }

  /** Read the servers, then each one's status. */
  async load(quiet = false): Promise<void> {
    await this.fleet.load(quiet);
    await Promise.all((this.fleet.list.value.value ?? []).map((view) => this.readStatus(view.instance)));
  }

  /** Read one server's status from its instance. */
  async readStatus(instance: InstanceName): Promise<void> {
    let read: StatusRead;
    try {
      const result = await this.#api.readFn.call({ fn: SERVER_STATUS_FN, args: { instance } });
      const parsed = McpServerStatus.safeParse(result);
      read = parsed.success ? { status: parsed.data } : { problem: 'Its status came back in a shape this page does not know.' };
    } catch (error) {
      read = { problem: problemText(error, "Couldn't read its status.") };
    }
    this.statuses.value = new Map([...this.statuses.value, [instance, read]]);
  }

  /** The status of a server, once read. */
  statusOf(instance: InstanceName): McpServerStatus | undefined {
    const read = this.statuses.value.get(instance);
    return read !== undefined && 'status' in read ? read.status : undefined;
  }

  /** Open one server's page: its status, tools and prompts (again, quietly, when it is the one open). */
  async show(instance: InstanceName): Promise<void> {
    const same = this.open.value === instance;
    if (!same) { this.close(); }
    this.open.value = instance;
    await Promise.all([
      this.fleet.load(this.fleet.list.value.value !== undefined),
      this.readStatus(instance),
      this.tools.load(async () => instanceFns(await this.#api.systemFns.call({ system: MCP }), instance), "Couldn't load its tools.", same),
      this.prompts.load(async () => {
        const page = await this.#api.query.call(promptsQuery(instance));
        return promptsOf(ContextRecord.array().parse(page.items), MCP, instance);
      }, "Couldn't load its prompts.", same),
    ]);
  }

  close(): void {
    this.open.value = undefined;
    this.tools.reset();
    this.prompts.reset();
  }
}
