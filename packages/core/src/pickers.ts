/**
 * Pickers (build 4): one search-as-you-type multi-select for every input that names things (fns, context, systems,
 * people, models, resources, types). The web's `UiPicker` asks `pick` for options and `pick` with `values` to label the
 * chips it already holds. The hub answers only with what the asker may see.
 */
import { z } from 'zod';

/** What a picker picks. `person` and `group` are actors; `model` a model id as the model picker takes it. */
export const PICK_SOURCES = ['fn', 'context', 'system', 'person', 'group', 'model', 'resource', 'type', 'kind'] as const;
export const PickSource = z.enum(PICK_SOURCES);
export type PickSource = z.infer<typeof PickSource>;

/** A picker's question: options matching `text` (best first), or, with `values`, those values' options to label chips. */
export const PickQuery = z.object({
  source: PickSource,
  text: z.string().optional(),
  values: z.array(z.string()).max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type PickQuery = z.infer<typeof PickQuery>;

/** One option: the value the input stores (a qualified name, an actor id, a URI), and how it reads. */
export const PickOption = z.object({
  value: z.string(),
  label: z.string(),
  hint: z.string().optional(),
  icon: z.string().optional(),
  /** Gone or no longer visible to the asker (a chip for a value that resolved to nothing). */
  missing: z.boolean().optional(),
});
export type PickOption = z.infer<typeof PickOption>;
