/**
 * The admin area's places: its sections and each page's tabs, as zod enums so the URL is read through the one list
 * of values each part may take (`useParamChoice`, `useQueryChoice`), and the route table is made from the same lists.
 */
import { SYSTEM_PART_SECTIONS } from '@harness/core';
import { z } from 'zod';

/** The admin sections, in the order the admin nav lists them. */
export const AdminSection = z.enum(['systems', 'fns', 'models', 'limits', 'policies', 'actor-settings', 'runs', 'model-calls', 'mcps']);
export type AdminSection = z.infer<typeof AdminSection>;

/** A system's tabs. */
export const SystemTab = z.enum(['overview', 'instances', 'config', 'fns', 'context', 'types', 'parts', 'graph', 'refusals', 'logs']);
export type SystemTab = z.infer<typeof SystemTab>;

/** The parts a system's Parts tab shows, one at a time (`?part=` in the URL): its resource roots and every other section. */
export const PartTab = z.enum(['roots', ...SYSTEM_PART_SECTIONS]);
export type PartTab = z.infer<typeof PartTab>;

/** A system's review tabs (build 7): everything it declares, then its grants, config, checks, pending changes and refusals. */
export const ReviewTab = z.enum(['fns', 'context', 'types', 'parts', 'graph', 'grants', 'config', 'checks', 'pending', 'refusals']);
export type ReviewTab = z.infer<typeof ReviewTab>;

/** The providers and models page's tabs. */
export const ModelsTab = z.enum(['providers', 'models', 'categories', 'roles', 'limits']);
export type ModelsTab = z.infer<typeof ModelsTab>;

/** The limits page's tabs. */
export const LimitsTab = z.enum(['budgets', 'priorities', 'resolved']);
export type LimitsTab = z.infer<typeof LimitsTab>;

/** One instance's tabs (a fleet's copy of a system). */
export const InstanceTab = z.enum(['overview', 'config', 'types', 'fns', 'data']);
export type InstanceTab = z.infer<typeof InstanceTab>;

/** One hub MCP's tabs. */
export const McpTab = z.enum(['rules', 'preview', 'connect', 'activity']);
export type McpTab = z.infer<typeof McpTab>;
