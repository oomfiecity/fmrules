/**
 * Module interface — the generic transform primitive.
 *
 * A module takes a list of in-progress rules and returns a (possibly
 * different-length) list of rules. This breadth is intentional: the
 * simplest use (field OR-expansion, e.g. the SimpleLogin bridge) is
 * a 1-to-1 map; but modules can also fan rules out, drop them, merge
 * their actions, or inject search fragments.
 *
 * Modules are discovered from meta/modules/**:
 *   - *.ts files default-export the result of `defineModule(...)`.
 *   - *.yaml files describe a declarative field transform; they are
 *     compiled into an equivalent module at load time.
 */

import type { z } from 'zod';
import type { Context } from './context.ts';
import type { PartialRule } from './types.ts';

export interface Module<A = unknown> {
  name: string;
  /** Optional zod schema for arg validation. */
  schema?: z.ZodType<A>;
  /** Human-readable description (surfaced by `fmrules check`). */
  description?: string;
  apply(rules: PartialRule[], args: A, ctx: Context): PartialRule[] | Promise<PartialRule[]>;
}

/**
 * Identity helper so authors get TS inference on args when writing
 * their own module files.
 */
export function defineModule<A>(mod: Module<A>): Module<A> {
  return mod;
}
