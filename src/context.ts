import path from 'node:path';
import { createLogger, type Logger, type LoggerOptions } from './logger.ts';

export interface Paths {
  cwd: string;
  rules: string;
  meta: string;
}

export interface Context {
  paths: Paths;
  log: Logger;
}

export interface ContextOptions extends LoggerOptions {
  cwd?: string;
  rules?: string;
  meta?: string;
}

export function createContext(opts: ContextOptions = {}): Context {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const rules = path.resolve(cwd, opts.rules ?? 'rules');
  const meta = path.resolve(cwd, opts.meta ?? 'meta');
  return {
    paths: { cwd, rules, meta },
    log: createLogger(opts),
  };
}
