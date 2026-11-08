/**
 * The mock hub's request log. `@ayepi/otel`'s telemetry logs a handler's declared failure (`fail(401, …)`, which
 * throws core's internal `ApiFailure`) as status 500 at error level, since it knows only `ApiError`. This logger sits
 * between it and the real one and logs such a line as what was answered: its declared status, at info level for a 4xx.
 * (The fix belongs in `@ayepi/otel`; this keeps the mock's log true meanwhile.)
 */
import type { Logger } from '@ayepi/log';

/** The status a thrown declared failure carries, if it is one. */
function declaredStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || error.name !== 'ApiFailure') { return undefined; }
  const status: unknown = Reflect.get(error, 'status');
  return typeof status === 'number' ? status : undefined;
}

/** `base`, logging declared failures with their real status. */
export function declaredStatusLogger(base: Logger): Logger {
  return {
    get config() { return base.config; },
    setLevel: (level) => { base.setLevel(level); },
    isLevelEnabled: (level) => base.isLevelEnabled(level),
    flush: () => base.flush(),
    close: () => base.close(),
    interceptConsole: () => base.interceptConsole(),
    restoreConsole: () => { base.restoreConsole(); },
    log: (level, ...args) => { base.log(level, ...args); },
    debug: (...args) => { base.debug(...args); },
    info: (...args) => { base.info(...args); },
    warn: (...args) => { base.warn(...args); },
    error: (...args) => {
      const [message, fields, error] = args;
      const status = declaredStatus(error);
      if (status === undefined || typeof fields !== 'object' || fields === null) { base.error(...args); return; }
      const line = { ...fields, status };
      if (status < 500) { base.info(message, line); } else { base.error(message, line); }
    },
    logWith: (add, inner) => base.logWith(add, inner),
    context: () => base.context(),
    setTransports: (transports) => { base.setTransports(transports); },
  };
}
