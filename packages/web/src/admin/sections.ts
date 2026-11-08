/**
 * The admin area's places: its sections and each page's tabs, as zod enums so the URL is read through the one list
 * of values each part may take (`useParamChoice`, `useQueryChoice`), and the route table is made from the same lists.
 */
import { z } from 'zod';

/** The admin sections, in the order the admin nav lists them. */
export const AdminSection = z.enum(['systems', 'models', 'limits', 'policies', 'actor-settings', 'runs', 'model-calls', 'mcps']);
export type AdminSection = z.infer<typeof AdminSection>;

/** A system's tabs. */
export const SystemTab = z.enum(['overview', 'instances', 'config', 'fns', 'logs']);
export type SystemTab = z.infer<typeof SystemTab>;

/** The providers and models page's tabs. */
export const ModelsTab = z.enum(['providers', 'models', 'categories', 'roles', 'limits']);
export type ModelsTab = z.infer<typeof ModelsTab>;

/** The limits page's tabs. */
export const LimitsTab = z.enum(['budgets', 'priorities', 'resolved']);
export type LimitsTab = z.infer<typeof LimitsTab>;

/** One instance's tabs (a fleet's copy of a system). */
export const InstanceTab = z.enum(['overview', 'config', 'data']);
export type InstanceTab = z.infer<typeof InstanceTab>;

/** One hub MCP's tabs. */
export const McpTab = z.enum(['rules', 'preview', 'connect', 'activity']);
export type McpTab = z.infer<typeof McpTab>;
