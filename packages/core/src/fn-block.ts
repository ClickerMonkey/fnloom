/**
 * What blocks a fn, as one shape: why a fn can't be called now (its availability), and what every refusal of a fn says
 * (`FnBlock`). Its own module, so run records (`InvalidInput.blocked`) and system records share it without a cycle.
 */
import { z } from 'zod';
import { SystemName } from './primitives.ts';

/**
 * Why a fn can't be called right now. `held` is off until an admin reviews its system (the fn changed and waits in a
 * pending review, or its system is installed and not live yet), apart from `disabled`, switched off by an admin.
 */
export const FnUnavailable = z.enum([
  'system-needs-config', 'system-disconnected', 'system-removed', 'kind-missing', 'kind-system-disconnected', 'dep-unavailable', 'disabled', 'held', 'paused',
]);
export type FnUnavailable = z.infer<typeof FnUnavailable>;

/** Whether a fn (or anything else a system contributes) can be used now, and why not. */
export const Availability = z.union([z.literal(true), z.object({ unavailable: FnUnavailable, detail: z.string() })]);
export type Availability = z.infer<typeof Availability>;

/**
 * Why the model can't have a fn it named: the fn's own availability code (`FnUnavailable`) when it exists but can't be
 * used now, else why it isn't offered at all — `no-such-fn` (or one the person can't see), `not-a-name` (not
 * `system/name`), `other-system` (the session doesn't use its system), `not-for-model` (its visibility leaves the model
 * out), `connect-account` (the person must connect an account first).
 */
export const FnBlockCode = z.enum([...FnUnavailable.options, 'no-such-fn', 'not-a-name', 'other-system', 'not-for-model', 'connect-account']);
export type FnBlockCode = z.infer<typeof FnBlockCode>;

/**
 * What blocks a fn, as every place that refuses one says it (`hub/load_fns`, `hub/load`, the static `run`,
 * `hub/load_context`'s brought fns, `hub/fns_search`'s unavailable hits, the prompt's context blocks): its code, the
 * hub's reason in words (the availability's `detail` when it is unavailable, "database/create_table changed and waits
 * for an admin to approve it"), and the fn's system when the name has one, so the web can point at what holds it.
 */
export const FnBlock = z.object({
  code: FnBlockCode,
  reason: z.string().min(1),
  system: SystemName.optional(),
});
export type FnBlock = z.infer<typeof FnBlock>;

/** A fn the hub refused, by the name it was asked for, with what blocks it. */
export const FnRefusal = FnBlock.extend({ fn: z.string() });
export type FnRefusal = z.infer<typeof FnRefusal>;

/** A name `hub/load` refused (a fn's or a context item's), with what blocks it; a name that is neither is `no-such-fn`. */
export const NameRefusal = FnBlock.extend({ name: z.string() });
export type NameRefusal = z.infer<typeof NameRefusal>;
