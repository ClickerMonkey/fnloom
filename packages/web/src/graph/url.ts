/**
 * The graph page's URL query (`/admin/graph`): its search and filters in `q`, written as the search box writes every
 * list's query (`nodeKind:fn system:fs read`), and one key per drawing control: systems collapsed into one node, the
 * focus and its hops, and whether references outside show. Declared here so the route table can name it without
 * reaching the graph's rules (which link to pages through the route table).
 */
import { z } from 'zod';

/** The graph page's query keys. */
export const GraphUrl = z.object({
  q: z.string(), external: z.literal('0'), collapse: z.string(), focus: z.string(), hops: z.enum(['1', '2', '3', '4']),
}).partial();
export type GraphUrl = z.infer<typeof GraphUrl>;
/** One of the graph page's query keys. */
export type GraphUrlKey = keyof GraphUrl;
/** Every query key the graph page reads. */
export const GRAPH_URL_KEYS = GraphUrl.keyof().options;
