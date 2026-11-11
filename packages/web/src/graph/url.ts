/**
 * The graph page's URL query (`/graph`): one key per filter, each a comma-separated list or one value, so the
 * route table can declare it without reaching the graph's rules (which link to pages through the route table).
 */
import { z } from 'zod';

/** The graph page's query keys, one per filter, each a comma-separated list (or one value). */
export const GraphUrl = z.object({
  systems: z.string(), external: z.literal('0'), nodes: z.string(), edges: z.string(), fnKinds: z.string(), modes: z.string(), effects: z.string(),
  visibility: z.string(), stages: z.string(), on: z.enum(['1', '0']), collapse: z.string(), q: z.string(), focus: z.string(), hops: z.enum(['1', '2', '3', '4']),
}).partial();
export type GraphUrl = z.infer<typeof GraphUrl>;
/** One of the graph page's query keys. */
export type GraphUrlKey = keyof GraphUrl;
/** Every query key the graph page reads. */
export const GRAPH_URL_KEYS = GraphUrl.keyof().options;
