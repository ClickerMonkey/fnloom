/**
 * The hub's own API groups (build 8, `core/api-index.ts`): its fns sorted into groups the way a system's are, so the
 * catalog writes `hub/api` and one `hub/api.<group>` per group and a small model walks the hub's API like any other.
 * The groups are given here, where the hub imports its contract, rather than on each fn: the names say the group.
 */
import { GENERAL_GROUP, type ApiGroupDecl, type FnDecl, type Manifest } from '@harness/core';

/** Each group, described once, with the hub fns in it. */
const GROUPS: ReadonlyArray<ApiGroupDecl & { readonly fns: readonly string[] }> = [
  { name: 'chat', title: 'Chat', description: 'Chat agents, sessions and their messages, and asking the person.', fns: ['chat', 'chat_small', 'ask_user', 'sessions_list', 'session_messages', 'session_create', 'session_update', 'session_delete'] },
  { name: 'catalog', title: 'Fns and types', description: 'Find, inspect, load and save fns; read types, any list by query, the graph and item histories.', fns: ['fns_search', 'fn_examples', 'fn_get', 'save_fn', 'load_fns', 'drop_fns', 'inspect', 'load', 'unload', 'types_get', 'query', 'graph', 'item_versions'] },
  { name: 'context', title: 'Context and memory', description: 'Read and load context items, remember and forget, and link context.', fns: ['load_context', 'context_get', 'remember', 'forget', 'memory_update', 'context_from_resource', 'context_link', 'context_unlink'] },
  { name: 'resources', title: 'Resources and files', description: 'Search, read, import, convert and send resources, and explore systems\' files.', fns: ['search_resources', 'resource_list', 'resource_read', 'resource_outline', 'resource_send', 'resource_convert', 'resource_import', 'resource_rename', 'resource_delete', 'explore_roots', 'explore_list', 'explore_read'] },
  { name: 'data', title: 'Data', description: 'Records of stored types: find, read, save, change and remove them, list the stored types, and read any fn\'s table with its visuals and row actions.', fns: ['data_sets', 'records_find', 'record_get', 'records_table', 'record_versions', 'record_save', 'record_update', 'record_remove', 'read_table', 'visuals', 'row_actions'] },
  { name: 'runs', title: 'Runs and spending', description: 'Follow, list and undo runs, read model calls, and how fns have been doing.', fns: ['run_status', 'run_wait', 'runs_list', 'run_get', 'run_tree', 'llm_call', 'model_calls', 'fn_metrics', 'run_background', 'turn_undo', 'system_calls'] },
  { name: 'systems', title: 'Systems', description: 'See, install, configure, switch and pair systems and their instances.', fns: ['systems_list', 'system_get', 'system_fns', 'system_logs', 'configure_system', 'enable_system', 'switch_item', 'remove_system', 'install_system', 'start_system', 'stop_system', 'restart_system', 'upgrade_system', 'system_reimport', 'export_system_data', 'install_package', 'add_instance', 'remove_instance', 'instances_list', 'approve_pairing', 'create_pairing_token', 'pairings_list', 'auto_pairs_list', 'auto_pair_revoke'] },
  { name: 'models', title: 'Models', description: 'Model providers, which model does which job, and model limits.', fns: ['model_roles', 'model_limits', 'set_model_role', 'clear_model_role', 'set_model_limits', 'configure_provider', 'set_model_category', 'providers_list', 'suggest_decision_get', 'suggest_decision_set'] },
  { name: 'people', title: 'People and sharing', description: 'People, groups, their settings, who sees what, and per-person connections.', fns: ['add_user', 'add_group', 'actors_list', 'actor_settings_list', 'set_actor_setting', 'access_set', 'connection_update', 'connection_disconnect'] },
  { name: 'rules', title: 'Budgets and rules', description: 'Budgets, priorities and approval policies.', fns: ['set_budget', 'set_priority', 'set_policy', 'remove_rule', 'budgets_list', 'policies_list', 'priority_rules_list'] },
  { name: 'mcp', title: 'Hub MCPs', description: 'The MCP servers the hub offers other tools, and their tokens.', fns: ['create_mcp', 'update_mcp', 'rotate_mcp_secret', 'delete_mcp', 'preview_mcp', 'mcps_list', 'mcp_sessions_list', 'mint_mcp_token'] },
];

/** A hub fn's group: the one that lists it, else the general group. */
export function hubGroupOf(local: string): string {
  return GROUPS.find((group) => group.fns.includes(local))?.name ?? GENERAL_GROUP;
}

/** The hub's contract with its API groups: each fn in its group, each group described. */
export function withHubGroups(manifest: Manifest): Manifest {
  const fns: FnDecl[] = manifest.fns.map((fn) => ({ ...fn, group: fn.group ?? hubGroupOf(fn.name) }));
  const used = new Set(fns.map((fn) => fn.group));
  const groups = GROUPS.filter((group) => used.has(group.name)).map(({ name, title, description }): ApiGroupDecl => ({ name, title, description }));
  return { ...manifest, fns, groups: [...(manifest.groups ?? []), ...groups] };
}
