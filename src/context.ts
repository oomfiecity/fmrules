import path from 'node:path';
import { createLogger, type Logger, type LoggerOptions } from './logger.ts';

export interface Context {
  /** Project root — contains manifest.yml, rules/, snippets/. */
  cwd: string;
  log: Logger;
}

export interface ContextOptions extends LoggerOptions {
  cwd?: string;
}

export function createContext(opts: ContextOptions = {}): Context {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  return {
    cwd,
    log: createLogger(opts),
  };
}
