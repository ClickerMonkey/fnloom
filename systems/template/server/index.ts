/**
 * The template system's server: its implementation (`impl.ts`) and the process that serves it (`main.ts`). Each outside
 * thing the implementation talks to (a service, a database, the clock) is an interface here, so `createImpl` takes
 * real ones in `main.ts` and fakes in tests.
 *
 * TODO: declare an interface per outside dependency, or delete this comment:
 *   export interface Service { fetch(id: string, signal: AbortSignal): Promise<Item | undefined> }
 *
 * TODO: once the contract declares config, name its type for the server's code (every context has it as `ctx.config`):
 *   export type TemplateConfig = ConfigOf<(typeof template)['defs']>;
 */
export { template } from '../shared/index.ts';
export { createImpl, type TemplateDeps } from './impl.ts';
