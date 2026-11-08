/**
 * Build 2's modules before their lanes build them: every service answers each call with a `NotBuilt` error naming the
 * module, service and method, so the hub starts and serves everything that exists while the rest is built. Each lane
 * replaces its module's factory (`<module>/create.ts`) and nothing here stays once build 2 is done.
 */
import { reject } from '@ayepi/core';

/** A service of a module whose lane hasn't built it yet: every method throws 501 `NOT_BUILT`. */
export function notBuiltService<T extends object>(name: string): T {
  const proxy = new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') { return undefined; }
      return () => { throw reject(501, 'NOT_BUILT', `${name}.${key} is not built yet.`); };
    },
  });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every member of T is a method answered by the proxy above; temporary, see the module comment
  return proxy as T;
}
