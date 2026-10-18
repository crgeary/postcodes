import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  level: LogLevel;
  /** True if a line at `level` would be written; lets callers skip building fields. */
  enabled(level: LogLevel): boolean;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** One JSON object per line on stdout. */
export function createLogger(level: LogLevel, base: LogFields = {}, write: (line: string) => void = defaultWrite): Logger {
  const enabled = (lvl: LogLevel): boolean => ORDER[lvl] >= ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (!enabled(lvl)) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...base, ...fields }) + '\n');
  };
  return {
    level,
    enabled,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, write),
  };
}

function defaultWrite(line: string): void {
  process.stdout.write(line);
}

export const silentLogger: Logger = createLogger('error', {}, () => {});
