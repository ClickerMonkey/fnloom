/**
 * The random system's server: its implementation (`impl.ts`) and the process that serves it (`main.ts`).
 */
export { random } from '../shared/index.ts';
export { createImpl, type RandomDeps } from './impl.ts';
